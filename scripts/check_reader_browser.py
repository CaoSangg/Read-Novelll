"""Seed an isolated local test chapter, run real SSR/browser QA, then clean up."""

import json
import os
import socket
import subprocess
import sys
import uuid
from pathlib import Path

import httpx
import psycopg
from dotenv import dotenv_values
from psycopg.conninfo import conninfo_to_dict


def main():
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    try:
        url = dotenv_values(".env.local.txt").get("DATABASE_URL")
        info = conninfo_to_dict(url) if url else {}
        if info.get("dbname") != "readnovel_test" or info.get("host") not in (
            "localhost",
            "127.0.0.1",
            "::1",
        ):
            raise ValueError()
    except Exception:
        raise SystemExit("Refused: requires local readnovel_test URL in .env.local.txt.") from None
    # Narrow subprocess bridge for browser publication-race/state assertions; fixture UUID only.
    fixture_action = next(
        (flag for flag in ("--fixture-state", "--archive-target") if flag in sys.argv), None
    )
    if fixture_action:
        identifier = uuid.UUID(sys.argv[sys.argv.index(fixture_action) + 1])
        with psycopg.connect(url) as conn:
            fixture = conn.execute(
                "SELECT id FROM novels WHERE id=%s AND slug=%s AND author='Test'",
                (identifier, f"toc-jump-{identifier.hex}"),
            ).fetchone()
            if not fixture:
                raise SystemExit("Refused: target must be this runner's isolated TOC jump fixture.")
            if fixture_action == "--archive-target":
                changed = conn.execute(
                    "UPDATE chapters SET content_status='Archived' WHERE novel_id=%s AND chapter_sequence=15 AND content_status='Published'",
                    (identifier,),
                ).rowcount
                print(json.dumps({"archived": changed}))
            else:
                fixture_user = uuid.uuid5(identifier, "toc-jump-reader-state")
                progress = conn.execute(
                    "SELECT last_read_chapter_id,max_read_sequence,scroll_position,updated_at FROM reading_progress WHERE novel_id=%s AND user_id=%s",
                    (identifier, fixture_user),
                ).fetchall()
                bookmarks = conn.execute(
                    "SELECT COUNT(*) FROM bookmarks WHERE novel_id=%s AND user_id=%s",
                    (identifier, fixture_user),
                ).fetchone()[0]
                sessions = conn.execute(
                    "SELECT COUNT(*) FROM user_sessions WHERE user_id=%s", (fixture_user,)
                ).fetchone()[0]
                print(
                    json.dumps(
                        {"progress": progress, "bookmarks": bookmarks, "sessions": sessions},
                        default=str,
                    )
                )
        return 0
    # Never attach to or shut down an unrelated existing HTTP/CDP server.
    existing_server = "--existing-server" in sys.argv
    for port in (9234,) if existing_server else (8000, 9234):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    if existing_server:
        # Explicit opt-in only: reject a server serving another checkout's assets.
        for asset in (
            "css/reader.css",
            "js/reader_theme.js",
            "js/reader_settings.js",
            "js/reader_toolbar.js",
            "js/reader_preferences.js",
            "js/reader_toc.js",
        ):
            response = httpx.get(f"http://127.0.0.1:8000/static/{asset}", timeout=5)
            if (
                response.status_code != 200
                or response.content != (root / "app/static" / asset).read_bytes()
            ):
                raise SystemExit("Refused: existing server assets differ from this workspace.")
    novel_id = uuid.uuid4()
    navigation_id = uuid.uuid4()
    navigation_user = uuid.uuid5(navigation_id, "toc-jump-reader-state")
    slug = f"reader-browser-{novel_id.hex}"
    content = (
        "Tiếng Việt có dấu.\r\n\r\nDòng một\r\nDòng hai\n\n<script>window.readerXss=true</script>\n\n"
        + "Nội dung chương dài. " * 400
    )
    server = None
    navigation_mode = "--navigation" in sys.argv
    final_mode = "--navigation-final" in sys.argv
    jump_mode = "--toc-jump" in sys.argv or final_mode
    navigation_slug = (
        f"toc-jump-{navigation_id.hex}" if jump_mode else f"navigation-{navigation_id.hex}"
    )
    persistence_mode = "--persistence" in sys.argv
    visual_mode = "--settings-visual" in sys.argv or persistence_mode
    typography_mode = "--typography" in sys.argv or visual_mode
    theme_mode = "--theme" in sys.argv or typography_mode
    toolbar_mode = "--toolbar" in sys.argv or theme_mode
    toc_mode = "--toc" in sys.argv or toolbar_mode or navigation_mode or jump_mode
    try:
        with psycopg.connect(url) as conn:
            conn.execute(
                "INSERT INTO novels(id,slug,title,author) VALUES (%s,%s,'Truyện kiểm thử SSR','Test')",
                (novel_id, slug),
            )
            conn.execute(
                "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,1,'Chương 1','Nội dung tiếng Việt',%s,'Published')",
                (novel_id, content),
            )
            if navigation_mode or jump_mode:
                conn.execute(
                    "INSERT INTO novels(id,slug,title,author) VALUES (%s,%s,'Navigation QA','Test')",
                    (navigation_id, navigation_slug),
                )
                with conn.cursor() as cur:
                    cur.executemany(
                        "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,%s,%s,%s,%s,%s)",
                        [
                            (
                                navigation_id,
                                seq,
                                '<img src=x onerror="window.jumpXss=true">'
                                if jump_mode and seq == 15
                                else f"Chương {seq}",
                                f"Navigation chapter {seq}",
                                f"NAVIGATION_CONTENT_{seq}\n\n" + content
                                if status == "Published"
                                else "HIDDEN_NAVIGATION_SECRET",
                                status,
                            )
                            for seq, status in [
                                (1, "Published"),
                                (2, "Draft"),
                                (3, "Published"),
                                (4, "Archived"),
                                (7, None),
                                (9, "Published"),
                            ]
                            + ([(15, "Published")] if jump_mode else [])
                        ],
                    )
            if toc_mode:
                with conn.cursor() as cur:
                    cur.executemany(
                        "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,%s,%s,%s,%s,'Published')",
                        [
                            (
                                novel_id,
                                1000 + index * 30,
                                f"Ngoại truyện {index}",
                                '<img src=x onerror="window.tocXss=true">'
                                if index == 50
                                else f"Chương {index}",
                                content if index == 50 else "OTHER_CHAPTER_CONTENT",
                            )
                            for index in range(101)
                        ],
                    )
                    cur.executemany(
                        "INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content,content_status) VALUES (%s,%s,'Hidden','DRAFT_OR_ARCHIVED_SECRET','SECRET',%s)",
                        [(novel_id, 2, "Draft"), (novel_id, 8, "Archived"), (novel_id, 10, None)],
                    )
                if toolbar_mode:
                    conn.execute(
                        "UPDATE novels SET title=%s WHERE id=%s",
                        ("Tên truyện tiếng Việt rất dài để kiểm tra thanh công cụ " * 4, novel_id),
                    )
            if jump_mode:
                conn.execute(
                    "INSERT INTO users(id,email,username) VALUES (%s,%s,%s)",
                    (
                        navigation_user,
                        f"toc-jump-{navigation_id.hex}@example.com",
                        f"toc-jump-{navigation_id.hex}",
                    ),
                )
                conn.execute(
                    "INSERT INTO reading_progress(user_id,novel_id,last_read_chapter_id,max_read_sequence) SELECT %s,%s,id,1 FROM chapters WHERE novel_id=%s AND chapter_sequence=1",
                    (navigation_user, navigation_id, navigation_id),
                )
        env = os.environ.copy()
        env["DATABASE_URL"] = url
        if not existing_server:
            server = subprocess.Popen(
                [sys.executable, "scripts/run_local.py"],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        return subprocess.call(
            [
                "node",
                "scripts/check_reader_browser.cjs",
                f"http://127.0.0.1:8000/novel/{navigation_slug}/1"
                if navigation_mode or jump_mode
                else f"http://127.0.0.1:8000/novel/{slug}/{2500 if toc_mode else 1}",
            ]
            + (
                ["--navigation", f"--rank-url=http://127.0.0.1:8000/novel/{slug}/2440"]
                if navigation_mode
                else []
            )
            + (
                [
                    "--toc-jump",
                    f"--fixture-novel={navigation_id}",
                    f"--rank-url=http://127.0.0.1:8000/novel/{slug}/2500",
                ]
                if jump_mode
                else []
            )
            + (["--toc"] if toc_mode else [])
            + (["--navigation-final"] if final_mode else [])
            + (["--toolbar"] if toolbar_mode else [])
            + (["--theme"] if theme_mode else [])
            + (["--typography"] if typography_mode else [])
            + (["--settings-visual"] if visual_mode else [])
            + (["--capture-before"] if "--capture-before" in sys.argv else [])
            + (["--visual-only"] if "--visual-only" in sys.argv else [])
            + (["--persistence"] if persistence_mode else [])
            + (["--persistence-only"] if "--persistence-only" in sys.argv else [])
        )
    finally:
        if server is not None:
            server.terminate()
            server.wait(timeout=15)
        with psycopg.connect(url) as conn:
            conn.execute("DELETE FROM users WHERE id=%s", (navigation_user,))
            conn.execute("DELETE FROM novels WHERE id=%s", (novel_id,))
            conn.execute("DELETE FROM novels WHERE id=%s", (navigation_id,))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Never print URL-bearing connection exception text.
        sys.exit("Reader browser QA failed; check local PostgreSQL, Edge and available ports.")
