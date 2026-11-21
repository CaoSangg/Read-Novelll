"""Canonical revision and the read-only Reader handoff to the Progress API."""

import hashlib

import psycopg
import pytest
from test_progress_api import CSRF
from test_progress_api import progress_db as progress_db
from test_reader_web import ReaderParser

from app.core.config import settings
from app.core.content_revision import HASH_SCHEME


def reader_metadata(response):
    assert response.status_code == 200
    parsed = ReaderParser(response.text)
    metadata = next(attrs for tag, attrs in parsed.tags if tag == "main")
    return parsed, metadata


@pytest.mark.parametrize("has_cookie", [False, True])
async def test_reader_revision_uses_canonical_content_and_no_extra_query(
    async_client, progress_db, monkeypatch, has_cookie
):
    f = progress_db
    if not has_cookie:
        async_client.cookies.clear()
    text = "  Tiếng Việt\r\n\r\n e\u0301 & <img src=x onerror=alert(1)>\n "
    await f.db.execute("UPDATE chapters SET content=%s WHERE id=%s", (text, f.chapters[10]))
    before = await f.resume_rows()
    queries = []
    execute = psycopg.AsyncCursor.execute

    async def record(cursor, query, *args, **kwargs):
        queries.append(str(query))
        return await execute(cursor, query, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(psycopg.AsyncCursor, "execute", record)
        response = await async_client.get(f"/novel/qa-{f.novels[0]}/10")
    parsed, metadata = reader_metadata(response)
    assert metadata["data-novel-id"] == str(f.novels[0])
    assert metadata["data-chapter-id"] == str(f.chapters[10])
    assert metadata["data-chapter-number"] and metadata["data-chapter-title"]
    assert metadata["data-hash-scheme"] == HASH_SCHEME
    assert metadata["data-content-hash"] == hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert parsed.paragraphs == ["  Tiếng Việt", " e\u0301 & <img src=x onerror=alert(1)>\n "]
    assert all(tag != "img" for tag, _ in parsed.tags)
    assert ("data-resume-candidate" in metadata) is has_cookie
    assert "reader_resume.js" in response.text
    assert "reader_completion.js" in response.text
    assert "reader_guest_progress.js" in response.text
    controls = [
        attrs
        for tag, attrs in parsed.tags
        if tag == "button" and "data-reader-completion-action" in attrs
    ]
    assert len(controls) == 1
    assert controls[0]["aria-disabled"] == "true"
    assert metadata["data-csrf-cookie"] == settings.CSRF_COOKIE_NAME
    assert metadata["data-csrf-header"] == settings.CSRF_HEADER_NAME
    assert all(token not in response.text for token in (*f.tokens, f.csrf))
    ids = {attrs["id"] for _, attrs in parsed.tags if "id" in attrs}
    guest_dialogs = [
        attrs
        for tag, attrs in parsed.tags
        if tag == "dialog" and attrs["id"].startswith("reader-guest-")
    ]
    assert {attrs["id"] for attrs in guest_dialogs} == {"reader-guest-clear"}
    assert "reader-bookmark-import" not in ids
    for dialog in guest_dialogs:
        assert "open" not in dialog
        assert {dialog["aria-labelledby"], dialog["aria-describedby"]} <= ids
    defaults = [attrs for tag, attrs in parsed.tags if tag == "button" and "autofocus" in attrs]
    assert any("data-reader-clear-cancel" in attrs for attrs in defaults)
    assert "set-cookie" not in response.headers
    substantive = [query for query in queries if not query.startswith("SET TRANSACTION")]
    assert len(substantive) == 2
    assert sum(query.lstrip().startswith("SELECT") for query in substantive) == 2
    assert await f.resume_rows() == before and await f.evidence() == []


async def test_ssr_revision_is_accepted_until_canonical_content_changes(async_client, progress_db):
    f = progress_db
    url = f"/novel/qa-{f.novels[0]}/10"
    _, view = reader_metadata(await async_client.get(url))

    def body(metadata):
        return {
            "chapter_id": metadata["data-chapter-id"],
            "scroll_position": 0.45,
            "content_revision": {
                "scheme": metadata["data-hash-scheme"],
                "hash": metadata["data-content-hash"],
            },
        }

    activate = await async_client.post(
        f.path + "/resume/activate",
        json=body(view),
        headers={CSRF: f.csrf, "If-None-Match": "*"},
    )
    assert activate.status_code == 201
    saved = await f.resume_rows()
    await f.db.execute(
        "UPDATE chapters SET content=replace(content, E'\\r\\n', E'\\n') WHERE id=%s",
        (f.chapters[10],),
    )
    replay = await async_client.post(
        f.path + "/resume/activate",
        json=body(view),
        headers={CSRF: f.csrf, "If-Match": activate.headers["ETag"]},
    )
    assert replay.status_code == 409
    assert replay.json()["detail"]["code"] == "content_revision_changed"
    assert await f.resume_rows() == saved and await f.evidence() == []
    current = await async_client.get(url)
    _, updated = reader_metadata(current)
    assert updated["data-content-hash"] != view["data-content-hash"]
    assert ReaderParser(current.text).paragraphs == ["  Tiếng Việt\nĐoạn kế.\n "]
    for sequence in (20, 40, 999):
        assert (await async_client.get(f"/novel/qa-{f.novels[0]}/{sequence}")).status_code == 404


async def test_guest_chapter_revision_is_published_novel_scoped_and_metadata_only(
    async_client, progress_db
):
    f = progress_db
    async_client.cookies.clear()
    base = f"/api/novels/qa-{f.novels[0]}/chapters/by-id"
    endpoint = f"{base}/{f.chapters[10]}/revision"
    response = await async_client.get(endpoint)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    _, ssr = reader_metadata(await async_client.get(f"/novel/qa-{f.novels[0]}/10"))
    chapter = response.json()
    assert chapter.keys() == {
        "id",
        "novel_id",
        "title",
        "chapter_sequence",
        "chapter_number",
        "content_revision",
    }
    assert chapter["novel_id"] == str(f.novels[0])
    assert chapter["chapter_sequence"] == 10
    assert chapter["content_revision"] == {"scheme": HASH_SCHEME, "hash": ssr["data-content-hash"]}
    assert (
        await async_client.get(endpoint.replace(str(f.novels[0]), str(f.novels[1])))
    ).status_code == 404
    assert (await async_client.get(f"{base}/invalid/revision")).status_code == 422
    await f.db.execute(
        "UPDATE chapters SET content_status='Archived' WHERE id=%s", (f.chapters[10],)
    )
    assert (await async_client.get(endpoint)).status_code == 404
    assert await f.evidence() == [] and await f.resume_rows() == []
