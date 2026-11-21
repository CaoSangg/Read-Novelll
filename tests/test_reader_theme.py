"""Reader-scoped theme SSR contracts without server-side reading-state mutations."""

import pytest
from test_novel_service import novels_data as novels_data
from test_reader_web import ReaderParser

from app.db.pool import get_db_connection


async def test_reader_ssr_sepia_and_single_accessible_selector(async_client, novels_data):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    parser = ReaderParser(response.text)
    assert (
        len([attrs for tag, attrs in parser.tags if attrs.get("data-reader-theme") == "sepia"]) == 1
    )
    assert (
        len([attrs for tag, attrs in parser.tags if attrs.get("id") == "reader-theme-selector"])
        == 1
    )
    trigger = next(attrs for tag, attrs in parser.tags if attrs.get("id") == "reader-theme-trigger")
    assert trigger["aria-expanded"] == "false" and trigger["aria-controls"] == "reader-theme-panel"
    choices = [attrs for tag, attrs in parser.tags if attrs.get("name") == "reader-theme"]
    assert [item["value"] for item in choices] == ["sepia", "light", "dark"]
    assert [item["value"] for item in choices if "checked" in item] == ["sepia"]
    assert all(item["type"] == "radio" for item in choices)
    assert (
        sum(tag == "dialog" and attrs.get("id") == "reader-toc" for tag, attrs in parser.tags) == 1
    )
    scripts = [attrs["src"] for tag, attrs in parser.tags if tag == "script"]
    assert scripts == [
        "http://test/static/js/reader_preferences.js",
        "http://test/static/js/reader_offline.js",
        "http://test/static/js/reader_completion.js",
        "http://test/static/js/reader_guest_progress.js",
        "http://test/static/js/reader_toc.js",
        "http://test/static/js/reader_toolbar.js",
        "http://test/static/js/reader_theme.js",
        "http://test/static/js/reader_settings.js",
        "http://test/static/js/reader_bookmarks.js",
        "http://test/static/js/reader_resume.js",
    ]
    assert "set-cookie" not in response.headers


async def test_theme_assets_and_scope(async_client):
    css = await async_client.get("/static/css/reader.css")
    script = await async_client.get("/static/js/reader_theme.js")
    assert css.status_code == script.status_code == 200
    assert "javascript" in script.headers["content-type"]
    for path in ["/", "/login", "/register"]:
        html = (await async_client.get(path)).text
        assert "data-reader-theme" not in html
        assert "reader_theme.js" not in html


@pytest.mark.parametrize("sequence", [4, 7])
async def test_themes_do_not_expose_unpublished_chapters(async_client, novels_data, sequence):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 404
    assert "reader-theme-selector" not in response.text


async def test_theme_page_keeps_state_and_content_unchanged(async_client, novels_data):
    slugs, ids, user_id = novels_data
    payload = "<script>window.themeXss=true</script>\n\nTiếng Việt & Unicode 漢字"
    async with get_db_connection() as conn:
        await conn.execute(
            "UPDATE chapters SET content=%s WHERE novel_id=%s AND chapter_sequence=1",
            (payload, ids[0]),
        )

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
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    assert ReaderParser(response.text).paragraphs == payload.split("\n\n")
    assert "<script>window.themeXss" not in response.text
    assert "&lt;script&gt;window.themeXss" in response.text
    assert "set-cookie" not in response.headers
    assert await snapshot() == before
