"""Read-only audit; optionally verify migrations on newly created, dedicated local databases.

Never migrates the configured database. Dedicated verification databases are retained,
not dropped/reset. No connection strings, record identifiers or secrets are printed.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from ipaddress import ip_address
from pathlib import Path
from uuid import uuid4

import psycopg
from dotenv import dotenv_values
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db" / "migrations"
DATABASE_MARKER = "Read-Novel 4.7.1a disposable verification only"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def local_audit_url() -> str:
    value = os.environ.get("DATABASE_URL") or dotenv_values(
        ROOT / ".env.local.txt", interpolate=False
    ).get("DATABASE_URL")
    info = conninfo_to_dict(value) if value else {}
    if info.get("host") not in LOCAL_HOSTS or info.get("dbname") != "readnovel_test":
        raise ValueError("Audit requires an explicit local readnovel_test target")
    if info.get("hostaddr") and info["hostaddr"] not in LOCAL_HOSTS:
        raise ValueError("Non-local hostaddr refused")
    if info.get("service"):
        raise ValueError("Connection service indirection refused")
    return value


def require_disposable(connection: psycopg.Connection) -> None:
    """Guard every connection that will run DDL/tests, even when invoked externally."""
    info = conninfo_to_dict(connection.info.dsn)
    if info.get("host") not in LOCAL_HOSTS or not re.fullmatch(
        r"readnovel_471a_test_[0-9a-f]{12}_(baseline|migrated)", connection.info.dbname
    ):
        raise ValueError("Dedicated local 4.7.1a database required")
    if info.get("hostaddr") and info["hostaddr"] not in LOCAL_HOSTS:
        raise ValueError("Non-local hostaddr refused")
    if not ip_address(connection.info.hostaddr).is_loopback:
        raise ValueError("Connected client peer is not loopback")
    marker = connection.execute(
        "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname=current_database()"
    ).fetchone()[0]
    if marker != DATABASE_MARKER:
        raise ValueError("Disposable database ownership marker missing")


def audit(url: str) -> dict:
    with psycopg.connect(url, connect_timeout=3, row_factory=dict_row) as conn:
        if not ip_address(conn.info.hostaddr).is_loopback:
            raise ValueError("Read-only audit requires a loopback client peer")
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        conn.execute("SET LOCAL statement_timeout = '10s'")
        report = {
            "read_only": conn.execute("SHOW transaction_read_only").fetchone()[
                "transaction_read_only"
            ],
            "server_version": conn.execute("SHOW server_version").fetchone()["server_version"],
        }
        queries = {
            "tables": "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
            "columns": """SELECT table_name,column_name,data_type,is_nullable,column_default
                FROM information_schema.columns WHERE table_schema='public' AND table_name IN
                ('reading_progress','bookmarks','reading_chapter_completions')
                ORDER BY table_name,ordinal_position""",
            "constraints": """SELECT c.relname AS table_name,k.conname,k.convalidated,
                pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k
                JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' ORDER BY c.relname,k.conname""",
            "indexes": """SELECT tablename,indexname,indexdef FROM pg_indexes
                WHERE schemaname='public' ORDER BY tablename,indexname""",
            "triggers": """SELECT c.relname AS table_name,t.tgname,
                pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
                JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname""",
            "progress_data": """SELECT count(*) AS rows,
                count(*) FILTER (WHERE p.scroll_position IS NULL) AS null_scroll,
                count(*) FILTER (WHERE p.scroll_position < 0) AS negative_scroll,
                count(*) FILTER (WHERE p.scroll_position > 1) AS over_one_scroll,
                count(*) FILTER (WHERE p.scroll_position IN
                    ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)) AS nonfinite_scroll,
                count(*) FILTER (WHERE p.updated_at IS NULL) AS null_updated_at,
                count(*) FILTER (WHERE p.max_read_sequence < 0) AS negative_max,
                count(*) FILTER (WHERE c.novel_id <> p.novel_id) AS cross_novel,
                count(*) FILTER (WHERE c.id IS NULL) AS missing_chapter,
                count(*) FILTER (WHERE c.content_status IS DISTINCT FROM 'Published') AS unavailable
                FROM public.reading_progress p LEFT JOIN public.chapters c
                    ON c.id=p.last_read_chapter_id""",
            "bookmark_data": """SELECT count(*) AS rows,
                count(*) FILTER (WHERE c.novel_id <> b.novel_id) AS cross_novel,
                count(*) FILTER (WHERE c.id IS NULL) AS missing_chapter,
                count(*) FILTER (WHERE b.note IS NOT NULL) AS notes,
                count(*) FILTER (WHERE b.created_at IS NULL) AS null_created_at,
                count(*) FILTER (WHERE c.content_status IS DISTINCT FROM 'Published'
                    OR c.chapter_sequence<=0) AS unavailable
                FROM public.bookmarks b LEFT JOIN public.chapters c ON c.id=b.chapter_id""",
        }
        for name, query in queries.items():
            report[name] = conn.execute(query).fetchall()
        return report


