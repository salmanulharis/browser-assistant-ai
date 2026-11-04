from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse

from app.core.context import AppContext
from app.core.errors import AppError

log = logging.getLogger(__name__)


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx


def sse_format(event: str, data: Any) -> str:
    payload = json.dumps(jsonable_encoder(data), ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


async def sse_response(gen: AsyncIterator[dict[str, Any]]) -> StreamingResponse:
    """Wrap an event generator as SSE.

    The first event is awaited *before* the response starts so that setup errors
    (missing model, unknown conversation, Ollama down) become normal JSON errors
    with proper HTTP status codes.
    """
    first = await gen.__anext__()

    async def body() -> AsyncIterator[str]:
        yield sse_format(first["event"], first["data"])
        try:
            async for ev in gen:
                yield sse_format(ev["event"], ev["data"])
        except AppError as exc:
            yield sse_format("error", exc.to_dict()["error"])
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("stream failed")
            yield sse_format("error", {"code": "INTERNAL_ERROR", "message": str(exc), "hint": None})
        finally:
            await gen.aclose()

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
