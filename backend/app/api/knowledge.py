from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Query, Response, UploadFile

from app.api.deps import get_ctx
from app.core.context import AppContext
from app.core.errors import PayloadTooLarge
from app.schemas.knowledge import CollectionOut, DocumentDetail, DocumentOut, KnowledgeHit, KnowledgeSearch, SavePageRequest
from app.security.auth import require_token
from app.services.documents import DocumentService

log = logging.getLogger(__name__)
router = APIRouter(prefix="/knowledge", tags=["knowledge"], dependencies=[Depends(require_token)])


async def _process(ctx: AppContext, doc_id: str) -> None:
    try:
        await DocumentService(ctx).process(doc_id)
    except Exception as exc:  # status + error already stored on the document
        log.info("Background indexing of %s failed: %s", doc_id, exc)


@router.post("/upload", status_code=201, summary="Upload one or more documents (indexed in background)")
async def upload(
    background: BackgroundTasks,
    files: list[UploadFile] = File(...),
    collection: str = Form(default="default", max_length=100),
    wait: bool = Query(default=False, description="Process synchronously (used by tests/CLI)"),
    ctx: AppContext = Depends(get_ctx),
) -> dict[str, Any]:
    svc = DocumentService(ctx)
    limit = ctx.env.max_upload_mb * 1024 * 1024
    results: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for f in files[:20]:
        name = f.filename or "upload"
        try:
            data = await f.read(limit + 1)
            if len(data) > limit:
                raise PayloadTooLarge(f"'{name}' exceeds the {ctx.env.max_upload_mb} MB limit.")
            doc, created = svc.create(name, data, collection)
            if created:
                if wait:
                    try:
                        doc = await svc.process(doc["id"])
                    except Exception:
                        doc = svc.get(doc["id"])
                else:
                    background.add_task(_process, ctx, doc["id"])
            results.append({**doc, "duplicate": not created})
        except Exception as exc:
            errors.append({"filename": name, "code": getattr(exc, "code", "UPLOAD_FAILED"), "message": getattr(exc, "message", str(exc))})
        finally:
            await f.close()
    return {"documents": results, "errors": errors}


@router.get("", response_model=list[DocumentOut], summary="List documents")
async def list_documents(collection: str | None = None, q: str | None = Query(default=None, max_length=200),
                         ctx: AppContext = Depends(get_ctx)) -> list[dict[str, Any]]:
    return DocumentService(ctx).list(collection, q)


@router.get("/collections", response_model=list[CollectionOut], summary="Collections with document counts")
async def collections(ctx: AppContext = Depends(get_ctx)) -> list[dict[str, Any]]:
    return DocumentService(ctx).collections()


@router.post("/search", response_model=list[KnowledgeHit], summary="Semantic search over indexed chunks")
async def search(req: KnowledgeSearch, ctx: AppContext = Depends(get_ctx)) -> list[dict[str, Any]]:
    return await DocumentService(ctx).search(req.query, req.top_k, req.collection, req.document_ids or None)


@router.post("/save-page", status_code=201, summary="Save the current webpage text into the knowledge base")
async def save_page(req: SavePageRequest, background: BackgroundTasks, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    svc = DocumentService(ctx)
    doc, created = svc.save_page(req.url, req.title, req.content, req.collection)
    if created:
        background.add_task(_process, ctx, doc["id"])
    return {**doc, "duplicate": not created}


@router.get("/{doc_id}", response_model=DocumentDetail, summary="Document details with chunk preview")
async def get(doc_id: str, preview: int = Query(default=5, ge=0, le=50), ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    return DocumentService(ctx).get(doc_id, preview_chunks=preview)


@router.post("/{doc_id}/reindex", response_model=DocumentOut, summary="Re-extract, re-chunk and re-embed")
async def reindex(doc_id: str, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    svc = DocumentService(ctx)
    try:
        return await svc.process(doc_id)
    except Exception:
        return svc.get(doc_id)


@router.delete("/{doc_id}", status_code=204, summary="Delete a document, its chunks, vectors and file")
async def delete(doc_id: str, ctx: AppContext = Depends(get_ctx)) -> Response:
    DocumentService(ctx).delete(doc_id)
    return Response(status_code=204)
