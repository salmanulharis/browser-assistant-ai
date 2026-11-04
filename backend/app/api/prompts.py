from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import get_ctx
from app.core.context import AppContext
from app.schemas.misc import PromptCreate, PromptOut, PromptUpdate
from app.security.auth import require_token
from app.services.prompts_lib import PromptService

router = APIRouter(prefix="/prompts", tags=["prompts"], dependencies=[Depends(require_token)])


@router.get("", response_model=list[PromptOut], summary="List / search prompts and samples")
async def list_prompts(q: str | None = Query(default=None, max_length=200), kind: Literal["prompt", "sample"] | None = None,
                       category: str | None = Query(default=None, max_length=80), ctx: AppContext = Depends(get_ctx)) -> list[dict[str, Any]]:
    return PromptService(ctx).list(q, kind, category)


@router.post("", response_model=PromptOut, status_code=201)
async def create(req: PromptCreate, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return await PromptService(ctx).create(req)


@router.patch("/{pid}", response_model=PromptOut)
async def update(pid: str, req: PromptUpdate, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return await PromptService(ctx).update(pid, req)


@router.post("/{pid}/use", response_model=PromptOut, summary="Increment usage counter")
async def use(pid: str, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return PromptService(ctx).mark_used(pid)


@router.delete("/{pid}", status_code=204)
async def delete(pid: str, ctx: AppContext = Depends(get_ctx)) -> Response:
    PromptService(ctx).delete(pid)
    return Response(status_code=204)
