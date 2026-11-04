from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.api.deps import get_ctx
from app.core.context import AppContext
from app.schemas.page import PageAnalyzeRequest, PageAnalyzeResponse
from app.security.auth import require_token
from app.security.sanitize import is_sensitive_field
from app.services.page_analysis import classify_page, page_chunks, page_context_text, select_relevant

router = APIRouter(prefix="/page", tags=["page"], dependencies=[Depends(require_token)])


@router.post("/analyze", response_model=PageAnalyzeResponse, summary="Structure, classify and select relevant page content")
async def analyze(req: PageAnalyzeRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    s = ctx.settings.get()
    max_chars = req.max_chars or s.max_page_context_chars
    page = req.page
    chunks = page_chunks(page)
    relevant, _ = select_relevant(page, req.query, max_chars) if req.query else (chunks[:5], False)
    fields = [f for form in page.forms for f in form.fields]
    sensitive = [f for f in fields if f.sensitive or is_sensitive_field(input_type=f.type, autocomplete=f.autocomplete, label=f.label, name=f.name, placeholder=f.placeholder)]
    preview, _ = page_context_text(page, req.query, min(max_chars, 3000))
    return {
        "url": page.url,
        "title": page.title,
        "page_type": classify_page(page),
        "word_count": len((page.main_text or " ".join(page.paragraphs)).split()),
        "chunk_count": len(chunks),
        "heading_outline": [("  " * (h.level - 1)) + h.text for h in page.headings[:50]],
        "form_count": len(page.forms),
        "field_count": len(fields),
        "sensitive_field_count": len(sensitive),
        "has_selection": bool(page.selected_text.strip()),
        "relevant_chunks": [{"index": c.index, "section": c.section, "text": c.text, "score": c.score} for c in relevant],
        "context_preview": preview,
    }
