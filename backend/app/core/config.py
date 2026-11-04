"""Static (process-level) configuration loaded from environment variables / .env.

Runtime-editable settings (models, temperatures, memory policy...) live in the
SQLite ``settings`` table and are managed by ``app.services.settings``.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_VERSION = "1.0.0"
API_VERSION = "v1"


def _default_data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "LocalBrowserAI"
    return Path.home() / ".local" / "share" / "LocalBrowserAI"


class EnvSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LBA_",
        env_file=(Path(__file__).resolve().parents[2] / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8765
    data_dir: Path = Field(default_factory=_default_data_dir)
    # Exact allowed CORS origins, comma separated (e.g. chrome-extension://<id>).
    allowed_origins: str = ""
    # Initial Ollama URL (runtime setting overrides once saved).
    ollama_url: str = "http://127.0.0.1:11434"
    max_upload_mb: int = 50
    allow_pairing: bool = True
    log_level: str = "INFO"

    @field_validator("host")
    @classmethod
    def _loopback_only(cls, v: str) -> str:
        if v not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Backend must bind to a loopback address (127.0.0.1)")
        return v

    @property
    def origins(self) -> list[str]:
        items = [o.strip().rstrip("/") for o in self.allowed_origins.split(",") if o.strip()]
        return [o for o in items if o != "*" and "*" not in o]

    # ---- paths -----------------------------------------------------------
    @property
    def db_path(self) -> Path:
        return self.data_dir / "app.db"

    @property
    def chroma_dir(self) -> Path:
        return self.data_dir / "chroma"

    @property
    def documents_dir(self) -> Path:
        return self.data_dir / "documents"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def token_path(self) -> Path:
        return self.data_dir / "api_token"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.chroma_dir, self.documents_dir, self.backups_dir, self.logs_dir):
            p.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_env() -> EnvSettings:
    return EnvSettings()
