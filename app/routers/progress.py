"""Private progress routes using the existing session and CSRF dependencies."""

import re
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response

from app.dependencies.auth import get_current_user, verify_csrf
from app.routers.private import PrivateReaderRoute
from app.schemas.progress import (
    ActivatedResume,
    CompletionInput,
    CompletionResult,
    CompletionStatuses,
    ProgressState,
    ResumeInput,
    ResumeState,
    ResumeUpdate,
)
from app.services import progress_service as service
from app.services.progress_service import ResumeVersion, progress_error

RESUME_ETAG = re.compile(r'"([0-9a-f-]{36}):(0|[1-9][0-9]{0,18})"')


class ProgressRoute(PrivateReaderRoute):
    unavailable_code = "progress_unavailable"


router = APIRouter(prefix="/api/progress/novels", tags=["progress"], route_class=ProgressRoute)
User = Annotated[dict, Depends(get_current_user)]
IfMatch = Annotated[list[str] | None, Header(alias="If-Match")]
IfNoneMatch = Annotated[list[str] | None, Header(alias="If-None-Match")]


def _precondition(if_match: list[str] | None) -> ResumeVersion:
    if if_match is None:
        raise progress_error(428, "resume_precondition_required")
    match = RESUME_ETAG.fullmatch(if_match[0]) if len(if_match) == 1 else None
    if match:
        try:
            row_id, revision = UUID(match[1]), int(match[2])
        except ValueError:
            pass
        else:
            if str(row_id) == match[1] and revision <= 2**63 - 1:
                return ResumeVersion(row_id, revision)
    raise progress_error(422, "invalid_resume_precondition")


@router.get("/{novel_id}", response_model=ProgressState)
async def progress(novel_id: UUID, user: User, include_summary: bool = False):
    return await service.read_progress(UUID(user["id"]), novel_id, include_summary)


@router.post(
    "/{novel_id}/resume/activate",
    response_model=ActivatedResume,
    responses={201: {"model": ActivatedResume}},
    dependencies=[Depends(verify_csrf)],
)
async def activate(
    novel_id: UUID,
    body: ResumeInput,
    response: Response,
    user: User,
    if_match: IfMatch = None,
    if_none_match: IfNoneMatch = None,
):
    if if_none_match is not None and (if_match is not None or if_none_match != ["*"]):
        raise progress_error(422, "invalid_resume_precondition")
    version = _precondition(if_match) if if_none_match is None else None
    result = await service.activate_resume(UUID(user["id"]), novel_id, body, version)
    response.status_code = 201 if version is None else 200
    response.headers["ETag"] = result.resume_etag
    return result


@router.put("/{novel_id}/resume", response_model=ResumeState, dependencies=[Depends(verify_csrf)])
async def update(
    novel_id: UUID,
    body: ResumeUpdate,
    response: Response,
    user: User,
    if_match: IfMatch = None,
    if_none_match: IfNoneMatch = None,
):
    if if_none_match is not None:
        raise progress_error(422, "invalid_resume_precondition")
    result = await service.update_resume(UUID(user["id"]), novel_id, body, _precondition(if_match))
    response.headers["ETag"] = result.resume_etag
    return result


@router.put(
    "/{novel_id}/completions/{chapter_id}",
    response_model=CompletionResult,
    dependencies=[Depends(verify_csrf)],
)
async def complete(novel_id: UUID, chapter_id: UUID, body: CompletionInput, user: User):
    return await service.complete_chapter(UUID(user["id"]), novel_id, chapter_id, body)


@router.get("/{novel_id}/completions", response_model=CompletionStatuses)
async def completions(
    novel_id: UUID,
    user: User,
    chapter_ids: Annotated[list[UUID], Query(min_length=1, max_length=100)],
):
    if len(set(chapter_ids)) != len(chapter_ids):
        raise progress_error(422, "duplicate_chapter_ids")
    return await service.completion_statuses(UUID(user["id"]), novel_id, chapter_ids)
