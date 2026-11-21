"""SSR integration with isolated PostgreSQL fixtures and escaped text rendering."""

from html.parser import HTMLParser
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from test_novel_service import novels_data as novels_data

from app.core.config import settings
from app.db.pool import get_db_connection
from app.routers import web


class ReaderParser(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.paragraphs = []
        self.tags = []
        self.in_content = False
        self.in_paragraph = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        self.tags.append((tag, attributes))
        if tag == "section" and attributes.get("class") == "reader-content":
            self.in_content = True
        if self.in_content and tag == "p":
            self.in_paragraph = True
            self.paragraphs.append("")

    def handle_endtag(self, tag):
        if tag == "p":
            self.in_paragraph = False
        if tag == "section":
            self.in_content = False

    def handle_data(self, data):
        if self.in_paragraph:
            self.paragraphs[-1] += data


@pytest.mark.parametrize(
    "content,expected",
    [
        ("Đoạn một.\n\nĐoạn hai.\nDòng tiếp.", ["Đoạn một.", "Đoạn hai.\nDòng tiếp."]),
        ("Dòng một\r\n\r\nDòng hai\r\nTiếp", ["Dòng một", "Dòng hai\nTiếp"]),
        ("Đầu\r\rCuối", ["Đầu", "Cuối"]),
        ("", [""]),
        ("\n\nA\n\n\n\nB\n\n", ["", "A", "", "B", ""]),
        (
            "漢字 😀 & <script>alert('XSS')</script><img src=x onerror=alert(1)>",
            ["漢字 😀 & <script>alert('XSS')</script><img src=x onerror=alert(1)>"],
        ),
        ("Nội dung dài " * 3000, ["Nội dung dài " * 3000]),
    ],
)
async def test_reader_html_content_integrity_and_escaping(
    async_client, novels_data, content, expected
):
    slugs, ids, _ = novels_data
    async with get_db_connection() as conn:
        await conn.execute(
            "UPDATE chapters SET content=%s, title=%s, chapter_number=%s WHERE novel_id=%s AND chapter_sequence=1",
            (content, "Tên chương <img src=x onerror=alert(1)>", "Ngoại truyện & một", ids[0]),
        )
        await conn.execute(
            "UPDATE novels SET title=%s WHERE id=%s",
            ("Truyện tiếng Việt <script>alert(2)</script>", ids[0]),
        )
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert '<html lang="vi">' in response.text and '<meta name="viewport"' in response.text
    assert "Tên chương &lt;img" in response.text
    assert "Truyện tiếng Việt &lt;script&gt;" in response.text
    assert "Ngoại truyện &amp; một" in response.text
    parser = ReaderParser(response.text)
    assert parser.paragraphs == expected
    assert all(tag not in ("img", "iframe") for tag, _ in parser.tags)
    scripts = [attrs for tag, attrs in parser.tags if tag == "script"]
    assert scripts == [
        {"src": "http://test/static/js/reader_preferences.js"},
        {"src": "http://test/static/js/reader_offline.js", "defer": None},
        {"src": "http://test/static/js/reader_completion.js", "defer": None},
        {"src": "http://test/static/js/reader_guest_progress.js", "defer": None},
        {"src": "http://test/static/js/reader_toc.js", "defer": None},
        {"src": "http://test/static/js/reader_toolbar.js", "defer": None},
        {"src": "http://test/static/js/reader_theme.js", "defer": None},
        {"src": "http://test/static/js/reader_settings.js", "defer": None},
        {"src": "http://test/static/js/reader_bookmarks.js", "defer": None},
        {"src": "http://test/static/js/reader_resume.js", "defer": None},
    ]
    assert "set-cookie" not in response.headers
    assert "{%" not in response.text
    css = await async_client.get("/static/css/reader.css")
    assert css.status_code == 200
    assert "text/css" in css.headers["content-type"]
    assert "white-space: pre-wrap" in css.text
    assert any(attrs.get("href", "").endswith("/static/css/reader.css") for _, attrs in parser.tags)
    async with get_db_connection() as conn:
        stored = await (
            await conn.execute(
                "SELECT content FROM chapters WHERE novel_id=%s AND chapter_sequence=1", (ids[0],)
            )
        ).fetchone()
    assert stored[0] == content


@pytest.mark.parametrize("sequence", [4, 7, 6, 100])
async def test_reader_unpublished_missing_and_null_404(async_client, novels_data, sequence):
    slugs, ids, _ = novels_data
    async with get_db_connection() as conn:
        await conn.execute(
            "INSERT INTO chapters (novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,6,'6','Null','DO_NOT_EXPOSE',NULL)",
            (ids[0],),
        )
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 404
    assert "DO_NOT_EXPOSE" not in response.text


async def test_reader_missing_novel_404(async_client, novels_data):
    slugs, _, _ = novels_data
    assert (await async_client.get(f"/novel/{slugs[0]}-missing/1")).status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "/novel/book/0",
        "/novel/book/-1",
        "/novel/book/abc",
        "/novel/book/2147483648",
        "/novel/invalid%20slug/1",
    ],
)
async def test_reader_validation(async_client, path):
    assert (await async_client.get(path)).status_code == 422


async def test_reader_service_error_propagation_without_internal_http(async_client, monkeypatch):
    service = AsyncMock(side_effect=HTTPException(503, "Novel data is temporarily unavailable."))
    monkeypatch.setattr(web, "get_published_chapter", service)
    response = await async_client.get("/novel/book/1")
    assert response.status_code == 503
    assert response.json() == {"detail": "Novel data is temporarily unavailable."}
    service.assert_awaited_once_with("book", 1)


async def test_reader_ignores_auth_secrets_and_preserves_reading_state(
    async_client, novels_data, monkeypatch
):
    slugs, _, user_id = novels_data
    monkeypatch.setattr(settings, "SECRET_KEY", "private-server-setting")
    async_client.cookies.set(settings.SESSION_COOKIE_NAME, "private-client-session")

    async def snapshot():
        async with get_db_connection() as conn:
            progress = await (
                await conn.execute("SELECT * FROM reading_progress WHERE user_id=%s", (user_id,))
            ).fetchone()
            sessions = await (
                await conn.execute(
                    "SELECT COUNT(*) FROM user_sessions WHERE user_id=%s", (user_id,)
                )
            ).fetchone()
            bookmarks = await (
                await conn.execute("SELECT COUNT(*) FROM bookmarks WHERE user_id=%s", (user_id,))
            ).fetchone()
        return progress, sessions, bookmarks

    before = await snapshot()
    response = await async_client.get(f"/novel/{slugs[0]}/9")
    assert response.status_code == 200
    assert await snapshot() == before
    assert "set-cookie" not in response.headers
    assert all(
        value not in response.text
        for value in [
            "private-server-setting",
            "private-client-session",
            "password_hash",
            "refresh_token_hash",
        ]
    )
