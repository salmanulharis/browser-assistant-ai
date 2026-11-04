"""Personal + automatic memory: CRUD, semantic search, candidate extraction."""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_, select

from app.core.context import AppContext
from app.core.errors import NotFoundError
from app.database.base import utcnow
from app.models.entities import Memory, MemoryCategory
from app.prompts import templates
from app.schemas.memory import MemoryCreate, MemoryImportItem, MemoryUpdate
from app.security.sanitize import contains_sensitive_data
from app.services.capabilities import reasoning_kwargs
from app.services.text import bm25_rank

log = logging.getLogger(__name__)

DUPLICATE_THRESHOLD = 0.92


def _norm(text: str) -> str:
    return re.sub(r"\W+", " ", text.lower()).strip()


def memory_to_dict(m: Memory) -> dict[str, Any]:
    return {
        "id": m.id,
        "content": m.content,
        "title": m.title,
        "category": m.category.name if m.category else None,
        "source": m.source,
        "status": m.status,
        "pinned": m.pinned,
        "expires_at": m.expires_at,
        "created_at": m.created_at,
        "updated_at": m.updated_at,
    }


def _is_live(m: Memory, now: datetime) -> bool:
    return m.status == "active" and (m.expires_at is None or m.expires_at > now)


class MemoryService:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx

    # ------------------------------------------------------------ categories
    def categories(self) -> list[MemoryCategory]:
        with self.ctx.db.session() as s:
            return list(s.execute(select(MemoryCategory).order_by(MemoryCategory.name)).scalars())

    def create_category(self, name: str, description: str | None, auto_allowed: bool) -> MemoryCategory:
        with self.ctx.db.session() as s:
            existing = s.execute(
                select(MemoryCategory).where(MemoryCategory.name == name.strip().lower())
            ).scalar_one_or_none()
            if existing:
                return existing
            cat = MemoryCategory(name=name.strip().lower(), description=description, auto_allowed=auto_allowed)
            s.add(cat)
            s.flush()
            return cat

    def _category_id(self, s: Any, name: str | None) -> int | None:
        if not name:
            return None
        key = name.strip().lower()
        cat = s.execute(select(MemoryCategory).where(MemoryCategory.name == key)).scalar_one_or_none()
        if cat is None:
            cat = MemoryCategory(name=key, auto_allowed=False)
            s.add(cat)
            s.flush()
        return cat.id

    # ------------------------------------------------------------------ CRUD
    def list(
        self, q: str | None = None, category: str | None = None, status: str | None = None
    ) -> list[dict[str, Any]]:
        with self.ctx.db.session() as s:
            stmt = select(Memory).order_by(Memory.pinned.desc(), Memory.updated_at.desc())
            if status:
                stmt = stmt.where(Memory.status == status)
            if category:
                stmt = stmt.join(MemoryCategory).where(MemoryCategory.name == category)
            if q:
                like = f"%{q}%"
                stmt = stmt.where(or_(Memory.content.ilike(like), Memory.title.ilike(like)))
            return [memory_to_dict(m) for m in s.execute(stmt).unique().scalars()]

    def get(self, memory_id: str) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            m = s.get(Memory, memory_id)
            if not m:
                raise NotFoundError("Memory not found.")
            return memory_to_dict(m)

    async def create(
        self,
        data: MemoryCreate | MemoryImportItem,
        *,
        source: str = "user",
        status: str | None = None,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            m = Memory(
                content=data.content.strip(),
                title=data.title,
                category_id=self._category_id(s, data.category),
                source=source,
                status=status or data.status,
                pinned=data.pinned,
                expires_at=_naive(data.expires_at),
                origin_conversation_id=conversation_id,
            )
            s.add(m)
            s.flush()
            mid = m.id
        await self._index(mid)
        return self.get(mid)

    async def update(self, memory_id: str, patch: MemoryUpdate) -> dict[str, Any]:
        changes = patch.model_dump(exclude_unset=True)
        reindex = False
        with self.ctx.db.session() as s:
            m = s.get(Memory, memory_id)
            if not m:
                raise NotFoundError("Memory not found.")
            if "content" in changes and changes["content"] is not None:
                m.content = changes["content"].strip()
                reindex = True
            if "title" in changes:
                m.title = changes["title"]
            if "category" in changes:
                m.category_id = self._category_id(s, changes["category"])
                reindex = True
            if changes.get("pinned") is not None:
                m.pinned = bool(changes["pinned"])
            if changes.get("status"):
                m.status = changes["status"]
                reindex = True
            if changes.get("clear_expiry"):
                m.expires_at = None
            elif "expires_at" in changes and changes["expires_at"] is not None:
                m.expires_at = _naive(changes["expires_at"])
        if reindex:
            await self._index(memory_id)
        return self.get(memory_id)

    def delete(self, memory_id: str) -> None:
        with self.ctx.db.session() as s:
            m = s.get(Memory, memory_id)
            if not m:
                raise NotFoundError("Memory not found.")
            s.delete(m)
        try:
            self.ctx.vectors.delete("memories", ids=[memory_id])
        except Exception as exc:  # pragma: no cover
            log.warning("Vector delete failed for memory %s: %s", memory_id, exc)

    async def _index(self, memory_id: str) -> None:
        """Embed a memory. Failure is non-fatal: keyword search remains available."""
        s_cfg = self.ctx.settings.get()
        if not s_cfg.embedding_model:
            return
        with self.ctx.db.session() as s:
            m = s.get(Memory, memory_id)
            if not m:
                return
            text = f"{m.title or ''}\n{m.content}".strip()
            meta = {"memory_id": m.id, "status": m.status, "category": m.category.name if m.category else ""}
        try:
            embedder = self.ctx.embedder(s_cfg)
            vec = (await embedder.embed_documents([text]))[0]
            self.ctx.vectors.upsert("memories", embedder.model, [memory_id], [vec], [meta])
            with self.ctx.db.session() as s:
                m2 = s.get(Memory, memory_id)
                if m2:
                    m2.embedded_model = embedder.model
        except Exception as exc:
            log.info("Memory %s not embedded (%s); keyword search fallback.", memory_id, exc)

    async def reindex_all(self) -> int:
        with self.ctx.db.session() as s:
            ids = [m.id for m in s.execute(select(Memory)).scalars()]
        for mid in ids:
            await self._index(mid)
        return len(ids)

    # ---------------------------------------------------------------- search
    async def search(self, query: str, limit: int = 5, min_score: float = 0.3) -> list[tuple[dict[str, Any], float]]:
        now = utcnow()
        s_cfg = self.ctx.settings.get()
        scored: dict[str, float] = {}
        if s_cfg.embedding_model:
            try:
                embedder = self.ctx.embedder(s_cfg)
                qv = await embedder.embed_query(query)
                for h in self.ctx.vectors.query(
                    "memories", embedder.model, qv, limit * 3, where={"status": "active"}
                ):
                    if h["score"] >= min_score:
                        scored[h["id"]] = h["score"]
            except Exception as exc:
                log.info("Semantic memory search unavailable: %s", exc)
        with self.ctx.db.session() as s:
            live = [m for m in s.execute(select(Memory).where(Memory.status == "active")).unique().scalars() if _is_live(m, now)]
            # Lexical search complements vectors (and replaces them when unavailable).
            ranked = bm25_rank(query, [f"{m.title or ''} {m.content}" for m in live])
            top = max((sc for _, sc in ranked), default=0) or 1
            for idx, sc in ranked[: limit * 2]:
                if sc <= 0:
                    break
                mid = live[idx].id
                scored[mid] = max(scored.get(mid, 0), 0.3 + 0.5 * sc / top)
            by_id = {m.id: m for m in live}
            hits = [(memory_to_dict(by_id[mid]), sc) for mid, sc in scored.items() if mid in by_id]
        hits.sort(key=lambda x: x[1], reverse=True)
        return hits[:limit]

    async def context_memories(self, query: str, limit: int) -> list[tuple[dict[str, Any], float]]:
        """Pinned memories + the most relevant ones for ``query``."""
        now = utcnow()
        with self.ctx.db.session() as s:
            pinned = [
                memory_to_dict(m)
                for m in s.execute(
                    select(Memory).where(Memory.status == "active", Memory.pinned.is_(True)).limit(5)
                ).unique().scalars()
                if _is_live(m, now)
            ]
        hits = await self.search(query, limit)
        seen = {p["id"] for p in pinned}
        return [(p, 1.0) for p in pinned] + [(m, sc) for m, sc in hits if m["id"] not in seen]

    # ------------------------------------------------------- auto memory
    async def extract_candidates(self, user_text: str, assistant_text: str) -> list[dict[str, Any]]:
        """Ask the LLM for durable facts about the user, then filter them."""
        s_cfg = self.ctx.settings.get()
        if s_cfg.auto_memory_mode == "off" or not s_cfg.chat_model:
            return []
        categories = [c.name for c in self.categories()]
        schema = {
            "type": "object",
            "properties": {
                "memories": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string"},
                            "category": {"type": "string", "enum": categories},
                            "reason": {"type": "string"},
                        },
                        "required": ["content", "category"],
                    },
                }
            },
            "required": ["memories"],
        }
        client = self.ctx.ollama(s_cfg)
        kw = await reasoning_kwargs(client, s_cfg.chat_model, [
            {"role": "system", "content": templates.MEMORY_EXTRACTION_SYSTEM},
            {"role": "user", "content": templates.memory_extraction_user(user_text[:4000], assistant_text[:2000])},
        ], False)
        resp = await client.chat(s_cfg.chat_model, kw["messages"], fmt=schema, options={"temperature": 0}, think=kw["think"])
        try:
            items = json.loads(resp.content).get("memories", [])
        except (json.JSONDecodeError, AttributeError):
            return []
        return await self.filter_candidates(items, user_text)

    async def filter_candidates(self, items: list[Any], user_text: str = "") -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        existing = {_norm(m["content"]) for m in self.list()}
        for it in items[:5]:
            if not isinstance(it, dict):
                continue
            content = str(it.get("content", "")).strip()
            if len(content) < 8 or len(content) > 600:
                continue
            if contains_sensitive_data(content) or (user_text and contains_sensitive_data(user_text) and _overlaps(content, user_text)):
                continue
            if _norm(content) in existing:
                continue
            if await self._is_duplicate(content):
                continue
            out.append(
                {
                    "content": content,
                    "category": str(it.get("category") or "other"),
                    "reason": str(it.get("reason") or "")[:300],
                }
            )
            existing.add(_norm(content))
        return out

    async def _is_duplicate(self, content: str) -> bool:
        hits = await self.search(content, limit=1, min_score=DUPLICATE_THRESHOLD)
        return bool(hits and hits[0][1] >= DUPLICATE_THRESHOLD and hits[0][0]["status"] == "active")

    async def save_candidates(self, candidates: list[dict[str, Any]], conversation_id: str | None) -> list[dict[str, Any]]:
        """Apply the configured policy: 'ask' → pending, 'auto' → active for allowed categories."""
        s_cfg = self.ctx.settings.get()
        allowed = set(s_cfg.auto_memory_categories)
        cat_auto = {c.name: c.auto_allowed for c in self.categories()}
        saved = []
        for c in candidates:
            auto_ok = (
                s_cfg.auto_memory_mode == "auto"
                and c["category"] in allowed
                and cat_auto.get(c["category"], False)
            )
            item = MemoryImportItem(content=c["content"], category=c["category"])
            saved.append(
                await self.create(
                    item, source="auto", status="active" if auto_ok else "pending", conversation_id=conversation_id
                )
            )
        return saved

    # -------------------------------------------------------- import/export
    def export(self) -> dict[str, Any]:
        return {"version": 1, "exported_at": datetime.now(UTC), "memories": self.list()}

    async def import_items(self, items: list[MemoryImportItem]) -> int:
        existing = {_norm(m["content"]) for m in self.list()}
        n = 0
        for it in items:
            if _norm(it.content) in existing:
                continue
            await self.create(it, source="import", status=it.status)
            existing.add(_norm(it.content))
            n += 1
        return n


def _naive(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _overlaps(a: str, b: str) -> bool:
    aw = set(_norm(a).split())
    bw = set(_norm(b).split())
    return len(aw & bw) >= max(3, len(aw) // 2)