def bootstrap(url: str, *, migrated: bool) -> None:
    with psycopg.connect(url, connect_timeout=3) as conn:
        require_disposable(conn)
        if conn.execute("SELECT count(*) FROM pg_tables WHERE schemaname='public'").fetchone()[0]:
            raise ValueError("Bootstrap refuses a nonempty public schema")
        conn.execute("SET LOCAL lock_timeout = '5s'")
        conn.execute("SET LOCAL statement_timeout = '60s'")
        for name in ("001_init_schema_v3_2.sql", "002_add_user_status.sql"):
            conn.execute((MIGRATIONS / name).read_text(encoding="utf-8"))
        if migrated:
            for name in ("003_reading_progress_evidence.sql", "004_bookmark_removal.sql"):
                conn.execute((MIGRATIONS / name).read_text(encoding="utf-8"))


def verify(url: str) -> int:
    """CREATE DATABASE uses fresh random names; existing databases are never reused."""
    urls = {}
    with psycopg.connect(url, connect_timeout=3, autocommit=True) as admin:
        # Docker port mapping may give PostgreSQL an internal non-loopback address.
        # Check libpq's actual client peer, not inet_server_addr() inside the container.
        if not ip_address(admin.info.hostaddr).is_loopback:
            raise ValueError("CREATE DATABASE requires a loopback client peer")
        allowed = admin.execute(
            "SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname=current_user"
        ).fetchone()[0]
        if not allowed:
            print("PARTIAL: local role cannot create dedicated test databases.")
            return 2
        suffix = uuid4().hex[:12]
        for kind in ("baseline", "migrated"):
            name = f"readnovel_471a_test_{suffix}_{kind}"
            admin.execute(
                sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8'").format(
                    sql.Identifier(name)
                )
            )
            admin.execute(
                sql.SQL("COMMENT ON DATABASE {} IS {}").format(
                    sql.Identifier(name), sql.Literal(DATABASE_MARKER)
                )
            )
            urls[kind] = make_conninfo(url, dbname=name)
            print(f"Created dedicated local database: {name}", flush=True)
    for kind, target in urls.items():
        bootstrap(target, migrated=kind == "migrated")
    env = os.environ.copy()
    env.update(
        DATABASE_URL=urls["migrated"],
        TEST_DATABASE_URL=urls["migrated"],
        MIGRATION_TEST_DATABASE_URL=urls["baseline"],
    )
    env["PYTHONIOENCODING"] = "utf-8"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "--tb=short",
            "-p",
            "no:cacheprovider",
            "--basetemp",
            tempfile.mkdtemp(prefix="readnovel-471a-"),
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    output = result.stdout
    for target in (url, *urls.values()):
        output = output.replace(target, "[REDACTED_DATABASE_URL]")
        password = conninfo_to_dict(target).get("password")
        if password:
            output = output.replace(password, "[REDACTED_PASSWORD]")
    print(output, end="", flush=True)
    print("Dedicated databases retained for review; no DROP/reset was executed.", flush=True)
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Create fresh local test databases")
    args = parser.parse_args()
    try:
        url = local_audit_url()
        report = audit(url)
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        progress = report["progress_data"][0]
        bookmarks = report["bookmark_data"][0]
        blockers = (
            progress["negative_scroll"]
            or progress["over_one_scroll"]
            or progress["nonfinite_scroll"]
            or progress["negative_max"]
            or progress["cross_novel"]
            or progress["missing_chapter"]
            or bookmarks["cross_novel"]
            or bookmarks["missing_chapter"]
        )
        if args.verify and blockers:
            print("PARTIAL: invalid legacy data found; stop for a reviewed data policy.")
            return 2
        return verify(url) if args.verify else 0
    except (psycopg.Error, ValueError) as exc:
        # Do not print exception text: it may contain a DSN or sensitive server detail.
        print(f"PARTIAL: {type(exc).__name__}; no fallback database will be used.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
