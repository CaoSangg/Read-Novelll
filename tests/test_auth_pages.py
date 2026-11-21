"""Authentication page contracts and the existing cookie/CSRF API integration."""

import uuid
from html.parser import HTMLParser

import pytest

from app.core.config import settings
from app.core.security import login_rate_limiter, register_rate_limiter
from app.db.pool import get_db_connection, init_db_pool


class AuthParser(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.elements = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def by_id(self, value):
        return next(attrs for _, attrs in self.elements if attrs.get("id") == value)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["login", "register"])
async def test_auth_page_semantics_assets_and_public_shell(async_client, mode):
    response = await async_client.get(f"/{mode}")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-store"
    assert '<html lang="vi">' in response.text
    assert '<meta name="viewport"' in response.text
    assert "{%" not in response.text
    parser = AuthParser(response.text)
    form = parser.by_id("auth-form")
    assert form["action"] == f"/api/auth/{mode}"
    assert form["method"] == "post"
    assert form["data-csrf-header"] == settings.CSRF_HEADER_NAME
    inputs = [attrs for tag, attrs in parser.elements if tag == "input"]
    names = {attrs["name"] for attrs in inputs}
    assert names == (
        {"username", "email", "password", "confirm_password"}
        if mode == "register"
        else {"username_or_email", "password"}
    )
    labels = {attrs["for"] for tag, attrs in parser.elements if tag == "label"}
    assert {attrs["id"] for attrs in inputs} == labels
    for attrs in inputs:
        assert "required" in attrs
        assert "value" not in attrs
        for described in attrs["aria-describedby"].split():
            parser.by_id(described)
    assert parser.by_id("password")["minlength"] == ("8" if mode == "register" else "1")
    assert parser.by_id("password")["maxlength"] == "128"
    assert parser.by_id("auth-error")["role"] == "alert"
    assert parser.by_id("auth-status")["aria-live"] == "polite"
    assert "disabled" in parser.by_id("auth-submit")  # Safe until JS binds submit.
    for path, content_type in [
        ("css/base.css", "text/css"),
        ("css/auth.css", "text/css"),
        ("js/auth.js", "javascript"),
    ]:
        assert f"/static/{path}" in response.text
        asset = await async_client.get(f"/static/{path}")
        assert asset.status_code == 200
        assert content_type in asset.headers["content-type"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["login", "register"])
@pytest.mark.parametrize(
    "target",
    [
        "https://evil.invalid",
        "//evil.invalid",
        "/\\evil.invalid",
        "/login",
        "/register",
        "/novel/missing/1",
    ],
)
async def test_auth_pages_do_not_reflect_redirects_or_secrets(
    async_client, monkeypatch, mode, target
):
    sentinel = "private-auth-setting-sentinel"
    monkeypatch.setattr(settings, "SECRET_KEY", sentinel)
    async_client.cookies.set(settings.SESSION_COOKIE_NAME, sentinel)
    response = await async_client.get(f"/{mode}", params={"returnUrl": target, "next": target})
    assert response.status_code == 200
    assert sentinel not in response.text
    assert "evil.invalid" not in response.text
    assert "password_hash" not in response.text
    assert "refresh_token_hash" not in response.text
    assert "set-cookie" not in response.headers
    links = [attrs["href"] for tag, attrs in AuthParser(response.text).elements if tag == "a"]
    assert links == ["/", "/register" if mode == "login" else "/login"]


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        ("/novel/Truyện/100", "/novel/Truy%E1%BB%87n/100?reader_entry=auth"),
        ("//evil.invalid/novel/book/1", ""),
        ("/novel/book/2147483648", ""),
        ("/novel/book/1?evil=1", ""),
        ("/novel/book%2f..%2f/1", ""),
        ("/novel/../1", ""),
    ],
)
async def test_auth_reader_return_is_allowlisted(async_client, target, expected):
    for mode in ("login", "register"):
        response = await async_client.get(f"/{mode}", params={"reader_return": target})
        parser = AuthParser(response.text)
        assert parser.by_id("auth-form")["data-reader-return"] == expected
        alternate = next(
            attrs["href"] for tag, attrs in parser.elements if tag == "a" and attrs["href"] != "/"
        )
        assert ("?reader_return=" in alternate) is bool(expected)


