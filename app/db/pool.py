"""
PostgreSQL Async Connection Pool Module (psycopg 3)
Compliant with Phase 1.5 Architecture (Step 2).
"""

import asyncio
import logging
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout

from app.core.config import mask_database_url, settings

# Ensure WindowsSelectorEventLoopPolicy on Windows for psycopg 3 async support
if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

logger = logging.getLogger("readnovel.db")

_pool: AsyncConnectionPool | None = None
_pool_loop: asyncio.AbstractEventLoop | None = None


def get_pool() -> AsyncConnectionPool:
    """
    Get the active global database connection pool.
    Raises RuntimeError if pool has not been initialized.
    """
    global _pool
    if _pool is None:
        raise RuntimeError(
            "Database connection pool is not initialized. "
            "Ensure init_db_pool() was called during FastAPI lifespan startup."
        )
    return _pool


async def init_db_pool(
    database_url: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    timeout: float | None = None,
    max_idle: float | None = None,
) -> AsyncConnectionPool:
    """
    Initialize and open the singleton AsyncConnectionPool.
    Called once during FastAPI lifespan startup.

    Fail-fast:
    - Raises ValueError if DATABASE_URL is missing or empty.
    - No ambient fallback to OS sockets or other databases.
    """
    global _pool, _pool_loop

    target_url = database_url if database_url is not None else settings.DATABASE_URL
    if not target_url or not target_url.strip():
        logger.error(
            "CRITICAL: DATABASE_URL is not configured. Database operations will be rejected."
        )
        raise ValueError(
            "DATABASE_URL is not configured. Please set DATABASE_URL environment variable."
        )

    # If pool already exists and is open, close it cleanly first
    if _pool is not None:
        await close_db_pool()

    p_min = min_size if min_size is not None else settings.DB_POOL_MIN_SIZE
    p_max = max_size if max_size is not None else settings.DB_POOL_MAX_SIZE
    p_timeout = timeout if timeout is not None else settings.DB_POOL_TIMEOUT
    p_max_idle = max_idle if max_idle is not None else settings.DB_POOL_MAX_IDLE

    # Never log unmasked connection strings
    logger.info(
        f"Initializing AsyncConnectionPool: {mask_database_url(target_url)} "
        f"[min_size={p_min}, max_size={p_max}, timeout={p_timeout}s, max_idle={p_max_idle}s]"
    )

    _pool = AsyncConnectionPool(
        conninfo=target_url,
        min_size=p_min,
        max_size=p_max,
        timeout=p_timeout,
        max_idle=p_max_idle,
        open=False,
    )

    # Track event loop where pool was opened
    _pool_loop = asyncio.get_running_loop()

    # Open pool asynchronously
    await _pool.open()
    logger.info("Database connection pool opened successfully.")
    return _pool


async def close_db_pool(timeout: float = 3.0) -> None:
    """
    Gracefully close all connections in the database connection pool.
    Called during FastAPI lifespan shutdown and test teardown.
    """
    global _pool, _pool_loop
    if _pool is not None:
        p = _pool
        p_loop = _pool_loop
        _pool = None
        _pool_loop = None
        logger.info("Closing database connection pool...")
        try:
            if not p.closed:
                curr_loop = asyncio.get_running_loop()
                if p_loop is not None and p_loop is not curr_loop and p_loop.is_closed():
                    logger.warning(
                        "Database pool's original event loop is closed. Forcing pool teardown."
                    )
                    return
                await asyncio.wait_for(p.close(timeout=timeout), timeout=timeout + 0.5)
            logger.info("Database connection pool closed cleanly.")
        except (Exception, asyncio.CancelledError) as e:
            logger.warning(f"Note during pool close: {type(e).__name__}")


@asynccontextmanager
async def get_db_connection() -> AsyncIterator[AsyncConnection]:
    """
    Async context manager acquiring a connection from the pool.
    Guarantees the connection is returned to the pool even on exception.

    Usage:
        async with get_db_connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT 1;")
    """
    pool = get_pool()
    try:
        async with pool.connection() as conn:
            yield conn
    except PoolTimeout:
        logger.error("Connection pool timeout: no connection available within timeout window.")
        raise
    except Exception as e:
        logger.error(f"Database connection error: {type(e).__name__}")
        raise


@asynccontextmanager
async def get_db_transaction() -> AsyncIterator[AsyncConnection]:
    """
    Async context manager acquiring a connection and wrapping operations
    inside an explicit transaction block.

    Guarantees:
    - Auto-commit on normal block exit.
    - Auto-rollback on any exception.
    - Connection returned to pool.

    Usage:
        async with get_db_transaction() as conn:
            async with conn.cursor() as cur:
                await cur.execute("INSERT INTO ...")
    """
    pool = get_pool()
    async with pool.connection() as conn:
        async with conn.transaction():
            yield conn


async def execute_query(
    query_sql: str,
    params: tuple[Any, ...] | list[Any] | dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """
    Execute a parameterized SQL query and return rows as dictionaries.
    Security: NEVER logs query parameters or credentials.
    """
    start_time = time.perf_counter()
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(query_sql, params)
            if cur.description is not None:
                rows = await cur.fetchall()
            else:
                rows = []

    elapsed_ms = (time.perf_counter() - start_time) * 1000
    if settings.DEBUG_DB_QUERY:
        # Strictly log only execution duration and row count, NEVER log params
        logger.debug(f"[DB Query] Executed in {elapsed_ms:.2f}ms, returned {len(rows)} rows.")
    return rows


async def check_database_readiness() -> tuple[bool, float, str | None]:
    """
    Execute a lightweight SELECT 1 query to check database connectivity.
    Returns:
        (is_ready, latency_ms, error_message)
    Error message is sanitized: NEVER contains passwords or connection strings.
    """
    if _pool is None:
        return False, 0.0, "Database pool not initialized"

    start_time = time.perf_counter()
    try:
        async with get_db_connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT 1;")
                await cur.fetchone()
        latency_ms = (time.perf_counter() - start_time) * 1000
        return True, round(latency_ms, 2), None
    except Exception as e:
        # Sanitize error message to avoid leaking any sensitive info
        err_type = type(e).__name__
        err_msg = str(e)
        if "@" in err_msg or "password" in err_msg.lower():
            err_msg = mask_database_url(err_msg)
        return False, 0.0, f"{err_type}: {err_msg[:120]}"
