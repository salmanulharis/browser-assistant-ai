"""Model capability lookups (cached per model, per process)."""

from __future__ import annotations

from typing import Any

from app.services.ollama import OllamaClient

_CACHE: dict[tuple[str, str], list[str]] = {}


async def model_capabilities(client: OllamaClient, model: str) -> list[str]:
    key = (client.base_url, model)
    if key not in _CACHE:
        try:
            info: dict[str, Any] = await client.show(model)
            _CACHE[key] = list(info.get("capabilities") or [])
        except Exception:
            return []
    return _CACHE[key]


async def think_param(client: OllamaClient, model: str, want: bool) -> bool | None:
    """Return the ``think`` flag to send, or ``None`` when the model doesn't support it."""
    caps = await model_capabilities(client, model)
    return want if "thinking" in caps else None


def apply_soft_think_switch(messages: list[dict[str, Any]], model: str, think_flag: bool | None, want: bool) -> list[dict[str, Any]]:
    """Qwen3-family models without the native ``think`` capability honour ``/no_think``
    in the prompt. Append it when reasoning is disabled so answers start immediately."""
    if want or think_flag is not None or "qwen3" not in model.lower() or not messages:
        return messages
    out = [dict(m) for m in messages]
    for m in reversed(out):
        if m.get("role") == "user":
            m["content"] = f"{m['content']}\n\n/no_think"
            break
    return out


def clear_cache() -> None:
    _CACHE.clear()


async def reasoning_kwargs(client: OllamaClient, model: str, messages: list[dict[str, Any]], want: bool) -> dict[str, Any]:
    """Return ``{"messages": ..., "think": ...}`` honouring the user's reasoning preference."""
    flag = await think_param(client, model, want)
    return {"messages": apply_soft_think_switch(messages, model, flag, want), "think": flag}
