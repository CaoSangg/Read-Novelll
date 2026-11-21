"""Isolated fixtures for local readnovel_test or verifier-owned disposable databases."""

import uuid

import psycopg
import pytest
from conftest import is_live_db_reachable
from psycopg.conninfo import conninfo_to_dict

from app.db.pool import get_db_connection, init_db_pool
from app.services import novel_service
from scripts.check_progress_migration import require_disposable


@pytest.fixture
async def novels_data(test_db_url):
    if not test_db_url:
        pytest.skip("Local readnovel_test DATABASE_URL unavailable.")
    info = conninfo_to_dict(test_db_url)
    if info.get("host") not in (
        "localhost",
        "127.0.0.1",
        "::1",
    ):
        pytest.fail("Novel fixtures require local readnovel_test.")
    if info.get("dbname") != "readnovel_test":
        try:
            with psycopg.connect(test_db_url, connect_timeout=3) as guard:
                require_disposable(guard)
        except (ValueError, psycopg.Error):
            pytest.fail(
                "Novel fixtures require a verified local disposable database.", pytrace=False
            )
    if not is_live_db_reachable(test_db_url):
        pytest.skip("Local readnovel_test PostgreSQL unavailable.")
    await init_db_pool(database_url=test_db_url)
    ids = [uuid.uuid4() for _ in range(3)]
    user_id, chapter_id = uuid.uuid4(), uuid.uuid4()
    prefix = f"readtest-{uuid.uuid4().hex}"
    slugs = [f"{prefix}-{index}" for index in range(3)]
    try:
        async with get_db_connection() as conn:
            for identifier, slug in zip(ids, slugs, strict=True):
                await conn.execute(
                    "INSERT INTO novels (id,slug,title,author) VALUES (%s,%s,%s,%s)",
                    (identifier, slug, "Test novel", "Test author"),
                )
            for sequence, status in [
                (9, "Published"),
                (1, "Published"),
                (4, "Draft"),
                (7, "Archived"),
            ]:
                identifier = chapter_id if sequence == 1 else uuid.uuid4()
                await conn.execute(
                    "INSERT INTO chapters (id,novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (
                        identifier,
                        ids[0],
                        sequence,
                        f"Chương {sequence}",
                        f"Chapter {sequence}",
                        "PRIVATE_CONTENT_SENTINEL",
                        status,
                    ),
                )
            await conn.execute(
                "INSERT INTO chapter_versions (chapter_id,version,content_hash,content,is_active) VALUES (%s,1,%s,%s,FALSE)",
                (chapter_id, "a" * 64, "PRIVATE_VERSION_SENTINEL"),
            )
            await conn.execute(
                "INSERT INTO chapters (novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,1,'1','Draft only','PRIVATE_DRAFT','Draft')",
                (ids[2],),
            )
            await conn.execute(
                "INSERT INTO users (id,email,username) VALUES (%s,%s,%s)",
                (user_id, f"{prefix}@example.com", prefix),
            )
            await conn.execute(
                "INSERT INTO reading_progress (user_id,novel_id,last_read_chapter_id,max_read_sequence) VALUES (%s,%s,%s,1)",
                (user_id, ids[0], chapter_id),
            )
        yield slugs, ids, user_id
    finally:
        async with get_db_connection() as conn:
            await conn.execute("DELETE FROM users WHERE id = %s", (user_id,))
            await conn.execute("DELETE FROM novels WHERE id = ANY(%s)", (ids,))


async def test_public_metadata_and_versions_are_not_exposed(async_client, novels_data):
    slugs, _, _ = novels_data
    response = await async_client.get(f"/api/novels/{slugs[0]}")
    assert response.status_code == 200
    data = response.json()
    assert data["published_chapter_count"] == 2
    assert data["description"] is None and data["cover_image_url"] is None
    assert set(data) == {
        "id",
        "slug",
        "title",
        "author",
        "description",
        "cover_image_url",
        "published_chapter_count",
    }
    chapters = (await async_client.get(f"/api/novels/{slugs[0]}/chapters")).json()
    assert [item["chapter_sequence"] for item in chapters["items"]] == [1, 9]
    assert all(
        set(item) == {"id", "chapter_sequence", "chapter_number", "title"}
        for item in chapters["items"]
    )
    assert "PRIVATE" not in str(chapters)


async def test_chapter_pagination_and_empty_pages(async_client, novels_data):
    slugs, _, _ = novels_data
    for page, expected in [(1, [1]), (2, [9]), (3, [])]:
        data = (
            await async_client.get(f"/api/novels/{slugs[0]}/chapters?page={page}&page_size=1")
        ).json()
        assert [item["chapter_sequence"] for item in data["items"]] == expected
        assert data["total"] == 2 and data["total_pages"] == 2
    for slug in slugs[1:]:
        assert (await novel_service.list_published_chapters(slug)).total == 0
        assert (await novel_service.get_novel_by_slug(slug)).published_chapter_count == 0


async def test_novel_list_pagination(async_client, novels_data):
    first = (await async_client.get("/api/novels?page_size=1")).json()
    second = (await async_client.get("/api/novels?page=2&page_size=1")).json()
    assert first["total"] >= 3
    assert first["items"][0]["slug"] < second["items"][0]["slug"]
    assert (await novel_service.list_novels(page=2147483647)).items == []


async def test_missing_and_injection_identifier(async_client, novels_data):
    for slug in [f"missing-{uuid.uuid4().hex}", "' OR TRUE --"]:
        for function in [novel_service.get_novel_by_slug, novel_service.list_published_chapters]:
            with pytest.raises(Exception) as caught:
                await function(slug)
            assert caught.value.status_code == 404
    assert (
        await async_client.get(f"/api/novels/missing-{uuid.uuid4().hex}/chapters")
    ).status_code == 404


async def test_metadata_reads_preserve_progress(novels_data):
    slugs, _, user_id = novels_data
    async with get_db_connection() as conn:
        before = await (
            await conn.execute("SELECT * FROM reading_progress WHERE user_id = %s", (user_id,))
        ).fetchone()
    await novel_service.get_novel_by_slug(slugs[0])
    await novel_service.list_published_chapters(slugs[0])
    await novel_service.list_novels()
    async with get_db_connection() as conn:
        after = await (
            await conn.execute("SELECT * FROM reading_progress WHERE user_id = %s", (user_id,))
        ).fetchone()
    assert before == after
