from __future__ import annotations

import shutil
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy import delete

from app.api.deps import get_ctx
from app.core.context import AppContext
from app.core.errors import AppError
from app.models.entities import (
    BrowserTask,
    Conversation,
    DiagnosticRun,
    Document,
    Memory,
    Prompt,
    SavedPage,
)
from app.schemas.misc import BackupOut, DeleteAllRequest
from app.schemas.settings import AppSettings, SettingsUpdate
from app.security.auth import require_token
from app.services.backup import backup_path, create_backup, list_backups
from app.services.capabilities import clear_cache

router = APIRouter(tags=["settings"], dependencies=[Depends(require_token)])


@router.get("/settings", response_model=AppSettings, summary="Current runtime settings")
async def get_settings(ctx: AppContext = Depends(get_ctx)) -> AppSettings:
    return ctx.settings.get()


@router.put("/settings", response_model=AppSettings, summary="Update runtime settings (partial)")
async def put_settings(req: SettingsUpdate, ctx: AppContext = Depends(get_ctx)) -> AppSettings:
    new = ctx.settings.update(req)
    clear_cache()
    return new


@router.get("/backups", response_model=list[BackupOut], summary="List backups")
async def backups(ctx: AppContext = Depends(get_ctx)) -> list[dict[str, Any]]:
    return list_backups(ctx.env)


@router.post("/backups", response_model=BackupOut, status_code=201, summary="Create a backup now")
async def make_backup(ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    p = create_backup(ctx.env)
    return next(b for b in list_backups(ctx.env) if b["name"] == p.name)


@router.get("/backups/{name}", summary="Download a backup archive")
async def download_backup(name: str, ctx: AppContext = Depends(get_ctx)) -> FileResponse:
    p = backup_path(ctx.env, name)
    return FileResponse(p, media_type="application/zip", filename=p.name)


@router.post("/data/delete-all", summary="Delete ALL local data (requires confirmation phrase)")
async def delete_all(req: DeleteAllRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    if req.confirm != "DELETE ALL MY DATA":
        raise AppError("Confirmation phrase does not match.", code="CONFIRMATION_REQUIRED", status_code=428)
    safety = create_backup(ctx.env, label="before-delete-all")
    with ctx.db.session() as s:
        for model in (SavedPage, Document, Memory, Conversation, Prompt, BrowserTask, DiagnosticRun):
            s.execute(delete(model))
    for purpose in ("documents", "memories", "messages", "samples"):
        try:
            for col in ctx.vectors.list_collections():
                if col["name"].startswith(f"lba_{purpose}__"):
                    ctx.vectors.client.delete_collection(col["name"])
        except Exception:
            pass
    if ctx.env.documents_dir.exists():
        shutil.rmtree(ctx.env.documents_dir)
    ctx.env.documents_dir.mkdir(parents=True, exist_ok=True)
    return {"deleted": True, "safety_backup": safety.name,
            "note": "A safety backup was saved in the backups folder; delete it manually if you want everything gone."}
