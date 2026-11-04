from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.api.deps import get_ctx, sse_response
from app.core.context import AppContext
from app.schemas.chat import AssistRequest, ChatRequest, ChatResponse
from app.security.auth import require_token
from app.services.orchestrator import ChatOrchestrator

router = APIRouter(tags=["chat"], dependencies=[Depends(require_token)])


@router.post("/chat", response_model=ChatResponse, summary="Context-aware chat (non-streaming)")
async def chat(req: ChatRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return await ChatOrchestrator(ctx).run(req)


@router.post(
    "/chat/stream",
    summary="Context-aware chat streamed as Server-Sent Events",
    description="Events: `meta` (conversation id, sources, warnings), `thinking`, `delta` (text), "
    "`done` (message id, citations, stats), `memory_suggestions`, `error`.",
)
async def chat_stream(req: ChatRequest, ctx: AppContext = Depends(get_ctx)):  # type: ignore[no-untyped-def]
    return await sse_response(ChatOrchestrator(ctx).stream(req))


@router.post("/assist/stream", summary="Stateless quick action on text (explain, rewrite, grammar...) via SSE")
async def assist_stream(req: AssistRequest, ctx: AppContext = Depends(get_ctx)):  # type: ignore[no-untyped-def]
    return await sse_response(ChatOrchestrator(ctx).assist_stream(req))
