"""Verify authenticated Reader in Edge against a verifier-owned migrated database."""

import argparse
import ctypes
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from tempfile import TemporaryDirectory, gettempdir
from uuid import UUID, uuid4

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from app.core.security import hash_password
from scripts.check_progress_migration import LOCAL_HOSTS, ROOT, local_audit_url, require_disposable


def release_browser_profile(profile: TemporaryDirectory) -> tuple[str | None, int]:
    target = Path(profile.name).resolve()
    if target.parent != Path(gettempdir()).resolve() or not target.name.startswith(
        "readnovel-resume-"
    ):
        return "Unexpected QA profile path", 0
    deadline = time.monotonic() + 5
    retries = 0
    while True:
        try:
            profile.cleanup()
            return None, retries
        except OSError as exc:
            code = getattr(exc, "winerror", None)
            # Windows can hold a profile handle briefly after the browser exits.
            if sys.platform != "win32" or code not in (5, 32, 33) or time.monotonic() >= deadline:
                return f"{type(exc).__name__} (errno={exc.errno}, winerror={code})", retries
            retries += 1
            time.sleep(0.1)


def case_label(suite: str, history: str, round_number: int | None) -> str:
    suffix = f" round={round_number}" if round_number is not None else ""
    return f"[{suite}/{history}{suffix}]"


def exit_label(code: int | None) -> str:
    if code is None:
        return "unobserved"
    return f"{code} (0x{code & 0xFFFFFFFF:08X})" if sys.platform == "win32" else str(code)


def shell_exit(code: int) -> int:
    # CPython's sys.exit uses a signed C int. Passing an unsigned NTSTATUS loses the bits.
    return code - (1 << 32) if sys.platform == "win32" and code >= (1 << 31) else code


def windows_memory_sample() -> str:
    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_uint32),
            ("load", ctypes.c_uint32),
            ("total_physical", ctypes.c_uint64),
            ("available_physical", ctypes.c_uint64),
            ("total_commit", ctypes.c_uint64),
            ("available_commit", ctypes.c_uint64),
            ("total_virtual", ctypes.c_uint64),
            ("available_virtual", ctypes.c_uint64),
            ("available_extended_virtual", ctypes.c_uint64),
        ]

    kernel = getattr(ctypes, "windll", None)
    sample = MemoryStatus(length=ctypes.sizeof(MemoryStatus))
    if kernel is None or not kernel.kernel32.GlobalMemoryStatusEx(ctypes.byref(sample)):
        return "Windows memory unavailable"
    return (
        f"physical load={sample.load}%, "
        f"available physical={sample.available_physical // (1024**2)} MiB, "
        f"available commit={sample.available_commit // (1024**2)} MiB"
    )


def wait_for_app(server: subprocess.Popen, port: int) -> str | None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        status = server.poll()
        if status is not None:
            return f"server exited before readiness ({exit_label(status)})"
        connection = HTTPConnection("127.0.0.1", port, timeout=0.5)
        try:
            connection.request("GET", "/api/health/readiness")
            if connection.getresponse().status == 200:
                return None
        except (OSError, HTTPException):
            pass
        finally:
            connection.close()
        time.sleep(0.035)
    return "server readiness did not return HTTP 200 in 15 s"


def start_owned_edge(profile: str, history: str) -> subprocess.Popen:
    executable = os.environ.get(
        "EDGE_PATH", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    )
    options = [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
    ]
    if history == "fresh":
        options.append("--disable-features=BackForwardCache")
    return subprocess.Popen(
        [executable, *options, f"--user-data-dir={profile}", "about:blank"],
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )


def kill_owned_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
                timeout=10,
                check=False,
            )
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)


