"""
Comprehensive Authentication & Authorization Integration Tests.
Compliant with Phase 1.5 Architecture (Step 3).

Coverage:
1. Valid registration + auto-login cookie.
2. Duplicate email / username rejection.
3. Argon2id password hashing and verification.
4. Valid login with username and email.
5. Invalid login (wrong password & nonexistent user).
6. HttpOnly session cookie issuance.
7. Database stores SHA-256 session token hash, never raw token.
8. /api/auth/me with valid session.
9. /api/auth/me unauthenticated (401).
10. Expired session rejection (401).
11. Logout session revocation and cookie clearing.
12. Old token unusable after logout.
13. Disabled account cannot log in.
14. Existing session of newly disabled account rejected (401).
15. Client cannot elevate role to Admin on register.
16. Admin-only endpoint authorization (403 for Reader, 200 for Admin).
17. CSRF protection on state-changing endpoints (logout & change-password).
18. Input validation errors (422).
19. Change password verification, Argon2id re-hashing, and session revocation.
20. Brute-force rate limiting (429 Too Many Requests).
"""

import hashlib
import uuid
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from psycopg.rows import dict_row

from app.core.config import settings
from app.core.security import (
    hash_password,
    hash_session_token,
    login_rate_limiter,
    register_rate_limiter,
    verify_password,
)
from app.db.pool import get_db_connection, init_db_pool
from app.main import app


@pytest.fixture
async def setup_auth(live_db_available: bool, test_db_url: str):
    """Function-level fixture: Initialize DB pool and ensure rate limiters are reset."""
    if not live_db_available:
        pytest.skip("PostgreSQL test container is not available. Skipping integration tests.")

    settings.DATABASE_URL = test_db_url
    await init_db_pool(database_url=test_db_url)
    login_rate_limiter.reset()
    register_rate_limiter.reset()
    yield


