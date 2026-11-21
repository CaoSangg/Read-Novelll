"""Capture the unmodified Next.js Reader in an isolated copy, using existing mock data only."""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx


def main():
    root = Path(__file__).resolve().parents[1]
    for port in (3001, 9234):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    # Next 14's Windows entry resolution requires dependencies and project on the same drive.
    project = Path(tempfile.mkdtemp(prefix="qa-next-reference-", dir=root / ".venv"))
    shutil.copytree(root / "src", project / "src")
    (project / "public").mkdir()
    shutil.copy2(root / "public/mock-chapters.json", project / "public/mock-chapters.json")
    for name in (
        "package.json",
        "next.config.mjs",
        "tailwind.config.ts",
        "postcss.config.mjs",
        "tsconfig.json",
        "next-env.d.ts",
    ):
        shutil.copy2(root / name, project / name)
    # A junction shares installed dependencies without modifying or reinstalling them.
    command = "New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null".format(
        str(project / "node_modules").replace("'", "''"),
        str(root / "node_modules").replace("'", "''"),
    )
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", command], check=True, capture_output=True
    )
    env = {
        key: value
        for key, value in os.environ.items()
        if "SUPABASE" not in key and key != "DATABASE_URL"
    }
    env.update(
        {
            "NEXT_PUBLIC_SUPABASE_URL": "",
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": "",
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": "",
            "NEXT_TELEMETRY_DISABLED": "1",
        }
    )
    mock = json.loads((project / "public/mock-chapters.json").read_text(encoding="utf-8"))
    url = f"http://127.0.0.1:3001/novel/{mock['novel']['slug']}/{mock['chapters'][0]['chapter_sequence']}"
    with (project / "reference-server.log").open("w", encoding="utf-8") as log:
        server = subprocess.Popen(
            [
                "node",
                str(root / "node_modules/next/dist/bin/next"),
                "dev",
                "--hostname",
                "127.0.0.1",
                "--port",
                "3001",
            ],
            cwd=project,
            env=env,
            stdout=log,
            stderr=log,
        )
        try:
            print(
                "Starting isolated Next.js reference on local port 3001; cloud credentials removed.",
                flush=True,
            )
            for _ in range(90):
                if server.poll() is not None:
                    raise RuntimeError("Reference server exited before readiness")
                try:
                    if httpx.get(url, timeout=2).status_code == 200:
                        break
                except httpx.RequestError:
                    pass
                time.sleep(1)
            else:
                raise RuntimeError("Reference server unavailable")
            # Source TOC is visual reference only; the new confirmation policy has no source equivalent.
            return subprocess.call(
                ["node", str(root / "scripts/check_reader_browser.cjs"), url, "--next-reference"]
                + (
                    ["--navigation-reference"]
                    if "--navigation" in sys.argv or "--navigation-final" in sys.argv
                    else []
                )
                + (["--final-reference"] if "--navigation-final" in sys.argv else [])
                + (["--toc-reference"] if "--toc-jump" in sys.argv else []),
                cwd=root,
            )
        finally:
            if server.poll() is None:
                # Only the process tree we created; never touch an existing developer server.
                subprocess.run(
                    ["taskkill", "/PID", str(server.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                server.wait(timeout=15)
    # Retain generated reference files in the OS temp directory; no recursive asset deletion.


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        sys.exit(
            f"Next.js reference failed ({type(error).__name__}); no cloud configuration changed."
        )
