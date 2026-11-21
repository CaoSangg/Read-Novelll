from urllib.parse import urlsplit, urlunsplit

from pydantic_settings import BaseSettings, SettingsConfigDict


def mask_database_url(url: str | None) -> str:
    """
    Mask password in database URL for safe logging.
    Example: postgresql://user:pass@host:5432/db -> postgresql://user:******@host:5432/db
    """
    if not url:
        return "[NOT_SET]"
    try:
        parts = urlsplit(url)
        if parts.password:
            # Replace password with ******
            user = parts.username or ""
            host = parts.hostname or ""
            port = f":{parts.port}" if parts.port else ""
            masked_netloc = f"{user}:******@{host}{port}"
            return urlunsplit(
                (parts.scheme, masked_netloc, parts.path, parts.query, parts.fragment)
            )
        return url
    except Exception:
        # Fallback regex masking
        import re

        return re.sub(r":([^/@:]+)@", r":******@", url)


class Settings(BaseSettings):
    """Application Settings loaded from environment and .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_NAME: str = "read-novel"
    ENVIRONMENT: str = "development"
    SECRET_KEY: str = "change-this-to-a-very-secure-random-secret-key-at-least-32-chars"
    SESSION_EXPIRE_DAYS: int = 7
    SESSION_COOKIE_NAME: str = "session_token"
    CSRF_COOKIE_NAME: str = "csrf_token"
    CSRF_HEADER_NAME: str = "X-CSRF-Token"
    ALLOWED_HOSTS: str = "localhost,127.0.0.1,test"
    ALLOWED_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,http://test"

    # Reverse proxy security: only trust forwarded headers from these peer IPs
    TRUSTED_PROXIES: str = "127.0.0.1,::1,testclient"

    # Rate limiting for auth
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: int = 5
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: int = 60
    REGISTER_RATE_LIMIT_MAX_ATTEMPTS: int = 5
    REGISTER_RATE_LIMIT_WINDOW_SECONDS: int = 60

    # Database connection parameters
    DATABASE_URL: str = ""
    DB_POOL_MIN_SIZE: int = 1
    DB_POOL_MAX_SIZE: int = 5
    DB_POOL_TIMEOUT: float = 5.0
    DB_POOL_MAX_IDLE: float = 30.0
    DEBUG_DB_QUERY: bool = False

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"

    @property
    def masked_database_url(self) -> str:
        return mask_database_url(self.DATABASE_URL)


settings = Settings()
