"""Run migration 003 against real 001/002 in a dedicated, guarded database.

Each test rolls back its entire transaction. The public schema of readnovel_test
is never migrated, reset or populated by this module. Run with the verifier script.
"""

import hashlib
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from scripts.check_progress_migration import require_disposable

MIGRATION = (
    Path(__file__).resolve().parents[1] / "db/migrations/003_reading_progress_evidence.sql"
).read_text(encoding="utf-8")
SCHEME = "sha256-utf8-raw-v1"
DIGEST = hashlib.sha256("Nội dung A\r\nĐoạn hai.\n".encode()).digest()
PROGRESS_COLUMNS = (
    "id,user_id,novel_id,last_read_chapter_id,max_read_sequence,scroll_position,updated_at"
)


@pytest.fixture
def legacy_db():
    url = os.environ.get("MIGRATION_TEST_DATABASE_URL")
    if not url:
        pytest.skip("NOT TESTED: run scripts/check_progress_migration.py --verify for dedicated DB")
    with psycopg.connect(url, connect_timeout=3) as conn:
        require_disposable(conn)
        assert conn.info.dbname.endswith("_baseline"), "A pre-003 baseline database is required"
        conn.rollback()
        with conn.transaction(force_rollback=True):
            conn.execute("SET LOCAL lock_timeout = '5s'")
            conn.execute("SET LOCAL statement_timeout = '20s'")
            assert conn.execute(
                "SELECT to_regclass('public.reading_chapter_completions')"
            ).fetchone() == (None,)
            yield conn


@pytest.fixture
def seeded(legacy_db):
    conn = legacy_db
    user_id, novel_id, other_novel = uuid4(), uuid4(), uuid4()
    conn.execute(
        "INSERT INTO users(id,email,username) VALUES (%s,%s,%s)",
        (user_id, f"{user_id}@example.invalid", f"migration-{user_id}"),
    )
    for novel in (novel_id, other_novel):
        conn.execute(
            "INSERT INTO novels(id,slug,title,author) VALUES (%s,%s,'Migration test','Fixture')",
            (novel, str(novel)),
        )
    chapters = []
    for sequence, status in enumerate(("Published", "Draft", "Archived"), start=1):
        chapter_id = uuid4()
        chapters.append(chapter_id)
        conn.execute(
            """INSERT INTO chapters(id,novel_id,chapter_sequence,chapter_number,title,content,content_status)
               VALUES (%s,%s,%s,%s,'Fixture chapter',%s,%s)""",
            (chapter_id, novel_id, sequence, str(sequence), "Nội dung A\r\nĐoạn hai.\n", status),
        )
    conn.execute(
        """INSERT INTO reading_progress(user_id,novel_id,last_read_chapter_id,
            max_read_sequence,scroll_position,updated_at)
            VALUES (%s,%s,%s,1000,0.3,'2001-01-01T00:00:00Z')""",
        (user_id, novel_id, chapters[0]),
    )
    conn.execute(
        "INSERT INTO bookmarks(user_id,novel_id,chapter_id,note) VALUES (%s,%s,%s,'Legacy note')",
        (user_id, novel_id, chapters[0]),
    )
    return conn, user_id, novel_id, chapters, other_novel


def insert_completion(conn, user_id, novel_id, chapter_id):
    conn.execute(
        """INSERT INTO reading_chapter_completions(user_id,novel_id,chapter_id,content_hash)
           VALUES (%s,%s,%s,%s)""",
        (user_id, novel_id, chapter_id, DIGEST),
    )


def legacy_snapshot(conn):
    result = {}
    for table in ("users", "novels", "chapters", "bookmarks", "user_sessions"):
        result[table] = conn.execute(
            sql.SQL("SELECT * FROM {} ORDER BY id").format(sql.Identifier(table))
        ).fetchall()
    result["reading_progress"] = conn.execute(
        "SELECT " + PROGRESS_COLUMNS + " FROM reading_progress ORDER BY id"
    ).fetchall()
    return result


def test_legacy_preserved_and_no_completion_backfill(seeded):
    conn, _, _, _, _ = seeded
    before = legacy_snapshot(conn)
    conn.execute(MIGRATION)
    assert legacy_snapshot(conn) == before
    assert conn.execute("SELECT count(*) FROM reading_chapter_completions").fetchone() == (0,)
    assert conn.execute(
        "SELECT revision,resume_writer_epoch,resume_content_hash,resume_hash_scheme FROM reading_progress"
    ).fetchone() == (0, None, None, None)
    assert conn.execute("SELECT max_read_sequence FROM reading_progress").fetchone() == (1000,)


