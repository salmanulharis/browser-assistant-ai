from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request

from app.api.deps import get_ctx, sse_response
from app.core.config import API_VERSION, APP_VERSION
from app.core.context import AppContext
from app.core.errors import ForbiddenError
from app.schemas.misc import HealthOut
from app.security.auth import require_token
from app.services.diagnostics import stream_self_test

public = APIRouter(tags=["health"])
private = APIRouter(tags=["health"], dependencies=[Depends(require_token)])


@public.get("/health", response_model=HealthOut, summary="Liveness check (no auth, no sensitive data)")
async def health() -> HealthOut:
    return HealthOut(status="ok", app="local-browser-ai", version=APP_VERSION, api_version=API_VERSION, time=datetime.now(UTC))


@public.post("/auth/pair", summary="Return the API token to the allow-listed extension origin only")
async def pair(request: Request, ctx: AppContext = Depends(get_ctx)) -> dict[str, str]:
    origin = (request.headers.get("origin") or "").rstrip("/")
    if not ctx.env.allow_pairing:
        raise ForbiddenError("Automatic pairing is disabled.", code="PAIRING_DISABLED",
                             hint="Paste the token shown by scripts/start.ps1 into Settings → Connection.")
    if not origin or origin not in ctx.env.origins:
        raise ForbiddenError(
            "This origin is not allowed to pair.",
            code="PAIRING_ORIGIN_REJECTED",
            hint="Run scripts/build.ps1 so the extension ID is written to backend/.env, restart the backend, "
            "or paste the token manually.",
            details={"origin": origin or None},
        )
    return {"token": ctx.api_token}


@private.get("/auth/check", summary="Verify the bearer token")
async def auth_check(request: Request) -> dict[str, object]:
    origin = request.headers.get("origin")
    ctx: AppContext = request.app.state.ctx
    return {"ok": True, "origin": origin, "origin_allowed": bool(origin and origin.rstrip("/") in ctx.env.origins)}


@private.get("/diagnostics/stream-test", summary="SSE self-test used by extension diagnostics")
async def stream_test():  # type: ignore[no-untyped-def]
    return await sse_response(stream_self_test())
