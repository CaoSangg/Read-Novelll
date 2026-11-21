"""Public API validation and sanitized database failures without PostgreSQL."""

import pytest
from psycopg import OperationalError

from app.services import novel_service


@pytest.mark.parametrize("path", ["/api/novels", "/api/novels/book", "/api/novels/book/chapters"])
async def test_novel_database_unavailable_is_sanitized(async_client, monkeypatch, path):
    def unavailable():
        raise RuntimeError("private pool configuration")

    monkeypatch.setattr(novel_service, "get_pool", unavailable)
    response = await async_client.get(path)
    assert response.status_code == 503
    assert response.json() == {"detail": "Novel data is temporarily unavailable."}


@pytest.mark.parametrize(
    "query", ["page=0", "page=-1", "page=x", "page_size=0", "page_size=101", "page=2147483648"]
)
@pytest.mark.parametrize("path", ["/api/novels", "/api/novels/book/chapters"])
async def test_novel_pagination_validation(async_client, query, path):
    assert (await async_client.get(f"{path}?{query}")).status_code == 422


async def test_novel_query_failure_does_not_leak_details(async_client, monkeypatch):
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def failed_connection():
        raise OperationalError("private SQL credentials")
        yield

    monkeypatch.setattr(novel_service, "get_pool", lambda: object())
    monkeypatch.setattr(novel_service, "get_db_connection", failed_connection)
    response = await async_client.get("/api/novels")
    assert response.status_code == 503
    assert "private" not in response.text


async def test_write_guards_and_public_web_routes(async_client):
    assert (await async_client.get("/novel/khau-van-tien-dao/1")).status_code == 503
    assert (await async_client.post("/api/novels", json={})).status_code == 405
    assert (await async_client.get("/login")).status_code == 200
    assert (await async_client.get("/register")).status_code == 200
    assert (await async_client.get("/")).status_code == 200
    assert (await async_client.get("/api/auth/me")).status_code == 401
