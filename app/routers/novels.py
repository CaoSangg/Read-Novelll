"""Guest-readable novel metadata and published chapter content; no mutation routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Path, Query, Response

from app.schemas.novel import (
    ChapterList,
    ChapterRead,
    NovelList,
    NovelMetadata,
    PublishedChapterRevision,
)
from app.services import novel_service

router = APIRouter(prefix="/api/novels", tags=["novels"])
Page = Annotated[int, Query(ge=1, le=2_147_483_647)]
PageSize = Annotated[int, Query(ge=1, le=100)]
# Preserve existing database slugs, including Unicode; reject path/control characters.
Slug = Annotated[str, Path(min_length=1, max_length=255, pattern=r"^[\w-]+$")]


@router.get("", response_model=NovelList)
async def novels(page: Page = 1, page_size: PageSize = 50):
    return await novel_service.list_novels(page, page_size)


@router.get("/{slug}", response_model=NovelMetadata)
async def novel(slug: Slug):
    return await novel_service.get_novel_by_slug(slug)


@router.get("/{slug}/chapters", response_model=ChapterList)
async def chapters(slug: Slug, page: Page = 1, page_size: PageSize = 50):
    return await novel_service.list_published_chapters(slug, page, page_size)


@router.get("/{slug}/chapters/{sequence}", response_model=ChapterRead)
async def chapter(slug: Slug, sequence: Annotated[int, Path(ge=1, le=2_147_483_647)]):
    return await novel_service.get_published_chapter(slug, sequence)


@router.get("/{slug}/chapters/by-id/{chapter_id}/revision", response_model=PublishedChapterRevision)
async def chapter_revision(slug: Slug, chapter_id: UUID, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return await novel_service.get_published_chapter_revision(slug, chapter_id)
