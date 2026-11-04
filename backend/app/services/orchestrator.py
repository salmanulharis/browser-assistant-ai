"""Chat orchestration: context gathering → prompt assembly → (streaming) generation →
persistence → post-processing (citations, summaries, memory suggestions)."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import AsyncIterator
from typing import Any

from app.core.context import AppContext
from app.core.errors import AppError
from app.prompts import templates
from app.schemas.chat import AssistRequest, ChatRequest, ContextToggles
from app.services.capabilities import model_capabilities, reasoning_kwargs
from app.services.conversations import ConversationService
from app.services.memory import MemoryService
from app.services.ollama import ModelNotConfigured
from app.services.retrieval import ContextBuilder
from app.services.text import truncate

log = logging.getLogger(__name__)

_CITE = re.compile(r"\[(S\d+(?:\s*,\s*S\d+)*)\]")
_BG_TASKS: set[asyncio.Task[Any]] = set()


def _spawn(coro: Any) -> None:
    task = asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


def validate_citations(text: str, source_ids: set[str]) -> tuple[list[str], list[str]]:
    """Return (used valid ids, invalid ids) referenced in ``text``."""
    used: list[str] = []
    invalid: list[str] = []
    for m in _CITE.finditer(text):
        for sid in re.split(r"\s*,\s*", m.group(1)):
            target = used if sid in source_ids else invalid
            if sid not in target:
                target.append(sid)
    return used, invalid


class ThinkFilter:
    """Separate inline ``<think>…</think>`` reasoning from answer text across chunks."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed(self, text: str) -> tuple[str, str]:
        self.buf += text
        content, thinking = "", ""
        while self.buf:
            tag = self.CLOSE if self.inside else self.OPEN
            idx = self.buf.find(tag)
            if idx >= 0:
                part, self.buf = self.buf[:idx], self.buf[idx + len(tag) :]
                if self.inside:
                    thinking += part
                else:
                    content += part
                self.inside = not self.inside
                continue
            # keep a possible partial tag at the end
            keep = 0
            for k in range(1, len(tag)):
                if self.buf.endswith(tag[:k]):
                    keep = k
            part = self.buf[: len(self.buf) - keep]
            self.buf = self.buf[len(self.buf) - keep :]
            if self.inside:
                thinking += part
            else:
                content += part
            break
        return content, thinking

    def flush(self) -> tuple[str, str]:
        rest, self.buf = self.buf, ""
        return ("", rest) if self.inside else (rest, "")


