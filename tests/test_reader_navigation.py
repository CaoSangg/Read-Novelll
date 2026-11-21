"""Read-only adjacent Published navigation using isolated local PostgreSQL fixtures."""

from urllib.parse import quote
from uuid import uuid4

import psycopg
import pytest
from test_chapter_service import chapter_data as chapter_data
from test_novel_service import novels_data as novels_data
from test_reader_web import ReaderParser

from app.db.pool import get_db_connection
from app.routers import web
from app.schemas.novel import ChapterRead
from app.services import novel_service


def navigation(html):
    markup = html.split('<nav class="reader-navigation"', 1)[1].split("</nav>", 1)[0]
    parser = ReaderParser(markup)
    return {
        attrs["id"]: (tag, attrs)
        for tag, attrs in parser.tags
        if attrs.get("id") in ("reader-previous-chapter", "reader-next-chapter")
    }, markup


@pytest.mark.parametrize(
    "sequence,neighbors", [(1, (None, 3)), (3, (1, 9)), (9, (3, None)), (5, (None, None))]
)
async def test_navigation_template_contract_without_database(
    async_client, monkeypatch, sequence, neighbors
):
    """Exercise real route/template/URL generation even when integration PostgreSQL is offline."""
    slug = "truyện-漢字_qa"

    def metadata(seq):
        return (
            None
            if seq is None
            else {
                "id": uuid4(),
                "chapter_sequence": seq,
                "chapter_number": str(seq),
                "title": "Future <script>unsafe</script>",
            }
        )

    async def read(actual_slug, actual_sequence):
        assert (actual_slug, actual_sequence) == (slug, sequence)
        return ChapterRead.model_validate(
            {
                "novel": {"id": uuid4(), "slug": slug, "title": "Novel <script>unsafe</script>"},
                "chapter": {
                    "id": uuid4(),
                    "chapter_sequence": sequence,
                    "chapter_number": str(sequence),
                    "title": "Chapter <img src=x>",
                    "content": "Only current & text",
                },
                "navigation": {"previous": metadata(neighbors[0]), "next": metadata(neighbors[1])},
            }
        )

    async def rank(actual_slug, actual_sequence):
        assert (actual_slug, actual_sequence) == (slug, sequence)
        return 1

    monkeypatch.setattr(web, "get_published_chapter", read)
    monkeypatch.setattr(web, "get_published_chapter_page", rank)
    response = await async_client.get(f"/novel/{quote(slug, safe='')}/{sequence}")
    assert response.status_code == 200
    controls, markup = navigation(response.text)
    for identifier, target, relation in [
        ("reader-previous-chapter", neighbors[0], "prev"),
        ("reader-next-chapter", neighbors[1], "next"),
    ]:
        tag, attrs = controls[identifier]
        if target is None:
            assert tag == "span" and attrs["aria-disabled"] == "true"
            assert "href" not in attrs and "tabindex" not in attrs
        else:
            assert tag == "a" and attrs["href"] == f"/novel/{quote(slug, safe='')}/{target}"
            assert attrs["rel"] == relation
    assert "Future" not in markup
    assert "Novel &lt;script&gt;" in response.text and "Chapter &lt;img" in response.text
    assert ReaderParser(response.text).paragraphs == ["Only current & text"]
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("sequence,previous,following", [(1, None, 5), (5, 1, 9), (9, 5, None)])
async def test_ssr_adjacent_published_gaps_and_cross_novel(
    async_client, chapter_data, sequence, previous, following
):
    slugs, ids, _ = chapter_data
    async with get_db_connection() as conn:
        await conn.execute(
            "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,4,'Other four','Other','OTHER_NOVEL_SECRET','Published'),(%s,6,'Other six','Other','OTHER_NOVEL_SECRET','Published')",
            (ids[1], ids[1]),
        )
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 200
    controls, _ = navigation(response.text)
    assert response.text.count('class="reader-navigation"') == 1
    for identifier, target, relation in [
        ("reader-previous-chapter", previous, "prev"),
        ("reader-next-chapter", following, "next"),
    ]:
        tag, attrs = controls[identifier]
        if target is None:
            assert tag == "span" and attrs["aria-disabled"] == "true"
            assert "href" not in attrs and "tabindex" not in attrs
        else:
            assert tag == "a" and attrs["href"] == f"/novel/{slugs[0]}/{target}"
            assert attrs["rel"] == relation
            assert (await async_client.get(attrs["href"])).status_code == 200
    assert "OTHER_NOVEL_SECRET" not in response.text
    assert "set-cookie" not in response.headers


