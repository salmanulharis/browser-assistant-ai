"""Async client for the official Ollama HTTP API.

Endpoints used: GET /api/version, GET /api/tags, POST /api/show, POST /api/chat,
POST /api/embed, POST /api/pull.
"""

from __future__ import annotations

import json
import logging
import time
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from app.core.errors import UpstreamError

log = logging.getLogger(__name__)


# ------------------------------------------------------------------- errors
class OllamaError(UpstreamError):
    code = "OLLAMA_ERROR"


class OllamaUnavailable(OllamaError):
    code = "OLLAMA_UNAVAILABLE"
    status_code = 503


class OllamaTimeout(OllamaError):
    code = "OLLAMA_TIMEOUT"
    status_code = 504


class OllamaModelNotFound(OllamaError):
    code = "OLLAMA_MODEL_NOT_FOUND"
    status_code = 404


class OllamaModelLoadFailed(OllamaError):
    code = "OLLAMA_MODEL_LOAD_FAILED"


class OllamaInvalidResponse(OllamaError):
    code = "OLLAMA_INVALID_RESPONSE"


class ModelNotConfigured(OllamaError):
    code = "MODEL_NOT_CONFIGURED"
    status_code = 409


# ------------------------------------------------------------------- status
@dataclass
class OllamaStatus:
    """Process-wide connection telemetry (shared across client instances)."""

    last_success: datetime | None = None
    last_error: dict[str, Any] | None = None
    recent_errors: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=20))

    def ok(self) -> None:
        self.last_success = datetime.now(UTC)

    def fail(self, category: str, exc: Exception) -> None:
        entry = {
            "time": datetime.now(UTC).isoformat(),
            "category": category,
            "code": getattr(exc, "code", type(exc).__name__),
            "message": str(exc),
        }
        self.last_error = entry
        self.recent_errors.append(entry)

    def errors_for(self, category: str) -> list[dict[str, Any]]:
        return [e for e in self.recent_errors if e["category"] == category]


def _hint_unavailable(base_url: str) -> str:
    return (
        f"Ollama is not responding at {base_url}. Check that Ollama is installed and running "
        "(start the Ollama app or run `ollama serve`), and verify the configured host/port."
    )


