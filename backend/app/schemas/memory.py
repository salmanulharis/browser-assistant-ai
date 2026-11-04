from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    auto_allowed: bool


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_\- ]+$")
    description: str | None = Field(default=None, max_length=300)
    auto_allowed: bool = False


class MemoryOut(BaseModel):
    id: str
    content: str
    title: str | None
    category: str | None
    source: str
    status: str
    pinned: bool
    expires_at: datetime | None
    created_at: datetime
    updated_at: datetime


class MemoryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=8000)
    title: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=80)
    pinned: bool = False
    expires_at: datetime | None = None
    status: Literal["active", "disabled"] = "active"


class MemoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str | None = Field(default=None, min_length=1, max_length=8000)
    title: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=80)
    pinned: bool | None = None
    expires_at: datetime | None = None
    clear_expiry: bool = False
    status: Literal["active", "pending", "disabled"] | None = None


class MemorySearch(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    limit: int = Field(default=10, ge=1, le=50)


class MemoryHit(BaseModel):
    memory: MemoryOut
    score: float


class MemoryExport(BaseModel):
    version: int = 1
    exported_at: datetime
    memories: list[MemoryOut]


class MemoryImportItem(BaseModel):
    content: str = Field(min_length=1, max_length=8000)
    title: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=80)
    pinned: bool = False
    expires_at: datetime | None = None
    status: Literal["active", "disabled", "pending"] = "active"


class MemoryImport(BaseModel):
    memories: list[MemoryImportItem] = Field(max_length=5000)


class MemoryCandidate(BaseModel):
    content: str
    category: str
    reason: str = ""
