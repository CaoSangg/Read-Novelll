"""Bookmark integration on the verifier-owned PostgreSQL database."""

from uuid import uuid4

import pytest
from test_progress_api import CSRF, assert_code, queued_requests
from test_progress_api import progress_db as progress_db

from app.core.config import settings
from app.db.pool import close_db_pool


def novel_path(f, index=0):
    return f"/api/bookmarks/novels/{f.novels[index]}"


def chapter_path(f, sequence=10, index=0):
    return f"{novel_path(f, index)}/chapters/{f.chapters[sequence]}"


def mutate(client, f, method="PUT", sequence=10):
    return client.request(method, chapter_path(f, sequence), headers={CSRF: f.csrf})


async def bookmark_rows(f):
    return await (
        await f.db.execute(
            """SELECT id,user_id,novel_id,chapter_id,note,created_at,removed_at
               FROM bookmarks WHERE user_id=ANY(%s) ORDER BY user_id,chapter_id""",
            (f.user_ids,),
        )
    ).fetchall()


@pytest.fixture
async def bookmark_db(progress_db):
    assert await (
        await progress_db.db.execute(
            """SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='bookmarks' AND column_name='removed_at'"""
        )
    ).fetchone() == (1,), "Run the verifier with migration 004"
    return progress_db


async def test_bookmark_lifecycle_is_idempotent(async_client, bookmark_db):
    f = bookmark_db
    status = {"chapter_id": str(f.chapters[10]), "available": True, "bookmarked": False}
    assert (await async_client.get(chapter_path(f))).json() == status
    assert (await async_client.get(novel_path(f))).json()["total"] == 0
    for attempt in range(2):
        response = await mutate(async_client, f)
        assert response.status_code == 204 and not response.content
        assert response.headers["Cache-Control"] == "no-store"
        if attempt == 0:
            saved = await bookmark_rows(f)
        else:
            assert await bookmark_rows(f) == saved
    assert len(saved) == 1 and saved[0][4] is None
    assert (await async_client.get(chapter_path(f))).json() == {**status, "bookmarked": True}
    items = (await async_client.get(novel_path(f))).json()["items"]
    assert len(items) == 1
    assert items[0] == {
        "chapter_id": str(f.chapters[10]),
        "created_at": items[0]["created_at"],
        "available": True,
        "chapter_sequence": 10,
        "chapter_number": "10",
        "title": "QA chapter",
        "url": f"/novel/qa-{f.novels[0]}/10",
    }
    assert items[0]["created_at"] is not None
    assert (await mutate(async_client, f, "DELETE")).status_code == 204
    removed = await bookmark_rows(f)
    assert removed[0][:-1] == saved[0][:-1] and removed[0][-1] is not None
    assert (await mutate(async_client, f, "DELETE")).status_code == 204
    assert await bookmark_rows(f) == removed
    assert (await async_client.get(chapter_path(f))).json() == status
    assert (await async_client.get(novel_path(f))).json()["items"] == []


async def test_bookmark_pagination_order_nulls_and_novel_scope(async_client, bookmark_db):
    f = bookmark_db
    inserted = {}
    for sequence, created in (
        (10, None),
        (30, "2020-01-01T00:00:00Z"),
        (100, "2020-01-01T00:00:00Z"),
        (60, "2021-01-01T00:00:00Z"),
    ):
        novel_index = 1 if sequence == 60 else 0
        row = await (
            await f.db.execute(
                """INSERT INTO bookmarks(user_id,novel_id,chapter_id,created_at)
                   VALUES (%s,%s,%s,%s) RETURNING id""",
                (f.user_ids[0], f.novels[novel_index], f.chapters[sequence], created),
            )
        ).fetchone()
        inserted[sequence] = row[0]
    actual = []
    for page in range(1, 5):
        response = await async_client.get(novel_path(f), params={"page": page, "page_size": 1})
        assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
        data = response.json()
        assert data["novel_id"] == str(f.novels[0])
        assert (data["page"], data["page_size"], data["total"], data["total_pages"]) == (
            page,
            1,
            3,
            3,
        )
        actual.extend((item["chapter_sequence"], item["created_at"]) for item in data["items"])
    assert [seq for seq, _ in actual] == sorted((30, 100), key=inserted.get, reverse=True) + [10]
    assert actual[-1][1] is None
    assert (await async_client.get(novel_path(f, 1))).json()["total"] == 1
    assert_code(
        await async_client.get(novel_path(f), params={"page_size": 101}), 422, "invalid_request"
    )
    assert_code(await async_client.get(f"/api/bookmarks/novels/{uuid4()}"), 404, "novel_not_found")


