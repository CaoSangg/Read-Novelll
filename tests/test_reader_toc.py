"""TOC rank and SSR metadata using isolated PostgreSQL rows, including sequence gaps."""

import pytest
from fastapi import HTTPException
from test_novel_service import novels_data as novels_data

from app.db.pool import get_db_connection
from app.services.novel_service import get_published_chapter_page, list_published_chapters


@pytest.fixture
async def toc_data(novels_data):
    slugs, ids, user_id = novels_data
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.executemany(
                "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,%s,%s,%s,'TOC_CONTENT_SECRET','Published')",
                [
                    (ids[0], 1000 + index * 10, f"Ngoại truyện {index}", f"Tên chương {index}")
                    for index in range(51)
                ],
            )
        await conn.execute(
            "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,6,'Null','NULL_SECRET','SECRET',NULL)",
            (ids[0],),
        )
    return slugs, ids, user_id


@pytest.mark.parametrize(
    "sequence,size,expected",
    [(1, 50, 1), (9, 1, 2), (1000, 2, 2), (1480, 50, 2), (1500, 50, 2), (1500, 100, 1)],
)
async def test_published_rank_not_sequence_division(toc_data, sequence, size, expected):
    slugs, _, _ = toc_data
    assert await get_published_chapter_page(slugs[0], sequence, size) == expected


@pytest.mark.parametrize("sequence", [4, 6, 7, 9999])
async def test_rank_missing_or_unpublished_404(toc_data, sequence):
    slugs, _, _ = toc_data
    with pytest.raises(HTTPException) as caught:
        await get_published_chapter_page(slugs[0], sequence)
    assert caught.value.status_code == 404


async def test_toc_published_pages_and_ssr_context(async_client, toc_data):
    slugs, _, _ = toc_data
    response = await async_client.get(f"/novel/{slugs[0]}/1500")
    assert response.status_code == 200
    assert 'data-initial-page="2"' in response.text
    assert 'data-sequence="1500"' in response.text
    assert 'aria-expanded="false"' in response.text
    assert '<dialog id="reader-toc"' in response.text
    assert 'aria-modal="true"' in response.text
    assert "data-toc-page" in response.text
    script = await async_client.get("/static/js/reader_toc.js")
    assert script.status_code == 200
    page = await list_published_chapters(slugs[0], 2, 50)
    assert page.total == 53 and page.total_pages == 2
    assert [item.chapter_sequence for item in page.items] == [1480, 1490, 1500]
    data = (await async_client.get(f"/api/novels/{slugs[0]}/chapters?page=1&page_size=50")).json()
    assert data["total"] == 53
    assert not {4, 6, 7}.intersection(item["chapter_sequence"] for item in data["items"])
    assert "TOC_CONTENT_SECRET" not in str(data)
    assert (await list_published_chapters(slugs[0], 3)).items == []
    assert (await list_published_chapters(slugs[1])).total == 0
    assert "set-cookie" not in response.headers


async def test_rank_rejects_injection_and_missing_novel(toc_data):
    for slug in ["not-a-novel", "' OR TRUE --"]:
        with pytest.raises(HTTPException) as caught:
            await get_published_chapter_page(slug, 1)
        assert caught.value.status_code == 404


async def test_empty_and_single_published_novel_rank(novels_data):
    slugs, ids, _ = novels_data
    with pytest.raises(HTTPException) as caught:
        await get_published_chapter_page(slugs[1], 2500)
    assert caught.value.status_code == 404
    async with get_db_connection() as conn:
        await conn.execute(
            "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,2500,'Ngoại truyện','Only chapter','Text','Published')",
            (ids[1],),
        )
    assert await get_published_chapter_page(slugs[1], 2500) == 1
    page = await list_published_chapters(slugs[1])
    assert page.total == 1 and page.total_pages == 1


async def test_toc_reads_leave_progress_sessions_bookmarks_unchanged(async_client, toc_data):
    slugs, _, user_id = toc_data

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
    assert (await async_client.get(f"/novel/{slugs[0]}/1500")).status_code == 200
    for page in [1, 2, 3]:
        response = await async_client.get(f"/api/novels/{slugs[0]}/chapters?page={page}")
        assert response.status_code == 200 and "set-cookie" not in response.headers
    assert await snapshot() == before


@pytest.mark.parametrize("page_size", [0, 101])
async def test_rank_page_size_validation(page_size):
    with pytest.raises(ValueError):
        await get_published_chapter_page("book", 1, page_size)
