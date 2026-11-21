"""
Database Connection Pool & Health Endpoint Integration Tests.
Compliant with Phase 1.5 Architecture (Step 2).
"""

import pytest
from psycopg.rows import dict_row

from app.core.config import mask_database_url
from app.db import pool as db_pool
from app.db.pool import (
    check_database_readiness,
    close_db_pool,
    execute_query,
    get_db_connection,
    get_pool,
    init_db_pool,
)

# ==============================================================================
# GROUP 1: POOL LIFECYCLE & FAIL-FAST TESTS (Always executable offline)
# ==============================================================================


@pytest.mark.asyncio
async def test_09_pool_lifecycle():
    """
    Test 9: Verify AsyncConnectionPool open/close lifecycle and cleanup.
    """
    await close_db_pool()
    with pytest.raises(RuntimeError) as exc_info:
        get_pool()
    assert "not initialized" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_10_missing_database_url_fail_fast(monkeypatch):
    """
    Test 10: Fail-fast behavior when DATABASE_URL is missing or empty.
    Must raise a clear ValueError, never fall back silently to ambient DB.
    """
    await close_db_pool()
    monkeypatch.setattr(db_pool.settings, "DATABASE_URL", "")

    with pytest.raises(ValueError) as exc_info:
        await init_db_pool(database_url="")
    assert "DATABASE_URL is not configured" in str(exc_info.value)

    with pytest.raises(ValueError) as exc_info2:
        await init_db_pool(database_url=None)
    assert "DATABASE_URL is not configured" in str(exc_info2.value)


@pytest.mark.asyncio
async def test_11_health_and_readiness_endpoints(async_client, monkeypatch):
    """
    Test 11:
    - GET /api/health returns 200 OK without querying the database (Liveness).
    - GET /api/health/readiness returns 503 Service Unavailable when DB is unreachable.
    - Confirms no password or sensitive credentials leak in responses.
    """
    # 1. Liveness check - must always return 200
    res_live = await async_client.get("/api/health")
    assert res_live.status_code == 200
    live_data = res_live.json()
    assert live_data["status"] == "ok"
    assert "app" in live_data
    assert "timestamp" in live_data

    # 2. Readiness check when DB is disconnected
    await close_db_pool()
    res_ready = await async_client.get("/api/health/readiness")
    assert res_ready.status_code == 503
    ready_data = res_ready.json()
    assert ready_data["status"] == "unavailable"
    assert ready_data["database"] == "disconnected"
    assert "password" not in str(ready_data).lower()


def test_password_masking_utility():
    """
    Verify URL password masking never exposes plain text credentials.
    """
    sample_url = "postgresql://myuser:SuperSecretPassword123@localhost:5432/readnovel_test"
    masked = mask_database_url(sample_url)
    assert "SuperSecretPassword123" not in masked
    assert "******" in masked
    assert "myuser" in masked
    assert "localhost:5432" in masked

    assert mask_database_url(None) == "[NOT_SET]"
    assert mask_database_url("") == "[NOT_SET]"


# ==============================================================================
# GROUP 2: REAL POSTGRESQL INTEGRATION TESTS
# Require live PostgreSQL container (readnovel-pg16-test).
# If database is unreachable in current environment, cleanly skipped / reported.
# ==============================================================================


@pytest.mark.asyncio
async def test_01_real_db_connection(test_db_url, live_db_available):
    """
    Test 1: Connect successfully to real PostgreSQL container.
    """
    if not live_db_available:
        pytest.skip(
            "BLOCKED / NOT RUN: PostgreSQL Docker container is not reachable. "
            "Start container 'readnovel-pg16-test' to run real database verification."
        )

    pool = await init_db_pool(database_url=test_db_url)
    assert pool is not None
    async with get_db_connection() as conn:
        assert conn is not None
        assert not conn.closed


@pytest.mark.asyncio
async def test_02_current_database(test_db_url, live_db_available):
    """
    Test 2: Verify SELECT current_database().
    """
    if not live_db_available:
        pytest.skip("BLOCKED / NOT RUN: PostgreSQL Docker container is not reachable.")

    await init_db_pool(database_url=test_db_url)
    rows = await execute_query("SELECT current_database() AS db_name;")
    assert len(rows) == 1
    db_name = rows[0]["db_name"]
    assert db_name is not None
    assert len(db_name) > 0


@pytest.mark.asyncio
async def test_03_select_1(test_db_url, live_db_available):
    """
    Test 3: Verify SELECT 1 readiness query and latency measurement.
    """
    if not live_db_available:
        pytest.skip("BLOCKED / NOT RUN: PostgreSQL Docker container is not reachable.")

    await init_db_pool(database_url=test_db_url)
    is_ready, latency_ms, error = await check_database_readiness()
    assert is_ready is True
    assert latency_ms > 0
    assert error is None