async def test_account_switch_read_write_delete_are_owner_scoped(async_client, bookmark_db):
    f = bookmark_db
    assert (await mutate(async_client, f)).status_code == 204
    a = await bookmark_rows(f)
    f.login(async_client, 1)
    assert not (await async_client.get(chapter_path(f))).json()["bookmarked"]
    assert (await async_client.get(novel_path(f))).json()["items"] == []
    assert (await mutate(async_client, f, "DELETE")).status_code == 204
    assert await bookmark_rows(f) == a
    assert (await mutate(async_client, f)).status_code == 204
    assert {row[1] for row in await bookmark_rows(f)} == set(f.user_ids)
    f.login(async_client)
    assert (await async_client.get(chapter_path(f))).json()["bookmarked"]
    assert (await async_client.get(novel_path(f))).json()["total"] == 1


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
async def test_both_mutations_require_csrf_and_reject_foreign_origin(
    async_client, bookmark_db, method
):
    f = bookmark_db
    path = chapter_path(f)
    for headers in (
        {},
        {CSRF: "invalid"},
        {CSRF: f.csrf, "Origin": "https://foreign.example"},
    ):
        response = await async_client.request(method, path, headers=headers)
        assert response.status_code == 403 and response.headers["Cache-Control"] == "no-store"
    assert await bookmark_rows(f) == []


async def test_client_owner_and_note_input_are_rejected_without_echo(async_client, bookmark_db):
    f = bookmark_db
    path = chapter_path(f)
    owner = str(f.user_ids[1])
    for response in (
        await async_client.get(novel_path(f), params={"user_id": owner}),
        await async_client.get(path, params={"user_id": owner}),
        await async_client.put(
            path, json={"user_id": owner, "note": "request note"}, headers={CSRF: f.csrf}
        ),
        await async_client.delete(path, params={"user_id": owner}, headers={CSRF: f.csrf}),
        await async_client.request("DELETE", path, json={"user_id": owner}, headers={CSRF: f.csrf}),
    ):
        assert_code(response, 422, "invalid_request")
    assert await bookmark_rows(f) == []


@pytest.mark.parametrize("session", ["missing", "expired", "disabled"])
async def test_bookmarks_require_active_session(async_client, bookmark_db, session):
    f = bookmark_db
    if session == "missing":
        async_client.cookies.delete(settings.SESSION_COOKIE_NAME)
    elif session == "expired":
        await f.db.execute(
            "UPDATE user_sessions SET expires_at=now()-interval '1 second' WHERE user_id=%s",
            (f.user_ids[0],),
        )
    else:
        await f.db.execute("UPDATE users SET is_active=false WHERE id=%s", (f.user_ids[0],))
    for response in (
        await async_client.get(novel_path(f)),
        await async_client.get(chapter_path(f)),
        await mutate(async_client, f),
        await mutate(async_client, f, "DELETE"),
    ):
        assert response.status_code == 401 and response.headers["Cache-Control"] == "no-store"
    assert await bookmark_rows(f) == []


@pytest.mark.parametrize("sequence", [20, 40, 50, 60, 999])
async def test_missing_wrong_novel_and_unpublished_unowned_chapters_are_404(
    async_client, bookmark_db, sequence
):
    f = bookmark_db
    path = f"{novel_path(f)}/chapters/{f.chapters.get(sequence) or uuid4()}"
    assert_code(await async_client.get(path), 404, "chapter_not_found")
    for method in ("PUT", "DELETE"):
        response = await async_client.request(method, path, headers={CSRF: f.csrf})
        assert_code(response, 404, "chapter_not_found")
    assert await bookmark_rows(f) == []


async def test_archived_bookmark_is_retained_and_redacted_until_explicit_removal(
    async_client, bookmark_db
):
    f = bookmark_db
    assert (await mutate(async_client, f)).status_code == 204
    saved = await bookmark_rows(f)
    await f.db.execute(
        "UPDATE chapters SET content_status='Archived' WHERE id=%s", (f.chapters[10],)
    )
    status = (await async_client.get(chapter_path(f))).json()
    assert status == {"chapter_id": str(f.chapters[10]), "available": False, "bookmarked": True}
    item = (await async_client.get(novel_path(f))).json()["items"][0]
    assert item == {
        "chapter_id": status["chapter_id"],
        "created_at": item["created_at"],
        "available": False,
        "chapter_sequence": None,
        "chapter_number": None,
        "title": None,
        "url": None,
    }
    assert_code(await mutate(async_client, f), 404, "chapter_not_found")
    assert await bookmark_rows(f) == saved
    f.login(async_client, 1)
    assert_code(await async_client.get(chapter_path(f)), 404, "chapter_not_found")
    assert_code(await mutate(async_client, f, "DELETE"), 404, "chapter_not_found")
    f.login(async_client)
    for _ in range(2):
        assert (await mutate(async_client, f, "DELETE")).status_code == 204
    assert (await async_client.get(novel_path(f))).json()["items"] == []
    assert_code(await async_client.get(chapter_path(f)), 404, "chapter_not_found")


