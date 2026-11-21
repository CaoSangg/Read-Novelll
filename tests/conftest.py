"""
Pytest configuration and shared fixtures for database pool and API tests.
Compliant with Phase 1.5 Architecture (Step 2).
"""

import asyncio
import os
import sys

import psycopg
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

# ==============================================================================
# 1. WINDOWS EVENT LOOP CONFIGURATION (psycopg 3 compatibility)
# ==============================================================================

if sys.platform == "win32":
    # Set WindowsSelectorEventLoopPolicy so any default loop creation uses Selector
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    @pytest.hookimpl
    def pytest_asyncio_loop_factories(config, item):
        """
        pytest-asyncio 1.5.0 hook: provide SelectorEventLoop factory on Windows.
        On Linux, this hook is omitted so the default platform loop is used.
        """
        return {"windows_selector": asyncio.SelectorEventLoop}


# ==============================================================================
# 2. DATABASE CONFIGURATION & CONNECTIVITY VERIFICATION
# ==============================================================================


def get_test_database_url() -> str:
    """
    Retrieve database connection string strictly from environment variables.
    Never hardcode passwords or connection strings.
    """
    return os.environ.get("DATABASE_URL") or os.environ.get("TEST_DATABASE_URL") or ""


def is_live_db_reachable(url: str | None = None) -> bool:
    """
    Verify real PostgreSQL connectivity by executing 'SELECT 1;' with short timeout.
    Returns True only if actual connection, authentication, and query succeed.
    """
    target_url = url or get_test_database_url()
    if not target_url or not target_url.strip():
        return False
    try:
        # Use sync psycopg.connect with connect_timeout=3 to confirm real credentials & server
        with psycopg.connect(target_url, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1;")
                row = cur.fetchone()
                return bool(row and row[0] == 1)
    except Exception:
        return False


@pytest.fixture(scope="session")
def test_db_url() -> str:
    """Fixture providing database connection string from environment."""
    return get_test_database_url()


@pytest.fixture(scope="session")
def live_db_available(test_db_url: str) -> bool:
    """Fixture confirming live PostgreSQL container is running and queryable."""
    return is_live_db_reachable(test_db_url)


# ==============================================================================
# 3. FIXTURES: CLEANUP & TEST CLIENT
# ==============================================================================


@pytest.fixture(autouse=True)
async def cleanup_db_pool():
    """
    Ensure any global DB pool opened during a test is cleanly closed
    in the SAME event loop before the test finishes.
    """
    yield
    from app.db.pool import close_db_pool

    await close_db_pool()


@pytest.fixture
async def async_client():
    """Async HTTP client fixture for testing FastAPI endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