def test_bookmark_migration_preserves_all_legacy_columns_and_activates_existing_rows(seeded):
    conn, user_id, novel_id, chapters, _ = seeded
    conn.execute(MIGRATION)
    conn.execute(
        """INSERT INTO bookmarks(user_id,novel_id,chapter_id,note,created_at)
           VALUES (%s,%s,%s,'',NULL)""",
        (user_id, novel_id, chapters[2]),
    )
    fields = "id,user_id,novel_id,chapter_id,note,created_at"
    before = conn.execute("SELECT " + fields + " FROM bookmarks ORDER BY id").fetchall()
    migration = Path(__file__).resolve().parents[1] / "db/migrations/004_bookmark_removal.sql"
    conn.execute(migration.read_text(encoding="utf-8"))
    assert (
        conn.execute(
            "SELECT " + fields + " FROM bookmarks WHERE removed_at IS NULL ORDER BY id"
        ).fetchall()
        == before
    )
    with pytest.raises(psycopg.errors.UniqueViolation), conn.transaction():
        conn.execute(
            "INSERT INTO bookmarks(user_id,novel_id,chapter_id) VALUES (%s,%s,%s)",
            (user_id, novel_id, chapters[0]),
        )


def test_defaults_and_types(seeded):
    conn, user_id, novel_id, chapters, _ = seeded
    conn.execute(MIGRATION)
    conn.execute("DELETE FROM reading_progress WHERE user_id=%s", (user_id,))
    row = conn.execute(
        """INSERT INTO reading_progress(user_id,novel_id,last_read_chapter_id) VALUES (%s,%s,%s)
           RETURNING max_read_sequence,revision,resume_writer_epoch,resume_content_hash,resume_hash_scheme""",
        (user_id, novel_id, chapters[0]),
    ).fetchone()
    assert row == (0, 0, None, None, None)
    columns = dict(
        conn.execute(
            """SELECT column_name,data_type FROM information_schema.columns
           WHERE table_schema='public' AND table_name='reading_progress'"""
        ).fetchall()
    )
    assert columns["revision"] == "bigint"
    assert columns["resume_writer_epoch"] == "uuid"
    assert columns["resume_content_hash"] == "bytea"
    insert_completion(conn, user_id, novel_id, chapters[0])
    assert conn.execute(
        """SELECT hash_scheme,completion_policy_version,completion_source,
                  completed_at IS NOT NULL,pg_typeof(content_hash)::text,octet_length(content_hash)
           FROM reading_chapter_completions"""
    ).fetchone() == (SCHEME, 1, "explicit", True, "bytea", 32)


def test_one_evidence_per_user_chapter(seeded):
    conn, user_id, novel_id, chapters, _ = seeded
    conn.execute(MIGRATION)
    insert_completion(conn, user_id, novel_id, chapters[0])
    with pytest.raises(psycopg.errors.UniqueViolation), conn.transaction():
        insert_completion(conn, user_id, novel_id, chapters[0])
    other = uuid4()
    conn.execute(
        "INSERT INTO users(id,email,username) VALUES (%s,%s,%s)",
        (other, f"{other}@example.invalid", str(other)),
    )
    insert_completion(conn, other, novel_id, chapters[0])
    assert conn.execute("SELECT count(*) FROM reading_chapter_completions").fetchone() == (2,)


@pytest.mark.parametrize("length", [0, 31, 33, 64])
def test_invalid_digest_length(seeded, length):
    conn, user_id, novel_id, chapters, _ = seeded
    conn.execute(MIGRATION)
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute(
            """INSERT INTO reading_chapter_completions(user_id,novel_id,chapter_id,content_hash)
               VALUES (%s,%s,%s,%s)""",
            (user_id, novel_id, chapters[0], b"x" * length),
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("content_hash", None),
        ("hash_scheme", "unknown"),
        ("hash_scheme", None),
        ("completion_policy_version", 0),
        ("completion_policy_version", 2),
        ("completion_policy_version", None),
        ("completion_source", "auto"),
        ("completion_source", None),
        ("completed_at", None),
    ],
)
def test_evidence_constraints(seeded, field, value):
    conn, user_id, novel_id, chapters, _ = seeded
    conn.execute(MIGRATION)
    insert_completion(conn, user_id, novel_id, chapters[0])
    with pytest.raises(psycopg.IntegrityError), conn.transaction():
        conn.execute(
            sql.SQL("UPDATE reading_chapter_completions SET {}=%s").format(sql.Identifier(field)),
            (value,),
        )


@pytest.mark.parametrize(
    ("digest", "scheme"),
    [(None, SCHEME), (DIGEST, None), (DIGEST, "unknown"), (b"x" * 31, SCHEME)],
)
def test_resume_hash_pair_constraints(seeded, digest, scheme):
    conn, *_ = seeded
    conn.execute(MIGRATION)
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute(
            "UPDATE reading_progress SET resume_content_hash=%s,resume_hash_scheme=%s",
            (digest, scheme),
        )


