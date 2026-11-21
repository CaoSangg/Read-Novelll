"""Real PostgreSQL progress tests, restricted to verifier-owned migrated databases."""

import asyncio
import hashlib
import json
import os
import secrets
from dataclasses import dataclass, field
from uuid import UUID, uuid4

import psycopg
import pytest

from app.core.config import settings
from app.core.content_revision import HASH_SCHEME, content_digest
from app.core.security import generate_session_token, hash_session_token
from app.db.pool import init_db_pool
from scripts.check_progress_migration import require_disposable

TEXT_A = "  Tiếng Việt\r\nĐoạn kế.\n "
TEXT_B = "Nội dung mới."
CSRF = settings.CSRF_HEADER_NAME
ALLOWED_ORIGIN = "http://localhost:8000"


def revision(content=TEXT_A):
    return {"scheme": HASH_SCHEME, "hash": hashlib.sha256(content.encode("utf-8")).hexdigest()}


@dataclass(repr=False)
class ProgressFixture:
    url: str
    db: psycopg.AsyncConnection
    user_ids: list[UUID]
    tokens: list[str]
    novels: list[UUID]
    chapters: dict[int, UUID]
    csrf: str = field(default_factory=lambda: secrets.token_hex(32))

    @property
    def path(self):
        return f"/api/progress/novels/{self.novels[0]}"

    def login(self, client, index=0):
        client.cookies.set(settings.SESSION_COOKIE_NAME, self.tokens[index])
        client.cookies.set(settings.CSRF_COOKIE_NAME, self.csrf)

    def resume(self, sequence=10, scroll=0, text=TEXT_A):
        return {
            "chapter_id": str(self.chapters[sequence]),
            "scroll_position": scroll,
            "content_revision": revision(text),
        }

    async def activate(self, client, sequence=10, etag=None, **kwargs):
        precondition = {"If-None-Match": "*"} if etag is None else {"If-Match": etag}
        return await client.post(
            self.path + "/resume/activate",
            json=self.resume(sequence, **kwargs),
            headers={CSRF: self.csrf, **precondition},
        )

    async def scroll(self, client, etag, activated, sequence=10, position=0.7, text=TEXT_A):
        return await client.put(
            self.path + "/resume",
            headers={CSRF: self.csrf, "If-Match": etag},
            json={
                **self.resume(sequence, position, text),
                "writer_epoch": activated["writer_epoch"],
            },
        )

    async def complete(self, client, sequence=10, text=TEXT_A):
        return await client.put(
            f"{self.path}/completions/{self.chapters[sequence]}",
            headers={CSRF: self.csrf},
            json={"confirmation": True, "content_revision": revision(text)},
        )

    async def status(self, client, *sequences):
        return await client.get(
            self.path + "/completions",
            params=[("chapter_ids", str(self.chapters[seq])) for seq in sequences],
        )

    async def resume_rows(self):
        return await (
            await self.db.execute(
                """SELECT id, last_read_chapter_id, max_read_sequence, scroll_position,
                      updated_at, revision, resume_writer_epoch, resume_content_hash
               FROM reading_progress WHERE user_id=%s AND novel_id=%s""",
                (self.user_ids[0], self.novels[0]),
            )
        ).fetchall()

    async def evidence(self):
        return await (
            await self.db.execute(
                """SELECT user_id, chapter_id, content_hash, completed_at,
                      completion_policy_version, completion_source
               FROM reading_chapter_completions WHERE novel_id=%s ORDER BY user_id,chapter_id""",
                (self.novels[0],),
            )
        ).fetchall()


