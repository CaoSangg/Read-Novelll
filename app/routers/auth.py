"""
Authentication API Endpoints (/api/auth/*).
Compliant with Phase 1.5 Architecture (Step 3).
"""

from typing import Any

from fastapi import APIRouter, Depends, Request, Response, status

from app.core.config import settings
from app.core.security import generate_csrf_token
from app.dependencies.auth import (
    clear_auth_cookies,
    require_admin,
    require_authenticated_user,
    set_auth_cookies,
    set_csrf_cookie,
    verify_csrf,
)
from app.schemas.auth import (
    AuthResponse,
    ChangePasswordRequest,
    CsrfTokenResponse,
    MessageResponse,
    UserLoginRequest,
    UserRegisterRequest,
    UserResponse,
)
from app.services import auth_service

router = APIRouter(prefix="/api/auth", tags=["authentication"])


def get_client_ip(request: Request) -> str:
    """
    Safely extract real client IP address.
    Strictly enforces proxy trust: X-Forwarded-For is ONLY parsed if the immediate
    network peer (request.client.host) is listed in settings.TRUSTED_PROXIES.
    Direct requests from untrusted clients return request.client.host directly,
    preventing header-spoofing bypasses of rate limiters.
    """
    peer_ip = request.client.host if request.client else "127.0.0.1"

    trusted_proxies = {p.strip().lower() for p in settings.TRUSTED_PROXIES.split(",") if p.strip()}

    if peer_ip.lower() in trusted_proxies:
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            # First IP in X-Forwarded-For represents the original client
            candidate_ip = forwarded.split(",")[0].strip()
            if candidate_ip:
                return candidate_ip

    return peer_ip


@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new user account",
    dependencies=[Depends(verify_csrf)],
)
async def register(
    payload: UserRegisterRequest,
    request: Request,
    response: Response,
) -> AuthResponse:
    """
    Register a new user account with 'Reader' role.
    On success, automatically creates an Opaque Session and sets HttpOnly Session Cookie.
    """
    user_agent = request.headers.get("User-Agent")
    ip_address = get_client_ip(request)

    user_dict, session_token, csrf_token = await auth_service.register_user(
        username=payload.username,
        email=payload.email,
        password=payload.password,
        user_agent=user_agent,
        ip_address=ip_address,
    )

    set_auth_cookies(response, session_token, csrf_token)

    return AuthResponse(
        user=UserResponse(**user_dict),
        csrf_token=csrf_token,
        message="Registration successful. Logged in automatically.",
    )


@router.post(
    "/login",
    response_model=AuthResponse,
    summary="Log in with username or email and password",
    dependencies=[Depends(verify_csrf)],
)
async def login(
    payload: UserLoginRequest,
    request: Request,
    response: Response,
) -> AuthResponse:
    """
    Authenticate user credentials against Argon2id hash.
    Enforces brute-force rate limiting and active account status.
    Issues secure Opaque Session Cookie and Lax CSRF Cookie.
    """
    user_agent = request.headers.get("User-Agent")
    ip_address = get_client_ip(request)

    user_dict, session_token, csrf_token = await auth_service.authenticate_user(
        username_or_email=payload.username_or_email,
        password=payload.password,
        user_agent=user_agent,
        ip_address=ip_address,
    )

    set_auth_cookies(response, session_token, csrf_token)

    return AuthResponse(
        user=UserResponse(**user_dict),
        csrf_token=csrf_token,
        message="Login successful.",
    )


@router.post(
    "/logout",
    response_model=MessageResponse,
    summary="Log out and revoke current session",
    dependencies=[Depends(verify_csrf)],
)
async def logout(
    request: Request,
    response: Response,
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> MessageResponse:
    """
    Log out the current user:
    - Revokes session by deleting session record from PostgreSQL.
    - Clears cookies on the browser.
    Protected by CSRF verification.
    """
    session_token = request.cookies.get(settings.SESSION_COOKIE_NAME)
    await auth_service.revoke_session_by_token(session_token)

    clear_auth_cookies(response)
    return MessageResponse(message="Successfully logged out.")


@router.get(
    "/me",
    response_model=UserResponse,
    summary="Retrieve authenticated user profile",
)
async def get_me(
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> UserResponse:
    """
    Return currently authenticated user information from PostgreSQL.
    Rejects requests without valid active session cookie with 401 Unauthorized.
    """
    return UserResponse(
        id=current_user["id"],
        email=current_user["email"],
        username=current_user["username"],
        role=current_user["role"],
        is_active=current_user["is_active"],
        created_at=current_user["created_at"],
    )


@router.post(
    "/change-password",
    response_model=MessageResponse,
    summary="Change user password and revoke all active sessions",
    dependencies=[Depends(verify_csrf)],
)
async def change_password(
    payload: ChangePasswordRequest,
    response: Response,
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> MessageResponse:
    """
    Change user password:
    - Verifies old password with Argon2id.
    - Hashes new password with Argon2id.
    - Updates database and revokes ALL user sessions in a single transaction.
    - Clears browser cookies and requires re-login.
    Protected by CSRF verification.
    """
    await auth_service.change_user_password(
        user_id=current_user["id"],
        old_password=payload.old_password,
        new_password=payload.new_password,
    )

    clear_auth_cookies(response)
    return MessageResponse(
        message="Password changed successfully. All active sessions revoked. Please log in again."
    )


@router.get(
    "/csrf-token",
    response_model=CsrfTokenResponse,
    summary="Obtain a fresh CSRF token and set CSRF cookie",
)
async def get_csrf_token(response: Response) -> CsrfTokenResponse:
    """Issue a fresh CSRF token and update the lax CSRF cookie."""
    token = generate_csrf_token()
    set_csrf_cookie(response, token)
    return CsrfTokenResponse(csrf_token=token)


@router.get(
    "/admin/verify",
    response_model=MessageResponse,
    summary="Admin-only authorization probe",
)
async def verify_admin_access(
    admin_user: dict[str, Any] = Depends(require_admin),
) -> MessageResponse:
    """Admin-only endpoint for verifying role-based access control."""
    return MessageResponse(message=f"Admin privileges confirmed for user {admin_user['username']}.")
