from __future__ import annotations

from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def validate_http_url(v: str) -> str:
    v = v.strip().rstrip("/")
    p = urlparse(v)
    if p.scheme not in {"http", "https"} or not p.hostname:
        raise ValueError("Must be an http(s) URL such as http://127.0.0.1:11434")
    if p.path not in {"", "/"} or p.query or p.fragment:
        raise ValueError("URL must not contain a path, query or fragment")
    return v


def is_loopback_url(v: str) -> bool:
    host = urlparse(v).hostname or ""
    return host in LOOPBACK_HOSTS


class AppSettings(BaseModel):
    """Runtime settings persisted in SQLite (``settings`` table)."""

    model_config = ConfigDict(extra="forbid")

    # AI
    ollama_url: str = "http://127.0.0.1:11434"
    chat_model: str = ""
    embedding_model: str = ""
    vision_model: str = ""
    temperature: float = Field(0.4, ge=0, le=2)
    context_length: int = Field(8192, ge=1024, le=262144)
    request_timeout: float = Field(10, ge=1, le=120, description="Seconds for lightweight calls")
    generation_timeout: float = Field(300, ge=10, le=3600, description="Seconds for generation")
    streaming: bool = True
    think: bool = False
    local_only: bool = True

    # RAG
    rag_top_k: int = Field(5, ge=1, le=20)
    chunk_size_tokens: int = Field(700, ge=100, le=4000)
    chunk_overlap_tokens: int = Field(100, ge=0, le=1000)
    min_relevance: float = Field(0.35, ge=0, le=1)
    max_page_context_chars: int = Field(12000, ge=1000, le=200000)

    # Memory
    auto_memory_mode: Literal["off", "ask", "auto"] = "ask"
    auto_memory_categories: list[str] = Field(
        default_factory=lambda: ["profile", "skills", "projects", "preferences", "writing_style"]
    )
    memory_retrieval: bool = True
    memory_top_k: int = Field(5, ge=1, le=20)
    cross_conversation_retrieval: bool = True
    conversation_retention_days: int = Field(0, ge=0, le=3650, description="0 = keep forever")
    recent_messages: int = Field(8, ge=2, le=50)
    summarize_after_messages: int = Field(16, ge=6, le=200)

    @field_validator("ollama_url")
    @classmethod
    def _url(cls, v: str) -> str:
        return validate_http_url(v)

    @field_validator("chunk_overlap_tokens")
    @classmethod
    def _overlap(cls, v: int, info) -> int:  # type: ignore[no-untyped-def]
        size = info.data.get("chunk_size_tokens", 700)
        if v >= size:
            raise ValueError("Overlap must be smaller than chunk size")
        return v


class SettingsUpdate(BaseModel):
    """Partial update – every field optional."""

    model_config = ConfigDict(extra="forbid")

    ollama_url: str | None = None
    chat_model: str | None = None
    embedding_model: str | None = None
    vision_model: str | None = None
    temperature: float | None = None
    context_length: int | None = None
    request_timeout: float | None = None
    generation_timeout: float | None = None
    streaming: bool | None = None
    think: bool | None = None
    local_only: bool | None = None
    rag_top_k: int | None = None
    chunk_size_tokens: int | None = None
    chunk_overlap_tokens: int | None = None
    min_relevance: float | None = None
    max_page_context_chars: int | None = None
    auto_memory_mode: Literal["off", "ask", "auto"] | None = None
    auto_memory_categories: list[str] | None = None
    memory_retrieval: bool | None = None
    memory_top_k: int | None = None
    cross_conversation_retrieval: bool | None = None
    conversation_retention_days: int | None = None
    recent_messages: int | None = None
    summarize_after_messages: int | None = None
