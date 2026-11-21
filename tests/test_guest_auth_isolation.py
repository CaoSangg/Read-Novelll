"""Login and Reader HTML preserve the account's data on a verifier-owned database."""

from secrets import token_urlsafe

from test_bookmark_api import bookmark_db as bookmark_db
from test_bookmark_api import bookmark_rows, novel_path
from test_progress_api import CSRF
from test_progress_api import progress_db as progress_db

from app.core.security import hash_password


async def test_retired_bookmark_import_routes_cannot_mutate_either_account(
    async_client, bookmark_db
):
    f = bookmark_db
    payload = {"items": [{"novel_id": str(f.novels[0]), "chapter_id": str(f.chapters[10])}]}
    f.login(async_client)
    for path in ("/api/bookmarks/import/preview", "/api/bookmarks/import"):
        assert (
            await async_client.post(path, json=payload, headers={CSRF: f.csrf, "If-Match": '"old"'})
        ).status_code == 404
    assert await bookmark_rows(f) == []
    assert await f.resume_rows() == []
    assert await f.evidence() == []


async def test_real_login_and_reader_return_preserve_existing_and_empty_accounts(
    async_client, bookmark_db
):
    f = bookmark_db
    assert (await f.activate(async_client, 10)).status_code == 201
    assert (await f.complete(async_client, 10)).status_code == 200
    for sequence, removed in ((10, False), (30, True)):
        await f.db.execute(
            """INSERT INTO bookmarks(user_id,novel_id,chapter_id,note,created_at,removed_at)
               VALUES (%s,%s,%s,'Legacy note','2020-01-01',
                       CASE WHEN %s THEN CURRENT_TIMESTAMP END)""",
            (f.user_ids[0], f.novels[0], f.chapters[sequence], removed),
        )

    async def snapshot():
        return (
            await (
                await f.db.execute(
                    "SELECT p::text FROM reading_progress p WHERE novel_id=%s ORDER BY user_id",
                    (f.novels[0],),
                )
            ).fetchall(),
            await f.evidence(),
            await bookmark_rows(f),
        )

    original = await snapshot()
    password = token_urlsafe(24)
    await f.db.execute(
        "UPDATE users SET password_hash=%s WHERE id=ANY(%s)", (hash_password(password), f.user_ids)
    )
    for index, owner in enumerate(f.user_ids):
        async_client.cookies.clear()
        csrf = (await async_client.get("/api/auth/csrf-token")).json()["csrf_token"]
        login = await async_client.post(
            "/api/auth/login",
            json={"username_or_email": str(owner), "password": password},
            headers={CSRF: csrf},
        )
        assert login.status_code == 200 and login.json()["user"]["id"] == str(owner)
        view = await async_client.get(f"/novel/qa-{f.novels[0]}/30?reader_entry=auth")
        assert view.status_code == 200
        assert "reader-guest-merge" not in view.text and "reader-bookmark-import" not in view.text
        resume = (await async_client.get(f.path)).json()["resume"]
        bookmarks = (await async_client.get(novel_path(f))).json()["items"]
        if index == 0:
            assert resume["chapter_id"] == str(f.chapters[10])
            assert [item["chapter_id"] for item in bookmarks] == [str(f.chapters[10])]
        else:
            assert resume is None and bookmarks == []
        assert await snapshot() == original