def test_resume_revision_and_writer_handle_schema(seeded):
    conn, *_ = seeded
    conn.execute(MIGRATION)
    epoch = uuid4()
    conn.execute(
        """UPDATE reading_progress SET revision=revision+1,resume_writer_epoch=%s,
           resume_content_hash=%s,resume_hash_scheme=%s""",
        (epoch, DIGEST, SCHEME),
    )
    assert conn.execute("SELECT revision,resume_writer_epoch FROM reading_progress").fetchone() == (
        1,
        epoch,
    )
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("UPDATE reading_progress SET revision=-1")
    # This proves field constraints only. CAS/epoch ownership belongs to 4.7.1b.


@pytest.mark.parametrize("position", [0.0, 1.0, None])
def test_compatible_legacy_scroll_is_not_rewritten(seeded, position):
    conn, *_ = seeded
    conn.execute("UPDATE reading_progress SET scroll_position=%s", (position,))
    before = legacy_snapshot(conn)
    conn.execute(MIGRATION)
    assert legacy_snapshot(conn) == before


@pytest.mark.parametrize("position", [-0.1, 1.1, float("nan"), float("inf"), -float("inf")])
def test_invalid_legacy_scroll_aborts_without_repair(seeded, position):
    conn, *_ = seeded
    conn.execute("UPDATE reading_progress SET scroll_position=%s", (position,))
    before = conn.execute(
        "SELECT scroll_position::text,updated_at FROM reading_progress"
    ).fetchall()
    with pytest.raises(psycopg.errors.RaiseException), conn.transaction():
        conn.execute(MIGRATION)
    assert conn.execute("SELECT to_regclass('public.reading_chapter_completions')").fetchone() == (
        None,
    )
    assert (
        conn.execute("SELECT scroll_position::text,updated_at FROM reading_progress").fetchall()
        == before
    )


@pytest.mark.parametrize("position", [-0.1, 1.1, float("nan"), float("inf"), -float("inf")])
def test_new_invalid_scroll_rejected(seeded, position):
    conn, *_ = seeded
    conn.execute(MIGRATION)
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("UPDATE reading_progress SET scroll_position=%s", (position,))


@pytest.mark.parametrize("bad_reference", ["user", "chapter", "novel", "cross_novel"])
def test_foreign_keys_and_novel_chapter_relationship(seeded, bad_reference):
    conn, user_id, novel_id, chapters, other_novel = seeded
    conn.execute(MIGRATION)
    values = [user_id, novel_id, chapters[0]]
    values[{"user": 0, "chapter": 2, "novel": 1, "cross_novel": 1}[bad_reference]] = (
        other_novel if bad_reference == "cross_novel" else uuid4()
    )
    with pytest.raises(psycopg.errors.ForeignKeyViolation), conn.transaction():
        insert_completion(conn, *values)


def test_ledger_does_not_depend_on_resume_row(seeded):
    conn, user_id, novel_id, chapters, _ = seeded
    conn.execute(MIGRATION)
    conn.execute("DELETE FROM reading_progress")
    insert_completion(conn, user_id, novel_id, chapters[0])
    assert conn.execute("SELECT count(*) FROM reading_chapter_completions").fetchone() == (1,)


@pytest.mark.parametrize("parent", ["users", "novels", "chapters"])
def test_cascade_and_other_chapter_evidence_survives(seeded, parent):
    conn, user_id, novel_id, chapters, _ = seeded
    conn.execute(MIGRATION)
    # Publish the second fixture before accepting its artificial SQL evidence.
    conn.execute("UPDATE chapters SET content_status='Published' WHERE id=%s", (chapters[1],))
    for chapter_id in chapters[:2]:
        insert_completion(conn, user_id, novel_id, chapter_id)
    parent_id = {"users": user_id, "novels": novel_id, "chapters": chapters[0]}[parent]
    conn.execute(sql.SQL("DELETE FROM {} WHERE id=%s").format(sql.Identifier(parent)), (parent_id,))
    assert conn.execute("SELECT count(*) FROM reading_progress").fetchone() == (0,)
    assert conn.execute("SELECT count(*) FROM reading_chapter_completions").fetchone() == (
        1 if parent == "chapters" else 0,
    )


def test_content_edit_archive_republish_reorder_keep_old_evidence(seeded):
    conn, user_id, novel_id, chapters, _ = seeded
    conn.execute(MIGRATION)
    insert_completion(conn, user_id, novel_id, chapters[0])
    old = conn.execute("SELECT * FROM reading_chapter_completions").fetchall()
    conn.execute(
        "UPDATE chapters SET content=%s,content_status='Archived',chapter_sequence=100 WHERE id=%s",
        ("Nội dung B", chapters[0]),
    )
    conn.execute("UPDATE chapters SET content_status='Published' WHERE id=%s", (chapters[0],))
    assert conn.execute("SELECT * FROM reading_chapter_completions").fetchall() == old
    current_digest = conn.execute(
        "SELECT digest(convert_to(content,'UTF8'),'sha256') FROM chapters WHERE id=%s",
        (chapters[0],),
    ).fetchone()[0]
    assert current_digest != old[0][3]
    assert conn.execute("SELECT max_read_sequence FROM reading_progress").fetchone() == (1000,)


