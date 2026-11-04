"""Local API token authentication."""

from __future__ import annotations

import hmac
import os
import secrets
from pathlib import Path

from fastapi import Request

from app.core.errors import AuthError


def load_or_create_token(path: Path) -> str:
    """Return the persistent API token, generating it on first run."""
    env_token = os.environ.get("LBA_API_TOKEN")
    if env_token:
        return env_token.strip()
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:  # pragma: no cover - Windows ignores most modes
        pass
    return token


def token_matches(expected: str, provided: str | None) -> bool:
    if not provided:
        return False
    return hmac.compare_digest(expected.encode(), provided.encode())


def extract_bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


async def require_token(request: Request) -> None:
    """FastAPI dependency enforcing the local bearer token."""
    expected: str = request.app.state.api_token
    if not token_matches(expected, extract_bearer(request)):
        raise AuthError(
            "Missing or invalid API token.",
            hint="Pair the extension again from Settings → Connection, or paste the token "
            "printed by scripts/start.ps1.",
        )