@pytest.mark.asyncio
async def test_csrf_bootstrap_and_existing_protected_routes(async_client):
    issued = await async_client.get("/api/auth/csrf-token")
    assert issued.status_code == 200
    token = issued.json()["csrf_token"]
    assert token == async_client.cookies.get(settings.CSRF_COOKIE_NAME)
    assert (await async_client.post("/api/auth/logout")).status_code == 403
    assert (
        await async_client.post("/api/auth/logout", headers={settings.CSRF_HEADER_NAME: "wrong"})
    ).status_code == 403
    assert (
        await async_client.post(
            "/api/auth/logout",
            headers={settings.CSRF_HEADER_NAME: token, "Origin": "https://evil.invalid"},
        )
    ).status_code == 403
    assert (await async_client.get("/api/auth/me")).status_code == 401
    assert (await async_client.get("/api/health")).status_code == 200
    assert (await async_client.get("/api/health/readiness")).status_code == 503


@pytest.mark.asyncio
async def test_page_field_mapping_to_real_session_api(
    async_client, live_db_available, test_db_url, monkeypatch
):
    if not live_db_available:
        pytest.skip("PostgreSQL test database unavailable; real form/API integration not tested.")
    monkeypatch.setattr(settings, "DATABASE_URL", test_db_url)
    await init_db_pool(database_url=test_db_url)
    login_rate_limiter.reset()
    register_rate_limiter.reset()
    username = f"testpage_{uuid.uuid4().hex[:12]}"
    email = f"{username}@example.com"
    password = "PageIntegration123!"
    user_id = None
    try:
        register = AuthParser((await async_client.get("/register")).text)
        fields = {attrs["name"] for tag, attrs in register.elements if tag == "input"}
        payload = {
            name: value
            for name, value in {"username": username, "email": email, "password": password}.items()
            if name in fields
        }
        token = (await async_client.get("/api/auth/csrf-token")).json()["csrf_token"]
        response = await async_client.post(
            register.by_id("auth-form")["action"],
            json=payload,
            headers={settings.CSRF_HEADER_NAME: token},
        )
        assert response.status_code == 201
        user_id = response.json()["user"]["id"]
        assert response.json()["user"]["role"] == "Reader"
        assert any(
            "httponly" in cookie.lower() for cookie in response.headers.get_list("set-cookie")
        )
        assert (await async_client.get("/api/auth/me")).json()["id"] == user_id
        assert (await async_client.post("/api/auth/logout")).status_code == 403
        token = response.json()["csrf_token"]
        assert (
            await async_client.post("/api/auth/logout", headers={settings.CSRF_HEADER_NAME: token})
        ).status_code == 200
        assert (await async_client.get("/api/auth/me")).status_code == 401
        login = AuthParser((await async_client.get("/login")).text)
        token = (await async_client.get("/api/auth/csrf-token")).json()["csrf_token"]
        response = await async_client.post(
            login.by_id("auth-form")["action"],
            json={login.by_id("identifier")["name"]: username, "password": password},
            headers={settings.CSRF_HEADER_NAME: token},
        )
        assert response.status_code == 200
        assert (await async_client.get("/api/auth/me")).json()["id"] == user_id
    finally:
        # Delete only this test's unique account and its sessions, including after failure.
        async with get_db_connection() as conn:
            await conn.execute(
                "DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE username = %s AND email = %s)",
                (username, email),
            )
            await conn.execute(
                "DELETE FROM users WHERE username = %s AND email = %s", (username, email)
            )
        login_rate_limiter.reset()
        register_rate_limiter.reset()