@pytest.fixture
async def progress_db(test_db_url, async_client):
    if not test_db_url:
        pytest.skip("Run check_progress_migration.py --verify for a disposable database")
    try:
        with psycopg.connect(test_db_url, connect_timeout=3) as guard:
            require_disposable(guard)
            if not guard.info.dbname.endswith("_migrated"):
                raise ValueError()
            assert guard.execute(
                "SELECT to_regclass('public.reading_chapter_completions') IS NOT NULL"
            ).fetchone() == (True,)
    except (psycopg.Error, ValueError):
        if os.environ.get("MIGRATION_TEST_DATABASE_URL"):
            pytest.fail("Verifier did not supply a usable disposable migrated DB", pytrace=False)
        pytest.skip("Progress integration requires a verified disposable migrated database")

    async with await psycopg.AsyncConnection.connect(
        test_db_url, connect_timeout=3, autocommit=True
    ) as db:
        fixture = ProgressFixture(
            test_db_url,
            db,
            [uuid4(), uuid4()],
            [generate_session_token(), generate_session_token()],
            [uuid4(), uuid4()],
            {seq: uuid4() for seq in (10, 20, 30, 40, 50, 60, 100)},
        )
        async with db.transaction():
            for user, token in zip(fixture.user_ids, fixture.tokens, strict=True):
                await db.execute(
                    "INSERT INTO users(id,email,username) VALUES (%s,%s,%s)",
                    (user, f"{user}@example.invalid", str(user)),
                )
                await db.execute(
                    """INSERT INTO user_sessions(user_id,refresh_token_hash,expires_at)
                       VALUES (%s,%s,now() + interval '1 day')""",
                    (user, hash_session_token(token)),
                )
            for novel in fixture.novels:
                await db.execute(
                    "INSERT INTO novels(id,slug,title,author) VALUES (%s,%s,'QA','QA')",
                    (novel, f"qa-{novel}"),
                )
            statuses = {20: "Draft", 40: "Archived", 50: None}
            for seq, chapter in fixture.chapters.items():
                await db.execute(
                    """INSERT INTO chapters(id,novel_id,chapter_sequence,chapter_number,title,content,content_status)
                       VALUES (%s,%s,%s,%s,'QA chapter',%s,%s)""",
                    (
                        chapter,
                        fixture.novels[1 if seq == 60 else 0],
                        seq,
                        str(seq),
                        TEXT_A,
                        statuses.get(seq, "Published"),
                    ),
                )
        try:
            await init_db_pool(database_url=test_db_url, min_size=2, max_size=5, timeout=5)
            fixture.login(async_client)
            yield fixture
        finally:
            async with db.transaction():
                await db.execute("DELETE FROM users WHERE id=ANY(%s)", (fixture.user_ids,))
                await db.execute("DELETE FROM novels WHERE id=ANY(%s)", (fixture.novels,))


def assert_code(response, status, code):
    assert response.status_code == status
    assert response.json() == {"detail": {"code": code}}
    assert response.headers["Cache-Control"] == "no-store"


async def test_resume_lifecycle_read_only_get_and_frozen_legacy_max(async_client, progress_db):
    f = progress_db
    result = await async_client.get(f.path)
    assert result.status_code == 200
    assert result.headers["Cache-Control"] == "no-store"
    assert result.json()["resume"] is None
    assert result.json()["resume_etag"] is None
    assert await f.resume_rows() == []
    created = await f.activate(async_client, 100)
    assert created.status_code == 201
    token = created.headers["ETag"]
    assert created.json()["resume_etag"] == token
    state = await f.resume_rows()
    assert state[0][2:4] == (0, 0.0)
    assert state[0][5] == 1
    await f.db.execute(
        "UPDATE reading_progress SET max_read_sequence=999 WHERE id=%s", (state[0][0],)
    )
    before = await f.resume_rows()
    get = await async_client.get(f.path)
    assert get.json()["resume_etag"] == token
    assert "writer_epoch" not in get.json() and "set-cookie" not in get.headers
    assert get.json()["resume"]["content_revision"] == revision()
    assert await f.resume_rows() == before
    at_end = await f.scroll(async_client, token, created.json(), sequence=100, position=1)
    assert at_end.status_code == 200 and at_end.json()["resume"]["scroll_position"] == 1
    assert "writer_epoch" not in at_end.json()
    backward = await f.activate(async_client, 10, etag=at_end.headers["ETag"])
    assert backward.status_code == 200
    assert backward.json()["resume"]["chapter_sequence"] == 10
    assert backward.json()["resume"]["scroll_position"] == 0
    assert bool(backward.json()["writer_epoch"] != created.json()["writer_epoch"])
    saved = (await f.resume_rows())[0]
    assert saved[2:4] == (999, 0)
    assert saved[5] == 3
    assert await f.evidence() == []


