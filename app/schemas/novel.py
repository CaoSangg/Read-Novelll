"""Public metadata and explicitly requested published chapter content."""

from uuid import UUID

from pydantic import BaseModel

from app.schemas.progress import ContentRevision


class NovelMetadata(BaseModel):
    id: UUID
    slug: str
    title: str
    author: str
    description: str | None
    cover_image_url: str | None
    published_chapter_count: int


class ChapterMetadata(BaseModel):
    id: UUID
    chapter_sequence: int
    chapter_number: str
    title: str


class Pagination(BaseModel):
    page: int
    page_size: int
    total: int
    total_pages: int


class NovelList(Pagination):
    items: list[NovelMetadata]


class ChapterList(Pagination):
    novel_slug: str
    items: list[ChapterMetadata]


class ReaderNovel(BaseModel):
    id: UUID
    slug: str
    title: str


class PublishedChapter(ChapterMetadata):
    content: str


class PublishedChapterRevision(ChapterMetadata):
    novel_id: UUID
    content_revision: ContentRevision


class ChapterNavigation(BaseModel):
    previous: ChapterMetadata | None
    next: ChapterMetadata | None


class ChapterRead(BaseModel):
    novel: ReaderNovel
    chapter: PublishedChapter
    navigation: ChapterNavigation
