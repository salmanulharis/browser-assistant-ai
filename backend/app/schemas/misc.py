from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DiagStatus = Literal[
    "healthy", "warning", "failed", "not_configured", "permission_required", "not_verifiable", "skipped"
]


class CheckResult(BaseModel):
    id: str
    group: str
    name: str
    status: DiagStatus
    message: str
    hint: str | None = None
    duration_ms: float = 0
    details: dict[str, Any] = Field(default_factory=dict)


class DiagnosticRunRequest(BaseModel):
    level: Literal["basic", "full"] = "basic"
    checks: list[str] | None = Field(default=None, max_length=100)


class DiagnosticRunOut(BaseModel):
    id: str
    level: str
    started_at: datetime
    finished_at: datetime | None
    summary: dict[str, Any]
    results: list[CheckResult]


class HealthOut(BaseModel):
    status: Literal["ok"]
    app: str
    version: str
    api_version: str
    time: datetime


class ModelInfo(BaseModel):
    name: str
    size_bytes: int | None = None
    family: str | None = None
    parameter_size: str | None = None
    quantization: str | None = None
    context_length: int | None = None
    modified_at: str | None = None
    capabilities: list[str] = Field(default_factory=list)
    kind: str
    selected_as: list[str] = Field(default_factory=list)


class ModelsOut(BaseModel):
    reachable: bool
    ollama_url: str
    version: str | None
    models: list[ModelInfo]
    selected: dict[str, str]
    missing: list[str]
    suggestions: list[dict[str, str]]
    error: dict[str, Any] | None = None


class ModelTestRequest(BaseModel):
    model: str = Field(min_length=1, max_length=200)
    kind: Literal["chat", "embedding", "vision"] = "chat"


class ModelTestOut(BaseModel):
    ok: bool
    model: str
    kind: str
    duration_ms: float
    result: str
    details: dict[str, Any] = Field(default_factory=dict)


class ModelPullRequest(BaseModel):
    model: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._:/\-]+$")
    confirm: bool = False


class ModelShowRequest(BaseModel):
    model: str = Field(min_length=1, max_length=200)


# ----------------------------------------------------------------- prompts
class PromptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    content: str
    kind: str
    category: str | None
    tags: list[str]
    pinned: bool
    use_count: int
    created_at: datetime
    updated_at: datetime


class PromptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)
    kind: Literal["prompt", "sample"] = "prompt"
    category: str | None = Field(default=None, max_length=80)
    tags: list[str] = Field(default_factory=list, max_length=20)
    pinned: bool = False


class PromptUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1, max_length=20_000)
    kind: Literal["prompt", "sample"] | None = None
    category: str | None = Field(default=None, max_length=80)
    tags: list[str] | None = Field(default=None, max_length=20)
    pinned: bool | None = None


# ------------------------------------------------------------------ backup
class BackupOut(BaseModel):
    name: str
    size_bytes: int
    created_at: datetime


class DeleteAllRequest(BaseModel):
    confirm: str = Field(description="Must equal 'DELETE ALL MY DATA'")