async def test_resume_legacy_and_archived_read_without_changes(async_client, progress_db):
    f = progress_db
    await f.db.execute(
        """INSERT INTO reading_progress(user_id,novel_id,last_read_chapter_id,scroll_position)
           VALUES (%s,%s,%s,NULL)""",
        (f.user_ids[0], f.novels[0], f.chapters[10]),
    )
    first = await async_client.get(f.path)
    assert first.json()["resume"]["scroll_position"] == 0
    assert first.json()["resume"]["content_revision"] is None
    await f.db.execute(
        "UPDATE chapters SET content_status='Archived' WHERE id=%s", (f.chapters[10],)
    )
    before = await f.resume_rows()
    hidden = await async_client.get(f.path)
    assert hidden.json()["resume"] == {
        "available": False,
        "chapter_id": None,
        "chapter_sequence": None,
        "url": None,
        "scroll_position": 0,
        "content_revision": None,
        "updated_at": first.json()["resume"]["updated_at"],
    }
    assert await f.resume_rows() == before
    assert hidden.json()["resume_etag"] == first.json()["resume_etag"]


async def test_tab_reclaim_and_stale_epoch(async_client, progress_db):
    f = progress_db
    a = await f.activate(async_client, 10)
    b = await f.activate(async_client, 100, etag=a.headers["ETag"])
    assert b.status_code == 200
    reclaimed = await f.resume_rows()
    old = await f.scroll(async_client, a.headers["ETag"], a.json())
    assert_code(old, 412, "resume_precondition_failed")
    get = await async_client.get(f.path)
    assert get.json()["resume"]["chapter_sequence"] == 100
    old_epoch = await f.scroll(async_client, get.json()["resume_etag"], a.json(), sequence=100)
    assert_code(old_epoch, 409, "resume_writer_changed")
    wrong_chapter = await f.scroll(async_client, get.json()["resume_etag"], b.json(), sequence=10)
    assert_code(wrong_chapter, 409, "resume_chapter_changed")
    assert_code(
        await f.activate(async_client, 10, etag=a.headers["ETag"]),
        412,
        "resume_precondition_failed",
    )
    rows_preserved = await f.resume_rows() == reclaimed
    assert rows_preserved
    assert reclaimed[0][1] == f.chapters[100]
    reclaim = await f.activate(async_client, 10, etag=get.json()["resume_etag"])
    assert reclaim.status_code == 200
    assert (await f.resume_rows())[0][1] == f.chapters[10]


async def test_resume_recreation_rejects_old_row_identity(async_client, progress_db):
    f = progress_db
    old = await f.activate(async_client)
    await f.db.execute("DELETE FROM reading_progress WHERE user_id=%s", (f.user_ids[0],))
    new = await f.activate(async_client)
    assert old.headers["ETag"].endswith(':1"') and new.headers["ETag"].endswith(':1"')
    assert old.headers["ETag"] != new.headers["ETag"]
    assert_code(
        await f.activate(async_client, 100, etag=old.headers["ETag"]),
        412,
        "resume_precondition_failed",
    )
    assert_code(
        await f.scroll(async_client, old.headers["ETag"], old.json()),
        412,
        "resume_precondition_failed",
    )