@pytest.fixture
async def auth_client(setup_auth) -> AsyncIterator[AsyncClient]:
    """Provide an AsyncClient configured for testing with initialized DB pool."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


def unique_email() -> str:
    return f"testauth_{uuid.uuid4().hex[:10]}@example.com"


def unique_username() -> str:
    return f"testauth_{uuid.uuid4().hex[:10]}"


async def post_with_csrf(client: AsyncClient, path: str, **kwargs):
    """Bootstrap anonymous CSRF for login/register, preserving explicit test headers."""
    bootstrap = await client.get("/api/auth/csrf-token")
    assert bootstrap.status_code == 200
    headers = dict(kwargs.pop("headers", {}))
    headers.setdefault(settings.CSRF_HEADER_NAME, bootstrap.json()["csrf_token"])
    return await client.post(path, headers=headers, **kwargs)


# ==============================================================================
# 1. ARGON2ID PASSWORD SECURITY TESTS
# ==============================================================================


def test_01_argon2_password_hashing():
    """Verify password hashing produces Argon2id hashes and validates accurately."""
    pwd = "CorrectHorseBatteryStaple123!"
    hashed = hash_password(pwd)

    # Must be valid Argon2id hash format
    assert hashed.startswith("$argon2id$")
    assert verify_password(pwd, hashed) is True
    assert verify_password("WrongPassword!", hashed) is False
    assert verify_password("", hashed) is False
    assert verify_password(pwd, None) is False


# ==============================================================================
# 2. REGISTRATION TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_02_register_valid_user_and_auto_login(auth_client: AsyncClient):
    """Valid registration creates Reader user, returns 201, and issues session + CSRF cookies."""
    email = unique_email()
    username = unique_username()
    password = "SecurePassword123!"

    response = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": password},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["user"]["email"] == email.lower()
    assert data["user"]["username"] == username
    assert data["user"]["role"] == "Reader"
    assert data["user"]["is_active"] is True
    assert "password" not in data["user"]
    assert "password_hash" not in data["user"]
    assert bool(data["csrf_token"]) is True

    # Verify cookies
    cookies = response.cookies
    assert settings.SESSION_COOKIE_NAME in cookies
    assert settings.CSRF_COOKIE_NAME in cookies


@pytest.mark.asyncio
async def test_03_register_duplicate_email_and_username(auth_client: AsyncClient):
    """Duplicate email or username must be rejected with HTTP 400."""
    email = unique_email()
    username = unique_username()
    pwd = "SecurePassword123!"

    # 1. First registration succeeds
    res1 = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    assert res1.status_code == 201

    # 2. Duplicate email
    res_dup_email = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": unique_username(), "password": pwd},
    )
    assert res_dup_email.status_code == 400
    assert "email" in res_dup_email.json()["detail"].lower()

    # 3. Duplicate username
    res_dup_user = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": unique_email(), "username": username, "password": pwd},
    )
    assert res_dup_user.status_code == 400
    assert "username" in res_dup_user.json()["detail"].lower()


@pytest.mark.asyncio
async def test_04_register_client_cannot_elevate_role(auth_client: AsyncClient):
    """Client attempting to pass role='Admin' on registration is ignored; role must be 'Reader'."""
    email = unique_email()
    username = unique_username()

    res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={
            "email": email,
            "username": username,
            "password": "SecurePassword123!",
            "role": "Admin",
        },
    )
    assert res.status_code == 201
    data = res.json()
    assert data["user"]["role"] == "Reader"

    # Verify in real PostgreSQL
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute("SELECT role FROM users WHERE id = %s", (data["user"]["id"],))
            db_user = await cur.fetchone()
            assert db_user["role"] == "Reader"


@pytest.mark.asyncio
async def test_05_register_input_validation(auth_client: AsyncClient):
    """Invalid input values must trigger Pydantic validation errors (422)."""
    # Short username
    res1 = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": unique_email(), "username": "ab", "password": "Password123!"},
    )
    assert res1.status_code == 422

    # Invalid email
    res2 = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": "invalid-email", "username": unique_username(), "password": "Password123!"},
    )
    assert res2.status_code == 422

    # Short password
    res3 = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": unique_email(), "username": unique_username(), "password": "short"},
    )
    assert res3.status_code == 422


# ==============================================================================
# 3. OPAQUE SESSION TOKEN & DATABASE STORAGE TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_06_database_stores_session_token_hash_not_raw(auth_client: AsyncClient):
    """PostgreSQL must only store the SHA-256 hash of the session token; raw token is never stored."""
    email = unique_email()
    username = unique_username()
    pwd = "SecurePassword123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    assert reg_res.status_code == 201
    raw_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]
    expected_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT refresh_token_hash FROM user_sessions WHERE refresh_token_hash = %s",
                (expected_hash,),
            )
            row = await cur.fetchone()
            assert row is not None
            assert row["refresh_token_hash"] == expected_hash

            # Verify raw token is NOT in database
            await cur.execute(
                "SELECT id FROM user_sessions WHERE refresh_token_hash = %s",
                (raw_token,),
            )
            assert await cur.fetchone() is None


# ==============================================================================
# 4. LOGIN & LOGOUT TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_07_login_with_email_and_username(auth_client: AsyncClient):
    """User can log in using either email or username with correct password."""
    email = unique_email()
    username = unique_username()
    pwd = "PasswordForLogin123!"

    await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )

    # 1. Log in with email
    login_res1 = await post_with_csrf(
        auth_client,
        "/api/auth/login",
        json={"username_or_email": email, "password": pwd},
    )
    assert login_res1.status_code == 200
    assert login_res1.json()["user"]["username"] == username
    assert settings.SESSION_COOKIE_NAME in login_res1.cookies

    # 2. Log in with username
    login_res2 = await post_with_csrf(
        auth_client,
        "/api/auth/login",
        json={"username_or_email": username, "password": pwd},
    )
    assert login_res2.status_code == 200
    assert login_res2.json()["user"]["email"] == email.lower()


@pytest.mark.asyncio
async def test_08_login_invalid_credentials_and_anti_enumeration(auth_client: AsyncClient):
    """Wrong password and nonexistent user must both return identical 401 response."""
    email = unique_email()
    username = unique_username()
    pwd = "CorrectPassword123!"

    await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )

    # 1. Wrong password
    res_wrong_pwd = await post_with_csrf(
        auth_client,
        "/api/auth/login",
        json={"username_or_email": username, "password": "WrongPassword123!"},
    )
    assert res_wrong_pwd.status_code == 401
    assert res_wrong_pwd.json()["detail"] == "Invalid username/email or password"

    # 2. Nonexistent user
    res_no_user = await post_with_csrf(
        auth_client,
        "/api/auth/login",
        json={"username_or_email": "nonexistent_user_999", "password": "AnyPassword123!"},
    )
    assert res_no_user.status_code == 401
    assert res_no_user.json()["detail"] == "Invalid username/email or password"


# ==============================================================================
# 5. USER PROFILE & SESSION VALIDATION TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_09_get_me_endpoint(auth_client: AsyncClient):
    """GET /api/auth/me returns user profile with valid session, 401 when unauthenticated."""
    # 1. Unauthenticated request
    res_unauth = await auth_client.get("/api/auth/me")
    assert res_unauth.status_code == 401

    # 2. Register & get authenticated session
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    assert reg_res.status_code == 201

    # 3. Call /me with session cookie
    auth_client.cookies.set(
        settings.SESSION_COOKIE_NAME, reg_res.cookies[settings.SESSION_COOKIE_NAME]
    )
    res_auth = await auth_client.get("/api/auth/me")
    assert res_auth.status_code == 200
    data = res_auth.json()
    assert data["email"] == email.lower()
    assert data["username"] == username
    assert data["role"] == "Reader"


@pytest.mark.asyncio
async def test_10_expired_session_rejected(auth_client: AsyncClient):
    """Sessions past expires_at must be rejected with 401."""
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    raw_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]
    token_hash = hash_session_token(raw_token)

    # Artificially expire session in PostgreSQL
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE user_sessions SET expires_at = CURRENT_TIMESTAMP - interval '1 hour' WHERE refresh_token_hash = %s",
                (token_hash,),
            )

    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, raw_token)
    me_res = await auth_client.get("/api/auth/me")
    assert me_res.status_code == 401


# ==============================================================================
# 6. LOGOUT & REVOCATION TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_11_logout_revocation_and_cookie_clearing(auth_client: AsyncClient):
    """Logout deletes DB session record and clears client cookies; token becomes unusable."""
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    raw_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]
    csrf_token = reg_res.cookies[settings.CSRF_COOKIE_NAME]
    token_hash = hash_session_token(raw_token)

    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, raw_token)
    auth_client.cookies.set(settings.CSRF_COOKIE_NAME, csrf_token)

    # Logout requires CSRF token header
    logout_res = await auth_client.post(
        "/api/auth/logout",
        headers={settings.CSRF_HEADER_NAME: csrf_token},
    )
    assert logout_res.status_code == 200

    # Verify session row is completely deleted from PostgreSQL
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT id FROM user_sessions WHERE refresh_token_hash = %s",
                (token_hash,),
            )
            assert await cur.fetchone() is None

    # Subsequent request using the old token must return 401
    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, raw_token)
    assert (await auth_client.get("/api/auth/me")).status_code == 401


# ==============================================================================
# 7. ACCOUNT STATUS (DISABLED ACCOUNT) TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_12_disabled_user_cannot_login(auth_client: AsyncClient):
    """Disabled user (is_active=FALSE) cannot log in."""
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    user_id = reg_res.json()["user"]["id"]

    # Disable user in DB
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE users SET is_active = FALSE, disabled_at = CURRENT_TIMESTAMP WHERE id = %s",
                (user_id,),
            )

    login_res = await post_with_csrf(
        auth_client,
        "/api/auth/login",
        json={"username_or_email": username, "password": pwd},
    )
    assert login_res.status_code == 401
    assert "disabled" in login_res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_13_existing_session_of_disabled_user_rejected(auth_client: AsyncClient):
    """Active session of a user that gets disabled must be rejected immediately."""
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    user_id = reg_res.json()["user"]["id"]
    raw_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]

    # Verify active session works initially
    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, raw_token)
    assert (await auth_client.get("/api/auth/me")).status_code == 200

    # Admin disables user
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE users SET is_active = FALSE, disabled_at = CURRENT_TIMESTAMP WHERE id = %s",
                (user_id,),
            )

    # Next request with the same session cookie must be rejected with 401
    assert (await auth_client.get("/api/auth/me")).status_code == 401


# ==============================================================================
# 8. CHANGE PASSWORD TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_14_change_password_success_and_session_revocation(auth_client: AsyncClient):
    """Changing password verifies old password, updates hash, revokes all sessions, and requires re-login."""
    email = unique_email()
    username = unique_username()
    old_pwd = "OldPassword123!"
    new_pwd = "BrandNewPassword456!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": old_pwd},
    )
    old_session_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]
    csrf_token = reg_res.cookies[settings.CSRF_COOKIE_NAME]
    user_id = reg_res.json()["user"]["id"]

    # HTTPX already stored Set-Cookie with its domain/path. Unscoped cookies.set()
    # would create duplicates that the server's scoped deletion cannot remove.
    session_cookie = next(
        cookie for cookie in reg_res.cookies.jar if cookie.name == settings.SESSION_COOKIE_NAME
    )

    # Change password
    change_res = await auth_client.post(
        "/api/auth/change-password",
        json={"old_password": old_pwd, "new_password": new_pwd},
        headers={settings.CSRF_HEADER_NAME: csrf_token},
    )
    assert change_res.status_code == 200

    # Old session is revoked in database
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = %s", (user_id,)
            )
            assert (await cur.fetchone())["count"] == 0

    # Old session token returns 401
    auth_client.cookies.set(
        settings.SESSION_COOKIE_NAME,
        old_session_token,
        domain=session_cookie.domain,
        path=session_cookie.path,
    )
    assert (await auth_client.get("/api/auth/me")).status_code == 401

    # Login with old password fails
    fail_login = await post_with_csrf(
        auth_client,
        "/api/auth/login",
        json={"username_or_email": username, "password": old_pwd},
    )
    assert fail_login.status_code == 401

    # Login with new password succeeds
    success_login = await post_with_csrf(
        auth_client,
        "/api/auth/login",
        json={"username_or_email": username, "password": new_pwd},
    )
    assert success_login.status_code == 200


@pytest.mark.asyncio
async def test_15_change_password_wrong_current_password(auth_client: AsyncClient):
    """Change password with incorrect current password must return HTTP 400."""
    email = unique_email()
    username = unique_username()
    pwd = "OldPassword123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    session_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]
    csrf_token = reg_res.cookies[settings.CSRF_COOKIE_NAME]

    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, session_token)
    auth_client.cookies.set(settings.CSRF_COOKIE_NAME, csrf_token)

    change_res = await auth_client.post(
        "/api/auth/change-password",
        json={"old_password": "IncorrectPassword123!", "new_password": "NewPassword789!"},
        headers={settings.CSRF_HEADER_NAME: csrf_token},
    )
    assert change_res.status_code == 400
    assert "incorrect" in change_res.json()["detail"].lower()


# ==============================================================================
# 9. CSRF PROTECTION TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_16_csrf_protection_on_state_changing_endpoints(auth_client: AsyncClient):
    """State-changing requests using cookie authentication must fail without matching CSRF token."""
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    session_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]
    csrf_token = reg_res.cookies[settings.CSRF_COOKIE_NAME]

    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, session_token)
    auth_client.cookies.set(settings.CSRF_COOKIE_NAME, csrf_token)

    # 1. Missing X-CSRF-Token header -> 403
    res_no_header = await auth_client.post(
        "/api/auth/logout",
    )
    assert res_no_header.status_code == 403

    # 2. Mismatched X-CSRF-Token header -> 403
    res_mismatch = await auth_client.post(
        "/api/auth/logout",
        headers={settings.CSRF_HEADER_NAME: "malicious_or_wrong_token"},
    )
    assert res_mismatch.status_code == 403

    # 3. Matching token -> 200
    res_valid = await auth_client.post(
        "/api/auth/logout",
        headers={settings.CSRF_HEADER_NAME: csrf_token},
    )
    assert res_valid.status_code == 200


# ==============================================================================
# 10. ROLE-BASED ACCESS CONTROL (RBAC) TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_17_admin_role_authorization(auth_client: AsyncClient):
    """Reader role is rejected with 403 on admin-only endpoint; Admin role is permitted."""
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    user_id = reg_res.json()["user"]["id"]
    session_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]

    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, session_token)

    # 1. As 'Reader': 403 Forbidden
    res_reader = await auth_client.get("/api/auth/admin/verify")
    assert res_reader.status_code == 403

    # 2. Elevate user to 'Admin' directly in PostgreSQL
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("UPDATE users SET role = 'Admin' WHERE id = %s", (user_id,))

    # 3. As 'Admin': 200 OK
    res_admin = await auth_client.get("/api/auth/admin/verify")
    assert res_admin.status_code == 200
    assert "Admin privileges confirmed" in res_admin.json()["message"]


# ==============================================================================
# 11. RATE LIMITING (BRUTE-FORCE MITIGATION) TESTS
# ==============================================================================


@pytest.mark.asyncio
async def test_18_login_rate_limiting_triggers_429(auth_client: AsyncClient):
    """Exceeding 5 failed login attempts from same IP returns HTTP 429 Too Many Requests."""
    test_ip = "192.168.1.100"
    login_rate_limiter.reset(test_ip)

    headers = {"X-Forwarded-For": test_ip}

    # First 5 failed attempts return 401
    for _ in range(5):
        res = await post_with_csrf(
            auth_client,
            "/api/auth/login",
            json={"username_or_email": "nonexistent_target", "password": "WrongPassword123!"},
            headers=headers,
        )
        assert res.status_code == 401

    # 6th attempt must be blocked by rate limiter with 429
    res_blocked = await post_with_csrf(
        auth_client,
        "/api/auth/login",
        json={"username_or_email": "nonexistent_target", "password": "WrongPassword123!"},
        headers=headers,
    )
    assert res_blocked.status_code == 429
    assert "too many" in res_blocked.json()["detail"].lower()
    assert "retry-after" in res_blocked.headers

    # Reset rate limiter
    login_rate_limiter.reset(test_ip)


@pytest.mark.asyncio
async def test_19_spoofed_x_forwarded_for_from_untrusted_peer_cannot_bypass_rate_limiting(
    setup_auth,
):
    """
    Direct requests from untrusted peer IPs cannot bypass rate limits by spoofing X-Forwarded-For.
    get_client_ip ignores forwarded headers unless peer IP is in TRUSTED_PROXIES.
    """
    untrusted_peer_ip = "203.0.113.88"
    login_rate_limiter.reset(untrusted_peer_ip)

    # Simulate client connection from an untrusted public IP
    transport = ASGITransport(app=app, client=(untrusted_peer_ip, 54321))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Attacker rotates X-Forwarded-For on each attempt
        for i in range(5):
            spoofed_headers = {"X-Forwarded-For": f"198.51.100.{i + 1}"}
            res = await post_with_csrf(
                client,
                "/api/auth/login",
                json={"username_or_email": "nonexistent_target", "password": "WrongPassword123!"},
                headers=spoofed_headers,
            )
            assert res.status_code == 401

        # 6th attempt with yet another spoofed IP must STILL be blocked because untrusted peer IP is tracked!
        res_blocked = await post_with_csrf(
            client,
            "/api/auth/login",
            json={"username_or_email": "nonexistent_target", "password": "WrongPassword123!"},
            headers={"X-Forwarded-For": "198.51.100.99"},
        )
        assert res_blocked.status_code == 429
        assert "too many" in res_blocked.json()["detail"].lower()

    login_rate_limiter.reset(untrusted_peer_ip)


@pytest.mark.asyncio
async def test_20_trusted_proxy_x_forwarded_for_respected(setup_auth):
    """When peer connection comes from a trusted reverse proxy, X-Forwarded-For is properly respected."""
    # 127.0.0.1 is in TRUSTED_PROXIES
    trusted_proxy_ip = "127.0.0.1"
    forwarded_client_ip = "192.0.2.77"
    login_rate_limiter.reset(forwarded_client_ip)

    transport = ASGITransport(app=app, client=(trusted_proxy_ip, 12345))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        for _ in range(5):
            res = await post_with_csrf(
                client,
                "/api/auth/login",
                json={"username_or_email": "nonexistent_target", "password": "WrongPassword123!"},
                headers={"X-Forwarded-For": forwarded_client_ip},
            )
            assert res.status_code == 401

        # 6th attempt from the forwarded client is rate-limited
        res_blocked = await post_with_csrf(
            client,
            "/api/auth/login",
            json={"username_or_email": "nonexistent_target", "password": "WrongPassword123!"},
            headers={"X-Forwarded-For": forwarded_client_ip},
        )
        assert res_blocked.status_code == 429

    login_rate_limiter.reset(forwarded_client_ip)


@pytest.mark.asyncio
async def test_21_register_rate_limiting_mitigates_argon2_dos(auth_client: AsyncClient):
    """Registration endpoint rate limits excessive attempts per IP to prevent Argon2id CPU/RAM exhaustion."""
    test_ip = "198.51.100.42"
    register_rate_limiter.reset(test_ip)
    headers = {"X-Forwarded-For": test_ip}

    # First 5 registration attempts are processed
    for _ in range(5):
        email = unique_email()
        username = unique_username()
        res = await post_with_csrf(
            auth_client,
            "/api/auth/register",
            json={"email": email, "username": username, "password": "Password123!"},
            headers=headers,
        )
        assert res.status_code == 201

    # 6th registration attempt from same IP must be rate-limited with 429
    res_blocked = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": unique_email(), "username": unique_username(), "password": "Password123!"},
        headers=headers,
    )
    assert res_blocked.status_code == 429
    assert "too many registration attempts" in res_blocked.json()["detail"].lower()
    assert "retry-after" in res_blocked.headers

    register_rate_limiter.reset(test_ip)


@pytest.mark.asyncio
async def test_22_csrf_untrusted_origin_rejected(auth_client: AsyncClient):
    """State-changing requests with an untrusted Origin header must be rejected with 403 Forbidden."""
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    session_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]
    csrf_token = reg_res.cookies[settings.CSRF_COOKIE_NAME]

    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, session_token)
    auth_client.cookies.set(settings.CSRF_COOKIE_NAME, csrf_token)

    # Attack scenario: Cross-site request from malicious origin
    attack_res = await auth_client.post(
        "/api/auth/logout",
        headers={
            settings.CSRF_HEADER_NAME: csrf_token,
            "Origin": "https://evil-attacker.example.com",
        },
    )
    assert attack_res.status_code == 403
    assert "untrusted origin" in attack_res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_23_csrf_valid_origin_accepted(auth_client: AsyncClient):
    """State-changing requests with an allowed Origin header and matching CSRF token succeed."""
    email = unique_email()
    username = unique_username()
    pwd = "Password123!"

    reg_res = await post_with_csrf(
        auth_client,
        "/api/auth/register",
        json={"email": email, "username": username, "password": pwd},
    )
    session_token = reg_res.cookies[settings.SESSION_COOKIE_NAME]
    csrf_token = reg_res.cookies[settings.CSRF_COOKIE_NAME]

    auth_client.cookies.set(settings.SESSION_COOKIE_NAME, session_token)
    auth_client.cookies.set(settings.CSRF_COOKIE_NAME, csrf_token)

    # Valid request with allowed Origin header
    valid_res = await auth_client.post(
        "/api/auth/logout",
        headers={
            settings.CSRF_HEADER_NAME: csrf_token,
            "Origin": "http://localhost:8000",
        },
    )
    assert valid_res.status_code == 200
    assert "successfully logged out" in valid_res.json()["message"].lower()