def run_edge_qa(config: dict) -> tuple[int, list[str]]:
    label = case_label(config["suite"], config["history"], config.get("round"))
    profile = TemporaryDirectory(prefix="readnovel-resume-", delete=False)
    edge = None
    output = ""
    diagnostics = []
    node_code = edge_code = None
    node_pid = None
    timed_out = forced_edge_stop = False
    stage = "Edge launch"
    try:
        edge = start_owned_edge(profile.name, config["history"])
        stage = "Node launch"
        with subprocess.Popen(
            ["node", "scripts/check_reader_resume_browser.cjs"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            cwd=ROOT,
        ) as child:
            node_pid = child.pid
            stage = "Node communication"
            try:
                output, _ = child.communicate(
                    json.dumps({**config, "profile": profile.name}), timeout=140
                )
            except subprocess.TimeoutExpired as exc:
                timed_out = True
                partial = exc.stdout or b""
                output = (
                    partial.decode("utf-8", errors="replace")
                    if isinstance(partial, bytes)
                    else partial
                )
                diagnostics.append(f"FAIL Browser QA {label} Node timeout after 140 s.")
                try:
                    kill_owned_process(child)
                finally:
                    node_code = child.poll()
                complete, _ = child.communicate(timeout=10)
                output = complete or output
            node_code = child.returncode
    except (OSError, subprocess.TimeoutExpired) as exc:
        diagnostics.append(f"FAIL Browser QA {label} Runner {stage}: {type(exc).__name__}.")
    finally:
        try:
            if edge is not None:
                edge_code = edge.poll()
                if (
                    sys.platform == "win32"
                    and node_code is not None
                    and node_code & 0xFFFFFFFF == 0xC0000409
                ):
                    state = "running" if edge_code is None else exit_label(edge_code)
                    diagnostics.append(
                        f"Browser QA {label} before cleanup Node PID={node_pid}, "
                        f"Edge PID={edge.pid}, Edge={state}, {windows_memory_sample()}."
                    )
                if edge_code is None:
                    try:
                        edge_code = edge.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        forced_edge_stop = True
                        kill_owned_process(edge)
                        edge_code = edge.poll()
        except (OSError, subprocess.TimeoutExpired) as exc:
            diagnostics.append(f"FAIL Browser QA {label} Edge shutdown: {type(exc).__name__}.")
        try:
            cleanup_error, retries = release_browser_profile(profile)
        except OSError as exc:
            cleanup_error, retries = f"{type(exc).__name__} (errno={exc.errno})", 0
        if cleanup_error:
            diagnostics.append(f"FAIL Browser QA {label} Edge profile cleanup: {cleanup_error}.")
        elif retries:
            diagnostics.append(f"Browser QA {label} released Edge profile after {retries} retries.")
    if node_code is not None and sys.platform == "win32" and node_code & 0xC0000000 == 0xC0000000:
        diagnostics.append(
            f"FAIL Browser QA {label} Node native termination: {exit_label(node_code)}."
        )
    if edge_code and not forced_edge_stop:
        diagnostics.append(f"FAIL Browser QA {label} Edge process exit: {exit_label(edge_code)}.")
    if forced_edge_stop and node_code == 0:
        diagnostics.append(
            f"FAIL Browser QA {label} Edge required a forced stop after Node completed."
        )
    failed = timed_out or any(line.startswith("FAIL ") for line in diagnostics)
    diagnostics.append(
        f"Browser QA {label} processes Node={exit_label(node_code)}, Edge={exit_label(edge_code)}, "
        f"forced Edge stop={forced_edge_stop}."
    )
    status = 1 if timed_out else node_code or int(failed or node_code is None)
    return status, [*output.splitlines(), *diagnostics]


def completion_fixture(database: str, novel: UUID, operation: str) -> int:
    """Narrow browser test bridge. Only a disposable runner-created novel is eligible."""
    url = make_conninfo(local_audit_url(), dbname=database)
    with psycopg.connect(url, connect_timeout=3) as db:
        if operation in ("snapshot", "bookmark-snapshot"):
            db.execute("SET TRANSACTION READ ONLY")
        require_disposable(db)
        fixture = db.execute(
            "SELECT 1 FROM novels WHERE id=%s AND slug=%s AND author='Test' AND title='Đọc tiếp QA'",
            (novel, f"resume-qa-{novel.hex}"),
        ).fetchone()
        if not database.endswith("_migrated") or not fixture:
            raise ValueError("Expected a disposable browser fixture")
        if operation == "archive-bookmark":
            changed = db.execute(
                """UPDATE chapters SET content_status='Archived'
                   WHERE novel_id=%s AND chapter_sequence=9""",
                (novel,),
            ).rowcount
            return 0 if changed == 1 else 1
        if operation == "expire-bookmark-b":
            changed = db.execute(
                """UPDATE user_sessions s SET expires_at=now()-interval '1 second'
                   FROM bookmarks b JOIN chapters c ON c.id=b.chapter_id
                   JOIN users u ON u.id=b.user_id
                   WHERE b.novel_id=%s AND c.chapter_sequence=3 AND s.user_id=b.user_id
                     AND u.email=u.id::text || '@example.invalid' AND s.expires_at>now()""",
                (novel,),
            ).rowcount
            return 0 if changed == 1 else 1
        if operation == "expire-a":
            changed = db.execute(
                """UPDATE user_sessions s SET expires_at=now()-interval '1 second'
                   FROM reading_progress p JOIN users u ON u.id=p.user_id
                   WHERE p.novel_id=%s AND p.max_read_sequence=777 AND s.user_id=u.id
                     AND u.email=u.id::text || '@example.invalid' AND s.expires_at>now()""",
                (novel,),
            ).rowcount
            return 0 if changed == 1 else 1
        if operation in ("edit-1", "edit-3"):
            changed = db.execute(
                "UPDATE chapters SET content=content || ' Revision B' WHERE novel_id=%s AND chapter_sequence=%s",
                (novel, int(operation[-1])),
            ).rowcount
            return 0 if changed == 1 else 1
        # Compare whole Resume rows without returning any individual field or writer epoch.
        fingerprint = db.execute(
            """SELECT md5(string_agg(p::text, '|' ORDER BY p.user_id))
               FROM reading_progress p WHERE p.novel_id=%s""",
            (novel,),
        ).fetchone()[0]
        evidence = db.execute(
            """SELECT c.chapter_sequence, e.content_hash=digest(convert_to(c.content,'UTF8'),'sha256')
               FROM reading_chapter_completions e JOIN chapters c ON c.id=e.chapter_id
               WHERE e.novel_id=%s ORDER BY c.chapter_sequence""",
            (novel,),
        ).fetchall()
        progress = db.execute(
            """SELECT c.chapter_sequence, p.revision, p.scroll_position, p.max_read_sequence
               FROM reading_progress p JOIN chapters c ON c.id=p.last_read_chapter_id
               WHERE p.novel_id=%s ORDER BY c.chapter_sequence, p.revision""",
            (novel,),
        ).fetchall()
        state = {"resume": fingerprint, "evidence": evidence, "progress": progress}
        if operation == "bookmark-snapshot":
            state["bookmarks"] = db.execute(
                """SELECT c.chapter_sequence, b.removed_at IS NULL, b.note IS NOT NULL
                   FROM bookmarks b JOIN chapters c ON c.id=b.chapter_id
                   WHERE b.novel_id=%s ORDER BY c.chapter_sequence""",
                (novel,),
            ).fetchall()
            state["a_sessions"] = db.execute(
                """SELECT count(*) FROM user_sessions s JOIN bookmarks b ON b.user_id=s.user_id
                   JOIN chapters c ON c.id=b.chapter_id
                   WHERE b.novel_id=%s AND c.chapter_sequence=9 AND b.note='QA legacy note'""",
                (novel,),
            ).fetchone()[0]
        print(json.dumps(state))
    return 0


def serve_offline_fixture(port: int, novel_id: str) -> None:
    """Record request entry and response status only for the guarded QA novel."""
    novel = UUID(novel_id)
    url = os.environ["DATABASE_URL"]
    info = conninfo_to_dict(url)
    if (
        info.get("host") not in LOCAL_HOSTS
        or (info.get("hostaddr") and info["hostaddr"] not in LOCAL_HOSTS)
        or info.get("service")
        or not re.fullmatch(r"readnovel_471a_test_[0-9a-f]{12}_migrated", info.get("dbname", ""))
    ):
        raise ValueError("Expected an explicit disposable loopback database")
    with psycopg.connect(url, connect_timeout=3) as db:
        db.execute("SET TRANSACTION READ ONLY")
        require_disposable(db)
        if not db.execute(
            """SELECT 1 FROM novels WHERE id=%s AND slug=%s AND author='Test'
                   AND to_regclass('public.reading_chapter_completions') IS NOT NULL""",
            (novel, f"resume-qa-{novel.hex}"),
        ).fetchone():
            raise ValueError("Expected a migrated Offline QA fixture")

    import uvicorn
    from starlette.responses import JSONResponse

    from app.main import app

    receipts = []
    resume_path = f"/api/progress/novels/{novel}/resume"

    async def with_receipts(scope, receive, send):
        if scope["type"] != "http":
            return await app(scope, receive, send)
        if scope["path"] == "/_reader_qa/resume-receipts" and scope["method"] == "GET":
            return await JSONResponse(receipts)(scope, receive, send)
        if scope["path"] != resume_path or scope["method"] != "PUT":
            return await app(scope, receive, send)
        attempt = dict(scope["headers"]).get(b"x-reader-qa-attempt", b"")
        receipt = {
            "id": attempt.decode("ascii") if re.fullmatch(rb"[AB]\d+-\d+", attempt) else None,
            "status": None,
        }
        receipts.append(receipt)

        async def observe_response(message):
            if message["type"] == "http.response.start":
                receipt["status"] = message["status"]
            await send(message)

        await app(scope, receive, observe_response)

    uvicorn.run(
        with_receipts,
        host="127.0.0.1",
        port=port,
        loop="asyncio:SelectorEventLoop" if sys.platform == "win32" else "auto",
        access_log=False,
    )


def check(database: str, history: str, suite: str, round_number: int | None = None) -> int:
    url = make_conninfo(local_audit_url(), dbname=database)
    guest_suite = suite == "guest"
    bookmark_suite = suite == "bookmarks"
    qa_password = secrets.token_urlsafe(24) if guest_suite or bookmark_suite else None
    signup_name = f"guest_qa_{uuid4().hex}"
    signup_email = f"{signup_name}@example.com"
    with psycopg.connect(url, connect_timeout=3) as db:
        require_disposable(db)
        if (
            not database.endswith("_migrated")
            or not db.execute(
                "SELECT to_regclass('public.reading_chapter_completions') IS NOT NULL"
            ).fetchone()[0]
        ):
            raise ValueError("A migrated disposable database is required")
        if (guest_suite or bookmark_suite) and not db.execute(
            """SELECT EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='bookmarks' AND column_name='removed_at')"""
        ).fetchone()[0]:
            raise ValueError("Bookmark QA requires migration 004 on the disposable database")
        novel = uuid4()
        users = [uuid4(), uuid4()]
        tokens = [secrets.token_hex(32), secrets.token_hex(32)]
        slug = f"resume-qa-{novel.hex}"
        content = ("Tiếng Việt, chính văn. " * 12 + "\r\n\r\n") * 48
        db.execute(
            "INSERT INTO novels(id,slug,title,author) VALUES (%s,%s,'Đọc tiếp QA','Test')",
            (novel, slug),
        )
        if guest_suite:
            sequences = (1, 50, 100)
        elif bookmark_suite:
            sequences = (1, 3, 9, *range(10, 31))
        else:
            sequences = (1, 3, 9, *range(10, 60)) if suite == "completion" else (1, 3, 9)
        for sequence in sequences:
            db.execute(
                """INSERT INTO chapters(novel_id,chapter_sequence,chapter_number,title,content)
                   VALUES (%s,%s,%s,%s,%s)""",
                (
                    novel,
                    sequence,
                    str(sequence),
                    f"Chương {sequence}",
                    content if guest_suite or sequence < 10 else "QA",
                ),
            )
        for user, token in zip(users, tokens, strict=True):
            db.execute(
                "INSERT INTO users(id,email,username) VALUES (%s,%s,%s)",
                (user, f"{user}@example.invalid", str(user)),
            )
            db.execute(
                """INSERT INTO user_sessions(user_id,refresh_token_hash,expires_at)
                   VALUES (%s,%s,now()+interval '1 day')""",
                (user, hashlib.sha256(token.encode()).hexdigest()),
            )
        if qa_password:
            db.execute(
                "UPDATE users SET password_hash=%s WHERE id=%s",
                (hash_password(qa_password), users[0]),
            )
        if bookmark_suite:
            db.execute(
                """INSERT INTO bookmarks(user_id,novel_id,chapter_id,note,created_at)
                   SELECT %s,novel_id,id,CASE WHEN chapter_sequence=9 THEN 'QA legacy note' END,
                          now()-chapter_sequence*interval '1 minute'
                   FROM chapters WHERE novel_id=%s AND chapter_sequence>=9""",
                (users[0], novel),
            )
            db.execute(
                """INSERT INTO bookmarks(user_id,novel_id,chapter_id)
                   SELECT %s,novel_id,id FROM chapters WHERE novel_id=%s AND chapter_sequence=3""",
                (users[1], novel),
            )
        db.execute(
            """INSERT INTO reading_progress (user_id,novel_id,last_read_chapter_id,
                   max_read_sequence,scroll_position,resume_content_hash,resume_hash_scheme)
               SELECT %s,%s,id,777,0.55,%s,'sha256-utf8-raw-v1'
               FROM chapters WHERE novel_id=%s AND chapter_sequence=%s""",
            (
                users[0],
                novel,
                hashlib.sha256(content.encode()).digest(),
                novel,
                50 if guest_suite else 3,
            ),
        )

    label = case_label(suite, history, round_number)
    server = None
    exit_code = 0
    try:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        env = os.environ.copy()
        env.update(DATABASE_URL=url, ALLOWED_ORIGINS=origin)
        command = (
            "import sys; from scripts.check_reader_resume_browser import serve_offline_fixture; "
            "serve_offline_fixture(int(sys.argv[1]),sys.argv[2])"
            if suite == "offline"
            else "import sys,uvicorn; uvicorn.run('app.main:app',host='127.0.0.1',"
            "port=int(sys.argv[1]),loop='asyncio:SelectorEventLoop' if sys.platform=='win32'"
            " else 'auto',access_log=False)"
        )
        server = subprocess.Popen(
            [sys.executable, "-c", command, str(port), str(novel)],
            env=env,
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"START Browser QA {label}", flush=True)
        startup_error = wait_for_app(server, port)
        if startup_error:
            print(f"FAIL Browser QA {label} app startup: {startup_error}.", flush=True)
            return 1
        print(f"Browser QA {label} app readiness HTTP 200, launching Edge and Node.", flush=True)
        exit_code, lines = run_edge_qa(
            {
                "origin": origin,
                "path": f"/novel/{slug}",
                "progress": f"/api/progress/novels/{novel}",
                "tokens": tokens,
                "owners": [str(user) for user in users]
                if suite in ("offline", "manual-offline")
                else [],
                "csrf": [secrets.token_hex(32), secrets.token_hex(32)],
                "sessionCookie": env.get("SESSION_COOKIE_NAME", "session_token"),
                "csrfCookie": env.get("CSRF_COOKIE_NAME", "csrf_token"),
                "history": history,
                "suite": suite,
                "round": round_number,
                "python": sys.executable,
                "database": database,
                "novel": str(novel),
                "login": str(users[0]) if qa_password else None,
                "signupName": signup_name if guest_suite else None,
                "signupEmail": signup_email if guest_suite else None,
                "password": qa_password,
            }
        )
        final = None
        for line in lines:
            if line.startswith("RESUME_QA_FINAL "):
                final = json.loads(line.removeprefix("RESUME_QA_FINAL "))
            else:
                print(line, flush=True)
        if exit_code:
            print(f"FAIL Browser QA {label} combined result {exit_label(exit_code)}.", flush=True)
            return exit_code
        if suite == "resume" and os.environ.get("READNOVEL_QA_TOP_INTENT_PROBE") == "1":
            return int("PASS guarded Home/reflow probe and PostgreSQL fraction 0." not in lines)
        with psycopg.connect(url, connect_timeout=3) as db:
            db.execute("SET TRANSACTION READ ONLY")
            require_disposable(db)
            if bookmark_suite:
                states = db.execute(
                    """SELECT b.user_id,c.chapter_sequence,b.removed_at IS NULL,b.note
                       FROM bookmarks b JOIN chapters c ON c.id=b.chapter_id
                       WHERE b.novel_id=%s ORDER BY c.chapter_sequence""",
                    (novel,),
                ).fetchall()
                expected = [
                    (users[0], 1, True, None),
                    (users[1], 3, True, None),
                    (users[0], 9, False, "QA legacy note"),
                    *((users[0], seq, True, None) for seq in range(10, 31)),
                ]
                if states != expected:
                    print(
                        "FAIL PostgreSQL bookmark owner, active flags or legacy note.",
                        file=sys.stderr,
                    )
                    return 1
                print(
                    "PASS PostgreSQL: isolated A/B bookmarks; archived note retained after removal."
                )
                return 0
            rows = db.execute(
                """SELECT p.user_id,c.chapter_sequence,p.revision,p.max_read_sequence
                   FROM reading_progress p JOIN chapters c ON c.id=p.last_read_chapter_id
                   WHERE p.novel_id=%s""",
                (novel,),
            ).fetchall()
            completions = db.execute(
                """SELECT e.user_id,c.chapter_sequence,
                          e.content_hash=digest(convert_to(c.content,'UTF8'),'sha256')
                   FROM reading_chapter_completions e JOIN chapters c ON c.id=e.chapter_id
                   WHERE e.novel_id=%s""",
                (novel,),
            ).fetchall()
            has_bookmark = (
                guest_suite
                and db.execute(
                    "SELECT EXISTS(SELECT 1 FROM bookmarks WHERE novel_id=%s)", (novel,)
                ).fetchone()[0]
            )
            signup = (
                db.execute(
                    "SELECT id FROM users WHERE username=%s AND email=%s",
                    (signup_name, signup_email),
                ).fetchone()
                if guest_suite
                else None
            )
        by_user = {user: [chapter, rev, maximum] for user, chapter, rev, maximum in rows}
        actual = [by_user.get(user) for user in users]
        if guest_suite:
            if (
                not signup
                or actual != [[50, 0, 777], None]
                or by_user.get(signup[0]) != [100, 1, 0]
                or len(rows) != 2
                or completions
                or has_bookmark
            ):
                print(
                    "FAIL Guest/Auth isolation, explicit Resume, legacy max or Guest claims in PostgreSQL.",
                    file=sys.stderr,
                )
                return 1
            print(
                "PASS PostgreSQL: A retained chapter 50 and legacy max 777; B saved chapter 100 explicitly; zero Completion and Bookmark rows."
            )
            return 0
        if suite == "completion":
            if (
                completions != [(users[0], 1, True)]
                or len(rows) != 2
                or [row[2] if row else None for row in actual] != [777, 0]
            ):
                print(
                    "FAIL final completion ledger, account isolation or legacy max.",
                    file=sys.stderr,
                )
                return 1
            print(
                "PASS PostgreSQL: one revision-B evidence for account A, Resume legacy max preserved."
            )
            return 0
        if suite == "manual-offline":
            expected = [[*final[0], 777], [*final[1], 0] if final[1] else None] if final else None
            if (
                not expected
                or actual != expected
                or len(rows) != sum(row is not None for row in expected)
                or completions != [(users[0], 1, True)]
            ):
                print(
                    "FAIL manual offline fixture state, ledger or account isolation.",
                    file=sys.stderr,
                )
                return 1
            print(
                f"PASS PostgreSQL: Resume {actual}; one explicit chapter 1 completion for A, zero for B."
            )
            return 0
        if suite == "offline":
            expected = [[*final[0], 777], [*final[1], 0] if final[1] else None] if final else None
            if (
                not expected
                or actual != expected
                or len(rows) != sum(row is not None for row in expected)
                or completions != [(users[0], 1, True)]
            ):
                print(
                    "FAIL offline authoritative state, isolated completion or legacy max.",
                    file=sys.stderr,
                )
                return 1
            print(f"PASS PostgreSQL offline state {actual}; one explicit completion for A.")
            return 0
        expected = [[*final[0], 777], [*final[1], 0]] if final else None
        if len(rows) != 2 or completions or actual != expected:
            print(
                f"FAIL final fixture state: actual={actual}, expected={expected}, "
                f"resume_rows={len(rows)}, completion_rows={len(completions)}",
                file=sys.stderr,
            )
            return 1
        print(
            f"PASS PostgreSQL: two Resume rows (chapter/revision/legacy max) {actual}, zero completions."
        )
        return 0
    finally:
        try:
            if server is not None and server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired) as exc:
            print(f"FAIL Browser QA {label} server cleanup: {type(exc).__name__}.", flush=True)
            if not exit_code:
                raise
        finally:
            try:
                with psycopg.connect(url, connect_timeout=3) as db:
                    require_disposable(db)
                    if guest_suite:
                        db.execute(
                            "DELETE FROM users WHERE username=%s AND email=%s",
                            (signup_name, signup_email),
                        )
                    db.execute("DELETE FROM users WHERE id=ANY(%s)", (users,))
                    db.execute("DELETE FROM novels WHERE id=%s", (novel,))
            except (psycopg.Error, ValueError, OSError) as exc:
                print(f"FAIL Browser QA {label} fixture cleanup: {type(exc).__name__}.", flush=True)
                if not exit_code:
                    raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, help="Verifier-owned migrated database name")
    parser.add_argument(
        "--suite",
        choices=(
            "resume",
            "completion",
            "guest",
            "offline",
            "manual-offline",
            "bookmarks",
        ),
        default="resume",
    )
    parser.add_argument("--round", type=int, help="Optional matrix round number for diagnostics")
    parser.add_argument("--fixture-novel", type=UUID, help=argparse.SUPPRESS)
    parser.add_argument(
        "--fixture-operation",
        choices=(
            "snapshot",
            "edit-1",
            "edit-3",
            "expire-a",
            "bookmark-snapshot",
            "archive-bookmark",
            "expire-bookmark-b",
        ),
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--history-mode",
        choices=("auto", "fresh"),
        default="auto",
        help="Use native history or force a fresh document to verify the fallback",
    )
    try:
        args = parser.parse_args()
        if args.fixture_operation:
            if args.fixture_novel is None:
                parser.error("Expected the browser fixture novel")
            sys.exit(completion_fixture(args.database, args.fixture_novel, args.fixture_operation))
        sys.exit(shell_exit(check(args.database, args.history_mode, args.suite, args.round)))
    except (psycopg.Error, ValueError, OSError, subprocess.TimeoutExpired) as exc:
        sys.exit(
            f"FAIL Browser QA {case_label(args.suite, args.history_mode, args.round)} "
            f"Local database, process or profile check failed ({type(exc).__name__})."
        )
