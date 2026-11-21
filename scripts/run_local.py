import os
import sys
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

import uvicorn
from dotenv import dotenv_values
from psycopg.conninfo import conninfo_to_dict

# Thêm thư mục gốc vào sys.path để nó tìm thư mục app
ROOT_DIR = Path(__file__).resolve().parent.parent

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def load_local_database_url() -> None:
    """Load only DATABASE_URL, validate the local QA target, then expose it to ASGI imports."""
    error = (
        "Local startup requires DATABASE_URL in environment or repo .env.local.txt: "
        "a PostgreSQL URL for localhost/127.0.0.1/::1 "
        "and database readnovel_test or readnovel_ui_test."
    )
    try:
        # Even an explicitly empty environment value must not be silently overwritten.
        value = (
            os.environ["DATABASE_URL"]
            if "DATABASE_URL" in os.environ
            else dotenv_values(ROOT_DIR / ".env.local.txt", interpolate=False).get("DATABASE_URL")
        )
        if not isinstance(value, str) or not value.strip():
            raise ValueError()
        parts = urlsplit(value)
        allowed_hosts = {"localhost", "127.0.0.1", "::1"}
        allowed_databases = {"readnovel_test", "readnovel_ui_test"}
        # Restrict query options so libpq cannot redirect the validated URL or
        # expose query-string credentials through existing masked-URL logging.
        query_keys = {key for key, _ in parse_qsl(parts.query, keep_blank_values=True)}
        if (
            parts.scheme not in {"postgres", "postgresql"}
            or parts.hostname not in allowed_hosts
            or unquote(parts.path) not in {f"/{db}" for db in allowed_databases}
            or parts.fragment
            or (parts.port is not None and not 1 <= parts.port <= 65535)
            or not query_keys <= {"sslmode", "connect_timeout"}
            or any(character.isspace() or ord(character) < 32 for character in value)
        ):
            raise ValueError()
        info = conninfo_to_dict(value)
        if (
            info.get("host") not in allowed_hosts
            or info.get("dbname") not in allowed_databases
            or os.environ.get("PGSERVICE")
            or os.environ.get("PGHOSTADDR", "") not in {"", "127.0.0.1", "::1"}
        ):
            raise ValueError()
    except Exception:
        # Never attach parser/file errors, which may contain connection credentials.
        raise ValueError(error) from None
    if "DATABASE_URL" not in os.environ:
        os.environ["DATABASE_URL"] = value


def main() -> None:
    try:
        load_local_database_url()
    except ValueError as error:
        raise SystemExit(str(error)) from None
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        workers=1,
        loop=("asyncio:SelectorEventLoop" if sys.platform == "win32" else "auto"),
    )


if __name__ == "__main__":
    main()
