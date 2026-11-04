from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import get_ctx
from app.core.context import AppContext
from app.schemas.memory import (
    CategoryCreate,
    CategoryOut,
    MemoryCreate,
    MemoryExport,
    MemoryHit,
    MemoryImport,
    MemoryOut,
    MemorySearch,
    MemoryUpdate,
)
from app.security.auth import require_token
from app.security.sanitize import contains_sensitive_data
from app.core.errors import AppError
from app.services.memory import MemoryService

router = APIRouter(prefix="/memory", tags=["memory"], dependencies=[Depends(require_token)])


@router.get("", response_model=list[MemoryOut], summary="List memories (filter by text, category, status)")
async def list_memories(
    q: str | None = Query(default=None, max_length=200),
    category: str | None = Query(default=None, max_length=80),
    status: Literal["active", "pending", "disabled"] | None = None,
    ctx: AppContext = Depends(get_ctx),
) -> list[dict[str, Any]]:
    return MemoryService(ctx).list(q, category, status)


@router.post("", response_model=MemoryOut, status_code=201, summary="Add a personal memory")
async def create(req: MemoryCreate, allow_sensitive: bool = False, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    reason = contains_sensitive_data(req.content)
    if reason and not allow_sensitive:
        raise AppError(
            f"This looks like it contains a {reason}. Sensitive data should not be stored in memory.",
            code="SENSITIVE_CONTENT",
            status_code=422,
            hint="Remove the sensitive part, or confirm explicitly to save anyway.",
        )
    return await MemoryService(ctx).create(req)


@router.post("/search", response_model=list[MemoryHit], summary="Semantic + keyword memory search")
async def search(req: MemorySearch, ctx: AppContext = Depends(get_ctx)) -> list[dict[str, Any]]:
    hits = await MemoryService(ctx).search(req.query, req.limit, min_score=0.25)
    return [{"memory": m, "score": round(s, 4)} for m, s in hits]


@router.get("/categories", response_model=list[CategoryOut], summary="Memory categories")
async def categories(ctx: AppContext = Depends(get_ctx)) -> list[Any]:
    return MemoryService(ctx).categories()


@router.post("/categories", response_model=CategoryOut, status_code=201, summary="Create category")
async def create_category(req: CategoryCreate, ctx: AppContext = Depends(get_ctx)) -> Any:
    return MemoryService(ctx).create_category(req.name, req.description, req.auto_allowed)


@router.get("/export", response_model=MemoryExport, summary="Export all memories as JSON")
async def export(ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return MemoryService(ctx).export()


@router.post("/import", summary="Import memories (duplicates skipped)")
async def import_(req: MemoryImport, ctx: AppContext = Depends(get_ctx)) -> dict[str, int]:
    return {"imported": await MemoryService(ctx).import_items(req.memories)}


@router.post("/reindex", summary="Re-embed all memories with the current embedding model")
async def reindex(ctx: AppContext = Depends(get_ctx)) -> dict[str, int]:
    return {"reindexed": await MemoryService(ctx).reindex_all()}


@router.get("/{memory_id}", response_model=MemoryOut)
async def get(memory_id: str, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return MemoryService(ctx).get(memory_id)


@router.patch("/{memory_id}", response_model=MemoryOut, summary="Edit / pin / disable / approve a memory")
async def update(memory_id: str, req: MemoryUpdate, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return await MemoryService(ctx).update(memory_id, req)


@router.delete("/{memory_id}", status_code=204, summary="Delete a memory (and its vector)")
async def delete(memory_id: str, ctx: AppContext = Depends(get_ctx)) -> Response:
    MemoryService(ctx).delete(memory_id)
    return Response(status_code=204)
