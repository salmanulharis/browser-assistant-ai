"""Runtime settings persisted in SQLite with an in-memory cache."""

from __future__ import annotations

import threading

from sqlalchemy import select

from app.core.errors import AppError
from app.database.base import Database
from app.models.entities import Setting
from app.schemas.settings import AppSettings, SettingsUpdate, is_loopback_url

_KEY = "app"


class SettingsService:
    def __init__(self, db: Database, defaults: AppSettings | None = None) -> None:
        self.db = db
        self._defaults = defaults or AppSettings()
        self._cache: AppSettings | None = None
        self._lock = threading.Lock()

    def get(self) -> AppSettings:
        with self._lock:
            if self._cache is None:
                self._cache = self._load()
            return self._cache.model_copy(deep=True)

    def _load(self) -> AppSettings:
        with self.db.session() as s:
            row = s.get(Setting, _KEY)
            stored = row.value if row and isinstance(row.value, dict) else {}
        merged = {**self._defaults.model_dump(), **stored}
        # Drop unknown keys from older versions.
        merged = {k: v for k, v in merged.items() if k in AppSettings.model_fields}
        try:
            return AppSettings.model_validate(merged)
        except Exception:
            return self._defaults.model_copy(deep=True)

    def update(self, patch: SettingsUpdate) -> AppSettings:
        current = self.get()
        changes = patch.model_dump(exclude_unset=True, exclude_none=True)
        data = {**current.model_dump(), **changes}
        try:
            new = AppSettings.model_validate(data)
        except Exception as exc:  # pydantic.ValidationError
            raise AppError(f"Invalid settings: {exc}", code="INVALID_SETTINGS", status_code=422) from exc
        if new.local_only and not is_loopback_url(new.ollama_url):
            raise AppError(
                "Local-only mode requires Ollama on a loopback address.",
                code="LOCAL_ONLY_VIOLATION",
                status_code=422,
                hint="Use http://127.0.0.1:11434 or disable local-only mode explicitly.",
            )
        with self.db.session() as s:
            row = s.get(Setting, _KEY)
            if row is None:
                s.add(Setting(key=_KEY, value=new.model_dump()))
            else:
                row.value = new.model_dump()
        with self._lock:
            self._cache = new
        return new.model_copy(deep=True)

    def get_value(self, key: str) -> object | None:
        with self.db.session() as s:
            row = s.execute(select(Setting).where(Setting.key == key)).scalar_one_or_none()
            return row.value if row else None

    def set_value(self, key: str, value: object) -> None:
        if key == _KEY:
            raise ValueError("reserved key")
        with self.db.session() as s:
            row = s.get(Setting, key)
            if row is None:
                s.add(Setting(key=key, value=value))
            else:
                row.value = value
