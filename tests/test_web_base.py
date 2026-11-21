"""HTML/static smoke checks independent of PostgreSQL availability."""

from html.parser import HTMLParser

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from app.core.config import settings
from app.main import create_app
from app.routers.web import templates


class StylesheetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stylesheets = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "link" and attributes.get("rel") == "stylesheet":
            self.stylesheets.append(attributes["href"])


@pytest.mark.asyncio
async def test_root_renders_inherited_html(async_client):
    response = await async_client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    # Shell from base and content/title from the child must both render.
    assert '<html lang="vi">' in response.text
    assert '<meta name="viewport"' in response.text
    assert "<title>Khấu Vấn Tiên Đạo</title>" in response.text
    assert '<main class="home-page"' in response.text
    assert 'id="particles-canvas"' in response.text
    assert "{%" not in response.text


@pytest.mark.asyncio
async def test_stylesheet_link_is_served(async_client):
    parser = StylesheetParser()
    parser.feed((await async_client.get("/")).text)
    local_stylesheets = [url for url in parser.stylesheets if url.startswith("http://test/static/")]
    assert local_stylesheets
    for url in local_stylesheets:
        response = await async_client.get(url)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/css")
        assert response.text.strip()
    # The inherited global stylesheet remains present alongside page-specific CSS.
    assert "http://test/static/css/base.css" in local_stylesheets
    base_css = await async_client.get("/static/css/base.css")
    assert "--background: #020305" in base_css.text


@pytest.mark.asyncio
async def test_templates_and_static_are_independent_of_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/")).status_code == 200
        assert (await client.get("/static/css/base.css")).status_code == 200


def test_inherited_template_autoescapes_context():
    app = create_app()
    request = Request(
        {
            "type": "http",
            "app": app,
            "router": app.router,
            "scheme": "http",
            "server": ("test", 80),
            "path": "/",
            "root_path": "",
            "headers": [],
        }
    )
    response = templates.TemplateResponse(
        request=request,
        name="foundation.html",
        context={"page_title": '<script>alert("unsafe")</script>'},
    )
    body = response.body.decode()
    assert "<script>" not in body
    assert "&lt;script&gt;" in body


@pytest.mark.asyncio
async def test_root_does_not_serialize_secrets_or_cookies(async_client, monkeypatch):
    secret_sentinel = "private-setting-must-stay-server-side"
    cookie_sentinel = "private-cookie-must-stay-server-side"
    monkeypatch.setattr(settings, "SECRET_KEY", secret_sentinel)
    monkeypatch.setattr(settings, "DATABASE_URL", secret_sentinel)
    async_client.cookies.set(settings.SESSION_COOKIE_NAME, cookie_sentinel)
    response = await async_client.get("/")
    assert response.status_code == 200
    assert secret_sentinel not in response.text
    assert cookie_sentinel not in response.text
    assert "password_hash" not in response.text
    assert "refresh_token_hash" not in response.text
    assert "set-cookie" not in response.headers


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "/static/.env",
        "/static/db/migrations/001_init_schema_v3_2.sql",
        "/static/app/core/config.py",
        "/static/%2e%2e/templates/base.html",
        "/static/%2e%2e/%2e%2e/.env",
        "/static/mock-chapters.json",
    ],
)
async def test_static_does_not_expose_project_files(async_client, path):
    assert (await async_client.get(path)).status_code == 404


@pytest.mark.asyncio
async def test_web_does_not_shadow_auth_or_health(async_client):
    assert (await async_client.get("/")).status_code == 200
    me = await async_client.get("/api/auth/me")
    assert me.status_code == 401
    assert me.headers["content-type"].startswith("application/json")
    # Invalid payload never reaches DB or performs a login attempt.
    csrf = (await async_client.get("/api/auth/csrf-token")).json()["csrf_token"]
    assert (
        await async_client.post(
            "/api/auth/login", json={}, headers={settings.CSRF_HEADER_NAME: csrf}
        )
    ).status_code == 422
    assert (await async_client.get("/api/health")).json()["status"] == "ok"
    # ASGITransport does not start lifespan: no initialized pool, so readiness is 503.
    readiness = await async_client.get("/api/health/readiness")
    assert readiness.status_code == 503
    assert readiness.json()["database"] == "disconnected"