class ChatOrchestrator:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx
        self.convs = ConversationService(ctx)
        self.memory = MemoryService(ctx)
        self.builder = ContextBuilder(ctx)

    async def _prepare(self, req: ChatRequest) -> dict[str, Any]:
        s = self.ctx.settings.get()
        model = req.model or s.chat_model
        warnings: list[str] = []
        images: list[str] = []
        if req.images:
            if s.vision_model:
                model = s.vision_model
                images = req.images
            else:
                warnings.append("Images were ignored because no vision model is configured.")
        if not model:
            raise ModelNotConfigured(
                "No chat model is configured.", hint="Choose a chat model in Settings → AI or Diagnostics."
            )

        # conversation + user message
        if req.conversation_id:
            conv = self.convs.get(req.conversation_id)
        else:
            conv = self.convs.create(
                page_url=req.page.url if req.page else None, page_title=req.page.title if req.page else None
            )
        conv_id = conv["id"]
        user_text = req.message
        if req.regenerate:
            prev = self.convs.pop_last_assistant(conv_id)
            if prev is None:
                raise AppError("Nothing to regenerate in this conversation.", code="NOTHING_TO_REGENERATE")
            user_text = prev
            user_msg = {"id": None}
        else:
            user_msg = self.convs.add_message(conv_id, "user", user_text)

        bundle = await self.builder.gather(
            user_text,
            toggles=req.context,
            page=req.page,
            tabs=req.tabs,
            conversation_id=conv_id,
            collection=req.knowledge_collection,
            document_ids=req.document_ids or None,
        )
        warnings.extend(bundle.warnings)

        system = templates.SYSTEM_CHAT
        if req.instructions.strip():
            system += f"\n\nThe user's standing instructions (trusted):\n{req.instructions.strip()}"
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        if req.context.history:
            summary, recent = self.convs.recent_messages(conv_id, s.recent_messages, exclude_last_user=not req.regenerate)
            if req.regenerate and recent and recent[-1]["role"] == "user":
                recent = recent[:-1]
            if summary:
                messages.append({"role": "system", "content": f"Summary of the earlier conversation:\n{summary}"})
            messages.extend(recent)
        ctx_text = bundle.render()
        user_content = f"{ctx_text}\n\n---\nUser question: {user_text}" if ctx_text else user_text
        um: dict[str, Any] = {"role": "user", "content": user_content}
        if images:
            um["images"] = images
        messages.append(um)

        client = self.ctx.ollama(s)
        kw = await reasoning_kwargs(client, model, messages, s.think)
        options = {
            "temperature": req.temperature if req.temperature is not None else s.temperature,
            "num_ctx": s.context_length,
        }
        return {
            "settings": s,
            "client": client,
            "model": model,
            "messages": kw["messages"],
            "options": options,
            "think": kw["think"],
            "conv_id": conv_id,
            "user_msg_id": user_msg["id"],
            "user_text": user_text,
            "sources": bundle.sources,
            "warnings": warnings,
        }

    def _finish(self, p: dict[str, Any], content: str, thinking: str, stats: dict[str, Any]) -> dict[str, Any]:
        source_ids = {src.id for src in p["sources"]}
        used, invalid = validate_citations(content, source_ids)
        srcs = [src.model_dump() for src in p["sources"]]
        for src in srcs:
            src["cited"] = src["id"] in used
        msg = self.convs.add_message(
            p["conv_id"],
            "assistant",
            content,
            sources=srcs,
            model=p["model"],
            stats={**stats, "invalid_citations": invalid, "thinking": truncate(thinking, 20000) if thinking else None},
        )
        return {"message": msg, "sources": srcs, "invalid": invalid, "used": used}

    def _post_process(self, p: dict[str, Any], content: str) -> None:
        if p["user_msg_id"]:
            _spawn(self.convs.index_exchange(p["conv_id"], p["user_msg_id"], p["user_text"], content))
        _spawn(self._safe_summarize(p["conv_id"]))

    async def _safe_summarize(self, conv_id: str) -> None:
        try:
            await self.convs.maybe_summarize(conv_id)
        except Exception as exc:
            log.info("Summary skipped: %s", exc)

    async def _memory_suggestions(self, p: dict[str, Any], content: str) -> list[dict[str, Any]]:
        s = p["settings"]
        if s.auto_memory_mode == "off" or not p["user_msg_id"]:
            return []
        try:
            cands = await self.memory.extract_candidates(p["user_text"], content)
            return await self.memory.save_candidates(cands, p["conv_id"]) if cands else []
        except Exception as exc:
            log.info("Memory extraction skipped: %s", exc)
            return []

    # ----------------------------------------------------------- streaming
    async def stream(self, req: ChatRequest) -> AsyncIterator[dict[str, Any]]:
        p = await self._prepare(req)
        yield {
            "event": "meta",
            "data": {
                "conversation_id": p["conv_id"],
                "user_message_id": p["user_msg_id"],
                "model": p["model"],
                "sources": [s.model_dump() for s in p["sources"]],
                "warnings": p["warnings"],
            },
        }
        started = time.perf_counter()
        first_token: float | None = None
        content, thinking, stats = "", "", {}
        tf = ThinkFilter()
        try:
            async for chunk in p["client"].chat_stream(
                p["model"], p["messages"], options=p["options"], think=p["think"]
            ):
                c, t = tf.feed(chunk.content)
                t = chunk.thinking + t
                if t:
                    thinking += t
                    yield {"event": "thinking", "data": {"text": t}}
                if c:
                    if first_token is None:
                        first_token = time.perf_counter()
                    content += c
                    yield {"event": "delta", "data": {"text": c}}
                if chunk.done:
                    stats = chunk.stats
        except (GeneratorExit, asyncio.CancelledError):
            # Client pressed "Stop": keep the partial answer so the history stays coherent.
            if content.strip():
                stats = {"stopped": True, "duration_ms": round((time.perf_counter() - started) * 1000)}
                self._finish(p, content.strip() + "\n\n*(generation stopped)*", thinking, stats)
            raise
        c, t = tf.flush()
        if c:
            content += c
            yield {"event": "delta", "data": {"text": c}}
        thinking += t
        content = content.strip()
        stats["duration_ms"] = round((time.perf_counter() - started) * 1000)
        if first_token:
            stats["first_token_ms"] = round((first_token - started) * 1000)
        fin = self._finish(p, content, thinking, stats)
        yield {
            "event": "done",
            "data": {
                "conversation_id": p["conv_id"],
                "message_id": fin["message"]["id"],
                "sources": fin["sources"],
                "invalid_citations": fin["invalid"],
                "stats": stats,
            },
        }
        self._post_process(p, content)
        suggestions = await self._memory_suggestions(p, content)
        if suggestions:
            yield {"event": "memory_suggestions", "data": {"memories": suggestions}}

    async def run(self, req: ChatRequest) -> dict[str, Any]:
        p = await self._prepare(req)
        started = time.perf_counter()
        resp = await p["client"].chat(p["model"], p["messages"], options=p["options"], think=p["think"])
        tf = ThinkFilter()
        c, t = tf.feed(resp.content)
        c2, t2 = tf.flush()
        content, thinking = (c + c2).strip(), resp.thinking + t + t2
        stats = {**resp.stats, "duration_ms": round((time.perf_counter() - started) * 1000)}
        fin = self._finish(p, content, thinking, stats)
        self._post_process(p, content)
        return {
            "conversation_id": p["conv_id"],
            "message_id": fin["message"]["id"],
            "content": content,
            "thinking": thinking,
            "sources": fin["sources"],
            "invalid_citations": fin["invalid"],
            "model": p["model"],
            "stats": stats,
            "warnings": p["warnings"],
        }

    # ------------------------------------------------------ quick actions
    async def assist_stream(self, req: AssistRequest) -> AsyncIterator[dict[str, Any]]:
        s = self.ctx.settings.get()
        model = req.model or s.chat_model
        if not model:
            raise ModelNotConfigured("No chat model is configured.", hint="Choose a chat model in Settings → AI.")
        instruction = templates.ASSIST_ACTIONS[req.action]
        sources_text = ""
        sources: list[dict[str, Any]] = []
        if req.use_memory and req.action in {"generate", "rewrite"}:
            bundle = await self.builder.gather(
                f"{req.instructions} {req.text}".strip() or req.action,
                toggles=ContextToggles(page=False, selection=False, tabs=False, history=False, knowledge=req.action == "generate"),
            )
            sources_text = bundle.render()
            sources = [x.model_dump() for x in bundle.sources]
        parts = [instruction]
        if req.instructions.strip():
            parts.append(f"Additional instructions from the user: {req.instructions.strip()}")
        if req.page and req.page.title:
            parts.append(f"(The text comes from the page '{req.page.title}' – {req.page.url})")
        if sources_text:
            parts.append(sources_text + "\nUse the user's saved information where relevant; do not invent facts.")
        if req.text.strip():
            parts.append(f"<input>\n{req.text}\n</input>")
        client = self.ctx.ollama(s)
        yield {"event": "meta", "data": {"model": model, "action": req.action, "sources": sources, "warnings": []}}
        tf = ThinkFilter()
        content = ""
        kw = await reasoning_kwargs(
            client, model,
            [{"role": "system", "content": templates.SYSTEM_ASSIST}, {"role": "user", "content": "\n\n".join(parts)}], False,
        )
        async for chunk in client.chat_stream(
            model,
            kw["messages"],
            options={"temperature": 0.3 if req.action in {"grammar", "translate"} else s.temperature, "num_ctx": s.context_length},
            think=kw["think"],
        ):
            c, _ = tf.feed(chunk.content)
            if c:
                content += c
                yield {"event": "delta", "data": {"text": c}}
        c, _ = tf.flush()
        if c:
            content += c
            yield {"event": "delta", "data": {"text": c}}
        yield {"event": "done", "data": {"length": len(content)}}


async def vision_supported(ctx: AppContext) -> bool:
    s = ctx.settings.get()
    if not s.vision_model:
        return False
    return "vision" in await model_capabilities(ctx.ollama(s), s.vision_model)
