from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    original_name: str
    extension: str
    size_bytes: int
    collection: str
    source_url: str | None
    status: str
    error: str | None
    chunk_count: int
    char_count: int
    embedded_model: str | None
    created_at: datetime
    updated_at: datetime


class ChunkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    chunk_index: int
    content: str
    location: str | None
    token_estimate: int


class DocumentDetail(DocumentOut):
    preview: list[ChunkOut] = Field(default_factory=list)


class KnowledgeSearch(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    top_k: int | None = Field(default=None, ge=1, le=50)
    collection: str | None = Field(default=None, max_length=100)
    document_ids: list[str] = Field(default_factory=list, max_length=50)


class KnowledgeHit(BaseModel):
    document_id: str
    document_name: str
    chunk_index: int
    location: str | None
    content: str
    score: float


class SavePageRequest(BaseModel):
    url: str = Field(max_length=2048)
    title: str = Field(max_length=500)
    content: str = Field(min_length=20, max_length=1_000_000)
    collection: str = Field(default="web-pages", max_length=100)


class CollectionOut(BaseModel):
    name: str
    document_count: int
