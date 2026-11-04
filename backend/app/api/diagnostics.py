from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.api.deps import get_ctx
from app.core.context import AppContext
from app.schemas.misc import DiagnosticRunOut, DiagnosticRunRequest
from app.security.auth import require_token
from app.services.diagnostics import DiagnosticsService

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"], dependencies=[Depends(require_token)])


@router.get("", summary="Latest diagnostic runs (history)")
async def get_diagnostics(limit: int = 10, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    hist = DiagnosticsService(ctx).history(min(max(limit, 1), 50))
    return {"latest": hist[0] if hist else None, "history": hist}


@router.post("/run", response_model=DiagnosticRunOut, summary="Run diagnostics (basic = no inference)")
async def run(req: DiagnosticRunRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return await DiagnosticsService(ctx).run(req.level, req.checks)


@router.delete("/history", summary="Clear diagnostic history")
async def clear(ctx: AppContext = Depends(get_ctx)) -> dict[str, int]:
    return {"deleted": DiagnosticsService(ctx).clear_history()}


@router.get("/report", summary="Sanitised diagnostic report (no personal data)")
async def report(ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return await DiagnosticsService(ctx).report()
