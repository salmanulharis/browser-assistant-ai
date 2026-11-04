from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.page import PageContext

SourceType = Literal[
    "page", "selection", "tab", "memory", "document", "conversation", "sample", "instruction"
]


class ContextToggles(BaseModel):
    page: bool = True
    selection: bool = True
    tabs: bool = True
    memory: bool = True
    knowledge: bool = True
    history: bool = True
    samples: bool = True


class Source(BaseModel):
    id: str  # e.g. "S1" – what the model cites
    type: SourceType
    title: str
    url: str | None = None
    ref_id: str | None = None  # memory id / document id / conversation id
    location: str | None = None
    snippet: str = ""
    score: float | None = None


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=20_000)
    conversation_id: str | None = Field(default=None, max_length=32)
    model: str | None = Field(default=None, max_length=200)
    context: ContextToggles = Field(default_factory=ContextToggles)
    page: PageContext | None = None
    tabs: list[PageContext] = Field(default_factory=list, max_length=8)
    instructions: str = Field(default="", max_length=4000)
    knowledge_collection: str | None = Field(default=None, max_length=100)
    document_ids: list[str] = Field(default_factory=list, max_length=20)
    images: list[str] = Field(default_factory=list, max_length=4, description="base64 images")
    regenerate: bool = False
    temperature: float | None = Field(default=None, ge=0, le=2)


class ChatResponse(BaseModel):
    conversation_id: str
    message_id: str
    content: str
    thinking: str = ""
    sources: list[Source]
    invalid_citations: list[str] = Field(default_factory=list)
    model: str
    stats: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


AssistAction = Literal[
    "explain", "summarize", "rewrite", "grammar", "translate", "generate", "ask", "key_points"
]


class AssistRequest(BaseModel):
    """Stateless quick action (floating assistant selection tools)."""

    model_config = ConfigDict(extra="forbid")

    action: AssistAction
    text: str = Field(default="", max_length=50_000)
    instructions: str = Field(default="", max_length=4000)
    page: PageContext | None = None
    use_memory: bool = True
    model: str | None = Field(default=None, max_length=200)


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    role: str
    content: str
    sources: list[dict[str, Any]] | None = None
    model: str | None = None
    stats: dict[str, Any] | None = None
    created_at: datetime


class ConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    page_url: str | None
    page_title: str | None
    summary: str | None
    created_at: datetime
    updated_at: datetime
    message_count: int = 0


class ConversationDetail(ConversationOut):
    messages: list[MessageOut] = Field(default_factory=list)


class ConversationCreate(BaseModel):
    title: str = Field(default="New conversation", max_length=300)
    page_url: str | None = Field(default=None, max_length=2048)
    page_title: str | None = Field(default=None, max_length=500)


class ConversationUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    archived: bool | None = None


class MessageSearchHit(BaseModel):
    conversation_id: str
    conversation_title: str
    message_id: str
    role: str
    snippet: str
    created_at: datetime
