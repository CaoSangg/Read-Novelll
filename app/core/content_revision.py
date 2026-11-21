"""D14 revision of the exact text stored in chapters.content."""

from hashlib import sha256

HASH_SCHEME = "sha256-utf8-raw-v1"


def content_digest(content: str) -> bytes:
    return sha256(content.encode("utf-8")).digest()
