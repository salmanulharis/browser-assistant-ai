from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.page import FieldOption, FormField

ActionType = Literal[
    "click", "type", "fill", "select", "scroll", "find", "read", "highlight", "navigate"
]


class ElementInfo(BaseModel):
    """Interactive element snapshot captured by the extension (values never included)."""

    model_config = ConfigDict(extra="ignore")

    ref: str = Field(max_length=40)
    tag: str = Field(max_length=40)
    type: str = Field(default="", max_length=40)
    role: str = Field(default="", max_length=40)
    label: str = Field(default="", max_length=500)
    text: str = Field(default="", max_length=500)
    name: str = Field(default="", max_length=200)
    placeholder: str = Field(default="", max_length=300)
    autocomplete: str = Field(default="", max_length=100)
    href: str = Field(default="", max_length=2048)
    options: list[FieldOption] = Field(default_factory=list, max_length=1000)
    disabled: bool = False
    # Current state of checkboxes/radios (None for other elements) so "turn off X" is planned correctly.
    checked: bool | None = None
    sensitive: str | None = Field(default=None, max_length=200)
    form_ref: str | None = Field(default=None, max_length=40)


class ActionTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ref: str | None = Field(default=None, max_length=40)
    label: str | None = Field(default=None, max_length=500)


class PlannedAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: ActionType
    target: ActionTarget | None = None
    value: str | None = Field(default=None, max_length=10_000)
    url: str | None = Field(default=None, max_length=2048)
    direction: Literal["up", "down", "top", "bottom"] | None = None
    reason: str = Field(default="", max_length=500)
    requires_confirmation: bool = False
    warning: str | None = None


class ActionPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: str = Field(max_length=2000)
    actions: list[PlannedAction] = Field(default_factory=list, max_length=50)


class AgentPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: str = Field(min_length=1, max_length=4000)
    url: str = Field(default="", max_length=2048)
    title: str = Field(default="", max_length=500)
    page_summary: str = Field(default="", max_length=8000)
    elements: list[ElementInfo] = Field(default_factory=list, max_length=400)
    use_memory: bool = True
    use_knowledge: bool = True
    model: str | None = Field(default=None, max_length=200)


class ManualTaskRequest(BaseModel):
    """A plan built by the user in the extension (e.g. approved form fields) – validated + logged."""

    model_config = ConfigDict(extra="forbid")

    task: str = Field(min_length=1, max_length=2000)
    url: str = Field(default="", max_length=2048)
    actions: list[PlannedAction] = Field(max_length=200)
    elements: list[ElementInfo] = Field(default_factory=list, max_length=400)


class BlockedAction(BaseModel):
    action: dict[str, Any]
    reason: str


class BrowserTaskOut(BaseModel):
    id: str
    task: str
    page_url: str | None
    status: str
    plan: ActionPlan
    blocked: list[BlockedAction]
    model: str | None
    created_at: datetime
    updated_at: datetime
    logs: list[dict[str, Any]] = Field(default_factory=list)


class ActionResult(BaseModel):
    index: int = Field(ge=0, le=100)
    status: Literal["success", "failed", "skipped", "blocked", "cancelled"]
    message: str = Field(default="", max_length=2000)


class TaskResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["approved", "executing", "completed", "partial", "cancelled", "failed"]
    results: list[ActionResult] = Field(default_factory=list, max_length=100)


# ------------------------------------------------------------ form filling
class FormGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(default="", max_length=2048)
    title: str = Field(default="", max_length=500)
    page_summary: str = Field(default="", max_length=8000)
    form_heading: str = Field(default="", max_length=500)
    form_instructions: str = Field(default="", max_length=2000)
    fields: list[FormField] = Field(max_length=200)
    target_refs: list[str] = Field(default_factory=list, max_length=200)
    instructions: str = Field(default="", max_length=4000)
    use_memory: bool = True
    use_knowledge: bool = True
    use_samples: bool = True
    model: str | None = Field(default=None, max_length=200)


class FieldSuggestion(BaseModel):
    ref: str
    value: str
    confidence: Literal["high", "medium", "low"] = "medium"
    note: str = ""
    source_ids: list[str] = Field(default_factory=list)


class SkippedField(BaseModel):
    ref: str
    reason: str


class FormGenerateResponse(BaseModel):
    suggestions: list[FieldSuggestion]
    skipped: list[SkippedField]
    sources: list[dict[str, Any]]
    model: str
