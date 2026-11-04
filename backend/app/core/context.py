"""Application context: the long-lived services shared by all requests."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx

from app.core.config import EnvSettings
from app.database.base import Database
from app.schemas.settings import AppSettings
from app.services.embeddings import Embedder
from app.services.ollama import OllamaClient, OllamaStatus
from app.services.settings import SettingsService
from app.services.vectorstore import VectorStore


@dataclass
class AppContext:
    env: EnvSettings
    db: Database
    settings: SettingsService
    vectors: VectorStore
    api_token: str
    ollama_status: OllamaStatus = field(default_factory=OllamaStatus)
    ollama_transport: httpx.AsyncBaseTransport | None = None
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def ollama(self, s: AppSettings | None = None) -> OllamaClient:
        s = s or self.settings.get()
        return OllamaClient(
            s.ollama_url,
            timeout=s.request_timeout,
            generation_timeout=s.generation_timeout,
            transport=self.ollama_transport,
            status=self.ollama_status,
        )

    def embedder(self, s: AppSettings | None = None) -> Embedder:
        s = s or self.settings.get()
        return Embedder(self.ollama(s), s.embedding_model)
