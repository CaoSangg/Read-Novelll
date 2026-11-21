"""TOC jump SSR metadata and existing publication/read-only contracts on local UUID fixtures."""

from urllib.parse import quote

import pytest
from test_chapter_service import chapter_data as chapter_data
from test_novel_service import novels_data as novels_data
from test_reader_toc import toc_data as toc_data
from test_reader_web import ReaderParser

from app.db.pool import get_db_connection


@pytest.mark.parametrize("sequence,following", [(1, 3), (3, 5), (9, 15), (15, None)])
async def test_jump_metadata_uses_published_neighbors_not_arithmetic(
    async_client, chapter_data, sequence, following
):
    slugs, ids, _ = chapter_data
    async with get_db_connection() as conn:
        await conn.execute(
            "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,3,'Extra','Three','THREE','Published'),(%s,15,'Last','Fifteen','FIFTEEN','Published')",
            (ids[0], ids[0]),
        )
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 200
    parser = ReaderParser(response.text)
    attrs = next(attrs for tag, attrs in parser.tags if attrs.get("id") == "reader-toc")
    assert (
        attrs["data-next-sequence"] == str(following)
        if following is not None
        else attrs["data-next-sequence"] == ""
    )
    assert attrs["data-sequence"] == str(sequence)
    assert (
        sum(tag == "dialog" and attrs.get("id") == "reader-toc" for tag, attrs in parser.tags) == 1
    )
    confirmation = next(
        attrs for tag, attrs in parser.tags if attrs.get("id") == "reader-jump-confirmation"
    )
    assert "hidden" in confirmation and confirmation["aria-describedby"] == "reader-jump-message"
    assert "HIDDEN_NAVIGATION_SECRET" not in response.text and "set-cookie" not in response.headers


async def test_jump_cross_page_uses_rank_50_51_and_only_published_metadata(async_client, toc_data):
    slugs, _, _ = toc_data
    first = (await async_client.get(f"/api/novels/{slugs[0]}/chapters?page=1&page_size=50")).json()
    second = (await async_client.get(f"/api/novels/{slugs[0]}/chapters?page=2&page_size=50")).json()
    assert len(first["items"]) == 50 and first["items"][-1]["chapter_sequence"] == 1470
    assert second["items"][0]["chapter_sequence"] == 1480
    for sequence, page, following in [(1470, 1, 1480), (1480, 2, 1490)]:
        response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
        assert response.status_code == 200
        assert f'data-initial-page="{page}"' in response.text
        assert f'data-next-sequence="{following}"' in response.text
    assert not {4, 6, 7}.intersection(
        item["chapter_sequence"] for item in first["items"] + second["items"]
    )
    assert "TOC_CONTENT_SECRET" not in str(first) + str(second)


async def test_jump_unicode_and_untrusted_number_title_stay_metadata(async_client, chapter_data):
    slugs, ids, _ = chapter_data
    slug = f"đọc-漢字_{slugs[0]}"
    number = '<img src=x onerror="alert(1)">'
    title = '<script>alert("future")</script>'
    async with get_db_connection() as conn:
        await conn.execute("UPDATE novels SET slug=%s WHERE id=%s", (slug, ids[0]))
        await conn.execute(
            "UPDATE chapters SET chapter_number=%s,title=%s WHERE novel_id=%s AND chapter_sequence=9",
            (number, title, ids[0]),
        )
    path = f"/novel/{quote(slug, safe='')}/5"
    response = await async_client.get(path)
    assert response.status_code == 200
    assert number not in response.text and title not in response.text
    assert f'data-slug="{slug}"' in response.text and 'data-next-sequence="9"' in response.text
    data = (
        await async_client.get(f"/api/novels/{quote(slug, safe='')}/chapters?page=1&page_size=50")
    ).json()
    target = next(item for item in data["items"] if item["chapter_sequence"] == 9)
    assert target["chapter_number"] == number and target["title"] == title
    assert all(
        set(item) == {"id", "chapter_sequence", "chapter_number", "title"} for item in data["items"]
    )
