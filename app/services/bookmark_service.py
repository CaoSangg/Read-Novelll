"""Owner-scoped bookmarks backed by the existing user/chapter unique key."""

from urllib.parse import quote
from uuid import UUID

from fastapi import HTTPException
from psycopg.rows import dict_row

from app.db.pool import get_db_transaction
from app.schemas.bookmarks import BookmarkEntry, BookmarkList, BookmarkStatus


def bookmark_error(status: int, code: str) -> HTTPException:
    return HTTPException(status, detail={"code": code})


def _entry(row: dict, slug: str) -> BookmarkEntry:
    seq = row["chapter_sequence"]
    available = row["content_status"] == "Published" and seq > 0
    return BookmarkEntry(
        chapter_id=row["chapter_id"],
        created_at=row["created_at"],
        available=available,
        chapter_sequence=seq if available else None,
        chapter_number=row["chapter_number"] if available else None,
        title=row["title"] if available else None,
        url=f"/novel/{quote(slug, safe='')}/{seq}" if available else None,
    )


_ACTIVE_BOOKMARKS = """
    FROM bookmarks b
    JOIN chapters c ON c.id=b.chapter_id AND c.novel_id=b.novel_id
    WHERE b.user_id=%s AND b.novel_id=%s AND b.removed_at IS NULL
"""


async def list_bookmarks(user_id: UUID, novel_id: UUID, page: int, page_size: int) -> BookmarkList:
    async with get_db_transaction() as conn, conn.cursor(row_factory=dict_row) as cur:
        await cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        await cur.execute("SELECT slug FROM novels WHERE id=%s", (novel_id,))
        novel = await cur.fetchone()
        if novel is None:
            raise bookmark_error(404, "novel_not_found")
        await cur.execute("SELECT count(*) AS total " + _ACTIVE_BOOKMARKS, (user_id, novel_id))
        total = (await cur.fetchone())["total"]
        await cur.execute(
            """SELECT b.chapter_id, b.created_at, c.chapter_sequence, c.chapter_number,
                      c.title, c.content_status """
            + _ACTIVE_BOOKMARKS
            + " ORDER BY b.created_at DESC NULLS LAST, b.id DESC LIMIT %s OFFSET %s",
            (user_id, novel_id, page_size, (page - 1) * page_size),
        )
        items = [_entry(row, novel["slug"]) for row in await cur.fetchall()]
    return BookmarkList(
        novel_id=novel_id,
        items=items,
        page=page,
        page_size=page_size,
        total=total,
        total_pages=(total + page_size - 1) // page_size,
    )


async def bookmark_status(user_id: UUID, novel_id: UUID, chapter_id: UUID) -> BookmarkStatus:
    async with get_db_transaction() as conn, conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            """SELECT COALESCE(c.content_status='Published' AND c.chapter_sequence>0, false)
                        AS available, b.id IS NOT NULL AS bookmarked
               FROM chapters c LEFT JOIN bookmarks b
                 ON b.chapter_id=c.id AND b.novel_id=c.novel_id AND b.user_id=%s
                 AND b.removed_at IS NULL
               WHERE c.novel_id=%s AND c.id=%s""",
            (user_id, novel_id, chapter_id),
        )
        row = await cur.fetchone()
    if row is None or not (row["available"] or row["bookmarked"]):
        raise bookmark_error(404, "chapter_not_found")
    return BookmarkStatus(chapter_id=chapter_id, **row)


async def put_bookmark(user_id: UUID, novel_id: UUID, chapter_id: UUID) -> None:
    async with get_db_transaction() as conn, conn.cursor() as cur:
        await cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        # SHARE blocks a publication or relationship change until the insert commits.
        await cur.execute(
            """SELECT id FROM chapters
               WHERE novel_id=%s AND id=%s AND content_status='Published' AND chapter_sequence>0
               FOR SHARE""",
            (novel_id, chapter_id),
        )
        if await cur.fetchone() is None:
            raise bookmark_error(404, "chapter_not_found")
        await cur.execute(
            """INSERT INTO bookmarks (user_id,novel_id,chapter_id) VALUES (%s,%s,%s)
               ON CONFLICT (user_id,chapter_id) DO UPDATE SET removed_at=NULL
               WHERE bookmarks.novel_id=EXCLUDED.novel_id AND bookmarks.removed_at IS NOT NULL""",
            (user_id, novel_id, chapter_id),
        )
        if cur.rowcount:
            return
        # The upsert locks the conflicting row, including when its WHERE skips the write.
        await cur.execute(
            "SELECT 1 FROM bookmarks WHERE user_id=%s AND novel_id=%s AND chapter_id=%s",
            (user_id, novel_id, chapter_id),
        )
        if await cur.fetchone() is None:
            raise bookmark_error(409, "bookmark_relation_conflict")


async def remove_bookmark(user_id: UUID, novel_id: UUID, chapter_id: UUID) -> None:
    async with get_db_transaction() as conn, conn.cursor() as cur:
        await cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        await cur.execute(
            """SELECT c.id FROM chapters c WHERE c.novel_id=%s AND c.id=%s AND (
                 (c.content_status='Published' AND c.chapter_sequence>0) OR EXISTS (
                   SELECT 1 FROM bookmarks b
                   WHERE b.chapter_id=c.id AND b.novel_id=c.novel_id AND b.user_id=%s
                 )
               ) FOR SHARE OF c""",
            (novel_id, chapter_id, user_id),
        )
        if await cur.fetchone() is None:
            raise bookmark_error(404, "chapter_not_found")
        await cur.execute(
            """UPDATE bookmarks SET removed_at=CURRENT_TIMESTAMP
               WHERE user_id=%s AND novel_id=%s AND chapter_id=%s AND removed_at IS NULL""",
            (user_id, novel_id, chapter_id),
        )