async def test_legacy_note_identity_and_nullable_timestamp_survive_remove_and_readd(
    async_client, bookmark_db
):
    f = bookmark_db
    await f.db.execute(
        """INSERT INTO bookmarks(user_id,novel_id,chapter_id,note,created_at)
           VALUES (%s,%s,%s,'Ghi chú legacy',NULL)""",
        (f.user_ids[0], f.novels[0], f.chapters[10]),
    )
    legacy = await bookmark_rows(f)
    assert (await mutate(async_client, f)).status_code == 204
    assert await bookmark_rows(f) == legacy
    assert (await mutate(async_client, f, "DELETE")).status_code == 204
    assert (await bookmark_rows(f))[0][:-1] == legacy[0][:-1]
    assert (await mutate(async_client, f)).status_code == 204
    assert await bookmark_rows(f) == legacy
    assert "note" not in (await async_client.get(novel_path(f))).json()["items"][0]


async def test_inconsistent_legacy_novel_relation_is_neither_exposed_nor_rewritten(
    async_client, bookmark_db
):
    f = bookmark_db
    await f.db.execute(
        """INSERT INTO bookmarks(user_id,novel_id,chapter_id,note)
           VALUES (%s,%s,%s,'Legacy mismatched relation')""",
        (f.user_ids[0], f.novels[1], f.chapters[10]),
    )
    legacy = await bookmark_rows(f)
    for novel in (0, 1):
        assert (await async_client.get(novel_path(f, novel))).json()["items"] == []
    assert_code(await mutate(async_client, f), 409, "bookmark_relation_conflict")
    assert (await mutate(async_client, f, "DELETE")).status_code == 204
    assert await bookmark_rows(f) == legacy


async def test_concurrent_puts_create_only_one_row(async_client, bookmark_db):
    f = bookmark_db
    responses = await queued_requests(f, [10], [mutate(async_client, f) for _ in range(2)])
    assert [response.status_code for response in responses] == [204, 204]
    assert len(await bookmark_rows(f)) == 1


@pytest.mark.parametrize("first", ["PUT", "DELETE"])
async def test_concurrent_put_delete_keep_one_legacy_row(async_client, bookmark_db, first):
    f = bookmark_db
    await f.db.execute(
        "INSERT INTO bookmarks(user_id,novel_id,chapter_id,note) VALUES (%s,%s,%s,'Keep')",
        (f.user_ids[0], f.novels[0], f.chapters[10]),
    )
    original = (await bookmark_rows(f))[0]
    second = "PUT" if first == "DELETE" else "DELETE"
    responses = await queued_requests(
        f,
        [10],
        [mutate(async_client, f, first), mutate(async_client, f, second)],
        edit="SELECT id FROM bookmarks WHERE chapter_id=%s FOR UPDATE",
    )
    assert [response.status_code for response in responses] == [204, 204]
    rows = await bookmark_rows(f)
    assert len(rows) == 1 and rows[0][:-1] == original[:-1]
    status = (await async_client.get(chapter_path(f))).json()
    assert status["bookmarked"] == (rows[0][-1] is None)


async def test_publish_validation_waits_for_concurrent_archive(async_client, bookmark_db):
    f = bookmark_db
    (response,) = await queued_requests(
        f,
        [10],
        [mutate(async_client, f)],
        edit="UPDATE chapters SET content_status='Archived' WHERE id=%s",
    )
    assert_code(response, 404, "chapter_not_found")
    assert await bookmark_rows(f) == []


async def test_bookmark_leaves_resume_legacy_max_completion_and_ai_state_alone(
    async_client, bookmark_db
):
    f = bookmark_db
    assert (await f.activate(async_client, scroll=0.45)).status_code == 201
    assert (await f.complete(async_client)).status_code == 200
    await f.db.execute(
        "UPDATE reading_progress SET max_read_sequence=777 WHERE user_id=%s", (f.user_ids[0],)
    )
    resume, evidence = await f.resume_rows(), await f.evidence()
    progress = (await async_client.get(f.path, params={"include_summary": "true"})).json()
    for method in ("PUT", "DELETE"):
        assert (await mutate(async_client, f, method, 100)).status_code == 204
        assert await f.resume_rows() == resume
        assert await f.evidence() == evidence
        assert (await f.status(async_client, 100)).json()["items"][0]["status"] == "not_completed"
        assert (
            await async_client.get(f.path, params={"include_summary": "true"})
        ).json() == progress
        assert await (
            await f.db.execute(
                """SELECT (SELECT count(*) FROM chapter_ai_status WHERE chapter_id=%s),
                          (SELECT count(*) FROM ai_jobs WHERE chapter_id=%s),
                          (SELECT count(*) FROM novel_chunks WHERE chapter_id=%s)""",
                (f.chapters[100],) * 3,
            )
        ).fetchone() == (0, 0, 0)


async def test_database_unavailable_has_private_sanitized_503(async_client, bookmark_db):
    f = bookmark_db
    await close_db_pool()
    for response in (
        await async_client.get(novel_path(f)),
        await mutate(async_client, f),
        await mutate(async_client, f, "DELETE"),
    ):
        assert_code(response, 503, "bookmarks_unavailable")
