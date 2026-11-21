"""Exercise real CSRF routing without a database; only auth services are stubbed."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from test_auth import post_with_csrf

from app.core.config import settings
from app.core.security import generate_csrf_token, generate_session_token
from app.dependencies import auth as auth_dependencies
from app.services import auth_service


@pytest.fixture
def auth_services(monkeypatch):
    """Do not bypass verify_csrf, token issuance, response schemas, or cookie setters."""
    user = {
        "id": "e9a8589c-396f-48dd-b0be-3bb3b90f7eaa",
        "username": "csrf_reader",
        "email": "csrf_reader@example.com",
        "role": "Reader",
        "is_active": True,
        "created_at": datetime.now(timezone.utc),
    }
    session = generate_session_token()
    rotated_csrf = generate_csrf_token()
    mocks = {}
    for mode, service in [("login", "authenticate_user"), ("register", "register_user")]:
        mocks[mode] = AsyncMock(return_value=(user, session, rotated_csrf))
        monkeypatch.setattr(auth_service, service, mocks[mode])
    return mocks, session, rotated_csrf


def payload(mode):
    if mode == "register":
        return {
            "username": "csrf_reader",
            "email": "csrf_reader@example.com",
            "password": "CsrfRegression123!",
        }
    return {"username_or_email": "csrf_reader", "password": "CsrfRegression123!"}


async def bootstrap(client):
    response = await client.get("/api/auth/csrf-token")
    assert response.status_code == 200
    return response.json()["csrf_token"]


@pytest.mark.asyncio
async def test_guest_bootstrap_requires_no_session_and_rotates_cookie(async_client):
    assert settings.SESSION_COOKIE_NAME not in async_client.cookies
    first = await bootstrap(async_client)
    assert async_client.cookies.get(settings.CSRF_COOKIE_NAME) == first
    second = await bootstrap(async_client)
    assert first != second
    assert async_client.cookies.get(settings.CSRF_COOKIE_NAME) == second
    assert settings.SESSION_COOKIE_NAME not in async_client.cookies
    assert (await async_client.get("/api/auth/me")).status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["login", "register"])
@pytest.mark.parametrize(
    "failure",
    [
        "missing_both",
        "missing_header",
        "missing_cookie",
        "empty_header",
        "mismatch",
        "stale",
        "origin",
        "referer",
        "null_origin",
    ],
)
async def test_anonymous_csrf_rejected_before_auth_service(
    async_client, auth_services, mode, failure
):
    mocks, _, _ = auth_services
    headers = {}
    if failure != "missing_both":
        token = await bootstrap(async_client)
        headers[settings.CSRF_HEADER_NAME] = token
        if failure == "missing_header":
            headers.clear()
        elif failure == "missing_cookie":
            async_client.cookies.clear()
        elif failure == "empty_header":
            headers[settings.CSRF_HEADER_NAME] = ""
        elif failure == "mismatch":
            headers[settings.CSRF_HEADER_NAME] = "hardcoded-forged-header"
        elif failure == "stale":
            await bootstrap(async_client)  # Cookie rotates; old header is now invalid.
        elif failure == "origin":
            headers["Origin"] = "https://untrusted.invalid"
            headers["Referer"] = "http://localhost:8000/login"
        elif failure == "referer":
            headers["Referer"] = "https://untrusted.invalid/form"
        elif failure == "null_origin":
            headers["Origin"] = "null"
    response = await async_client.post(f"/api/auth/{mode}", json=payload(mode), headers=headers)
    assert response.status_code == 403
    assert "CSRF validation failed" in response.json()["detail"]
    assert "set-cookie" not in response.headers
    mocks["login"].assert_not_awaited()
    mocks["register"].assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["login", "register"])
@pytest.mark.parametrize(
    "origin_headers",
    [{}, {"Origin": "http://localhost:8000"}, {"Referer": "http://127.0.0.1:8000/login"}],
    ids=["no-origin-or-referer", "allowed-origin", "allowed-referer"],
)
async def test_valid_anonymous_csrf_preserves_success_schema_and_cookies(
    async_client, auth_services, mode, origin_headers
):
    mocks, session, rotated_csrf = auth_services
    token = await bootstrap(async_client)
    assert settings.SESSION_COOKIE_NAME not in async_client.cookies
    response = await async_client.post(
        f"/api/auth/{mode}",
        json=payload(mode),
        headers={settings.CSRF_HEADER_NAME: token, **origin_headers},
    )
    assert response.status_code == (201 if mode == "register" else 200)
    mocks[mode].assert_awaited_once()
    assert set(response.json()) == {"user", "csrf_token", "message"}
    assert response.json()["user"]["role"] == "Reader"
    assert response.json()["csrf_token"] == rotated_csrf
    assert token != rotated_csrf
    assert session not in response.text
    assert "password_hash" not in response.text
    assert response.cookies[settings.SESSION_COOKIE_NAME] == session
    assert response.cookies[settings.CSRF_COOKIE_NAME] == rotated_csrf
    session_cookie = next(
        cookie
        for cookie in response.headers.get_list("set-cookie")
        if cookie.startswith(f"{settings.SESSION_COOKIE_NAME}=")
    )
    assert "httponly" in session_cookie.lower()
    assert "samesite=lax" in session_cookie.lower()
    assert "path=/" in session_cookie.lower()
    assert f"max-age={settings.SESSION_EXPIRE_DAYS * 86400}" in session_cookie.lower()
    assert ("; secure" in session_cookie.lower()) == settings.is_production


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["login", "register"])
async def test_valid_csrf_keeps_payload_validation(async_client, auth_services, mode):
    mocks, _, _ = auth_services
    token = await bootstrap(async_client)
    response = await async_client.post(
        f"/api/auth/{mode}", json={}, headers={settings.CSRF_HEADER_NAME: token}
    )
    assert response.status_code == 422
    mocks[mode].assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,status,detail",
    [
        ("login", 401, "Invalid username/email or password"),
        ("login", 429, "Too many failed login attempts. Please try again later."),
        ("register", 400, "Email is already registered"),
        ("register", 429, "Too many registration attempts. Please try again later."),
    ],
)
async def test_valid_csrf_preserves_service_errors(
    async_client, auth_services, mode, status, detail
):
    mocks, _, _ = auth_services
    headers = {"Retry-After": "60"} if status == 429 else None
    mocks[mode].side_effect = HTTPException(status_code=status, detail=detail, headers=headers)
    token = await bootstrap(async_client)
    response = await async_client.post(
        f"/api/auth/{mode}", json=payload(mode), headers={settings.CSRF_HEADER_NAME: token}
    )
    assert response.status_code == status
    assert response.json()["detail"] == detail
    if status == 429:
        assert response.headers["Retry-After"] == "60"
    assert settings.SESSION_COOKIE_NAME not in response.cookies


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["logout", "change-password"])
@pytest.mark.parametrize("failure", ["missing", "mismatch", "origin"])
async def test_existing_state_changing_routes_still_require_csrf(async_client, path, failure):
    headers = {}
    if failure != "missing":
        token = await bootstrap(async_client)
        headers[settings.CSRF_HEADER_NAME] = token if failure == "origin" else "wrong"
        if failure == "origin":
            headers["Origin"] = "https://untrusted.invalid"
    response = await async_client.post(
        f"/api/auth/{path}",
        json={"old_password": "OldPassword123!", "new_password": "NewPassword123!"},
        headers=headers,
    )
    assert response.status_code == 403
    assert "CSRF" in response.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unscoped_duplicate", [False, True], ids=["browser-cookie-scope", "legacy-unscoped-duplicate"]
)
async def test_csrf_bootstrap_after_change_password_and_revoked_session(
    async_client, auth_services, monkeypatch, unscoped_duplicate
):
    """Real cookie lifecycle/CSRF; auth and session storage are simulated without PostgreSQL."""
    mocks, old_session, _ = auth_services
    user = mocks["register"].return_value[0]
    revoked = False

    async def current_user(token):
        return user if token == old_session and not revoked else None

    async def change_password(**kwargs):
        nonlocal revoked
        revoked = True

    async def login(**kwargs):
        if kwargs["password"] == "OldPassword123!":
            raise HTTPException(status_code=401, detail="Invalid username/email or password")
        return user, generate_session_token(), generate_csrf_token()

    monkeypatch.setattr(auth_dependencies, "get_user_by_session_token", current_user)
    change = AsyncMock(side_effect=change_password)
    monkeypatch.setattr(auth_service, "change_user_password", change)
    mocks["login"].side_effect = login

    register = await post_with_csrf(async_client, "/api/auth/register", json=payload("register"))
    assert register.status_code == 201
    session_cookie = next(
        cookie for cookie in register.cookies.jar if cookie.name == settings.SESSION_COOKIE_NAME
    )
    if unscoped_duplicate:
        # Reproduce test 14's old mistake; retain it to prove why scoped deletion matters.
        async_client.cookies.set(settings.CSRF_COOKIE_NAME, register.json()["csrf_token"])
    changed = await async_client.post(
        "/api/auth/change-password",
        json={"old_password": "OldPassword123!", "new_password": "NewPassword123!"},
        headers={settings.CSRF_HEADER_NAME: register.json()["csrf_token"]},
    )
    assert changed.status_code == 200
    change.assert_awaited_once()
    assert revoked
    assert settings.SESSION_COOKIE_NAME not in async_client.cookies
    assert sum(
        cookie.name == settings.CSRF_COOKIE_NAME for cookie in async_client.cookies.jar
    ) == int(unscoped_duplicate)

    # Replay only the revoked session, using the server's original cookie scope.
    async_client.cookies.set(
        settings.SESSION_COOKIE_NAME,
        old_session,
        domain=session_cookie.domain,
        path=session_cookie.path,
    )
    before_me = [(cookie.name, cookie.domain, cookie.path) for cookie in async_client.cookies.jar]
    me = await async_client.get("/api/auth/me")
    assert me.status_code == 401
    assert "set-cookie" not in me.headers
    assert [
        (cookie.name, cookie.domain, cookie.path) for cookie in async_client.cookies.jar
    ] == before_me

    failed = await post_with_csrf(
        async_client,
        "/api/auth/login",
        json={"username_or_email": user["username"], "password": "OldPassword123!"},
    )
    # Inspect the final request as ASGI/Starlette sees it, without logging token values.
    request = Request(
        {
            "type": "http",
            "headers": [(name.lower(), value) for name, value in failed.request.headers.raw],
        }
    )
    matches = (
        request.cookies.get(settings.CSRF_COOKIE_NAME) == request.headers[settings.CSRF_HEADER_NAME]
    )
    assert matches is (not unscoped_duplicate)
    if unscoped_duplicate:
        assert failed.status_code == 403
        assert failed.json()["detail"] == "CSRF validation failed: missing or invalid CSRF token."
        mocks["login"].assert_not_awaited()
    else:
        assert failed.status_code == 401
        mocks["login"].assert_awaited_once()
        succeeded = await post_with_csrf(
            async_client,
            "/api/auth/login",
            json={"username_or_email": user["username"], "password": "NewPassword123!"},
        )
        assert succeeded.status_code == 200
        assert mocks["login"].await_count == 2