async def test_completion_is_idempotent_and_preserves_resume_and_other_users(
    async_client, progress_db
):
    f = progress_db
    await f.activate(async_client)
    await f.db.execute(
        "UPDATE reading_progress SET max_read_sequence=999 WHERE user_id=%s", (f.user_ids[0],)
    )
    before = await f.resume_rows()
    first = await f.complete(async_client, 100)
    assert first.status_code == 200 and first.json()["already_completed"] is False
    stored = await f.evidence()
    retry = await f.complete(async_client, 100)
    assert retry.status_code == 200 and retry.json()["already_completed"] is True
    assert retry.json()["completed_at"] == first.json()["completed_at"]
    assert await f.evidence() == stored
    assert stored[0][-2:] == (1, "explicit")
    assert await f.resume_rows() == before
    f.login(async_client, 1)
    read = await async_client.get(f.path + "?include_summary=true")
    assert read.json()["resume"] is None
    assert read.json()["completion_summary"]["highest_confirmed_sequence"] is None
    assert (await f.status(async_client, 100)).json()["items"][0]["status"] == "not_completed"
    assert (await f.complete(async_client, 100)).json()["already_completed"] is False
    assert len(await f.evidence()) == 2


async def test_resume_preconditions_cannot_cross_users(async_client, progress_db):
    f = progress_db
    a = await f.activate(async_client)
    before = await f.resume_rows()
    f.login(async_client, 1)
    b = await f.activate(async_client, 100)
    assert b.status_code == 201
    assert_code(
        await f.scroll(async_client, a.headers["ETag"], a.json()), 412, "resume_precondition_failed"
    )
    assert_code(
        await f.activate(async_client, 100, etag=a.headers["ETag"]),
        412,
        "resume_precondition_failed",
    )
    assert await f.resume_rows() == before
    assert (await async_client.get(f.path)).json()["resume"]["chapter_sequence"] == 100


async def test_revision_edit_keeps_old_evidence_until_explicit_reconfirm(async_client, progress_db):
    f = progress_db
    active = await f.activate(async_client)
    await f.complete(async_client)
    old = await f.evidence()
    await f.db.execute("UPDATE chapters SET content=%s WHERE id=%s", (TEXT_B, f.chapters[10]))
    response = await f.status(async_client, 10, 100)
    assert response.status_code == 200
    assert [item["status"] for item in response.json()["items"]] == [
        "old_revision",
        "not_completed",
    ]
    assert response.json()["items"][0]["content_revision"] == revision(TEXT_B)
    assert_code(await f.complete(async_client), 409, "content_revision_changed")
    assert_code(
        await f.scroll(async_client, active.headers["ETag"], active.json()),
        409,
        "content_revision_changed",
    )
    assert_code(
        await f.scroll(async_client, active.headers["ETag"], active.json(), text=TEXT_B),
        409,
        "resume_activation_required",
    )
    assert await f.evidence() == old
    confirm = await f.complete(async_client, text=TEXT_B)
    assert confirm.status_code == 200 and confirm.json()["already_completed"] is False
    assert (await f.evidence())[0][2] == content_digest(TEXT_B)
    assert (await f.status(async_client, 10)).json()["items"][0]["status"] == "completed"


async def test_summary_published_order_gaps_insertion_and_revision(async_client, progress_db):
    f = progress_db

    async def metrics():
        response = await async_client.get(f.path + "?include_summary=true")
        assert response.status_code == 200
        summary = response.json()["completion_summary"]
        return summary["highest_confirmed_sequence"], summary[
            "contiguous_confirmed_through_sequence"
        ]

    assert await metrics() == (None, None)
    assert (await f.complete(async_client, 10)).status_code == 200
    assert (await f.complete(async_client, 100)).status_code == 200
    assert await metrics() == (100, 10)
    assert (await f.complete(async_client, 30)).status_code == 200
    assert await metrics() == (100, 100)
    await f.db.execute(
        "UPDATE chapters SET content_status='Published' WHERE id=%s", (f.chapters[20],)
    )
    assert await metrics() == (100, 10)
    await f.db.execute("UPDATE chapters SET content=%s WHERE id=%s", (TEXT_B, f.chapters[10]))
    assert await metrics() == (100, None)
    assert await f.resume_rows() == []
    assert (await async_client.get(f.path)).json()["completion_summary"] is None


