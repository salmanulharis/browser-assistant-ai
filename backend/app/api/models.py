from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends

from app.api.deps import get_ctx, sse_response
from app.core.context import AppContext
from app.core.errors import AppError
from app.schemas.misc import ModelPullRequest, ModelShowRequest, ModelsOut, ModelTestOut, ModelTestRequest
from app.security.auth import require_token
from app.services.capabilities import clear_cache, reasoning_kwargs
from app.services.ollama import OllamaError, model_summary

router = APIRouter(prefix="/models", tags=["models"], dependencies=[Depends(require_token)])

SUGGESTIONS = [
    {"name": "qwen3:4b-instruct", "kind": "chat", "why": "Fast, capable general assistant; non-thinking, reliable JSON for forms (~2.5 GB)"},
    {"name": "nomic-embed-text", "kind": "embedding", "why": "Small, high-quality embeddings (~275 MB)"},
    {"name": "qwen2.5vl:3b", "kind": "vision", "why": "Optional image understanding (~3 GB)"},
]

# 1x1 transparent PNG – used to test vision models without user data
_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="


@router.get("", response_model=ModelsOut, summary="Discover installed Ollama models")
async def list_models(ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    s = ctx.settings.get()
    client = ctx.ollama(s)
    selected = {"chat": s.chat_model, "embedding": s.embedding_model, "vision": s.vision_model}
    try:
        version = await client.version()
        raw = await client.list_models()
    except OllamaError as exc:
        return {"reachable": False, "ollama_url": s.ollama_url, "version": None, "models": [], "selected": selected,
                "missing": [], "suggestions": SUGGESTIONS, "error": exc.to_dict()["error"]}
    clear_cache()
    models = []
    names: set[str] = set()
    for m in raw:
        info = model_summary(m)
        names.add(info["name"])
        if info["name"].endswith(":latest"):
            names.add(info["name"][:-7])
        info["selected_as"] = [k for k, v in selected.items() if v and v in (info["name"], info["name"].removesuffix(":latest"))]
        models.append(info)
    missing = [v for v in selected.values() if v and v not in names]
    return {"reachable": True, "ollama_url": s.ollama_url, "version": version, "models": models, "selected": selected,
            "missing": missing, "suggestions": SUGGESTIONS, "error": None}


@router.post("/show", summary="Model details from Ollama /api/show")
async def show(req: ModelShowRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    info = await ctx.ollama().show(req.model)
    details = info.get("details") or {}
    model_info = info.get("model_info") or {}
    ctx_len = next((v for k, v in model_info.items() if k.endswith(".context_length")), None)
    return {"model": req.model, "details": details, "capabilities": info.get("capabilities") or [],
            "context_length": ctx_len, "modified_at": info.get("modified_at"),
            "parameters": info.get("parameters"), "template_present": bool(info.get("template"))}


@router.post("/test", response_model=ModelTestOut, summary="Send a short test prompt and time it")
async def test_model(req: ModelTestRequest, ctx: AppContext = Depends(get_ctx)) -> dict[str, Any]:
    client = ctx.ollama()
    t0 = time.perf_counter()
    try:
        if req.kind == "embedding":
            vec = await client.embed(req.model, ["Local Browser AI embedding test"])
            dims = len(vec[0])
            return {"ok": True, "model": req.model, "kind": req.kind, "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
                    "result": f"{dims}-dimension vector", "details": {"dimensions": dims}}
        msg: dict[str, Any] = {"role": "user", "content": "In one short sentence, say hello and name what you are."}
        if req.kind == "vision":
            msg = {"role": "user", "content": "What colour is this image? One word.", "images": [_PIXEL]}
        # Honour the reasoning setting like chat does, so thinking models answer instead of only reasoning.
        kw = await reasoning_kwargs(client, req.model, [msg], ctx.settings.get().think)
        resp = await client.chat(req.model, kw["messages"], options={"num_predict": 60, "temperature": 0.2}, think=kw["think"])
    except OllamaError as exc:
        return {"ok": False, "model": req.model, "kind": req.kind, "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
                "result": exc.message, "details": {"code": exc.code, "hint": exc.hint}}
    text = resp.content.strip() or (f"(thinking only) {resp.thinking.strip()[:200]}" if resp.thinking else "(empty)")
    return {"ok": bool(resp.content.strip() or resp.thinking.strip()), "model": req.model, "kind": req.kind,
            "duration_ms": round((time.perf_counter() - t0) * 1000, 1), "result": text[:500], "details": resp.stats}


@router.post("/pull", summary="Download a model (requires explicit confirmation)")
async def pull(req: ModelPullRequest, ctx: AppContext = Depends(get_ctx)):  # type: ignore[no-untyped-def]
    if not req.confirm:
        raise AppError("Model downloads require explicit confirmation.", code="CONFIRMATION_REQUIRED", status_code=428,
                       hint="Ask the user to confirm the download size first, then resend with confirm=true.")
    client = ctx.ollama()

    async def gen() -> AsyncIterator[dict[str, Any]]:
        yield {"event": "start", "data": {"model": req.model}}
        last_pct = -1
        async for ev in client.pull(req.model):
            total, done = ev.get("total"), ev.get("completed")
            pct = int(done * 100 / total) if total and done else None
            if pct is None or pct != last_pct:
                last_pct = pct if pct is not None else last_pct
                yield {"event": "progress", "data": {"status": ev.get("status"), "total": total, "completed": done, "percent": pct}}
        clear_cache()
        yield {"event": "done", "data": {"model": req.model, "ok": True}}

    return await sse_response(gen())
