"""
Authentication, Authorization & CSRF Dependencies for FastAPI.
Compliant with Phase 1.5 Architecture (Step 3).
"""

from typing import Any
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request, Response, status

from app.core.config import settings
from app.core.security import verify_csrf_token
from app.services.auth_service import get_user_by_session_token


def is_allowed_origin(origin_url: str | None) -> bool:
    """
    Verify if the Origin or Referer header matches allowed origins or hosts.
    Prevents cross-site request forgery from malicious third-party websites.
    """
    if not origin_url or not origin_url.strip():
        return False
    try:
        parts = urlsplit(origin_url.strip())
        origin_host = (
            parts.netloc.split(":")[0].lower() if parts.netloc else parts.path.split(":")[0].lower()
        )
        origin_base = (
            f"{parts.scheme}://{parts.netloc}".lower() if parts.scheme and parts.netloc else ""
        )

        allowed_origins = [
            o.strip().lower() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()
        ]
        allowed_hosts = [h.strip().lower() for h in settings.ALLOWED_HOSTS.split(",") if h.strip()]

        if origin_base and origin_base in allowed_origins:
            return True
        if origin_host and origin_host in allowed_hosts:
            return True
        return False
    except Exception:
        return False


def set_csrf_cookie(response: Response, csrf_token: str) -> None:
    """Set the readable Lax CSRF cookie for Double Submit verification."""
    max_age_seconds = settings.SESSION_EXPIRE_DAYS * 86400
    response.set_cookie(
        key=settings.CSRF_COOKIE_NAME,
        value=csrf_token,
        max_age=max_age_seconds,
        httponly=False,
        samesite="lax",
        secure=settings.is_production,
        path="/",
    )


def set_auth_cookies(
    response: Response,
    session_token: str,
    csrf_token: str,
) -> None:
    """
    Set secure HttpOnly Session Cookie and Lax CSRF Cookie on HTTP response.
    - Session Cookie: HttpOnly=True, SameSite=Lax, Secure=(True in production)
    - CSRF Cookie: HttpOnly=False (readable by frontend), SameSite=Lax, Secure=(True in production)
    """
    max_age_seconds = settings.SESSION_EXPIRE_DAYS * 86400

    # 1. Opaque Session Cookie
    response.set_cookie(
        key=settings.SESSION_COOKIE_NAME,
        value=session_token,
        max_age=max_age_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.is_production,
        path="/",
    )

    # 2. CSRF Double Submit Cookie
    set_csrf_cookie(response, csrf_token)


def clear_auth_cookies(response: Response) -> None:
    """Clear both session and CSRF cookies on client browser."""
    response.delete_cookie(
        key=settings.SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.is_production,
    )
    response.delete_cookie(
        key=settings.CSRF_COOKIE_NAME,
        path="/",
        httponly=False,
        samesite="lax",
        secure=settings.is_production,
    )


async def get_current_user(request: Request) -> dict[str, Any]:
    """
    Extract session token from cookie, query PostgreSQL for active session and user.
    Enforces active user status and session expiration.
    Returns user dict or raises 401 Unauthorized.
    """
    session_token = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if not session_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please log in.",
        )

    user = await get_user_by_session_token(session_token)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session. Please log in again.",
        )

    # Attach to request state for downstream handlers
    request.state.user = user
    return user


# Alias for explicit requirement naming
require_authenticated_user = get_current_user


async def require_admin(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Ensure the authenticated user has 'Admin' role in PostgreSQL.
    Denies 'Reader' role with HTTP 403 Forbidden.
    """
    if user.get("role") != "Admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required to perform this action.",
        )
    return user


async def verify_csrf(request: Request) -> None:
    """
    Verify CSRF token for state-changing requests using cookie authentication:
    1. Origin / Referer Validation: Blocks requests originating from untrusted third-party domains.
    2. Double Submit Cookie Verification: Compares X-CSRF-Token header with csrf_token cookie.
    Raises 403 Forbidden on any failure.
    """
    # 1. Check Origin or Referer if present (browsers always send Origin on cross-origin POST)
    origin = request.headers.get("Origin") or request.headers.get("Referer")
    if origin:
        if not is_allowed_origin(origin):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="CSRF validation failed: untrusted origin.",
            )

    # 2. Check Double Submit Cookie token
    csrf_cookie = request.cookies.get(settings.CSRF_COOKIE_NAME)
    csrf_header = request.headers.get(settings.CSRF_HEADER_NAME)

    if not verify_csrf_token(csrf_cookie, csrf_header):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF validation failed: missing or invalid CSRF token.",
        )
