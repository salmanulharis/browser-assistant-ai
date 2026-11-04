"""Structured webpage context sent by the extension. All of it is untrusted input."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Str200 = Field(default="", max_length=200)


class Heading(BaseModel):
    level: int = Field(ge=1, le=6)
    text: str = Field(max_length=500)


class Link(BaseModel):
    text: str = Field(default="", max_length=300)
    href: str = Field(default="", max_length=2048)


class Table(BaseModel):
    caption: str = Field(default="", max_length=300)
    rows: list[list[str]] = Field(default_factory=list, max_length=200)


class CodeBlock(BaseModel):
    language: str = Field(default="", max_length=40)
    code: str = Field(max_length=20000)


class FieldOption(BaseModel):
    value: str = Field(default="", max_length=300)
    label: str = Field(default="", max_length=300)


class FormField(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ref: str = Field(max_length=40)
    tag: Literal["input", "textarea", "select", "contenteditable"]
    type: str = Field(default="text", max_length=40)
    name: str = Field(default="", max_length=200)
    label: str = Field(default="", max_length=500)
    placeholder: str = Field(default="", max_length=300)
    autocomplete: str = Field(default="", max_length=100)
    required: bool = False
    max_length: int | None = None
    options: list[FieldOption] = Field(default_factory=list, max_length=1000)
    nearby_text: str = Field(default="", max_length=1000)
    has_value: bool = False
    sensitive: str | None = Field(default=None, max_length=200)


class FormInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ref: str = Field(max_length=40)
    name: str = Field(default="", max_length=200)
    heading: str = Field(default="", max_length=500)
    instructions: str = Field(default="", max_length=2000)
    fields: list[FormField] = Field(default_factory=list, max_length=200)


class PageContext(BaseModel):
    model_config = ConfigDict(extra="ignore")

    url: str = Field(default="", max_length=2048)
    title: str = Field(default="", max_length=500)
    description: str = Field(default="", max_length=2000)
    lang: str = Field(default="", max_length=20)
    site_name: str = Field(default="", max_length=200)
    headings: list[Heading] = Field(default_factory=list, max_length=300)
    main_text: str = Field(default="", max_length=400_000)
    paragraphs: list[str] = Field(default_factory=list, max_length=3000)
    lists: list[list[str]] = Field(default_factory=list, max_length=300)
    tables: list[Table] = Field(default_factory=list, max_length=50)
    code_blocks: list[CodeBlock] = Field(default_factory=list, max_length=100)
    links: list[Link] = Field(default_factory=list, max_length=500)
    selected_text: str = Field(default="", max_length=50_000)
    forms: list[FormInfo] = Field(default_factory=list, max_length=30)
    content_hash: str = Field(default="", max_length=100)
    truncated: bool = False


class PageAnalyzeRequest(BaseModel):
    page: PageContext
    query: str = Field(default="", max_length=4000)
    max_chars: int | None = Field(default=None, ge=500, le=200_000)


class PageChunkOut(BaseModel):
    index: int
    section: str | None
    text: str
    score: float


class PageAnalyzeResponse(BaseModel):
    url: str
    title: str
    page_type: str
    word_count: int
    chunk_count: int
    heading_outline: list[str]
    form_count: int
    field_count: int
    sensitive_field_count: int
    has_selection: bool
    relevant_chunks: list[PageChunkOut]
    context_preview: str
