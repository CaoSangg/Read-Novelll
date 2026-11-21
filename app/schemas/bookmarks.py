"""Private chapter bookmark contracts."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.schemas.novel import Pagination


class BookmarkEntry(BaseModel):
    chapter_id: UUID
    created_at: datetime | None
    available: bool
    chapter_sequence: int | None
    chapter_number: str | None
    title: str | None
    url: str | None


class BookmarkList(Pagination):
    novel_id: UUID
    items: list[BookmarkEntry]


class BookmarkStatus(BaseModel):
    chapter_id: UUID
    available: bool
    bookmarked: bool