@dataclass
class ChatChunk:
    content: str = ""
    thinking: str = ""
    done: bool = False
    stats: dict[str, Any] = field(default_factory=dict)


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 10.0,
        generation_timeout: float = 300.0,
        transport: httpx.AsyncBaseTransport | None = None,
        status: OllamaStatus | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.generation_timeout = generation_timeout
        self._transport = transport
        self.status = status or OllamaStatus()

    # ------------------------------------------------------------ internals
    def _client(self, timeout: float | httpx.Timeout) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            transport=self._transport,
            trust_env=False,  # never route local traffic through a proxy
        )

    def _gen_timeout(self, override: float | None = None) -> httpx.Timeout:
        # connect fast, but allow long reads while a model loads / generates.
        read = override if override is not None else self.generation_timeout
        return httpx.Timeout(connect=min(self.timeout, 10.0), read=read, write=30.0, pool=10.0)

    def _translate(self, exc: Exception, category: str, model: str | None = None) -> OllamaError:
        if isinstance(exc, OllamaError):
            err = exc
        elif isinstance(exc, httpx.TimeoutException):
            if isinstance(exc, httpx.ConnectTimeout):
                err = OllamaUnavailable(
                    f"Connection to Ollama at {self.base_url} timed out.",
                    hint=_hint_unavailable(self.base_url),
                )
            else:
                err = OllamaTimeout(
                    "Ollama did not respond in time"
                    + (f" while using model '{model}'" if model else "")
                    + ".",
                    hint="Large models can take a while to load. Increase the generation timeout "
                    "in Settings or choose a smaller model.",
                )
        elif isinstance(exc, (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError)):
            err = OllamaUnavailable(
                f"Ollama server is not responding at {self.base_url}.",
                hint=_hint_unavailable(self.base_url),
            )
        elif isinstance(exc, json.JSONDecodeError):
            err = OllamaInvalidResponse(
                "Ollama returned a response that is not valid JSON.",
                hint="Verify the configured URL points to Ollama and not another service.",
            )
        else:
            err = OllamaError(f"Unexpected Ollama error: {exc}")
        self.status.fail(category, err)
        return err

    def _raise_for_status(self, resp: httpx.Response, model: str | None, body_text: str) -> None:
        if resp.status_code < 400:
            return
        message = body_text
        try:
            message = json.loads(body_text).get("error", body_text)
        except (json.JSONDecodeError, AttributeError):
            pass
        lower = message.lower()
        if resp.status_code == 404 or "not found" in lower:
            raise OllamaModelNotFound(
                f"Model '{model}' is not installed in Ollama." if model else message,
                hint=f"Pull it with `ollama pull {model}` or choose an installed model."
                if model
                else None,
                details={"upstream": message},
            )
        if any(k in lower for k in ("memory", "load", "llama runner", "cuda", "gpu")):
            raise OllamaModelLoadFailed(
                f"Ollama failed to load model '{model}': {message}",
                hint="The model may need more RAM/VRAM than available. Try a smaller or more "
                "quantized model, or close other applications.",
                details={"upstream": message},
            )
        if "does not support" in lower:
            raise OllamaError(
                f"Model '{model}' does not support this operation: {message}",
                code="OLLAMA_UNSUPPORTED",
                status_code=422,
                hint="Choose a model with the required capability (e.g. an embedding model "
                "for embeddings).",
            )
        raise OllamaError(
            f"Ollama returned HTTP {resp.status_code}: {message}", details={"upstream": message}
        )

    async def _get_json(self, path: str, category: str) -> Any:
        try:
            async with self._client(self.timeout) as c:
                resp = await c.get(path)
                text = resp.text
                self._raise_for_status(resp, None, text)
                data = json.loads(text)
        except Exception as exc:
            raise self._translate(exc, category) from exc
        self.status.ok()
        return data

    async def _post_json(
        self, path: str, payload: dict[str, Any], category: str, *, model: str | None, timeout: Any
    ) -> Any:
        try:
            async with self._client(timeout) as c:
                resp = await c.post(path, json=payload)
                text = resp.text
                self._raise_for_status(resp, model, text)
                data = json.loads(text)
        except Exception as exc:
            raise self._translate(exc, category, model) from exc
        if isinstance(data, dict) and data.get("error"):
            raise self._translate(OllamaError(str(data["error"])), category, model)
        self.status.ok()
        return data

    # ------------------------------------------------------------ public API
    async def version(self) -> str:
        data = await self._get_json("/api/version", "connection")
        if not isinstance(data, dict) or "version" not in data:
            raise self._translate(
                OllamaInvalidResponse("Unexpected /api/version payload"), "connection"
            )
        return str(data["version"])

    async def list_models(self) -> list[dict[str, Any]]:
        data = await self._get_json("/api/tags", "models")
        models = data.get("models") if isinstance(data, dict) else None
        if not isinstance(models, list):
            raise self._translate(OllamaInvalidResponse("Unexpected /api/tags payload"), "models")
        return models

    async def show(self, model: str) -> dict[str, Any]:
        data = await self._post_json(
            "/api/show", {"model": model}, "models", model=model, timeout=self.timeout
        )
        if not isinstance(data, dict):
            raise self._translate(OllamaInvalidResponse("Unexpected /api/show payload"), "models")
        return data

    async def has_model(self, model: str) -> bool:
        if not model:
            return False
        models = await self.list_models()
        names = {m.get("name") for m in models} | {m.get("model") for m in models}
        if model in names:
            return True
        return ":" not in model and f"{model}:latest" in names

    async def embed(
        self, model: str, inputs: list[str], *, timeout: float | None = None
    ) -> list[list[float]]:
        if not model:
            raise ModelNotConfigured(
                "No embedding model is configured.",
                hint="Select an embedding model (e.g. nomic-embed-text) in Settings → AI.",
            )
        if not inputs:
            return []
        data = await self._post_json(
            "/api/embed",
            {"model": model, "input": inputs, "truncate": True},
            "embedding",
            model=model,
            timeout=self._gen_timeout(timeout or max(self.timeout * 6, 60)),
        )
        emb = data.get("embeddings")
        if not isinstance(emb, list) or len(emb) != len(inputs):
            raise self._translate(
                OllamaInvalidResponse("Embedding response has unexpected shape"), "embedding", model
            )
        return emb

    async def chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        *,
        options: dict[str, Any] | None = None,
        fmt: str | dict[str, Any] | None = None,
        think: bool | None = None,
        timeout: float | None = None,
        keep_alive: str | None = None,
    ) -> ChatChunk:
        """Non-streaming chat completion."""
        if not model:
            raise ModelNotConfigured(
                "No chat model is configured.", hint="Select a chat model in Settings → AI."
            )
        payload: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
        if options:
            payload["options"] = options
        if fmt is not None:
            payload["format"] = fmt
        if think is not None:
            payload["think"] = think
        if keep_alive:
            payload["keep_alive"] = keep_alive
        data = await self._post_json(
            "/api/chat", payload, "chat", model=model, timeout=self._gen_timeout(timeout)
        )
        msg = data.get("message") if isinstance(data, dict) else None
        if not isinstance(msg, dict):
            raise self._translate(OllamaInvalidResponse("Chat response missing message"), "chat", model)
        return ChatChunk(
            content=str(msg.get("content") or ""),
            thinking=str(msg.get("thinking") or ""),
            done=True,
            stats=_stats(data),
        )

    async def chat_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        *,
        options: dict[str, Any] | None = None,
        think: bool | None = None,
        timeout: float | None = None,
    ) -> AsyncIterator[ChatChunk]:
        if not model:
            raise ModelNotConfigured(
                "No chat model is configured.", hint="Select a chat model in Settings → AI."
            )
        payload: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
        if options:
            payload["options"] = options
        if think is not None:
            payload["think"] = think
        try:
            async with self._client(self._gen_timeout(timeout)) as c:
                async with c.stream("POST", "/api/chat", json=payload) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode("utf-8", "replace")
                        self._raise_for_status(resp, model, body)
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        data = json.loads(line)
                        if data.get("error"):
                            self._raise_for_status(
                                httpx.Response(500), model, json.dumps({"error": data["error"]})
                            )
                        msg = data.get("message") or {}
                        chunk = ChatChunk(
                            content=str(msg.get("content") or ""),
                            thinking=str(msg.get("thinking") or ""),
                            done=bool(data.get("done")),
                            stats=_stats(data) if data.get("done") else {},
                        )
                        yield chunk
                        if chunk.done:
                            self.status.ok()
                            return
        except Exception as exc:
            raise self._translate(exc, "chat", model) from exc

    async def pull(self, model: str) -> AsyncIterator[dict[str, Any]]:
        """Stream pull progress. Callers must obtain explicit user confirmation first."""
        try:
            async with self._client(httpx.Timeout(connect=10, read=600, write=30, pool=10)) as c:
                async with c.stream("POST", "/api/pull", json={"model": model, "stream": True}) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode("utf-8", "replace")
                        self._raise_for_status(resp, model, body)
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        data = json.loads(line)
                        if data.get("error"):
                            raise OllamaError(
                                f"Model download failed: {data['error']}",
                                code="OLLAMA_PULL_FAILED",
                                hint="Check your internet connection, disk space and model name.",
                            )
                        yield data
        except Exception as exc:
            raise self._translate(exc, "pull", model) from exc
        self.status.ok()


def _stats(data: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "total_duration", "load_duration", "prompt_eval_count", "prompt_eval_duration",
        "eval_count", "eval_duration", "done_reason",
    )
    out = {k: data[k] for k in keys if k in data}
    if out.get("eval_count") and out.get("eval_duration"):
        out["tokens_per_second"] = round(out["eval_count"] / (out["eval_duration"] / 1e9), 2)
    return out


def model_summary(m: dict[str, Any]) -> dict[str, Any]:
    details = m.get("details") or {}
    caps = m.get("capabilities") or []
    family = details.get("family") or ""
    families = details.get("families") or []
    is_embed = "embedding" in caps or any("bert" in f for f in [family, *families]) or "embed" in (
        m.get("name") or ""
    )
    return {
        "name": m.get("name") or m.get("model"),
        "size_bytes": m.get("size"),
        "family": family or None,
        "parameter_size": details.get("parameter_size"),
        "quantization": details.get("quantization_level"),
        "context_length": details.get("context_length"),
        "modified_at": m.get("modified_at"),
        "capabilities": caps,
        "kind": "embedding" if is_embed else ("vision" if "vision" in caps else "chat"),
    }


def timed() -> float:
    return time.perf_counter()
