"""Authenticated chapter bookmarks using the existing session and CSRF dependencies."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response

from app.dependencies.auth import get_current_user, verify_csrf
from app.routers.private import PrivateReaderRoute
from app.schemas.bookmarks import BookmarkList, BookmarkStatus
from app.services import bookmark_service as service
from app.services.bookmark_service import bookmark_error


class BookmarkRoute(PrivateReaderRoute):
    unavailable_code = "bookmarks_unavailable"


router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"], route_class=BookmarkRoute)
User = Annotated[dict, Depends(get_current_user)]
ChapterPath = "/novels/{novel_id}/chapters/{chapter_id}"


async def _empty_mutation(request: Request) -> None:
    if request.query_params or await request.body():
        raise bookmark_error(422, "invalid_request")


@router.get("/novels/{novel_id}", response_model=BookmarkList)
async def list_bookmarks(
    novel_id: UUID,
    request: Request,
    user: User,
    page: Annotated[int, Query(ge=1, le=2_147_483_647)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 50,
):
    if set(request.query_params) - {"page", "page_size"}:
        raise bookmark_error(422, "invalid_request")
    return await service.list_bookmarks(UUID(user["id"]), novel_id, page, page_size)


@router.get(ChapterPath, response_model=BookmarkStatus)
async def bookmark_status(novel_id: UUID, chapter_id: UUID, request: Request, user: User):
    if request.query_params:
        raise bookmark_error(422, "invalid_request")
    return await service.bookmark_status(UUID(user["id"]), novel_id, chapter_id)


@router.put(
    ChapterPath, status_code=204, dependencies=[Depends(verify_csrf), Depends(_empty_mutation)]
)
async def put_bookmark(novel_id: UUID, chapter_id: UUID, user: User) -> Response:
    await service.put_bookmark(UUID(user["id"]), novel_id, chapter_id)
    return Response(status_code=204)


@router.delete(
    ChapterPath, status_code=204, dependencies=[Depends(verify_csrf), Depends(_empty_mutation)]
)
async def remove_bookmark(novel_id: UUID, chapter_id: UUID, user: User) -> Response:
    await service.remove_bookmark(UUID(user["id"]), novel_id, chapter_id)
    return Response(status_code=204)
