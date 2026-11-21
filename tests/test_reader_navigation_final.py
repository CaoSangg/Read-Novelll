"""Shared Footer/Toolbar TOC semantics and read-only navigation for guest/authenticated readers."""

import pytest
from test_chapter_service import chapter_data as chapter_data
from test_novel_service import novels_data as novels_data
from test_reader_web import ReaderParser

from app.core.config import settings
from app.core.security import generate_session_token, hash_session_token
from app.db.pool import get_db_connection
from app.services.auth_service import get_user_by_session_token


@pytest.mark.parametrize("sequence", [1, 5, 9])
async def test_footer_toolbar_share_one_dialog_and_have_unique_ids(
    async_client, chapter_data, sequence
):
    slugs, _, _ = chapter_data
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 200
    parser = ReaderParser(response.text)
    ids = [attrs["id"] for tag, attrs in parser.tags if "id" in attrs]
    assert len(ids) == len(set(ids))
    assert (
        sum(tag == "dialog" and attrs.get("id") == "reader-toc" for tag, attrs in parser.tags) == 1
    )
    triggers = [
        attrs for tag, attrs in parser.tags if tag == "button" and "data-reader-toc-open" in attrs
    ]
    assert [attrs["id"] for attrs in triggers] == ["reader-toc-open", "reader-toc-footer"]
    assert all(
        attrs["aria-controls"] == "reader-toc"
        and attrs["aria-expanded"] == "false"
        and attrs["type"] == "button"
        and "disabled" in attrs
        for attrs in triggers
    )
    footer = response.text.split('<nav class="reader-navigation"', 1)[1].split("</nav>", 1)[0]
    controls = [attrs["id"] for tag, attrs in ReaderParser(footer).tags if "id" in attrs]
    assert controls == ["reader-previous-chapter", "reader-toc-footer", "reader-next-chapter"]
    assert "onclick" not in footer
    previous = next(
        attrs for tag, attrs in parser.tags if attrs.get("id") == "reader-previous-chapter"
    )
    following = next(
        attrs for tag, attrs in parser.tags if attrs.get("id") == "reader-next-chapter"
    )
    if sequence == 1:
        assert (
            previous["aria-disabled"] == "true"
            and "href" not in previous
            and "tabindex" not in previous
        )
    else:
        assert previous["href"] == f"/novel/{slugs[0]}/{1 if sequence == 5 else 5}"
    if sequence == 9:
        assert (
            following["aria-disabled"] == "true"
            and "href" not in following
            and "tabindex" not in following
        )
    else:
        assert following["href"] == f"/novel/{slugs[0]}/{5 if sequence == 1 else 9}"


@pytest.mark.parametrize("authenticated", [False, True])
async def test_guest_and_authenticated_navigation_never_updates_reading_state(
    async_client, chapter_data, authenticated
):
    slugs, _, user_id = chapter_data
    if authenticated:
        token = generate_session_token()
        async with get_db_connection() as conn:
            await conn.execute(
                "INSERT INTO user_sessions(user_id,refresh_token_hash,expires_at) VALUES (%s,%s,CURRENT_TIMESTAMP + INTERVAL '1 day')",
                (user_id, hash_session_token(token)),
            )
        assert str((await get_user_by_session_token(token))["id"]) == str(user_id)
        async_client.cookies.set(settings.SESSION_COOKIE_NAME, token)

    async def snapshot():
        async with get_db_connection() as conn:
            progress = await (
                await conn.execute(
                    "SELECT last_read_chapter_id,max_read_sequence,scroll_position,updated_at FROM reading_progress WHERE user_id=%s",
                    (user_id,),
                )
            ).fetchall()
            bookmarks = await (
                await conn.execute("SELECT COUNT(*) FROM bookmarks WHERE user_id=%s", (user_id,))
            ).fetchone()
            sessions = await (
                await conn.execute(
                    "SELECT COUNT(*) FROM user_sessions WHERE user_id=%s", (user_id,)
                )
            ).fetchone()
        return progress, bookmarks, sessions

    before = await snapshot()
    for sequence in [1, 5, 9, 1, 9, 5, 5]:
        response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
        assert response.status_code == 200 and "set-cookie" not in response.headers
        assert (
            await async_client.get(f"/api/novels/{slugs[0]}/chapters?page=1&page_size=50")
        ).status_code == 200
    assert await snapshot() == before


@pytest.mark.parametrize("sequence", [4, 6, 7])
async def test_unpublished_reader_never_renders_footer_trigger(
    async_client, chapter_data, sequence
):
    slugs, _, _ = chapter_data
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 404 and "reader-toc-footer" not in response.text
