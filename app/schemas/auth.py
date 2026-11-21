"""
Authentication Request & Response Schemas (Pydantic v2).
Compliant with Phase 1.5 Architecture (Step 3).
"""

import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Precompiled regex patterns for input hygiene
USERNAME_REGEX = re.compile(r"^[a-zA-Z0-9_.-]+$")
EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")


class UserRegisterRequest(BaseModel):
    """Payload for user registration."""

    model_config = ConfigDict(extra="ignore")

    username: str = Field(
        ...,
        min_length=3,
        max_length=50,
        description="Alphanumeric username with underscores, periods, and hyphens",
    )
    email: str = Field(
        ...,
        min_length=5,
        max_length=255,
        description="Valid email address",
    )
    password: str = Field(
        ...,
        min_length=8,
        max_length=128,
        description="Plaintext password (8-128 characters)",
    )

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        clean = v.strip()
        if not USERNAME_REGEX.match(clean):
            raise ValueError(
                "Username may only contain letters, numbers, underscores, periods, and hyphens"
            )
        return clean

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        clean = v.strip().lower()
        if not EMAIL_REGEX.match(clean):
            raise ValueError("Invalid email address format")
        return clean


class UserLoginRequest(BaseModel):
    """Payload for user login."""

    model_config = ConfigDict(extra="ignore")

    username_or_email: str = Field(
        ...,
        min_length=3,
        max_length=255,
        description="Username or email address",
    )
    password: str = Field(
        ...,
        min_length=1,
        max_length=128,
        description="Plaintext password",
    )

    @field_validator("username_or_email")
    @classmethod
    def validate_identifier(cls, v: str) -> str:
        clean = v.strip()
        if not clean:
            raise ValueError("Username or email cannot be empty")
        return clean


class ChangePasswordRequest(BaseModel):
    """Payload for changing password of the currently authenticated user."""

    model_config = ConfigDict(extra="ignore")

    old_password: str = Field(
        ...,
        min_length=1,
        max_length=128,
        description="Current plaintext password",
    )
    new_password: str = Field(
        ...,
        min_length=8,
        max_length=128,
        description="New plaintext password (8-128 characters)",
    )


class UserResponse(BaseModel):
    """Safe public representation of a user profile."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    username: str
    role: str
    is_active: bool
    created_at: datetime


class AuthResponse(BaseModel):
    """Response returned upon successful registration or login."""

    user: UserResponse
    csrf_token: str
    message: str


class MessageResponse(BaseModel):
    """Generic message response."""

    message: str
    detail: str | None = None


class CsrfTokenResponse(BaseModel):
    """Response containing CSRF token."""

    csrf_token: str