@pytest.mark.parametrize("sequence", [20, 40, 50, 60, 70])
async def test_nonpublic_cross_novel_or_missing_chapter_is_hidden(
    async_client, progress_db, sequence
):
    f = progress_db
    if sequence == 70:
        f.chapters[sequence] = uuid4()
    for response in (
        await f.activate(async_client, sequence),
        await f.complete(async_client, sequence),
        await f.status(async_client, sequence),
    ):
        assert_code(response, 404, "chapter_not_found")
    assert await f.resume_rows() == [] and await f.evidence() == []


@pytest.mark.parametrize(
    "case,status",
    [
        ("guest", 401),
        ("expired", 401),
        ("missing_csrf", 403),
        ("wrong_csrf", 403),
        ("origin", 403),
        ("referer", 403),
    ],
)
async def test_write_authentication_and_csrf(async_client, progress_db, case, status):
    f = progress_db
    headers = {CSRF: f.csrf}
    if case == "guest":
        async_client.cookies.delete(settings.SESSION_COOKIE_NAME)
    elif case == "expired":
        await f.db.execute(
            "UPDATE user_sessions SET expires_at=now() WHERE user_id=%s", (f.user_ids[0],)
        )
    elif case == "missing_csrf":
        headers = {}
    elif case == "wrong_csrf":
        headers[CSRF] = secrets.token_hex(32)
    elif case == "origin":
        headers["Origin"] = "https://invalid.example"
    else:
        headers["Referer"] = "https://invalid.example/progress"
    assert (
        await async_client.post(
            f.path + "/resume/activate", json=f.resume(), headers={**headers, "If-None-Match": "*"}
        )
    ).status_code == status
    assert (
        await async_client.put(
            f.path + "/resume", headers=headers, json={**f.resume(), "writer_epoch": str(uuid4())}
        )
    ).status_code == status
    assert (
        await async_client.put(
            f"{f.path}/completions/{f.chapters[10]}",
            headers=headers,
            json={"confirmation": True, "content_revision": revision()},
        )
    ).status_code == status
    if status == 401:
        assert (await async_client.get(f.path)).status_code == 401
        assert (await f.status(async_client, 10)).status_code == 401
    assert await f.resume_rows() == [] and await f.evidence() == []


@pytest.mark.parametrize(
    "value", [-0.01, 1.01, "0.5", True, None, float("nan"), float("inf"), -float("inf")]
)
async def test_invalid_scroll_is_rejected_without_echo(async_client, progress_db, value):
    f = progress_db
    response = await async_client.post(
        f.path + "/resume/activate",
        content=json.dumps(f.resume(scroll=value)),
        headers={CSRF: f.csrf, "If-None-Match": "*", "Content-Type": "application/json"},
    )
    assert_code(response, 422, "invalid_request")
    assert await f.resume_rows() == []