async def test_single_chapter_has_two_unfocusable_unavailable_states(async_client, chapter_data):
    slugs, _, _ = chapter_data
    response = await async_client.get(f"/novel/{slugs[1]}/5")
    assert response.status_code == 200
    controls, markup = navigation(response.text)
    assert len(controls) == 2
    assert all(
        tag == "span" and attrs["aria-disabled"] == "true" for tag, attrs in controls.values()
    )
    assert all("href" not in attrs and "tabindex" not in attrs for tag, attrs in controls.values())
    assert "Chương Trước" in markup and "Hết chương" in markup
    assert not any(tag == "a" for tag, attrs in ReaderParser(markup).tags)
    assert [attrs.get("id") for tag, attrs in ReaderParser(markup).tags if tag == "button"] == [
        "reader-toc-footer"
    ]


async def test_unicode_slug_is_encoded_and_relative(async_client, chapter_data):
    slugs, ids, _ = chapter_data
    slug = f"truyện-漢字_{slugs[0]}"
    async with get_db_connection() as conn:
        await conn.execute("UPDATE novels SET slug=%s WHERE id=%s", (slug, ids[0]))
    response = await async_client.get(f"/novel/{quote(slug, safe='')}/5")
    assert response.status_code == 200
    controls, _ = navigation(response.text)
    for identifier, sequence in [("reader-previous-chapter", 1), ("reader-next-chapter", 9)]:
        href = controls[identifier][1]["href"]
        assert href == f"/novel/{quote(slug, safe='')}/{sequence}"
        assert href.startswith("/novel/") and not href.startswith("//")
        assert (await async_client.get(href)).status_code == 200


async def test_navigation_contains_no_adjacent_content_or_injected_metadata(
    async_client, chapter_data
):
    slugs, ids, _ = chapter_data
    async with get_db_connection() as conn:
        await conn.execute(
            "UPDATE novels SET title=%s WHERE id=%s",
            ("Novel <script>window.navXss=true</script>", ids[0]),
        )
        await conn.execute(
            "UPDATE chapters SET content=%s,title=%s WHERE novel_id=%s AND chapter_sequence=5",
            ("Current & text", "Chapter <img src=x onerror=alert(1)>", ids[0]),
        )
        await conn.execute(
            "UPDATE chapters SET content='ADJACENT_CONTENT_SECRET',title=%s WHERE novel_id=%s AND chapter_sequence IN (1,9)",
            ("Future <script>window.navXss=true</script>", ids[0]),
        )
    response = await async_client.get(f"/novel/{slugs[0]}/5")
    assert response.status_code == 200
    assert "Novel &lt;script&gt;" in response.text and "Chapter &lt;img" in response.text
    assert ReaderParser(response.text).paragraphs == ["Current & text"]
    assert "ADJACENT_CONTENT_SECRET" not in response.text
    controls, markup = navigation(response.text)
    assert "Future" not in markup and "Current &" not in markup
    assert all(tag not in ("script", "img", "iframe") for tag, attrs in ReaderParser(markup).tags)
    assert len(controls) == 2
    metadata = (await async_client.get(f"/api/novels/{slugs[0]}/chapters/5")).json()["navigation"]
    assert all(
        set(item) == {"id", "chapter_sequence", "chapter_number", "title"}
        for item in metadata.values()
    )


