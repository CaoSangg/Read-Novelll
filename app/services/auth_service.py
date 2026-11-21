"""
Authentication Business Logic and Database Operations.
Compliant with Phase 1.5 Architecture (Step 3).
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from psycopg.rows import dict_row

from app.core.config import settings
from app.core.security import (
    generate_csrf_token,
    generate_session_token,
    hash_password,
    hash_session_token,
    login_rate_limiter,
    register_rate_limiter,
    verify_dummy_password,
    verify_password,
)
from app.db.pool import get_db_connection, get_db_transaction

logger = logging.getLogger("readnovel.auth")


async def register_user(
    username: str,
    email: str,
    password: str,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> tuple[dict[str, Any], str, str]:
    """
    Register a new user account with default 'Reader' role and active status.
    Automatically generates initial Opaque Session and CSRF token upon successful creation.

    Returns:
        (user_dict, raw_session_token, csrf_token)
    """
    rate_limit_key = ip_address or "unknown_client"

    # 1. Enforce rate limiting to mitigate registration flooding and Argon2 CPU/RAM DoS
    if register_rate_limiter.is_rate_limited(rate_limit_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registration attempts. Please try again later.",
            headers={"Retry-After": str(settings.REGISTER_RATE_LIMIT_WINDOW_SECONDS)},
        )

    register_rate_limiter.record_attempt(rate_limit_key)

    # 2. Check for duplicate email or username
    check_sql = """
        SELECT id, email, username
        FROM users
        WHERE LOWER(email) = LOWER(%s) OR LOWER(username) = LOWER(%s)
        LIMIT 1;
    """
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(check_sql, (email, username))
            existing = await cur.fetchone()

    if existing:
        if existing["email"].lower() == email.lower():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email is already registered",
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username is already taken",
        )

    # 2. Hash password with Argon2id
    hashed_pwd = hash_password(password)

    # 3. Insert user & create initial session within a single transaction
    insert_user_sql = """
        INSERT INTO users (email, username, password_hash, role, is_active)
        VALUES (%s, %s, %s, 'Reader', TRUE)
        RETURNING id, email, username, role, is_active, created_at;
    """

    raw_session_token = generate_session_token()
    token_hash = hash_session_token(raw_session_token)
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.SESSION_EXPIRE_DAYS)

    insert_session_sql = """
        INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id;
    """

    async with get_db_transaction() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            # Insert User
            await cur.execute(insert_user_sql, (email, username, hashed_pwd))
            new_user = await cur.fetchone()
            if not new_user:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to create user record",
                )

            # Insert Session (storing only SHA-256 token hash)
            await cur.execute(
                insert_session_sql,
                (new_user["id"], token_hash, user_agent, ip_address, expires_at),
            )

    csrf_token = generate_csrf_token()
    # Convert UUID to string for JSON serialization
    new_user["id"] = str(new_user["id"])
    return new_user, raw_session_token, csrf_token


async def authenticate_user(
    username_or_email: str,
    password: str,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> tuple[dict[str, Any], str, str]:
    """
    Authenticate a user by username or email.
    Verifies Argon2id password hash, checks account status, enforces rate limiting,
    and creates a new Opaque Session.

    Returns:
        (user_dict, raw_session_token, csrf_token)
    """
    rate_limit_key = ip_address or "unknown_client"

    # 1. Enforce rate limiting to mitigate brute-force attacks
    if login_rate_limiter.is_rate_limited(rate_limit_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Please try again later.",
            headers={"Retry-After": str(settings.LOGIN_RATE_LIMIT_WINDOW_SECONDS)},
        )

    # 2. Query user record by email or username
    find_user_sql = """
        SELECT id, email, username, password_hash, role, is_active, created_at
        FROM users
        WHERE LOWER(email) = LOWER(%s) OR LOWER(username) = LOWER(%s)
        LIMIT 1;
    """
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(find_user_sql, (username_or_email, username_or_email))
            user = await cur.fetchone()

    # 3. Timing-safe user verification
    if not user:
        verify_dummy_password(password)
        login_rate_limiter.record_failed_attempt(rate_limit_key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username/email or password",
        )

    # 4. Verify password with Argon2id
    if not verify_password(password, user["password_hash"]):
        login_rate_limiter.record_failed_attempt(rate_limit_key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username/email or password",
        )

    # 5. Check if user account is active
    if not user.get("is_active", True):
        login_rate_limiter.record_failed_attempt(rate_limit_key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is disabled. Please contact an administrator.",
        )

    # Authentication succeeded: reset failed attempts for this identifier
    login_rate_limiter.reset(rate_limit_key)

    # 6. Generate Opaque Session Token and store SHA-256 hash in PostgreSQL
    raw_session_token = generate_session_token()
    token_hash = hash_session_token(raw_session_token)
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.SESSION_EXPIRE_DAYS)

    insert_session_sql = """
        INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
        VALUES (%s, %s, %s, %s, %s);
    """
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                insert_session_sql,
                (user["id"], token_hash, user_agent, ip_address, expires_at),
            )

    csrf_token = generate_csrf_token()

    # Clean user dict for response
    clean_user = {
        "id": str(user["id"]),
        "email": user["email"],
        "username": user["username"],
        "role": user["role"],
        "is_active": user["is_active"],
        "created_at": user["created_at"],
    }
    return clean_user, raw_session_token, csrf_token


async def get_user_by_session_token(raw_session_token: str | None) -> dict[str, Any] | None:
    """
    Retrieve active user and session info from raw session token.
    Hashes token using SHA-256 and verifies expiration and active user status.
    """
    if not raw_session_token or not raw_session_token.strip():
        return None

    token_hash = hash_session_token(raw_session_token)

    query_sql = """
        SELECT u.id, u.email, u.username, u.role, u.is_active, u.created_at,
               s.id AS session_id, s.expires_at
        FROM user_sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.refresh_token_hash = %s
          AND s.expires_at > CURRENT_TIMESTAMP
          AND u.is_active = TRUE
        LIMIT 1;
    """

    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(query_sql, (token_hash,))
            row = await cur.fetchone()

    if not row:
        return None

    row["id"] = str(row["id"])
    row["session_id"] = str(row["session_id"])
    return row


async def revoke_session_by_token(raw_session_token: str | None) -> None:
    """
    Revoke a session by deleting the session row from PostgreSQL.
    Compliance: Does NOT query revoked_at column; deletes the record cleanly.
    """
    if not raw_session_token or not raw_session_token.strip():
        return

    token_hash = hash_session_token(raw_session_token)
    delete_sql = "DELETE FROM user_sessions WHERE refresh_token_hash = %s;"

    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(delete_sql, (token_hash,))


async def change_user_password(
    user_id: str,
    old_password: str,
    new_password: str,
) -> None:
    """
    Verify current password, update to new Argon2id hash in a transaction,
    and immediately revoke all active sessions for the user.
    """
    # 1. Fetch current password hash
    find_sql = "SELECT password_hash FROM users WHERE id = %s AND is_active = TRUE;"
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(find_sql, (user_id,))
            user = await cur.fetchone()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found or disabled",
        )

    # 2. Verify old password
    if not verify_password(old_password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    # 3. Hash new password with Argon2id
    new_hashed_pwd = hash_password(new_password)

    # 4. Update password and revoke all user sessions within transaction
    update_user_sql = """
        UPDATE users
        SET password_hash = %s, updated_at = CURRENT_TIMESTAMP
        WHERE id = %s;
    """
    revoke_all_sessions_sql = "DELETE FROM user_sessions WHERE user_id = %s;"

    async with get_db_transaction() as conn:
        async with conn.cursor() as cur:
            await cur.execute(update_user_sql, (new_hashed_pwd, user_id))
            await cur.execute(revoke_all_sessions_sql, (user_id,))

    logger.info(f"Password updated and all sessions revoked for user {user_id}")
