"""Launcher configuration tests; no server or database connections are opened."""

import runpy
from pathlib import Path
from unittest.mock import Mock

import pytest

from scripts import run_local

URL = "postgresql://testuser:TestOnlyPassword@localhost:5432/readnovel_test"


@pytest.fixture
def local_root(tmp_path, monkeypatch):
    monkeypatch.setattr(run_local, "ROOT_DIR", tmp_path)
    # Record even an originally absent key, so direct launcher writes are undone.
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("PGHOSTADDR", raising=False)
    monkeypatch.delenv("PGSERVICE", raising=False)
    return tmp_path


def test_loads_only_database_url_independent_of_cwd(local_root, tmp_path, monkeypatch, capsys):
    (local_root / ".env.local.txt").write_text(
        f'DATABASE_URL="{URL}"\nNEXT_PUBLIC_SUPABASE_URL=must-not-load\nSECRET_KEY=must-not-load\n',
        encoding="utf-8",
    )
    monkeypatch.delenv("NEXT_PUBLIC_SUPABASE_URL", raising=False)
    monkeypatch.setenv("SECRET_KEY", "keep-original")
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.chdir(other)
    run_local.load_local_database_url()
    import os

    assert os.environ["DATABASE_URL"] == URL
    assert "NEXT_PUBLIC_SUPABASE_URL" not in os.environ
    assert os.environ["SECRET_KEY"] == "keep-original"
    output = capsys.readouterr()
    assert output.out == output.err == ""


def test_environment_precedes_file_and_does_not_read_file(local_root, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", URL)
    monkeypatch.setattr(
        run_local, "dotenv_values", Mock(side_effect=AssertionError("must not read"))
    )
    run_local.load_local_database_url()
    import os

    assert os.environ["DATABASE_URL"] == URL


@pytest.mark.parametrize("file_text", [None, "OTHER=value\n", "DATABASE_URL=\n"])
def test_missing_configuration_fails_without_uvicorn(local_root, monkeypatch, file_text, capsys):
    if file_text is not None:
        (local_root / ".env.local.txt").write_text(file_text, encoding="utf-8")
    server = Mock()
    monkeypatch.setattr(run_local.uvicorn, "run", server)
    with pytest.raises(SystemExit, match="Local startup requires DATABASE_URL"):
        run_local.main()
    server.assert_not_called()
    assert "TestOnlyPassword" not in str(capsys.readouterr())


@pytest.mark.parametrize(
    "url",
    [
        "",
        " ",
        "not-a-url",
        "host=localhost dbname=readnovel_test password=TestOnlyPassword",
        "https://testuser:TestOnlyPassword@localhost/readnovel_test",
        "postgresql://testuser:TestOnlyPassword@remote.invalid/readnovel_test",
        "postgresql://testuser:TestOnlyPassword@localhost/production",
        "postgresql:///readnovel_test",
        "postgresql://localhost:invalid/readnovel_test",
        "postgresql://localhost:70000/readnovel_test",
        "postgresql://localhost/readnovel_test#fragment",
        "postgresql://localhost/readnovel_test?host=remote.invalid",
        "postgresql://localhost/readnovel_test?hostaddr=203.0.113.1",
        "postgresql://localhost/readnovel_test?dbname=production",
        "postgresql://localhost/readnovel_test?service=production",
        "postgresql://localhost/readnovel_test?password=TestOnlyPassword",
        "postgresql://localhost/readnovel_test\n",
    ],
)
def test_invalid_or_nonlocal_url_is_rejected_without_secret_output(
    local_root, monkeypatch, url, capsys
):
    monkeypatch.setenv("DATABASE_URL", url)
    (local_root / ".env.local.txt").write_text(f"DATABASE_URL={URL}", encoding="utf-8")
    with pytest.raises(ValueError) as caught:
        run_local.load_local_database_url()
    assert str(caught.value).startswith("Local startup requires DATABASE_URL")
    assert "TestOnlyPassword" not in str(caught.value)
    assert "TestOnlyPassword" not in str(capsys.readouterr())
    import os

    assert os.environ["DATABASE_URL"] == url  # No fallback after an invalid explicit value.


@pytest.mark.parametrize(
    "url",
    [
        URL,
        "postgres://user:password@127.0.0.1/readnovel_test",
        "postgresql://user:password@[::1]:5432/readnovel_test?sslmode=disable&connect_timeout=3",
        "postgresql://user:p%40ss%3Aword@localhost/readnovel_test",
    ],
)
def test_valid_local_urls_do_not_connect(local_root, monkeypatch, url):
    monkeypatch.setenv("DATABASE_URL", url)
    run_local.load_local_database_url()


@pytest.mark.parametrize("name,value", [("PGHOSTADDR", "203.0.113.1"), ("PGSERVICE", "cloud")])
def test_libpq_environment_cannot_redirect_local_target(local_root, monkeypatch, name, value):
    monkeypatch.setenv("DATABASE_URL", URL)
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError):
        run_local.load_local_database_url()


@pytest.mark.parametrize(
    "platform,loop", [("win32", "asyncio:SelectorEventLoop"), ("linux", "auto")]
)
def test_environment_loaded_before_uvicorn_and_startup_options_preserved(
    local_root, monkeypatch, platform, loop
):
    (local_root / ".env.local.txt").write_text(f"DATABASE_URL={URL}", encoding="utf-8")
    monkeypatch.setattr(run_local.sys, "platform", platform)

    def start(app, **options):
        import os

        assert os.environ["DATABASE_URL"] == URL
        assert app == "app.main:app"
        assert options == dict(host="127.0.0.1", port=8000, workers=1, loop=loop)

    server = Mock(side_effect=start)
    monkeypatch.setattr(run_local.uvicorn, "run", server)
    run_local.main()
    server.assert_called_once()


def test_import_has_no_configuration_or_server_side_effects(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    server = Mock()
    monkeypatch.setattr(run_local.uvicorn, "run", server)
    runpy.run_path(str(Path(run_local.__file__).resolve()), run_name="local_launcher_import_test")
    server.assert_not_called()
    import os

    assert "DATABASE_URL" not in os.environ
    assert run_local.ROOT_DIR == Path(run_local.__file__).resolve().parent.parent
