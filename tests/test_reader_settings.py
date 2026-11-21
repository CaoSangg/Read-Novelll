"""Source-backed SSR settings contracts and unchanged publication/content/reading state."""

import pytest
from test_novel_service import novels_data as novels_data
from test_reader_web import ReaderParser

from app.db.pool import get_db_connection


async def test_settings_ssr_options_defaults_and_native_labels(async_client, novels_data):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    parser = ReaderParser(response.text)
    ids = [attrs["id"] for _, attrs in parser.tags if "id" in attrs]
    assert len(ids) == len(set(ids))
    assert ids.count("reader-theme-selector") == ids.count("reader-theme-panel") == 1
    assert {attrs["id"] for tag, attrs in parser.tags if tag == "details"} == {
        "reader-theme-selector",
        "reader-account-menu",
    }
    assert (
        sum(tag == "dialog" and attrs.get("id") == "reader-toc" for tag, attrs in parser.tags) == 1
    )
    trigger = next(attrs for _, attrs in parser.tags if attrs.get("id") == "reader-theme-trigger")
    assert trigger["aria-label"] == "Cài đặt đọc"
    assert trigger["aria-controls"] == "reader-theme-panel"
    assert trigger["aria-expanded"] == "false"
    summary = response.text.split('id="reader-theme-trigger"', 1)[1].split("</summary>", 1)[0]
    assert 'viewBox="0 0 24 24"' in summary
    assert 'stroke-width="2"' in summary and '<circle cx="12" cy="12" r="3"/>' in summary
    expected = {
        "reader-theme": (["sepia", "light", "dark"], "sepia"),
        "reader-font-family": (["Lora", "Merriweather", "Roboto"], "Lora"),
        "reader-line-height": (["1.65", "1.85", "2.1"], "1.85"),
        "reader-reading-width": (["normal", "wide"], "normal"),
    }
    for name, (values, default) in expected.items():
        choices = [attrs for tag, attrs in parser.tags if attrs.get("name") == name]
        assert [choice["value"] for choice in choices] == values
        assert [choice["value"] for choice in choices if "checked" in choice] == [default]
        assert all(choice["type"] == "radio" for choice in choices)
    assert len([tag for tag, attrs in parser.tags if tag == "label" and "for" not in attrs]) == 11
    assert [attrs["for"] for tag, attrs in parser.tags if tag == "label" and "for" in attrs] == [
        "reader-toc-page-input"
    ]
    steps = [attrs for _, attrs in parser.tags if "data-reader-size-step" in attrs]
    assert [attrs["data-reader-size-step"] for attrs in steps] == ["-1", "1"]
    assert all(attrs["type"] == "button" and attrs["aria-label"] for attrs in steps)
    assert 'aria-live="polite">19px</output>' in response.text
    assert 'aria-live="polite">1.85</output>' in response.text
    scripts = [attrs for tag, attrs in parser.tags if tag == "script"]
    assert scripts.count({"src": "http://test/static/js/reader_settings.js", "defer": None}) == 1
    assert all("onclick" not in attrs for _, attrs in parser.tags)
    assert "set-cookie" not in response.headers


async def test_settings_static_assets_and_non_reader_scope(async_client):
    for asset, content_type in [
        ("css/reader.css", "text/css"),
        ("js/reader_settings.js", "javascript"),
    ]:
        response = await async_client.get(f"/static/{asset}")
        assert response.status_code == 200
        assert content_type in response.headers["content-type"]
    for path in ["/", "/login", "/register"]:
        response = await async_client.get(path)
        assert response.status_code == 200
        assert "reader_settings.js" not in response.text
        assert "reader-typography-controls" not in response.text


async def test_compact_settings_preserve_native_names_and_full_font_labels(
    async_client, novels_data
):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    parser = ReaderParser(response.text)
    themes = [attrs for tag, attrs in parser.tags if attrs.get("name") == "reader-theme"]
    assert [(attrs["value"], attrs["aria-label"]) for attrs in themes] == [
        ("sepia", "Ấm (Sepia)"),
        ("light", "Sáng (Light)"),
        ("dark", "Tối (Dark)"),
    ]
    assert all(attrs["type"] == "radio" for attrs in themes)
    assert '<span class="reader-option-text">Merriweather</span>' in response.text
    assert '<span class="reader-option-text">Ấm</span>' in response.text
    assert (
        len([attrs for tag, attrs in parser.tags if attrs.get("class") == "reader-option-text"])
        == 11
    )
    assert 'aria-live="polite">19px</output>' in response.text
    assert 'aria-live="polite">1.85</output>' in response.text


@pytest.mark.parametrize("sequence", [4, 7])
async def test_settings_preserve_unpublished_404(async_client, novels_data, sequence):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 404
    assert "reader-typography-controls" not in response.text


async def test_settings_preserve_escaped_content_and_reading_state(async_client, novels_data):
    slugs, ids, user_id = novels_data

    async def snapshot():
        async with get_db_connection() as conn:
            content = await (
                await conn.execute(
                    "SELECT content FROM chapters WHERE novel_id=%s AND chapter_sequence=1",
                    (ids[0],),
                )
            ).fetchone()
            progress = await (
                await conn.execute("SELECT * FROM reading_progress WHERE user_id=%s", (user_id,))
            ).fetchall()
            sessions = await (
                await conn.execute("SELECT * FROM user_sessions WHERE user_id=%s", (user_id,))
            ).fetchall()
            bookmarks = await (
                await conn.execute("SELECT * FROM bookmarks WHERE user_id=%s", (user_id,))
            ).fetchall()
        return content, progress, sessions, bookmarks

    before = await snapshot()
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    assert ReaderParser(response.text).paragraphs == before[0][0].split("\n\n")
    assert all("src" in attrs for tag, attrs in ReaderParser(response.text).tags if tag == "script")
    assert "set-cookie" not in response.headers
    assert await snapshot() == before
