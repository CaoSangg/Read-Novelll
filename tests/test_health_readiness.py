import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.db import pool


@pytest.mark.parametrize("mode", ["healthy", "error", "stalled"])
async def test_readiness_query_is_bounded_and_sanitized(async_client, monkeypatch, mode):
    returned = False

    async def execute_query(statement):
        assert statement == "SELECT 1;"
        if mode == "error":
            raise RuntimeError("postgresql://user:sentinel-secret@example.invalid/db")
        if mode == "stalled":
            await asyncio.Event().wait()

    @asynccontextmanager
    async def cursor_context():
        yield SimpleNamespace(execute=AsyncMock(side_effect=execute_query), fetchone=AsyncMock())

    @asynccontextmanager
    async def connection():
        nonlocal returned
        try:
            yield SimpleNamespace(cursor=cursor_context)
        finally:
            returned = True

    monkeypatch.setattr(pool, "_pool", object())
    monkeypatch.setattr(pool, "get_db_connection", connection)
    try:
        response = await asyncio.wait_for(async_client.get("/api/health/readiness"), 4)
        assert returned
        if mode == "healthy":
            assert response.status_code == 200
            assert response.json()["database"] == "connected"
            assert response.json()["latency_ms"] >= 0
        else:
            assert response.status_code == 503
            assert response.json()["error"] == "Database connection failed"
            assert "sentinel-secret" not in response.text
    finally:
        # The test substituted a sentinel rather than opening a real pool.
        monkeypatch.setattr(pool, "_pool", None)
