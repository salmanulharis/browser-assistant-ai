from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import get_ctx
from app.core.context import AppContext
from app.schemas.chat import ConversationCreate, ConversationDetail, ConversationOut, ConversationUpdate, MessageSearchHit
from app.security.auth import require_token
from app.services.conversations import ConversationService

router = APIRouter(prefix="/conversations", tags=["conversations"], dependencies=[Depends(require_token)])


@router.get("", response_model=list[ConversationOut], summary="List / search conversations")
async def list_conversations(
    q: str | None = Query(default=None, max_length=200),
    page_url: str | None = Query(default=None, max_length=2048),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    ctx: AppContext = Depends(get_ctx),
) -> list[dict[str, Any]]:
    return ConversationService(ctx).list(q, page_url, limit, offset)


@router.post("", response_model=ConversationOut, status_code=201, summary="Create a conversation")
async def create(req: ConversationCreate, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return ConversationService(ctx).create(req.title, req.page_url, req.page_title)


@router.get("/search", response_model=list[MessageSearchHit], summary="Full-text search across messages")
async def search(q: str = Query(min_length=1, max_length=200), ctx: AppContext = Depends(get_ctx)) -> list[dict[str, Any]]:
    return ConversationService(ctx).search_messages(q)


@router.get("/{conv_id}", response_model=ConversationDetail, summary="Conversation with messages")
async def get(conv_id: str, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return ConversationService(ctx).get(conv_id)


@router.patch("/{conv_id}", response_model=ConversationDetail, summary="Rename / archive")
async def update(conv_id: str, req: ConversationUpdate, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return ConversationService(ctx).update(conv_id, req.title, req.archived)


@router.delete("/{conv_id}", status_code=204, summary="Delete a conversation and its messages")
async def delete(conv_id: str, ctx: AppContext = Depends(get_ctx)) -> Response:
    ConversationService(ctx).delete(conv_id)
    return Response(status_code=204)
