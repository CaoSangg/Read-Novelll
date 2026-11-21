"""Owner-scoped Resume and explicit completion evidence on the existing pool."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import quote
from uuid import UUID, uuid4

import psycopg
from fastapi import HTTPException
from psycopg import AsyncCursor
from psycopg.rows import dict_row
from psycopg_pool import PoolClosed, PoolTimeout

from app.core.content_revision import HASH_SCHEME, content_digest
from app.db.pool import get_db_transaction, get_pool
from app.schemas.progress import (
    ActivatedResume,
    ChapterCompletionStatus,
    CompletionInput,
    CompletionResult,
    CompletionStatuses,
    CompletionSummary,
    ContentRevision,
    ProgressState,
    ResumeInput,
    ResumePosition,
    ResumeState,
    ResumeUpdate,
)


@dataclass(frozen=True)
class ResumeVersion:
    row_id: UUID
    revision: int


def progress_error(status: int, code: str) -> HTTPException:
    return HTTPException(status, detail={"code": code})


@asynccontextmanager
async def _cursor(*, write: bool = False) -> AsyncIterator[AsyncCursor]:
    try:
        get_pool()
    except RuntimeError:
        raise progress_error(503, "progress_unavailable") from None
    try:
        async with get_db_transaction() as conn, conn.cursor(row_factory=dict_row) as cur:
            if write:
                await cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
            else:
                await cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            yield cur
    except (psycopg.Error, PoolClosed, PoolTimeout):
        raise progress_error(503, "progress_unavailable") from None


def _revision(digest: bytes) -> ContentRevision:
    return ContentRevision(scheme=HASH_SCHEME, hash=digest.hex())


def _resume(row: dict | None, *, slug: str, sequence: int | None) -> ResumeState:
    if row is None:
        return ResumeState(resume=None, resume_etag=None)
    chapter_id = row["last_read_chapter_id"] if sequence is not None else None
    digest = row["resume_content_hash"] if chapter_id is not None else None
    return ResumeState(
        resume=ResumePosition(
            available=chapter_id is not None,
            chapter_id=chapter_id,
            chapter_sequence=sequence,
            url=f"/novel/{quote(slug, safe='')}/{sequence}" if chapter_id is not None else None,
            scroll_position=row["scroll_position"] if row["scroll_position"] is not None else 0.0,
            content_revision=_revision(digest) if digest is not None else None,
            updated_at=row["updated_at"],
        ),
        resume_etag=f'"{row["id"]}:{row["revision"]}"',
    )


async def _summary(cur: AsyncCursor, user_id: UUID, novel_id: UUID) -> CompletionSummary:
    # The CASE hashes only Published chapters with evidence for this user.
    # Materialize once so the two aggregates don't repeat digest work.
    await cur.execute(
        """WITH evidence AS MATERIALIZED (
               SELECT c.chapter_sequence, CASE WHEN e.chapter_id IS NOT NULL THEN
                   e.content_hash = digest(convert_to(c.content,'UTF8'),'sha256')
                   ELSE false END AS confirmed
               FROM chapters c LEFT JOIN reading_chapter_completions e
                 ON e.novel_id = c.novel_id AND e.chapter_id = c.id AND e.user_id = %s
                 AND e.hash_scheme = %s AND e.completion_policy_version = 1
                 AND e.completion_source = 'explicit'
               WHERE c.novel_id = %s AND c.content_status = 'Published' AND c.chapter_sequence > 0
           ), gap AS (SELECT min(chapter_sequence) AS first_missing FROM evidence WHERE NOT confirmed)
           SELECT max(chapter_sequence) FILTER (WHERE confirmed) AS highest_confirmed_sequence,
                  max(chapter_sequence) FILTER (WHERE confirmed AND
                       (first_missing IS NULL OR chapter_sequence < first_missing))
                      AS contiguous_confirmed_through_sequence
           FROM evidence CROSS JOIN gap""",
        (user_id, HASH_SCHEME, novel_id),
    )
    return CompletionSummary(**await cur.fetchone())


async def read_progress(user_id: UUID, novel_id: UUID, include_summary: bool) -> ProgressState:
    async with _cursor() as cur:
        await cur.execute(
            """SELECT n.slug, p.id, p.revision, p.last_read_chapter_id,
                      p.scroll_position, p.resume_content_hash, p.updated_at, c.chapter_sequence
               FROM novels n LEFT JOIN reading_progress p ON p.novel_id = n.id AND p.user_id = %s
               LEFT JOIN chapters c ON c.id = p.last_read_chapter_id AND c.novel_id = n.id
                  AND c.content_status = 'Published' AND c.chapter_sequence > 0
               WHERE n.id = %s""",
            (user_id, novel_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise progress_error(404, "novel_not_found")
        state = _resume(
            row if row["id"] else None, slug=row["slug"], sequence=row["chapter_sequence"]
        )
        summary = await _summary(cur, user_id, novel_id) if include_summary else None
        return ProgressState(**state.model_dump(), novel_id=novel_id, completion_summary=summary)


async def _locked_chapter(
    cur: AsyncCursor, novel_id: UUID, chapter_id: UUID, expected: ContentRevision
) -> tuple[dict, bytes]:
    # SHARE conflicts with content/status UPDATE, yet concurrent progress writers
    # for this chapter can validate together. Hold the lock through commit.
    await cur.execute(
        """SELECT c.content, c.chapter_sequence, n.slug
           FROM chapters c JOIN novels n ON n.id = c.novel_id
           WHERE c.novel_id = %s AND c.id = %s AND c.content_status = 'Published'
             AND c.chapter_sequence > 0
           FOR SHARE OF c""",
        (novel_id, chapter_id),
    )
    chapter = await cur.fetchone()
    if chapter is None:
        raise progress_error(404, "chapter_not_found")
    digest = content_digest(chapter["content"])
    if digest.hex() != expected.hash:
        raise progress_error(409, "content_revision_changed")
    return chapter, digest


_RESUME_RETURNING = " RETURNING id, revision, last_read_chapter_id, scroll_position, resume_content_hash, updated_at"


async def activate_resume(
    user_id: UUID, novel_id: UUID, body: ResumeInput, version: ResumeVersion | None
) -> ActivatedResume:
    async with _cursor(write=True) as cur:
        chapter, digest = await _locked_chapter(
            cur, novel_id, body.chapter_id, body.content_revision
        )
        epoch = uuid4()
        if version is None:
            await cur.execute(
                """INSERT INTO reading_progress (user_id, novel_id, last_read_chapter_id,
                        scroll_position, resume_writer_epoch, resume_content_hash, resume_hash_scheme, revision)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,1) ON CONFLICT (user_id, novel_id) DO NOTHING"""
                + _RESUME_RETURNING,
                (
                    user_id,
                    novel_id,
                    body.chapter_id,
                    body.scroll_position,
                    epoch,
                    digest,
                    HASH_SCHEME,
                ),
            )
        else:
            await cur.execute(
                """UPDATE reading_progress SET last_read_chapter_id = %s, scroll_position = %s,
                       resume_writer_epoch = %s, resume_content_hash = %s, resume_hash_scheme = %s,
                       revision = revision + 1
                   WHERE user_id = %s AND novel_id = %s AND id = %s AND revision = %s"""
                + _RESUME_RETURNING,
                (
                    body.chapter_id,
                    body.scroll_position,
                    epoch,
                    digest,
                    HASH_SCHEME,
                    user_id,
                    novel_id,
                    version.row_id,
                    version.revision,
                ),
            )
        row = await cur.fetchone()
        if row is None:
            raise progress_error(412, "resume_precondition_failed")
        state = _resume(row, slug=chapter["slug"], sequence=chapter["chapter_sequence"])
        return ActivatedResume(**state.model_dump(), writer_epoch=epoch)


async def update_resume(
    user_id: UUID, novel_id: UUID, body: ResumeUpdate, version: ResumeVersion
) -> ResumeState:
    async with _cursor(write=True) as cur:
        chapter, digest = await _locked_chapter(
            cur, novel_id, body.chapter_id, body.content_revision
        )
        await cur.execute(
            """UPDATE reading_progress SET scroll_position = %s, revision = revision + 1
               WHERE user_id = %s AND novel_id = %s AND id = %s AND revision = %s
                 AND resume_writer_epoch = %s AND last_read_chapter_id = %s
                 AND resume_content_hash = %s AND resume_hash_scheme = %s"""
            + _RESUME_RETURNING,
            (
                body.scroll_position,
                user_id,
                novel_id,
                version.row_id,
                version.revision,
                body.writer_epoch,
                body.chapter_id,
                digest,
                HASH_SCHEME,
            ),
        )
        row = await cur.fetchone()
        if row is None:
            await cur.execute(
                """SELECT resume_writer_epoch, last_read_chapter_id
                   FROM reading_progress WHERE user_id = %s AND novel_id = %s AND id = %s
                     AND revision = %s""",
                (user_id, novel_id, version.row_id, version.revision),
            )
            current = await cur.fetchone()
            if current is None:
                raise progress_error(412, "resume_precondition_failed")
            if current["resume_writer_epoch"] != body.writer_epoch:
                raise progress_error(409, "resume_writer_changed")
            if current["last_read_chapter_id"] != body.chapter_id:
                raise progress_error(409, "resume_chapter_changed")
            raise progress_error(409, "resume_activation_required")
        return _resume(row, slug=chapter["slug"], sequence=chapter["chapter_sequence"])


async def complete_chapter(
    user_id: UUID, novel_id: UUID, chapter_id: UUID, body: CompletionInput
) -> CompletionResult:
    if not body.confirmation:
        raise progress_error(422, "explicit_confirmation_required")
    async with _cursor(write=True) as cur:
        chapter, digest = await _locked_chapter(cur, novel_id, chapter_id, body.content_revision)
        await cur.execute(
            """INSERT INTO reading_chapter_completions AS e (user_id, novel_id, chapter_id, content_hash)
               VALUES (%s,%s,%s,%s)
               ON CONFLICT (user_id, chapter_id) DO UPDATE SET
                   content_hash = excluded.content_hash, hash_scheme = excluded.hash_scheme,
                   completion_policy_version = excluded.completion_policy_version,
                   completion_source = excluded.completion_source, completed_at = excluded.completed_at
               WHERE (e.content_hash,e.hash_scheme,e.completion_policy_version,e.completion_source)
                   IS DISTINCT FROM (excluded.content_hash,excluded.hash_scheme,
                                     excluded.completion_policy_version,excluded.completion_source)
               RETURNING completed_at""",
            (user_id, novel_id, chapter_id, digest),
        )
        row = await cur.fetchone()
        already_completed = row is None
        if already_completed:
            # ON CONFLICT holds the evidence row lock even when its WHERE is false.
            await cur.execute(
                """SELECT completed_at FROM reading_chapter_completions
                   WHERE user_id = %s AND novel_id = %s AND chapter_id = %s""",
                (user_id, novel_id, chapter_id),
            )
            row = await cur.fetchone()
        return CompletionResult(
            chapter_id=chapter_id,
            chapter_sequence=chapter["chapter_sequence"],
            content_revision=_revision(digest),
            completed_at=row["completed_at"],
            already_completed=already_completed,
        )


async def completion_statuses(
    user_id: UUID, novel_id: UUID, chapter_ids: list[UUID]
) -> CompletionStatuses:
    async with _cursor() as cur:
        await cur.execute(
            """SELECT c.id, c.chapter_sequence, digest(convert_to(c.content,'UTF8'),'sha256') AS digest,
                      e.content_hash AS evidence_hash
               FROM chapters c LEFT JOIN reading_chapter_completions e
                 ON e.novel_id = c.novel_id AND e.chapter_id = c.id AND e.user_id = %s
                 AND e.hash_scheme = %s AND e.completion_policy_version = 1
                 AND e.completion_source = 'explicit'
               WHERE c.novel_id = %s AND c.id = ANY(%s) AND c.content_status = 'Published'
                 AND c.chapter_sequence > 0""",
            (user_id, HASH_SCHEME, novel_id, chapter_ids),
        )
        rows = {row["id"]: row for row in await cur.fetchall()}
        if len(rows) != len(chapter_ids):
            raise progress_error(404, "chapter_not_found")
        items = []
        for chapter_id in chapter_ids:
            row = rows[chapter_id]
            digest = row["digest"]
            evidence = row["evidence_hash"]
            status = (
                "not_completed"
                if evidence is None
                else ("completed" if evidence == digest else "old_revision")
            )
            items.append(
                ChapterCompletionStatus(
                    chapter_id=chapter_id,
                    chapter_sequence=row["chapter_sequence"],
                    content_revision=_revision(digest),
                    status=status,
                )
            )
        return CompletionStatuses(items=items)
