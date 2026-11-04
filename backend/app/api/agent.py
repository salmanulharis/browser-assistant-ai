from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.api.deps import get_ctx
from app.core.context import AppContext
from app.schemas.agent import AgentPlanRequest, BrowserTaskOut, FormGenerateRequest, FormGenerateResponse, ManualTaskRequest, TaskResultRequest
from app.security.auth import require_token
from app.services.browser_agent import BrowserAgentService

router = APIRouter(tags=["agent"], dependencies=[Depends(require_token)])


@router.post("/agent/plan", summary="Plan browser actions (never executes; extension asks for approval)")
async def plan(req: AgentPlanRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return await BrowserAgentService(ctx).plan(req)


@router.get("/agent/tasks", response_model=list[BrowserTaskOut], summary="Recent browser tasks")
async def tasks(ctx: AppContext = Depends(get_ctx)) -> list[dict[str, Any]]:
    return BrowserAgentService(ctx).list_tasks()


@router.post("/agent/tasks", response_model=BrowserTaskOut, status_code=201, summary="Log a user-built, approved plan (validated by policy)")
async def create_task(req: ManualTaskRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return BrowserAgentService(ctx).create_manual_task(req)


@router.get("/agent/tasks/{task_id}", response_model=BrowserTaskOut, summary="Task with action logs")
async def get_task(task_id: str, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return BrowserAgentService(ctx).get_task(task_id)


@router.post("/agent/tasks/{task_id}/result", response_model=BrowserTaskOut, summary="Record approval/execution results")
async def result(task_id: str, req: TaskResultRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return BrowserAgentService(ctx).record_result(task_id, req)


@router.post("/forms/generate", response_model=FormGenerateResponse, summary="Generate values for form fields (preview only)")
async def generate(req: FormGenerateRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return await BrowserAgentService(ctx).generate_fields(req)