def test_new_indexes_are_distinct_and_fk_is_validated(seeded):
    conn, *_ = seeded
    conn.execute(MIGRATION)
    definitions = conn.execute(
        """SELECT i.indisunique,array_agg(a.attname ORDER BY k.ordinality)
           FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
           JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
           WHERE i.indrelid='reading_chapter_completions'::regclass
           GROUP BY i.indexrelid,i.indisunique"""
    ).fetchall()
    assert len(definitions) == 3
    assert {tuple(cols) for _, cols in definitions} == {
        ("user_id", "chapter_id"),
        ("user_id", "novel_id"),
        ("novel_id", "chapter_id"),
    }
    assert conn.execute(
        "SELECT bool_and(convalidated) FROM pg_constraint WHERE conrelid='reading_chapter_completions'::regclass"
    ).fetchone() == (True,)


def test_late_ddl_failure_rolls_back_all_changes(seeded):
    conn, *_ = seeded
    conn.execute("CREATE INDEX idx_completions_novel_chapter ON bookmarks(id)")
    before = legacy_snapshot(conn)
    with pytest.raises(psycopg.errors.DuplicateTable), conn.transaction():
        conn.execute(MIGRATION)
    assert legacy_snapshot(conn) == before
    assert conn.execute("SELECT to_regclass('public.reading_chapter_completions')").fetchone() == (
        None,
    )
    assert conn.execute(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='reading_progress' AND column_name='revision'"
    ).fetchone() == (0,)
    assert conn.execute(
        "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='reading_progress' AND column_name='max_read_sequence'"
    ).fetchone() == ("1",)
    assert conn.execute(
        "SELECT count(*) FROM pg_constraint WHERE conname='uq_chapters_novel_id_id'"
    ).fetchone() == (0,)


def test_replay_refuses_schema_drift_without_data_changes(seeded):
    conn, *_ = seeded
    conn.execute(MIGRATION)
    before = legacy_snapshot(conn)
    with pytest.raises(psycopg.errors.RaiseException), conn.transaction():
        conn.execute(MIGRATION)
    assert legacy_snapshot(conn) == before


@pytest.mark.parametrize("content", ["", "Tiếng Việt", " a \n", "a\r\nb", "é", "e\u0301"])
def test_raw_utf8_digest_contract_matches_postgresql(legacy_db, content):
    digest = legacy_db.execute(
        "SELECT digest(convert_to(%s::text,'UTF8'),'sha256')", (content,)
    ).fetchone()[0]
    assert digest == hashlib.sha256(content.encode("utf-8")).digest()


def test_hash_contract_distinguishes_line_endings_and_unicode(legacy_db):
    variants = ["a\r\nb", "a\nb", "é", "e\u0301", " a", "a"]
    digests = [
        legacy_db.execute(
            "SELECT digest(convert_to(%s::text,'UTF8'),'sha256')", (value,)
        ).fetchone()[0]
        for value in variants
    ]
    assert len(set(digests)) == len(variants)


@pytest.mark.parametrize(
    ("host", "dbname", "peer"),
    [
        ("127.0.0.1", "readnovel_test", "127.0.0.1"),
        ("127.0.0.1", "readnovel_prod", "127.0.0.1"),
        ("db.example.invalid", "readnovel_471a_test_123456abcdef_baseline", "127.0.0.1"),
        ("127.0.0.1", "readnovel_471a_test_123456abcdef_migrated", "192.0.2.1"),
    ],
)
def test_disposable_guard_rejects_unverified_targets_before_query(host, dbname, peer):
    class Target:
        info = SimpleNamespace(dsn=f"host={host} dbname={dbname}", dbname=dbname, hostaddr=peer)

        def execute(self, query):
            pytest.fail("An unverified target must be rejected before issuing a query")

    with pytest.raises(ValueError):
        require_disposable(Target())


def test_disposable_guard_rejects_missing_ownership_marker():
    class Target:
        info = SimpleNamespace(
            dsn="host=127.0.0.1 dbname=readnovel_471a_test_123456abcdef_migrated",
            dbname="readnovel_471a_test_123456abcdef_migrated",
            hostaddr="127.0.0.1",
        )

        def execute(self, query):
            return SimpleNamespace(fetchone=lambda: (None,))

    with pytest.raises(ValueError):
        require_disposable(Target())