async def test_stale_published_link_returns_404_after_unpublication(async_client, chapter_data):
    slugs, ids, _ = chapter_data
    controls, _ = navigation((await async_client.get(f"/novel/{slugs[0]}/1")).text)
    href = controls["reader-next-chapter"][1]["href"]
    async with get_db_connection() as conn:
        await conn.execute(
            "UPDATE chapters SET content_status='Archived' WHERE novel_id=%s AND chapter_sequence=5",
            (ids[0],),
        )
    response = await async_client.get(href)
    assert response.status_code == 404
    assert "location" not in response.headers
    assert "MIDDLE_CONTENT" not in response.text


@pytest.mark.parametrize("sequence", [4, 6, 7])
async def test_unpublished_current_chapter_has_no_navigation(async_client, chapter_data, sequence):
    slugs, _, _ = chapter_data
    response = await async_client.get(f"/novel/{slugs[0]}/{sequence}")
    assert response.status_code == 404
    assert "reader-navigation" not in response.text


async def test_unavailable_database_returns_503_without_navigation(async_client, monkeypatch):
    def unavailable():
        raise RuntimeError("Pool unavailable")

    monkeypatch.setattr(novel_service, "get_pool", unavailable)
    response = await async_client.get("/novel/unavailable/1")
    assert response.status_code == 503
    assert "reader-navigation" not in response.text


async def test_navigation_preserves_progress_bookmarks_and_sessions(async_client, chapter_data):
    slugs, _, user_id = chapter_data

    async def snapshot():
        async with get_db_connection() as conn:
            progress = await (
                await conn.execute("SELECT * FROM reading_progress WHERE user_id=%s", (user_id,))
            ).fetchall()
            bookmarks = await (
                await conn.execute("SELECT COUNT(*) FROM bookmarks WHERE user_id=%s", (user_id,))
            ).fetchone()
            sessions = await (
                await conn.execute(
                    "SELECT COUNT(*) FROM user_sessions WHERE user_id=%s", (user_id,)
                )
            ).fetchone()
        return progress, bookmarks, sessions

    before = await snapshot()
    for sequence in [1, 5, 9, 5, 1]:
        assert (await async_client.get(f"/novel/{slugs[0]}/{sequence}")).status_code == 200
    assert await snapshot() == before


async def test_navigation_reuses_existing_two_application_selects(
    async_client, chapter_data, monkeypatch
):
    slugs, _, _ = chapter_data
    original = psycopg.AsyncCursor.execute
    application_selects = []

    async def counted(cursor, query, *args, **kwargs):
        if "FROM novels n JOIN chapters c" in str(query):
            application_selects.append(str(query))
        return await original(cursor, query, *args, **kwargs)

    monkeypatch.setattr(psycopg.AsyncCursor, "execute", counted)
    assert (await async_client.get(f"/novel/{slugs[0]}/5")).status_code == 200
    assert len(application_selects) == 2
    assert any("LEFT JOIN LATERAL" in query for query in application_selects)
    assert any("COUNT(p.id)" in query for query in application_selects)


async def test_out_of_route_sequence_metadata_never_becomes_a_fake_link(async_client, chapter_data):
    slugs, ids, _ = chapter_data
    # The existing schema has no positive-sequence CHECK. Keep bad historical data out of hrefs.
    async with get_db_connection() as conn:
        await conn.execute(
            "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,0,'Invalid','Invalid','INVALID_CONTENT','Published')",
            (ids[0],),
        )
    response = await async_client.get(f"/novel/{slugs[0]}/1")
    assert response.status_code == 200
    controls, _ = navigation(response.text)
    assert controls["reader-previous-chapter"][0] == "span"
    assert "href" not in controls["reader-previous-chapter"][1]
    assert "INVALID_CONTENT" not in response.text