async def test_invalid_input_body_limit_and_preconditions(async_client, progress_db):
    f = progress_db
    path = f.path + "/resume/activate"
    headers = {CSRF: f.csrf, "If-None-Match": "*", "Origin": ALLOWED_ORIGIN}
    for patch in (
        {"chapter_id": "invalid"},
        {"user_id": str(f.user_ids[1])},
        {"chapter_sequence": 100},
        {"max_read_sequence": 999},
        {"writer_epoch": str(uuid4())},
        {"content_revision": {**revision(), "scheme": "other"}},
        {"content_revision": {**revision(), "hash": "G" * 64}},
        {"content_revision": {**revision(), "hash": "a" * 63}},
    ):
        assert_code(
            await async_client.post(path, json={**f.resume(), **patch}, headers=headers),
            422,
            "invalid_request",
        )
    for body, status, code in (
        ("{", 422, "invalid_request"),
        (" " * 2049, 413, "payload_too_large"),
    ):
        assert_code(
            await async_client.post(
                path, content=body, headers={**headers, "Content-Type": "application/json"}
            ),
            status,
            code,
        )

    async def chunks():
        yield b" " * 1024
        yield b" " * 1025

    assert_code(
        await async_client.post(
            path, content=chunks(), headers={**headers, "Content-Type": "application/json"}
        ),
        413,
        "payload_too_large",
    )
    assert_code(
        await async_client.post(path, json=f.resume(), headers={CSRF: f.csrf}),
        428,
        "resume_precondition_required",
    )
    for etag in ("*", 'W/"x"', '"not-a-token"', f'"{uuid4()}:9223372036854775808"'):
        assert_code(
            await async_client.post(
                path, json=f.resume(), headers={CSRF: f.csrf, "If-Match": etag}
            ),
            422,
            "invalid_resume_precondition",
        )
    for extra in ({"completed_at": "2001-01-01"}, {"completion_source": "auto"}):
        assert_code(
            await async_client.put(
                f"{f.path}/completions/{f.chapters[10]}",
                json={"confirmation": True, "content_revision": revision(), **extra},
                headers=headers,
            ),
            422,
            "invalid_request",
        )
    assert_code(
        await async_client.put(
            f"{f.path}/completions/{f.chapters[10]}",
            json={"confirmation": False, "content_revision": revision()},
            headers=headers,
        ),
        422,
        "explicit_confirmation_required",
    )
    assert_code(await async_client.get("/api/progress/novels/invalid"), 422, "invalid_request")
    assert_code(await async_client.get(f"/api/progress/novels/{uuid4()}"), 404, "novel_not_found")
    assert_code(await f.status(async_client, 10, 10), 422, "duplicate_chapter_ids")
    assert_code(
        await async_client.get(
            f.path + "/completions", params=[("chapter_ids", str(uuid4())) for _ in range(101)]
        ),
        422,
        "invalid_request",
    )
    assert (await f.activate(async_client)).status_code == 201


async def wait_for_blocked_backends(db, *tasks):
    """Count distinct waiters, including those queued behind a tuple locker."""
    async with asyncio.timeout(5):
        while True:
            # A transaction can cache activity across polls. Refresh so newly
            # connected or newly blocked sessions are visible to the test.
            await db.execute("SELECT pg_stat_clear_snapshot()")
            row = await (
                await db.execute(
                    """WITH RECURSIVE blockers(pid) AS (
                       SELECT pid FROM pg_stat_activity
                       WHERE datname=current_database()
                         AND pg_backend_pid()=ANY(pg_blocking_pids(pid))
                       UNION
                       SELECT a.pid FROM pg_stat_activity a JOIN blockers b
                           ON b.pid=ANY(pg_blocking_pids(a.pid))
                       WHERE a.datname=current_database()
                   ) SELECT count(*) FROM blockers"""
                )
            ).fetchone()
            if row[0] == len(tasks):
                return
            if any(task.done() for task in tasks):
                pytest.fail("A concurrent request finished before its database lock wait")
            await asyncio.sleep(0.01)


async def queued_requests(f, sequences, requests, *, edit=None):
    tasks = []
    try:
        async with f.db.transaction():
            if edit:
                await f.db.execute(edit, (f.chapters[sequences[0]],))
            else:
                await f.db.execute(
                    "SELECT id FROM chapters WHERE id=ANY(%s) FOR UPDATE",
                    ([f.chapters[seq] for seq in sequences],),
                )
            tasks = [asyncio.create_task(request) for request in requests]
            await wait_for_blocked_backends(f.db, *tasks)
        async with asyncio.timeout(5):
            return await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


