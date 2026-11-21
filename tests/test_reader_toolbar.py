"""Toolbar SSR contracts and publication/state regression using local UUID fixtures."""

import pytest
from markupsafe import escape
from test_novel_service import novels_data as novels_data
from test_reader_web import ReaderParser

from app.db.pool import get_db_connection


@pytest.mark.parametrize(
    "title",
    ["Khấu Vấn Tiên Đạo", 'Tên truyện <script>alert("XSS")</script>', "Tên truyện rất dài " * 30],
)
async def test_toolbar_semantics_single_toc_and_safe_title(async_client, novels_data, title):
    slugs, ids, _ = novels_data
    chapter_title = 'Huyền Môn Bí Ký <img src=x onerror="alert(1)">'
    async with get_db_connection() as conn:
        # VARCHAR(255), so long-title fixture remains within the actual schema.
        title = title[:250]
        await conn.execute("UPDATE novels SET title=%s WHERE id=%s", (title, ids[0]))
        await conn.execute(
            "UPDATE chapters SET chapter_number=%s,title=%s WHERE novel_id=%s AND chapter_sequence=1",
            ("Chương 2", chapter_title, ids[0]),
        )
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    parser = ReaderParser(response.text)
    toolbar = [attrs for tag, attrs in parser.tags if attrs.get("id") == "reader-toolbar"]
    assert len(toolbar) == 1
    assert toolbar[0]["aria-label"] == "Thanh công cụ đọc truyện"
    triggers = [attrs for tag, attrs in parser.tags if attrs.get("id") == "reader-toc-open"]
    assert len(triggers) == 1 and triggers[0]["aria-controls"] == "reader-toc"
    assert triggers[0]["aria-expanded"] == "false"
    assert (
        sum(tag == "dialog" and attrs.get("id") == "reader-toc" for tag, attrs in parser.tags) == 1
    )
    assert not any(tag in ["img", "iframe"] for tag, attrs in parser.tags)
    assert [
        attrs.get("title")
        for tag, attrs in parser.tags
        if attrs.get("class") == "reader-toolbar-title"
    ] == ["S-ReadNovel"]
    assert (
        '<span class="reader-toolbar-title" title="S-ReadNovel">S-ReadNovel</span>' in response.text
    )
    assert f'<p class="reader-novel-title">{escape(title)}</p>' in response.text
    assert '<p class="reader-chapter-number">Chương 2</p>' in response.text
    assert f'<h1 id="reader-chapter-title">{escape(chapter_title)}</h1>' in response.text
    metadata = next(attrs for _, attrs in parser.tags if "data-content-hash" in attrs)
    assert metadata["data-chapter-title"] == chapter_title
    toolbar_markup = response.text.split('<header id="reader-toolbar"', 1)[1].split("</header>", 1)[
        0
    ]
    toolbar_parser = ReaderParser(toolbar_markup)
    assert [
        (attrs.get("href"), attrs.get("aria-label"))
        for tag, attrs in toolbar_parser.tags
        if tag == "a"
    ] == [
        ("/", "Trở về Thư Phòng"),
        (f"/login?reader_return=%2Fnovel%2F{slugs[0]}%2F1", None),
        (f"/register?reader_return=%2Fnovel%2F{slugs[0]}%2F1", None),
    ]
    assert [attrs.get("id") for tag, attrs in toolbar_parser.tags if tag == "button"] == [
        "reader-toc-open",
        "reader-bookmark-toggle",
        "reader-bookmarks-open",
        "reader-logout",
        "reader-font-size-decrease",
        "reader-font-size-increase",
        None,
    ]
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
    assert all("onclick" not in attrs for _, attrs in parser.tags)
    assert (
        sum(tag == "dialog" and attrs.get("id") == "reader-bookmarks" for tag, attrs in parser.tags)
        == 1
    )
    close = next(attrs for _, attrs in parser.tags if "data-bookmarks-close" in attrs)
    assert close["aria-label"] == "Đóng dấu trang"
    account = next(attrs for _, attrs in toolbar_parser.tags if "data-reader-account" in attrs)
    assert "hidden" in account
    trigger = next(
        attrs for _, attrs in toolbar_parser.tags if attrs.get("id") == "reader-account-trigger"
    )
    assert trigger["aria-label"] == "Tài khoản"
    assert trigger["aria-controls"] == "reader-account-panel"
    assert any("data-reader-logout" in attrs for _, attrs in toolbar_parser.tags)
    settings = toolbar_markup.split('<details class="reader-theme-selector"', 1)[1]
    assert "data-reader-logout" not in settings
    assert settings.count("data-reader-guest-clear") == 1
    assert response.text.count("data-reader-guest-clear") == 1
    chapter_header = response.text.split('<header class="reader-chapter-header">', 1)[1].split(
        "</header>", 1
    )[0]
    assert "/login?" not in chapter_header and "/register?" not in chapter_header
    assert all("data-bookmark-import-manual" not in attrs for _, attrs in toolbar_parser.tags)
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("sequence", [4, 7])
async def test_toolbar_never_renders_unpublished_chapter(async_client, novels_data, sequence):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 404
    assert 'id="reader-toolbar"' not in response.text


async def test_toolbar_asset_is_served_and_reading_state_unchanged(async_client, novels_data):
    slugs, _, user_id = novels_data

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
    script = await async_client.get("/static/js/reader_toolbar.js")
    assert script.status_code == 200
    assert "javascript" in script.headers["content-type"]
    assert (await async_client.get("/api/auth/me")).status_code == 401
    assert (await async_client.get(f"/api/novels/{slugs[0]}/chapters/9")).status_code == 200