@pytest.mark.asyncio
async def test_04_schema_11_tables(test_db_url, live_db_available):
    """
    Test 4: Verify all 11 tables from schema v3.2 exist in public schema.
    Tables: users, user_sessions, user_identities, novels, chapters,
            chapter_versions, chapter_ai_status, reading_progress,
            bookmarks, novel_chunks, ai_jobs.
    """
    if not live_db_available:
        pytest.skip("BLOCKED / NOT RUN: PostgreSQL Docker container is not reachable.")

    await init_db_pool(database_url=test_db_url)
    rows = await execute_query("""
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name;
    """)

    table_names = {r["table_name"] for r in rows}
    expected_tables = {
        "users",
        "user_sessions",
        "user_identities",
        "novels",
        "chapters",
        "chapter_versions",
        "chapter_ai_status",
        "reading_progress",
        "bookmarks",
        "novel_chunks",
        "ai_jobs",
    }

    missing_tables = expected_tables - table_names
    assert len(missing_tables) == 0, f"Missing tables in PostgreSQL: {missing_tables}"
    assert len(expected_tables) == 11


@pytest.mark.asyncio
async def test_05_schema_extensions(test_db_url, live_db_available):
    """
    Test 5: Verify required extensions 'vector' (pgvector) and 'pg_trgm' are active.
    """
    if not live_db_available:
        pytest.skip("BLOCKED / NOT RUN: PostgreSQL Docker container is not reachable.")

    await init_db_pool(database_url=test_db_url)
    rows = await execute_query("""
        SELECT extname FROM pg_extension
        WHERE extname IN ('vector', 'pg_trgm');
    """)

    ext_names = {r["extname"] for r in rows}
    assert "vector" in ext_names, "Extension 'vector' is missing"
    assert "pg_trgm" in ext_names, "Extension 'pg_trgm' is missing"


@pytest.mark.asyncio
async def test_06_transaction_commit(test_db_url, live_db_available):
    """
    Test 6: Verify transaction commit works as expected.
    Uses temporary table to ensure zero side-effects on persistent data.
    """
    if not live_db_available:
        pytest.skip("BLOCKED / NOT RUN: PostgreSQL Docker container is not reachable.")

    await init_db_pool(database_url=test_db_url)

    # Setup temporary table
    async with get_db_connection() as setup_conn:
        async with setup_conn.cursor() as cur:
            await cur.execute(
                "CREATE TEMP TABLE IF NOT EXISTS _test_commit (id INT PRIMARY KEY, val TEXT);"
            )
            await cur.execute("TRUNCATE _test_commit;")
            await setup_conn.commit()

        # Perform transaction commit
        async with setup_conn.transaction():
            async with setup_conn.cursor() as cur:
                await cur.execute("INSERT INTO _test_commit (id, val) VALUES (1, 'committed_val');")

        # Verify value is persisted in the session
        async with setup_conn.cursor(row_factory=dict_row) as cur:
            await cur.execute("SELECT val FROM _test_commit WHERE id = 1;")
            row = await cur.fetchone()
            assert row is not None
            assert row["val"] == "committed_val"


@pytest.mark.asyncio
async def test_07_transaction_rollback(test_db_url, live_db_available):
    """
    Test 7: Verify transaction rollback when an intentional error occurs.
    """
    if not live_db_available:
        pytest.skip("BLOCKED / NOT RUN: PostgreSQL Docker container is not reachable.")

    await init_db_pool(database_url=test_db_url)

    async with get_db_connection() as setup_conn:
        async with setup_conn.cursor() as cur:
            await cur.execute(
                "CREATE TEMP TABLE IF NOT EXISTS _test_rollback (id INT PRIMARY KEY, val TEXT);"
            )
            await cur.execute("TRUNCATE _test_rollback;")
            await setup_conn.commit()

        # Attempt transaction with deliberate failure
        with pytest.raises(RuntimeError):
            async with setup_conn.transaction():
                async with setup_conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO _test_rollback (id, val) VALUES (99, 'rollback_val');"
                    )
                raise RuntimeError("Intentional error to trigger rollback")

        # Verify value was rolled back
        async with setup_conn.cursor(row_factory=dict_row) as cur:
            await cur.execute("SELECT COUNT(*)::int AS cnt FROM _test_rollback WHERE id = 99;")
            row = await cur.fetchone()
            assert row["cnt"] == 0


@pytest.mark.asyncio
async def test_08_connection_returned_after_exception(test_db_url, live_db_available):
    """
    Test 8: Verify connection is returned to pool even after an exception occurs.
    """
    if not live_db_available:
        pytest.skip("BLOCKED / NOT RUN: PostgreSQL Docker container is not reachable.")

    # Initialize a pool with max_size=1 to detect connection leaks immediately
    await init_db_pool(database_url=test_db_url, min_size=1, max_size=1)

    # 1. Cause an exception inside connection context
    try:
        async with get_db_connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT 1;")
            raise ValueError("Deliberate failure inside context manager")
    except ValueError:
        pass

    # 2. Acquire connection again: if leak occurred with max_size=1, this would time out
    async with get_db_connection() as conn2:
        async with conn2.cursor() as cur2:
            await cur2.execute("SELECT 2::int AS val;")
            res = await cur2.fetchone()
            assert res[0] == 2
