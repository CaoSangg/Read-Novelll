"""Read-only novel metadata and published chapter queries using the existing pool."""

from contextlib import asynccontextmanager
from uuid import UUID

import psycopg
from fastapi import HTTPException
from psycopg.rows import dict_row
from psycopg_pool import PoolClosed, PoolTimeout

from app.core.content_revision import HASH_SCHEME, content_digest
from app.db.pool import get_db_connection, get_pool
from app.schemas.novel import (
    ChapterList,
    ChapterRead,
    NovelList,
    NovelMetadata,
    PublishedChapterRevision,
)

# No novel publication/status column exists. All novel metadata is public;
# only chapters explicitly marked Published may appear in counts or TOC.
NOVEL_COLUMNS = """
    n.id, n.slug, n.title, n.author, n.description, n.cover_image_url,
    (SELECT COUNT(*) FROM chapters c
     WHERE c.novel_id = n.id AND c.content_status = 'Published') AS published_chapter_count
"""


@asynccontextmanager
async def _read_cursor():
    try:
        get_pool()
    except RuntimeError:
        raise HTTPException(503, "Novel data is temporarily unavailable.") from None
    try:
        async with get_db_connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                # Keep count and page in one snapshot; forbid accidental writes.
                await cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                yield cur
    except (psycopg.Error, PoolTimeout, PoolClosed):
        raise HTTPException(503, "Novel data is temporarily unavailable.") from None


def _pagination(page: int, page_size: int, total: int) -> dict:
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("Invalid pagination")
    return dict(
        page=page,
        page_size=page_size,
        total=total,
        total_pages=(total + page_size - 1) // page_size,
    )


async def get_novel_by_slug(slug: str) -> NovelMetadata:
    async with _read_cursor() as cur:
        await cur.execute("SELECT " + NOVEL_COLUMNS + " FROM novels n WHERE n.slug = %s", (slug,))
        novel = await cur.fetchone()
    if novel is None:
        raise HTTPException(404, "Novel not found.")
    return NovelMetadata(**novel)


async def list_novels(page: int = 1, page_size: int = 50) -> NovelList:
    _pagination(page, page_size, 0)
    async with _read_cursor() as cur:
        await cur.execute("SELECT COUNT(*) AS total FROM novels")
        total = (await cur.fetchone())["total"]
        await cur.execute(
            "SELECT " + NOVEL_COLUMNS + " FROM novels n ORDER BY n.slug, n.id LIMIT %s OFFSET %s",
            (page_size, (page - 1) * page_size),
        )
        items = await cur.fetchall()
    return NovelList(items=items, **_pagination(page, page_size, total))


async def list_published_chapters(slug: str, page: int = 1, page_size: int = 50) -> ChapterList:
    _pagination(page, page_size, 0)
    async with _read_cursor() as cur:
        await cur.execute("SELECT id FROM novels WHERE slug = %s", (slug,))
        novel = await cur.fetchone()
        if novel is None:
            raise HTTPException(404, "Novel not found.")
        await cur.execute(
            "SELECT COUNT(*) AS total FROM chapters WHERE novel_id = %s AND content_status = 'Published'",
            (novel["id"],),
        )
        total = (await cur.fetchone())["total"]
        await cur.execute(
            """SELECT id, chapter_sequence, chapter_number, title FROM chapters
               WHERE novel_id = %s AND content_status = 'Published'
               ORDER BY chapter_sequence, id LIMIT %s OFFSET %s""",
            (novel["id"], page_size, (page - 1) * page_size),
        )
        items = await cur.fetchall()
    return ChapterList(novel_slug=slug, items=items, **_pagination(page, page_size, total))


async def get_published_chapter(slug: str, sequence: int) -> ChapterRead:
    """Preserve Next.js's chapters.content source; versions never override publication."""
    if not 1 <= sequence <= 2_147_483_647:
        raise ValueError("Invalid chapter sequence")
    async with _read_cursor() as cur:
        await cur.execute(
            """SELECT n.id AS novel_id, n.slug, n.title AS novel_title,
                      c.id, c.chapter_sequence, c.chapter_number, c.title, c.content,
                      prev.item AS previous, following.item AS next
               FROM novels n JOIN chapters c ON c.novel_id = n.id
               LEFT JOIN LATERAL (
                   SELECT jsonb_build_object(
                       'id', p.id, 'chapter_sequence', p.chapter_sequence,
                       'chapter_number', p.chapter_number, 'title', p.title
                   ) AS item
                   FROM chapters p
                   WHERE p.novel_id = c.novel_id AND p.content_status = 'Published'
                     AND p.chapter_sequence < c.chapter_sequence
                   ORDER BY p.chapter_sequence DESC LIMIT 1
               ) prev ON TRUE
               LEFT JOIN LATERAL (
                   SELECT jsonb_build_object(
                       'id', p.id, 'chapter_sequence', p.chapter_sequence,
                       'chapter_number', p.chapter_number, 'title', p.title
                   ) AS item
                   FROM chapters p
                   WHERE p.novel_id = c.novel_id AND p.content_status = 'Published'
                     AND p.chapter_sequence > c.chapter_sequence
                   ORDER BY p.chapter_sequence ASC LIMIT 1
               ) following ON TRUE
               WHERE n.slug = %s AND c.chapter_sequence = %s
                 AND c.content_status = 'Published'""",
            (slug, sequence),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "Published chapter not found.")
    return ChapterRead(
        novel={"id": row["novel_id"], "slug": row["slug"], "title": row["novel_title"]},
        chapter={
            field: row[field]
            for field in ("id", "chapter_sequence", "chapter_number", "title", "content")
        },
        navigation={"previous": row["previous"], "next": row["next"]},
    )


async def get_published_chapter_page(slug: str, sequence: int, page_size: int = 50) -> int:
    """Find the current Published chapter's page by rank, never by sequence arithmetic."""
    _pagination(1, page_size, 0)
    if not 1 <= sequence <= 2_147_483_647:
        raise ValueError("Invalid chapter sequence")
    async with _read_cursor() as cur:
        await cur.execute(
            """SELECT (COUNT(p.id) - 1) / %s + 1 AS page
               FROM novels n JOIN chapters c ON c.novel_id = n.id
               JOIN chapters p ON p.novel_id = c.novel_id
                 AND p.content_status = 'Published'
                 AND p.chapter_sequence <= c.chapter_sequence
               WHERE n.slug = %s AND c.chapter_sequence = %s
                 AND c.content_status = 'Published'
               GROUP BY c.id""",
            (page_size, slug, sequence),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "Published chapter not found.")
    return row["page"]


async def get_published_chapter_revision(slug: str, chapter_id: UUID) -> PublishedChapterRevision:
    """Resolve one device Resume without returning chapter text."""
    async with _read_cursor() as cur:
        await cur.execute(
            """SELECT c.id, c.novel_id, c.chapter_sequence, c.chapter_number, c.title, c.content
               FROM chapters c JOIN novels n ON n.id = c.novel_id
               WHERE c.id = %s AND n.slug = %s AND c.content_status = 'Published'""",
            (chapter_id, slug),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "Published chapter not found.")
    digest = content_digest(row.pop("content")).hex()
    return PublishedChapterRevision(**row, content_revision={"scheme": HASH_SCHEME, "hash": digest})
