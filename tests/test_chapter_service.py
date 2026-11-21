"""Published chapter integration tests using isolated local readnovel_test fixtures."""

import pytest
from fastapi import HTTPException
from test_novel_service import novels_data as novels_data

from app.db.pool import get_db_connection
from app.services.novel_service import get_published_chapter


@pytest.fixture
async def chapter_data(novels_data):
    slugs, ids, user_id = novels_data
    async with get_db_connection() as conn:
        await conn.execute(
            "INSERT INTO chapters (novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,5,'Ngoại truyện','Middle','MIDDLE_CONTENT','Published'), (%s,6,'6','Null status','NULL_SECRET',NULL), (%s,5,'5','Other novel','OTHER_NOVEL_SECRET','Published')",
            (ids[0], ids[0], ids[1]),
        )
        await conn.execute(
            "INSERT INTO chapter_versions (chapter_id,version,content_hash,content,is_active) SELECT id,2,%s,'ACTIVE_VERSION_SECRET',TRUE FROM chapters WHERE novel_id=%s AND chapter_sequence=1",
            ("b" * 64, ids[0]),
        )
        await conn.execute(
            "INSERT INTO chapter_versions (chapter_id,version,content_hash,content,is_active) SELECT id,3,%s,'LATEST_INACTIVE_SECRET',FALSE FROM chapters WHERE novel_id=%s AND chapter_sequence=1",
            ("c" * 64, ids[0]),
        )
        await conn.execute(
            "INSERT INTO chapter_versions (chapter_id,version,content_hash,content,is_active) SELECT id,1,%s,'ACTIVE_DRAFT_SECRET',TRUE FROM chapters WHERE novel_id=%s AND chapter_sequence=4",
            ("d" * 64, ids[0]),
        )
    return slugs, ids, user_id


@pytest.mark.parametrize("sequence,previous,following", [(1, None, 5), (5, 1, 9), (9, 5, None)])
async def test_published_chapter_navigation_and_guest_contract(
    async_client, chapter_data, sequence, previous, following
):
    slugs, ids, _ = chapter_data
    response = await async_client.get(f"/api/novels/{slugs[0]}/chapters/{sequence}")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert "set-cookie" not in response.headers
    data = response.json()
    assert data["novel"] == {"id": str(ids[0]), "slug": slugs[0], "title": "Test novel"}
    assert set(data) == {"novel", "chapter", "navigation"}
    assert set(data["chapter"]) == {"id", "chapter_sequence", "chapter_number", "title", "content"}
    assert data["chapter"]["content"] == (
        "MIDDLE_CONTENT" if sequence == 5 else "PRIVATE_CONTENT_SENTINEL"
    )
    for key, expected in [("previous", previous), ("next", following)]:
        item = data["navigation"][key]
        if expected is None:
            assert item is None
        else:
            assert item["chapter_sequence"] == expected
            assert set(item) == {"id", "chapter_sequence", "chapter_number", "title"}
    assert "SECRET" not in response.text
    if sequence == 5:
        assert data["chapter"]["chapter_number"] == "Ngoại truyện"


@pytest.mark.parametrize("sequence", [2, 4, 6, 7, 100])
async def test_unpublished_or_missing_chapter_is_not_readable(async_client, chapter_data, sequence):
    slugs, _, _ = chapter_data
    response = await async_client.get(f"/api/novels/{slugs[0]}/chapters/{sequence}")
    assert response.status_code == 404
    assert response.json() == {"detail": "Published chapter not found."}


async def test_missing_novel_and_parameterized_slug(async_client, chapter_data):
    slugs, _, _ = chapter_data
    assert (await async_client.get(f"/api/novels/{slugs[0]}-missing/chapters/1")).status_code == 404
    with pytest.raises(HTTPException) as caught:
        await get_published_chapter("' OR TRUE --", 1)
    assert caught.value.status_code == 404


async def test_active_inactive_and_absent_versions_do_not_override_chapters(chapter_data):
    slugs, ids, _ = chapter_data
    assert (await get_published_chapter(slugs[0], 1)).chapter.content == "PRIVATE_CONTENT_SENTINEL"
    # Published sequence 5 has no version record at all.
    assert (await get_published_chapter(slugs[0], 5)).chapter.content == "MIDDLE_CONTENT"
    async with get_db_connection() as conn:
        await conn.execute(
            "UPDATE chapter_versions SET is_active=FALSE WHERE chapter_id IN (SELECT id FROM chapters WHERE novel_id=%s)",
            (ids[0],),
        )
    assert (await get_published_chapter(slugs[0], 1)).chapter.content == "PRIVATE_CONTENT_SENTINEL"


async def test_content_text_is_returned_verbatim_without_fallback(chapter_data):
    slugs, ids, _ = chapter_data
    for content in ["", "Đoạn một.\n\nĐoạn hai. <script>alert(1)</script>"]:
        async with get_db_connection() as conn:
            await conn.execute(
                "UPDATE chapters SET content=%s WHERE novel_id=%s AND chapter_sequence=1",
                (content, ids[0]),
            )
        assert (await get_published_chapter(slugs[0], 1)).chapter.content == content


async def test_single_published_chapter_has_no_navigation(chapter_data):
    slugs, _, _ = chapter_data
    result = await get_published_chapter(slugs[1], 5)
    assert result.navigation.previous is None
    assert result.navigation.next is None


async def test_chapter_reads_do_not_change_progress_or_create_sessions_bookmarks(
    async_client, chapter_data
):
    slugs, _, user_id = chapter_data

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
    for sequence in [1, 5, 9]:
        response = await async_client.get(f"/api/novels/{slugs[0]}/chapters/{sequence}")
        assert response.status_code == 200
        assert "set-cookie" not in response.headers
    assert await snapshot() == before
