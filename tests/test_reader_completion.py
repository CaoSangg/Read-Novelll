"""Reader metadata supplies the explicit completion precondition without touching Resume."""

from test_progress_api import CSRF
from test_progress_api import progress_db as progress_db
from test_reader_resume import reader_metadata


async def test_reader_completion_and_legacy_evidence_follow_ssr_revision(async_client, progress_db):
    f = progress_db
    path = f"/novel/qa-{f.novels[0]}/10"
    endpoint = f.path + "/completions"
    target = f.chapters[10]
    status_path = endpoint + "?chapter_ids=" + str(target)
    await f.activate(async_client)
    await f.db.execute(
        "UPDATE reading_progress SET max_read_sequence=777 WHERE user_id=%s", (f.user_ids[0],)
    )
    resume = await f.resume_rows()

    async def status():
        return (await async_client.get(status_path)).json()["items"][0]["status"]

    async def document():
        response = await async_client.get(path)
        parsed, metadata = reader_metadata(response)
        classes = [attrs.get("class") for _, attrs in parsed.tags]
        assert classes.index("reader-content") < classes.index("reader-completion")
        assert classes.index("reader-completion") < classes.index("reader-navigation")
        return {
            "confirmation": True,
            "content_revision": {
                "scheme": metadata["data-hash-scheme"],
                "hash": metadata["data-content-hash"],
            },
        }

    old = await document()
    assert await status() == "not_completed"
    assert await f.evidence() == []

    async def confirm(body):
        return await async_client.put(f"{endpoint}/{target}", json=body, headers={CSRF: f.csrf})

    first = await confirm(old)
    repeat = await confirm(old)
    assert first.status_code == repeat.status_code == 200
    assert (
        repeat.json()["already_completed"]
        and first.json()["completed_at"] == repeat.json()["completed_at"]
    )
    assert await status() == "completed"
    evidence = await f.evidence()
    await f.db.execute("UPDATE chapters SET content=content || ' B' WHERE id=%s", (target,))
    new = await document()
    assert new["content_revision"] != old["content_revision"]
    assert await status() == "old_revision"
    assert (await confirm(old)).status_code == 409
    assert await f.evidence() == evidence
    assert (await confirm(new)).status_code == 200
    assert await status() == "completed"
    assert len(await f.evidence()) == 1
    assert await f.resume_rows() == resume
