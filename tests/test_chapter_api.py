"""Chapter HTTP validation and safe failures independent of PostgreSQL."""

from contextlib import asynccontextmanager

import pytest
from psycopg import OperationalError

from app.services import novel_service


@pytest.mark.parametrize("sequence", ["0", "-1", "abc", "1.5", "2147483648", "1%20OR%20TRUE"])
async def test_chapter_invalid_sequence_is_422(async_client, sequence):
    assert (await async_client.get(f"/api/novels/book/chapters/{sequence}")).status_code == 422


@pytest.mark.parametrize("slug", ["invalid%20slug", "%27%20OR%20TRUE--", "x" * 256])
async def test_chapter_invalid_slug_is_422(async_client, slug):
    assert (await async_client.get(f"/api/novels/{slug}/chapters/1")).status_code == 422


@pytest.mark.parametrize("failure", ["pool", "query"])
async def test_chapter_database_errors_are_sanitized(async_client, monkeypatch, failure):
    def no_pool():
        raise RuntimeError("private configuration")

    @asynccontextmanager
    async def no_connection():
        raise OperationalError("private database exception")
        yield

    if failure == "pool":
        monkeypatch.setattr(novel_service, "get_pool", no_pool)
    else:
        monkeypatch.setattr(novel_service, "get_pool", lambda: object())
        monkeypatch.setattr(novel_service, "get_db_connection", no_connection)
    response = await async_client.get("/api/novels/book/chapters/1")
    assert response.status_code == 503
    assert response.json() == {"detail": "Novel data is temporarily unavailable."}


async def test_chapter_write_guard_and_existing_web_routes(async_client):
    assert (await async_client.post("/api/novels/book/chapters/1", json={})).status_code == 405
    assert (await async_client.get("/novel/khau-van-tien-dao/1")).status_code == 503
    assert (await async_client.get("/")).status_code == 200
    assert (await async_client.get("/login")).status_code == 200
    assert (await async_client.get("/register")).status_code == 200
    assert (await async_client.get("/api/auth/me")).status_code == 401
