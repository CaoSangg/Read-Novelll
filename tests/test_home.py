"""Homepage HTTP checks; browser interactions are verified separately."""

import hashlib
from html.parser import HTMLParser
from pathlib import Path

import pytest


class HomeParser(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.elements = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def by_id(self, element_id):
        return next((tag, attrs) for tag, attrs in self.elements if attrs.get("id") == element_id)


@pytest.mark.asyncio
async def test_home_guest_layout_and_layers(async_client):
    response = await async_client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    parser = HomeParser(response.text)
    assert parser.by_id("home-stage")[0] == "main"
    assert parser.by_id("particles-canvas")[0] == "canvas"
    images = [attrs for tag, attrs in parser.elements if tag == "img"]
    assert len(images) == 4
    assert [image["class"] for image in images] == [
        "layer-img bg-layer",
        "layer-img sprite-layer sprite-tome",
        "layer-img sprite-layer sprite-buddha",
        "layer-img sprite-layer sprite-map",
    ]
    assert all("alt" in image for image in images)
    assert "Trang kiểm tra nền tảng Jinja2" not in response.text
    assert '<html lang="vi">' in response.text
    assert "set-cookie" not in response.headers


@pytest.mark.asyncio
async def test_home_references_served_original_images(async_client):
    parser = HomeParser((await async_client.get("/")).text)
    originals = Path(__file__).resolve().parents[1] / "images"
    for tag, attrs in parser.elements:
        if tag != "img":
            continue
        response = await async_client.get(attrs["src"])
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("image/png")
        original = originals / attrs["src"].rsplit("/", 1)[1]
        assert (
            hashlib.sha256(response.content).digest()
            == hashlib.sha256(original.read_bytes()).digest()
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path,content_type",
    [
        ("/static/css/home.css", "text/css"),
        ("/static/js/home.js", "javascript"),
    ],
)
async def test_home_serves_linked_styles_and_script(async_client, path, content_type):
    html = (await async_client.get("/")).text
    parser = HomeParser(html)
    assert any(
        attrs.get("href", attrs.get("src", "")).endswith(path) for _, attrs in parser.elements
    )
    response = await async_client.get(path)
    assert response.status_code == 200
    assert content_type in response.headers["content-type"]
    assert response.content
    scripts = [attrs for tag, attrs in parser.elements if tag == "script"]
    assert scripts == [{"src": "http://test/static/js/home.js", "defer": None}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key,title,button_text",
    [
        ("buddha", "NGỌC PHẬT", "???????????????"),
        ("map", "CỬU CHÂU SƠN HÀ ĐỒ", "Trở về"),
    ],
)
async def test_home_modal_semantics_and_original_copy(async_client, key, title, button_text):
    html = (await async_client.get("/")).text
    parser = HomeParser(html)
    _, overlay = parser.by_id(f"modal-{key}")
    assert "hidden" in overlay
    dialogs = [attrs for _, attrs in parser.elements if attrs.get("role") == "dialog"]
    assert len(dialogs) == 2
    dialog = next(attrs for attrs in dialogs if attrs["aria-labelledby"] == f"modal-title-{key}")
    assert dialog["aria-modal"] == "true"
    assert dialog["aria-describedby"] == f"modal-desc-{key}"
    assert f'<h3 id="modal-title-{key}">{title}</h3>' in html
    assert f'<p id="modal-desc-{key}">??????????????</p>' in html
    assert f"data-modal-close>{button_text}</button>" in html
    triggers = [
        attrs
        for tag, attrs in parser.elements
        if tag == "button" and attrs.get("data-modal-open") == key
    ]
    assert len(triggers) == 1
    assert triggers[0]["aria-controls"] == overlay["id"]
    assert triggers[0]["aria-haspopup"] == "dialog"


@pytest.mark.asyncio
async def test_read_link_preserves_source_and_is_not_a_fake_reader(async_client):
    parser = HomeParser((await async_client.get("/")).text)
    links = [attrs for tag, attrs in parser.elements if tag == "a"]
    assert len(links) == 1
    href = links[0]["href"]
    assert href == "/novel/khau-van-tien-dao/1"
    source = (Path(__file__).resolve().parents[1] / "src/app/page.tsx").read_text(encoding="utf-8")
    assert f'href="{href}"' in source
    # Reader now uses PostgreSQL; no initialized pool must not serve fake content.
    assert (await async_client.get(href)).status_code == 503


@pytest.mark.asyncio
async def test_home_ignores_client_navigation_and_auth_input(async_client):
    response = await async_client.get("/?returnUrl=https://untrusted.invalid/&role=Admin")
    assert response.status_code == 200
    assert "untrusted.invalid" not in response.text
    assert 'href="/novel/khau-van-tien-dao/1"' in response.text
    assert "password_hash" not in response.text
    assert "refresh_token_hash" not in response.text
    assert "DATABASE_URL" not in response.text
