"""Prompt library + reusable sample answers (samples are embedded for retrieval)."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import or_, select

from app.core.context import AppContext
from app.core.errors import NotFoundError
from app.models.entities import Prompt
from app.schemas.misc import PromptCreate, PromptUpdate
from app.services.text import bm25_rank

log = logging.getLogger(__name__)


def prompt_to_dict(p: Prompt) -> dict[str, Any]:
    return {
        "id": p.id,
        "title": p.title,
        "content": p.content,
        "kind": p.kind,
        "category": p.category,
        "tags": list(p.tags or []),
        "pinned": p.pinned,
        "use_count": p.use_count,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
    }


DEFAULT_PROMPTS: list[dict[str, Any]] = [
    {"title": "Summarize this page", "content": "Summarize the current page in 5 bullet points, then list any action items.", "category": "reading", "pinned": True},
    {"title": "Explain like I'm new", "content": "Explain the main idea of this page to someone new to the topic, with a short example.", "category": "reading"},
    {"title": "Compare selected tabs", "content": "Compare the selected tabs in a table: key differences, pros/cons, and a recommendation.", "category": "research", "pinned": True},
    {"title": "Draft a reply", "content": "Draft a polite, concise reply to the selected text in my writing style.", "category": "writing"},
    {"title": "Extract data as table", "content": "Extract the structured data on this page into a Markdown table.", "category": "data"},
]


class PromptService:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx

    def seed_defaults(self) -> None:
        with self.ctx.db.session() as s:
            if s.execute(select(Prompt.id).limit(1)).first():
                return
            for p in DEFAULT_PROMPTS:
                s.add(Prompt(kind="prompt", tags=[], **p))

    def list(self, q: str | None = None, kind: str | None = None, category: str | None = None) -> list[dict[str, Any]]:
        with self.ctx.db.session() as s:
            stmt = select(Prompt).order_by(Prompt.pinned.desc(), Prompt.use_count.desc(), Prompt.updated_at.desc())
            if kind:
                stmt = stmt.where(Prompt.kind == kind)
            if category:
                stmt = stmt.where(Prompt.category == category)
            if q:
                like = f"%{q}%"
                stmt = stmt.where(or_(Prompt.title.ilike(like), Prompt.content.ilike(like), Prompt.category.ilike(like)))
            return [prompt_to_dict(p) for p in s.execute(stmt).scalars()]

    def get(self, pid: str) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            p = s.get(Prompt, pid)
            if not p:
                raise NotFoundError("Prompt not found.")
            return prompt_to_dict(p)

    async def create(self, data: PromptCreate) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            p = Prompt(**data.model_dump())
            s.add(p)
            s.flush()
            pid = p.id
        await self._index(pid)
        return self.get(pid)

    async def update(self, pid: str, patch: PromptUpdate) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            p = s.get(Prompt, pid)
            if not p:
                raise NotFoundError("Prompt not found.")
            for k, v in patch.model_dump(exclude_unset=True).items():
                setattr(p, k, v)
        await self._index(pid)
        return self.get(pid)

    def mark_used(self, pid: str) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            p = s.get(Prompt, pid)
            if not p:
                raise NotFoundError("Prompt not found.")
            p.use_count += 1
        return self.get(pid)

    def delete(self, pid: str) -> None:
        with self.ctx.db.session() as s:
            p = s.get(Prompt, pid)
            if not p:
                raise NotFoundError("Prompt not found.")
            s.delete(p)
        try:
            self.ctx.vectors.delete("samples", ids=[pid])
        except Exception:
            pass

    async def _index(self, pid: str) -> None:
        s_cfg = self.ctx.settings.get()
        with self.ctx.db.session() as s:
            p = s.get(Prompt, pid)
            if not p:
                return
            kind, text = p.kind, f"{p.title}\n{p.content}"
        if kind != "sample":
            try:
                self.ctx.vectors.delete("samples", ids=[pid])
            except Exception:
                pass
            return
        if not s_cfg.embedding_model:
            return
        try:
            emb = self.ctx.embedder(s_cfg)
            vec = (await emb.embed_documents([text]))[0]
            self.ctx.vectors.upsert("samples", emb.model, [pid], [vec], [{"prompt_id": pid}])
        except Exception as exc:
            log.info("Sample %s not embedded: %s", pid, exc)

    async def relevant_samples(self, query: str, k: int = 3) -> list[tuple[dict[str, Any], float]]:
        samples = self.list(kind="sample")
        if not samples:
            return []
        s_cfg = self.ctx.settings.get()
        scored: dict[str, float] = {}
        if s_cfg.embedding_model:
            try:
                emb = self.ctx.embedder(s_cfg)
                qv = await emb.embed_query(query)
                for h in self.ctx.vectors.query("samples", emb.model, qv, k * 2):
                    if h["score"] >= s_cfg.min_relevance + 0.1:
                        scored[h["id"]] = h["score"]
            except Exception as exc:
                log.info("Sample vector search unavailable: %s", exc)
        ranked = bm25_rank(query, [f"{p['title']} {p['content']}" for p in samples])
        top = max((s for _, s in ranked), default=0) or 1
        for i, sc in ranked[:k]:
            if sc > 0:
                pid = samples[i]["id"]
                scored[pid] = max(scored.get(pid, 0), 0.3 + 0.5 * sc / top)
        by_id = {p["id"]: p for p in samples}
        out = [(by_id[i], sc) for i, sc in scored.items() if i in by_id]
        out.sort(key=lambda x: x[1], reverse=True)
        return out[:k]
