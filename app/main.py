"""
FastAPI Application Entry Point.
Phase 1.5 Architecture (Step 1 & Step 2).
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.db.pool import close_db_pool, init_db_pool
from app.routers import auth, bookmarks, health, novels, progress, web

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("readnovel.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI Lifespan Context Manager.
    Manages global resources (database connection pool) across the application process lifecycle.
    """
    # 1. Startup phase
    logger.info(f"Starting {settings.APP_NAME} in '{settings.ENVIRONMENT}' mode...")

    if settings.DATABASE_URL and settings.DATABASE_URL.strip():
        try:
            await init_db_pool()
        except Exception as e:
            logger.error(f"Database pool initialization failed during startup: {type(e).__name__}")
            if settings.is_production:
                raise
    else:
        logger.warning(
            "DATABASE_URL not configured. Database endpoints will report 503 until configured."
        )
        if settings.is_production:
            raise ValueError("DATABASE_URL is mandatory in production environment.")

    yield

    # 2. Shutdown phase
    logger.info("Shutting down application. Cleaning up resources...")
    await close_db_pool()
    logger.info("Shutdown complete.")


def create_app() -> FastAPI:
    """Application factory for FastAPI."""
    app = FastAPI(
        title="Khấu Vấn Tiên Đạo - Web Đọc Tiểu Thuyết",
        description="FastAPI Backend & Jinja2 Reader Platform",
        version="1.5.0",
        lifespan=lifespan,
    )

    # Configure CORS with explicit origins (No wildcard when allow_credentials=True)
    allowed_origins = [o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-CSRF-Token", "Accept"],
    )

    # Include API Routers
    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(novels.router)
    app.include_router(progress.router)
    app.include_router(bookmarks.router)
    app.include_router(web.router)

    # Serve only the dedicated asset directory, independent of the working directory.
    static_dir = Path(__file__).resolve().parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    return app


app = create_app()
