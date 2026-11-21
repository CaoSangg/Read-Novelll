"""Authenticated reading progress contracts."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.content_revision import HASH_SCHEME


class ContentRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scheme: Literal[HASH_SCHEME]
    hash: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$", min_length=64, max_length=64)]


class ResumeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chapter_id: UUID
    content_revision: ContentRevision
    scroll_position: Annotated[float, Field(strict=True, ge=0, le=1, allow_inf_nan=False)]


class ResumeUpdate(ResumeInput):
    writer_epoch: UUID


class CompletionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content_revision: ContentRevision
    confirmation: Annotated[bool, Field(strict=True)]


class ResumePosition(BaseModel):
    available: bool
    chapter_id: UUID | None
    chapter_sequence: int | None
    url: str | None
    scroll_position: float
    content_revision: ContentRevision | None
    updated_at: datetime | None


class ResumeState(BaseModel):
    resume: ResumePosition | None
    resume_etag: str | None


class ActivatedResume(ResumeState):
    writer_epoch: UUID


class CompletionSummary(BaseModel):
    highest_confirmed_sequence: int | None
    contiguous_confirmed_through_sequence: int | None


class ProgressState(ResumeState):
    novel_id: UUID
    completion_summary: CompletionSummary | None = None


class ChapterCompletionStatus(BaseModel):
    chapter_id: UUID
    chapter_sequence: int
    content_revision: ContentRevision
    status: Literal["not_completed", "completed", "old_revision"]


class CompletionStatuses(BaseModel):
    items: list[ChapterCompletionStatus]


class CompletionResult(BaseModel):
    chapter_id: UUID
    chapter_sequence: int
    content_revision: ContentRevision
    completed_at: datetime
    already_completed: bool