async def test_concurrent_first_activation_has_one_winner(async_client, progress_db):
    f = progress_db
    results = await queued_requests(
        f, [10, 100], [f.activate(async_client), f.activate(async_client, 100)]
    )
    assert sorted(response.status_code for response in results) == [201, 412]
    rows = await f.resume_rows()
    assert len(rows) == 1 and rows[0][5] == 1
    winner = next(response for response in results if response.status_code == 201)
    assert str(rows[0][1]) == winner.json()["resume"]["chapter_id"]


async def test_concurrent_scroll_cas_has_one_winner(async_client, progress_db):
    f = progress_db
    active = await f.activate(async_client)
    results = await queued_requests(
        f,
        [10],
        [
            f.scroll(async_client, active.headers["ETag"], active.json(), position=p)
            for p in (0.4, 0.6)
        ],
    )
    assert sorted(response.status_code for response in results) == [200, 412]
    winner = next(response for response in results if response.status_code == 200)
    row = (await f.resume_rows())[0]
    assert row[5] == 2 and row[3] == winner.json()["resume"]["scroll_position"]


async def test_delayed_scroll_overlaps_new_tab_activation(async_client, progress_db):
    f = progress_db
    a = await f.activate(async_client)

    # Delay A with another backend's chapter lock, wait for A's blocked SQL, then finish B.
    async with f.db.transaction():
        await f.db.execute("SELECT id FROM chapters WHERE id=%s FOR UPDATE", (f.chapters[10],))
        delayed = asyncio.create_task(f.scroll(async_client, a.headers["ETag"], a.json()))
        try:
            await wait_for_blocked_backends(f.db, delayed)
            async with asyncio.timeout(5):
                b = await f.activate(async_client, 100, etag=a.headers["ETag"])
                assert b.status_code == 200
        except BaseException:
            delayed.cancel()
            await asyncio.gather(delayed, return_exceptions=True)
            raise
    assert_code(await asyncio.wait_for(delayed, 5), 412, "resume_precondition_failed")
    assert (await f.resume_rows())[0][1] == f.chapters[100]


async def test_concurrent_completion_retry_keeps_one_timestamp(async_client, progress_db):
    f = progress_db
    results = await queued_requests(f, [10], [f.complete(async_client), f.complete(async_client)])
    assert [r.status_code for r in results] == [200, 200]
    assert sorted(r.json()["already_completed"] for r in results) == [False, True]
    assert results[0].json()["completed_at"] == results[1].json()["completed_at"]
    assert len(await f.evidence()) == 1
    assert await f.resume_rows() == []


@pytest.mark.parametrize("change", ["content", "archive"])
async def test_committing_editor_race_revalidates_completion_and_resume(
    async_client, progress_db, change
):
    f = progress_db
    await f.complete(async_client)
    evidence = await f.evidence()
    active = await f.activate(async_client)
    saved = await f.resume_rows()
    edit = (
        "UPDATE chapters SET content='Edited during write' WHERE id=%s"
        if change == "content"
        else "UPDATE chapters SET content_status='Archived' WHERE id=%s"
    )
    results = await queued_requests(
        f,
        [10],
        [
            f.complete(async_client),
            f.scroll(async_client, active.headers["ETag"], active.json()),
        ],
        edit=edit,
    )
    for response in results:
        if change == "content":
            assert_code(response, 409, "content_revision_changed")
        else:
            assert_code(response, 404, "chapter_not_found")
    assert await f.evidence() == evidence
    assert await f.resume_rows() == saved


