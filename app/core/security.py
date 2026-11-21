"""
Security, Cryptography, and Password Hashing Module.
Compliant with Phase 1.5 Architecture (Step 3).

Standards:
- Password Hashing: Argon2id via pwdlib[argon2].
- Session Security: CSPRNG Opaque Tokens hashed with SHA-256 before storage in PostgreSQL.
- CSRF Protection: Double Submit / Cookie-to-Header verification.
- Anti-enumeration: Constant-time dummy verification for non-existent accounts.
- Rate Limiting: In-memory sliding window limiter to reduce brute-force attacks.
"""

import hashlib
import secrets
import threading
import time
from collections import defaultdict

from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher

# Initialize Argon2id password hash manager (default parameters: memory 64MB, time cost 3, parallelism 4)
_password_hash_manager = PasswordHash((Argon2Hasher(),))

# Pre-computed dummy Argon2id hash for constant-time comparison when user does not exist
DUMMY_ARGON2_HASH = "$argon2id$v=19$m=65536,t=3,p=4$TwydOnniSte0BVAEAz0Dfw$wmBSrAy6x3ZRd/6+4JuFt17wxSqW56BI2SaVRwxHo2A"


# ==============================================================================
# 1. PASSWORD HASHING & VERIFICATION (Argon2id)
# ==============================================================================


def hash_password(plain_password: str) -> str:
    """
    Hash a plaintext password using Argon2id.
    Never logs the password or hash.
    """
    return _password_hash_manager.hash(plain_password)


def verify_password(plain_password: str, hashed_password: str | None) -> bool:
    """
    Verify a plaintext password against an Argon2id hash.
    If hashed_password is None or invalid format, safely returns False.
    """
    if not hashed_password:
        return False
    try:
        return _password_hash_manager.verify(plain_password, hashed_password)
    except Exception:
        return False


def verify_dummy_password(plain_password: str) -> None:
    """
    Execute Argon2id verification against a pre-computed dummy hash.
    Mitigates user enumeration and timing differences when a requested user does not exist.
    """
    try:
        _password_hash_manager.verify(plain_password, DUMMY_ARGON2_HASH)
    except Exception:
        pass


# ==============================================================================
# 2. OPAQUE SESSION TOKEN & SHA-256 HASHING
# ==============================================================================


def generate_session_token() -> str:
    """
    Generate a cryptographically secure random opaque session token.
    Uses CSPRNG (secrets.token_urlsafe(32)), returning a 43-character base64-encoded string.
    """
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    """
    Hash a session token using SHA-256 hex digest.
    This 64-character hex string is the only value saved in the PostgreSQL user_sessions table.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ==============================================================================
# 3. CSRF TOKEN MANAGEMENT
# ==============================================================================


def generate_csrf_token() -> str:
    """Generate a cryptographically secure random token for CSRF protection."""
    return secrets.token_urlsafe(32)


def verify_csrf_token(cookie_token: str | None, header_token: str | None) -> bool:
    """
    Constant-time comparison between CSRF cookie token and request header token.
    Both must be non-empty and match exactly.
    """
    if not cookie_token or not header_token:
        return False
    return secrets.compare_digest(cookie_token.strip(), header_token.strip())


# ==============================================================================
# 4. IN-MEMORY RATE LIMITER (BRUTE-FORCE & DOS MITIGATION)
# ==============================================================================


class ActionRateLimiter:
    """
    Thread-safe in-memory sliding window rate limiter designed for a single FastAPI worker.
    Tracks attempts per identifier (client IP address) within a sliding time window.
    """

    def __init__(self, max_attempts: int = 5, window_seconds: int = 60) -> None:
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._attempts: dict[str, list[float]] = defaultdict(list)

    def is_rate_limited(self, identifier: str) -> bool:
        """Check if the given identifier has exceeded the maximum allowed attempts."""
        now = time.monotonic()
        with self._lock:
            timestamps = self._attempts.get(identifier, [])
            valid_timestamps = [t for t in timestamps if now - t < self.window_seconds]
            self._attempts[identifier] = valid_timestamps
            return len(valid_timestamps) >= self.max_attempts

    def record_attempt(self, identifier: str) -> int:
        """
        Record an action/attempt timestamp.
        Returns the current number of attempts within the sliding window.
        """
        now = time.monotonic()
        with self._lock:
            timestamps = self._attempts.get(identifier, [])
            valid_timestamps = [t for t in timestamps if now - t < self.window_seconds]
            valid_timestamps.append(now)
            self._attempts[identifier] = valid_timestamps
            return len(valid_timestamps)

    def record_failed_attempt(self, identifier: str) -> int:
        """Alias for backward compatibility with login failure tracking."""
        return self.record_attempt(identifier)

    def reset(self, identifier: str | None = None) -> None:
        """Clear recorded attempts for a specific identifier or for all identifiers."""
        with self._lock:
            if identifier is not None:
                self._attempts.pop(identifier, None)
            else:
                self._attempts.clear()


# Backward compatibility alias
LoginRateLimiter = ActionRateLimiter

# Global rate limiter instances (configured for single Uvicorn worker)
login_rate_limiter = ActionRateLimiter(max_attempts=5, window_seconds=60)
register_rate_limiter = ActionRateLimiter(max_attempts=5, window_seconds=60)
