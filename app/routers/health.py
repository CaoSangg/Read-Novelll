"""
Health and Readiness check endpoints.
Compliant with Phase 1.5 Architecture (Step 2).
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from app.core.config import settings
from app.db.pool import check_database_readiness

router = APIRouter(prefix="/api/health", tags=["health"])


class LivenessResponse(BaseModel):
    status: str
    app: str
    environment: str
    timestamp: str


class ReadinessResponse(BaseModel):
    status: str
    database: str
    latency_ms: float | None = None
    error: str | None = None
    timestamp: str


@router.get("", response_model=LivenessResponse, summary="Liveness Probe")
async def liveness_check() -> LivenessResponse:
    """
    FastAPI Liveness check: confirms the HTTP process is running.
    Does NOT execute database queries.
    """
    return LivenessResponse(
        status="ok",
        app=settings.APP_NAME,
        environment=settings.ENVIRONMENT,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


@router.get(
    "/readiness",
    response_model=ReadinessResponse,
    summary="Readiness Probe",
    responses={
        200: {"description": "Database is ready and reachable"},
        503: {"description": "Database is unavailable or not ready"},
    },
)
async def readiness_check(response: Response) -> ReadinessResponse:
    """
    Readiness check: confirms PostgreSQL connection pool can execute queries.
    Returns 200 if database responds, 503 if database is disconnected.
    Never exposes credentials or raw connection strings in error output.
    """
    is_ready, latency_ms, error_msg = await check_database_readiness()

    now_iso = datetime.now(timezone.utc).isoformat()

    if is_ready:
        return ReadinessResponse(
            status="ready",
            database="connected",
            latency_ms=latency_ms,
            error=None,
            timestamp=now_iso,
        )

    response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(
        status="unavailable",
        database="disconnected",
        latency_ms=None,
        error=error_msg or "Database connection failed",
        timestamp=now_iso,
    )