async def test_completion_holds_chapter_lock_until_ledger_transaction_finishes(
    async_client, progress_db
):
    f = progress_db
    await f.complete(async_client)
    evidence = await f.evidence()

    async def edit():
        async with await psycopg.AsyncConnection.connect(f.url, connect_timeout=3) as editor:
            await editor.execute(
                "UPDATE chapters SET content=%s WHERE id=%s", (TEXT_B, f.chapters[10])
            )

    tasks = []
    try:
        async with f.db.transaction():
            # Block the ledger UPSERT after it has already validated/locked the chapter.
            await f.db.execute(
                "SELECT chapter_id FROM reading_chapter_completions WHERE chapter_id=%s FOR UPDATE",
                (f.chapters[10],),
            )
            repeat = asyncio.create_task(f.complete(async_client))
            tasks.append(repeat)
            await wait_for_blocked_backends(f.db, repeat)
            author = asyncio.create_task(edit())
            tasks.append(author)
            # The edit waits on the completion transaction, which is waiting on our ledger lock.
            await wait_for_blocked_backends(f.db, repeat, author)
        async with asyncio.timeout(5):
            result, _ = await asyncio.gather(*tasks)
        assert result.status_code == 200 and result.json()["already_completed"] is True
        assert await f.evidence() == evidence
        assert (await f.status(async_client, 10)).json()["items"][0]["status"] == "old_revision"
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_query_count_and_digest_scope(async_client, progress_db, monkeypatch):
    f = progress_db
    calls = []
    execute = psycopg.AsyncCursor.execute

    async def record(cursor, query, *args, **kwargs):
        calls.append(" ".join(str(query).split()))
        return await execute(cursor, query, *args, **kwargs)

    monkeypatch.setattr(psycopg.AsyncCursor, "execute", record)

    def queries(*prefixes):
        return [call for call in calls if call.startswith(prefixes)]

    assert (await async_client.get(f.path)).status_code == 200
    assert len(queries("SELECT")) == 2  # session and Resume
    assert not queries("INSERT", "UPDATE", "WITH")
    assert all("c.content," not in call and "digest(" not in call for call in calls)
    calls.clear()

    assert (await async_client.get(f.path + "?include_summary=true")).status_code == 200
    assert len(queries("SELECT", "WITH")) == 3
    assert len([call for call in calls if "digest(" in call]) == 1
    calls.clear()

    assert (await f.status(async_client, 10, 30, 100)).status_code == 200
    assert len(queries("SELECT")) == 2
    assert len([call for call in calls if "digest(" in call]) == 1
    calls.clear()

    assert (await f.complete(async_client)).status_code == 200
    assert len(queries("SELECT", "INSERT")) == 3
    assert len([call for call in calls if "FOR SHARE OF c" in call]) == 1
    calls.clear()

    assert (await f.complete(async_client)).status_code == 200
    assert len(queries("SELECT", "INSERT")) == 4
    assert not any("reading_progress" in call for call in calls)


@pytest.mark.parametrize("value", ["", "Tiếng Việt", " a ", "a\r\nb", "a\nb", "é", "e\u0301"])
def test_content_digest_matches_exact_utf8(value):
    assert content_digest(value) == hashlib.sha256(value.encode("utf-8")).digest()


async def test_published_status_batch_hash_matches_postgresql_without_content(
    async_client, progress_db
):
    f = progress_db
    values = ("", "Tiếng Việt\r\n", " é ", " e\u0301 ")
    await f.db.execute(
        "UPDATE chapters SET content_status='Published' WHERE id=%s", (f.chapters[20],)
    )
    for seq, value in zip((10, 20, 30, 100), values, strict=True):
        await f.db.execute("UPDATE chapters SET content=%s WHERE id=%s", (value, f.chapters[seq]))
    response = await f.status(async_client, 100, 20, 10, 30)
    assert response.status_code == 200
    items = response.json()["items"]
    assert [i["chapter_sequence"] for i in items] == [100, 20, 10, 30]
    for item, value in zip(items, (values[3], values[1], values[0], values[2]), strict=True):
        assert set(item) == {"chapter_id", "chapter_sequence", "content_revision", "status"}
        assert item["content_revision"]["hash"] == content_digest(value).hex()
    assert await f.evidence() == [] and await f.resume_rows() == []
