"""Reader-only early bootstrap contracts; behavioral validation lives in JS/browser tests."""

import pytest
from test_novel_service import novels_data as novels_data
from test_reader_web import ReaderParser


async def test_preferences_bootstrap_is_external_blocking_and_before_reader_markup(
    async_client, novels_data
):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    parser = ReaderParser(response.text)
    scripts = [attrs for tag, attrs in parser.tags if tag == "script"]
    assert scripts[0] == {"src": "http://test/static/js/reader_preferences.js"}
    assert len([attrs for attrs in scripts if "reader_preferences.js" in attrs["src"]]) == 1
    assert all("src" in attrs for attrs in scripts)
    assert response.text.index("reader_preferences.js") < response.text.index("/css/reader.css")
    assert response.text.index("reader_preferences.js") < response.text.index('class="reader-page"')
    assert 'data-reader-theme="sepia"' in response.text
    assert 'aria-live="polite">19px</output>' in response.text
    assert 'aria-live="polite">1.85</output>' in response.text
    assert "set-cookie" not in response.headers


async def test_preferences_asset_is_served_only_on_reader_pages(async_client):
    response = await async_client.get("/static/js/reader_preferences.js")
    assert response.status_code == 200
    assert "javascript" in response.headers["content-type"]
    for path in ["/", "/login", "/register"]:
        response = await async_client.get(path)
        assert response.status_code == 200
        assert "reader_preferences.js" not in response.text


@pytest.mark.parametrize("sequence", [4, 7])
async def test_unpublished_chapters_do_not_load_preferences(async_client, novels_data, sequence):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 404
    assert "reader_preferences.js" not in response.text
