"""Public web pages; only the Reader requires published PostgreSQL chapter data."""

import re
from pathlib import Path
from typing import Annotated
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Request
from fastapi import Path as PathParam
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from app.core.config import settings
from app.core.content_revision import HASH_SCHEME, content_digest
from app.services.novel_service import get_published_chapter, get_published_chapter_page

router = APIRouter(tags=["web"])

# Jinja2Templates enables select_autoescape() for HTML by default.
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parents[1] / "templates"))


# Preserved from the trusted link in src/app/page.tsx; the Reader resolves its
# novel and chapter from PostgreSQL, without assuming IDs or stored progress.
HOME_READ_URL = "/novel/khau-van-tien-dao/1"
READER_RETURN_PATH = re.compile(r"/novel/([\w-]{1,255})/([1-9][0-9]{0,9})")


@router.get("/", response_class=HTMLResponse, name="web_home")
async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="home.html",
        context={"page_title": "Khấu Vấn Tiên Đạo", "read_url": HOME_READ_URL},
    )


@router.get("/novel/{slug}/{sequence}", response_class=HTMLResponse, name="web_reader")
async def reader(
    request: Request,
    slug: Annotated[str, PathParam(min_length=1, max_length=255, pattern=r"^[\w-]+$")],
    sequence: Annotated[int, PathParam(ge=1, le=2_147_483_647)],
):
    data = await get_published_chapter(slug, sequence)
    toc_page = await get_published_chapter_page(slug, sequence)
    canonical_content = data.chapter.content
    revision = content_digest(canonical_content).hex()
    # Normalize newline spelling only for rendering; never write content back.
    content = canonical_content.replace("\r\n", "\n").replace("\r", "\n")
    return templates.TemplateResponse(
        request=request,
        name="reader.html",
        context={
            "reader": data,
            "paragraphs": content.split("\n\n"),
            "toc_page": toc_page,
            "revision_hash": revision,
            "revision_scheme": HASH_SCHEME,
            "reader_auth_query": urlencode({"reader_return": f"/novel/{slug}/{sequence}"}),
            # Only a hint: the controller still verifies the HttpOnly session with /me.
            "resume_candidate": bool(request.cookies.get(settings.SESSION_COOKIE_NAME)),
            "csrf_header_name": settings.CSRF_HEADER_NAME,
            "csrf_cookie_name": settings.CSRF_COOKIE_NAME,
        },
        headers={"Vary": "Cookie"},
    )


@router.get("/login", response_class=HTMLResponse, name="web_login")
async def login_page(request: Request):
    return auth_page(request, "login")


@router.get("/register", response_class=HTMLResponse, name="web_register")
async def register_page(request: Request):
    return auth_page(request, "register")


def auth_page(request: Request, mode: str):
    match = READER_RETURN_PATH.fullmatch(request.query_params.get("reader_return", ""))
    reader_return = ""
    auth_query = ""
    if match and int(match[2]) <= 2_147_483_647:
        reader_return = f"/novel/{quote(match[1], safe='')}/{match[2]}?reader_entry=auth"
        auth_query = "?" + urlencode({"reader_return": match[0]})
    return templates.TemplateResponse(
        request=request,
        name=f"{mode}.html",
        context={
            "csrf_header_name": settings.CSRF_HEADER_NAME,
            "reader_return": reader_return,
            "reader_auth_query": auth_query,
        },
        headers={"Cache-Control": "no-store", "Referrer-Policy": "same-origin"},
    )
