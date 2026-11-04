"""Conversation persistence, summaries, cross-conversation retrieval, retention."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, or_, select

from app.core.context import AppContext
from app.core.errors import NotFoundError
from app.database.base import utcnow
from app.models.entities import Conversation, Message
from app.prompts import templates
from app.services.capabilities import reasoning_kwargs
from app.services.text import truncate

log = logging.getLogger(__name__)


def conv_to_dict(c: Conversation, message_count: int = 0) -> dict[str, Any]:
    return {
        "id": c.id,
        "title": c.title,
        "page_url": c.page_url,
        "page_title": c.page_title,
        "summary": c.summary,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
        "message_count": message_count,
    }


def msg_to_dict(m: Message) -> dict[str, Any]:
    return {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "sources": m.sources,
        "model": m.model,
        "stats": m.stats,
        "created_at": m.created_at,
    }


class ConversationService:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx

    def create(self, title: str = "New conversation", page_url: str | None = None, page_title: str | None = None) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            c = Conversation(title=title[:300] or "New conversation", page_url=page_url, page_title=page_title)
            s.add(c)
            s.flush()
            return conv_to_dict(c)

    def list(self, q: str | None = None, page_url: str | None = None, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        with self.ctx.db.session() as s:
            count_sq = (
                select(Message.conversation_id, func.count(Message.id).label("n"))
                .group_by(Message.conversation_id)
                .subquery()
            )
            stmt = (
                select(Conversation, func.coalesce(count_sq.c.n, 0))
                .outerjoin(count_sq, count_sq.c.conversation_id == Conversation.id)
                .where(Conversation.archived.is_(False))
                .order_by(Conversation.updated_at.desc())
                .limit(limit)
                .offset(offset)
            )
            if page_url:
                stmt = stmt.where(Conversation.page_url == page_url)
            if q:
                like = f"%{q}%"
                sub = select(Message.conversation_id).where(Message.content.ilike(like))
                stmt = stmt.where(or_(Conversation.title.ilike(like), Conversation.id.in_(sub)))
            return [conv_to_dict(c, n) for c, n in s.execute(stmt).all()]

    def get(self, conv_id: str) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            c = s.get(Conversation, conv_id)
            if not c:
                raise NotFoundError("Conversation not found.")
            out = conv_to_dict(c, len(c.messages))
            out["messages"] = [msg_to_dict(m) for m in c.messages]
            return out

    def update(self, conv_id: str, title: str | None = None, archived: bool | None = None) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            c = s.get(Conversation, conv_id)
            if not c:
                raise NotFoundError("Conversation not found.")
            if title is not None:
                c.title = title[:300]
            if archived is not None:
                c.archived = archived
        return self.get(conv_id)

    def delete(self, conv_id: str) -> None:
        with self.ctx.db.session() as s:
            c = s.get(Conversation, conv_id)
            if not c:
                raise NotFoundError("Conversation not found.")
            s.delete(c)
        try:
            self.ctx.vectors.delete("messages", where={"conversation_id": conv_id})
        except Exception as exc:  # pragma: no cover
            log.warning("vector cleanup failed: %s", exc)

    def search_messages(self, q: str, limit: int = 30) -> list[dict[str, Any]]:
        with self.ctx.db.session() as s:
            rows = s.execute(
                select(Message, Conversation.title)
                .join(Conversation)
                .where(Message.content.ilike(f"%{q}%"), Message.role != "system")
                .order_by(Message.created_at.desc())
                .limit(limit)
            ).all()
            out = []
            for m, title in rows:
                i = m.content.lower().find(q.lower())
                start = max(0, i - 80)
                out.append(
                    {
                        "conversation_id": m.conversation_id,
                        "conversation_title": title,
                        "message_id": m.id,
                        "role": m.role,
                        "snippet": ("…" if start else "") + m.content[start : start + 240],
                        "created_at": m.created_at,
                    }
                )
            return out

    # ------------------------------------------------------------ messages
    def add_message(self, conv_id: str, role: str, content: str, **extra: Any) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            c = s.get(Conversation, conv_id)
            if not c:
                raise NotFoundError("Conversation not found.")
            seq = (s.execute(select(func.max(Message.seq)).where(Message.conversation_id == conv_id)).scalar() or 0) + 1
            m = Message(conversation_id=conv_id, seq=seq, role=role, content=content, **extra)
            s.add(m)
            c.updated_at = utcnow()
            if role == "user" and c.title == "New conversation":
                c.title = truncate(content.strip().splitlines()[0] if content.strip() else "Chat", 80)
            s.flush()
            return msg_to_dict(m)

    def pop_last_assistant(self, conv_id: str) -> str | None:
        """For regenerate: remove the final assistant reply; return the last user message."""
        with self.ctx.db.session() as s:
            msgs = list(
                s.execute(
                    select(Message).where(Message.conversation_id == conv_id).order_by(Message.seq.desc()).limit(2)
                ).scalars()
            )
            if msgs and msgs[0].role == "assistant":
                s.delete(msgs[0])
                try:
                    self.ctx.vectors.delete("messages", ids=[msgs[0].id])
                except Exception:
                    pass
                msgs = msgs[1:]
            return msgs[0].content if msgs and msgs[0].role == "user" else None

    def recent_messages(self, conv_id: str, n: int, exclude_last_user: bool = True) -> tuple[str | None, list[dict[str, str]]]:
        """Return (summary, recent messages) – never the full history."""
        with self.ctx.db.session() as s:
            c = s.get(Conversation, conv_id)
            if not c:
                return None, []
            rows = list(
                s.execute(
                    select(Message).where(Message.conversation_id == conv_id).order_by(Message.seq.desc()).limit(n + 1)
                ).scalars()
            )
            rows.reverse()
            if exclude_last_user and rows and rows[-1].role == "user":
                rows = rows[:-1]
            return c.summary, [{"role": m.role, "content": m.content} for m in rows[-n:]]

    async def index_exchange(self, conv_id: str, user_msg_id: str, user_text: str, assistant_text: str) -> None:
        s_cfg = self.ctx.settings.get()
        if not (s_cfg.cross_conversation_retrieval and s_cfg.embedding_model):
            return
        try:
            embedder = self.ctx.embedder(s_cfg)
            text = f"User: {user_text}\nAssistant: {truncate(assistant_text, 1500)}"
            vec = (await embedder.embed_documents([text]))[0]
            self.ctx.vectors.upsert(
                "messages", embedder.model, [user_msg_id], [vec], [{"conversation_id": conv_id, "message_id": user_msg_id}]
            )
        except Exception as exc:
            log.info("Exchange not indexed: %s", exc)

    async def related_exchanges(self, query: str, exclude_conv: str | None, k: int = 3) -> list[dict[str, Any]]:
        s_cfg = self.ctx.settings.get()
        if not (s_cfg.cross_conversation_retrieval and s_cfg.embedding_model):
            return []
        embedder = self.ctx.embedder(s_cfg)
        qv = await embedder.embed_query(query)
        where = {"conversation_id": {"$ne": exclude_conv}} if exclude_conv else None
        hits = [h for h in self.ctx.vectors.query("messages", embedder.model, qv, k, where) if h["score"] >= s_cfg.min_relevance + 0.1]
        if not hits:
            return []
        out = []
        with self.ctx.db.session() as s:
            for h in hits:
                m = s.get(Message, h["metadata"].get("message_id"))
                if not m:
                    continue
                reply = s.execute(
                    select(Message).where(Message.conversation_id == m.conversation_id, Message.seq == m.seq + 1)
                ).scalar_one_or_none()
                out.append(
                    {
                        "conversation_id": m.conversation_id,
                        "title": m.conversation.title,
                        "text": f"User: {m.content}\nAssistant: {truncate(reply.content, 800) if reply else ''}",
                        "score": h["score"],
                    }
                )
        return out

    async def maybe_summarize(self, conv_id: str) -> bool:
        """Roll older messages into the conversation summary once the threshold is reached."""
        s_cfg = self.ctx.settings.get()
        with self.ctx.db.session() as s:
            c = s.get(Conversation, conv_id)
            if not c:
                return False
            total = len(c.messages)
            keep = s_cfg.recent_messages
            if total - c.summarized_count < s_cfg.summarize_after_messages:
                return False
            to_summarize = c.messages[c.summarized_count : total - keep]
            if not to_summarize:
                return False
            prev = c.summary or ""
            transcript = "\n".join(f"{m.role.upper()}: {truncate(m.content, 1200)}" for m in to_summarize)
            new_count = total - keep
        client = self.ctx.ollama(s_cfg)
        kw = await reasoning_kwargs(client, s_cfg.chat_model, [
            {"role": "system", "content": templates.SUMMARY_SYSTEM},
            {"role": "user", "content": f"Previous summary:\n{prev or '(none)'}\n\nNew messages:\n{transcript}"},
        ], False)
        resp = await client.chat(
            s_cfg.chat_model, kw["messages"], options={"temperature": 0.2, "num_ctx": s_cfg.context_length}, think=kw["think"]
        )
        summary = resp.content.strip()
        if not summary:
            return False
        with self.ctx.db.session() as s:
            c = s.get(Conversation, conv_id)
            if c:
                c.summary, c.summarized_count = summary[:4000], new_count
        return True

    def apply_retention(self) -> int:
        days = self.ctx.settings.get().conversation_retention_days
        if not days:
            return 0
        cutoff = utcnow() - timedelta(days=days)
        with self.ctx.db.session() as s:
            ids = [r for r in s.execute(select(Conversation.id).where(Conversation.updated_at < cutoff)).scalars()]
            if ids:
                s.execute(delete(Conversation).where(Conversation.id.in_(ids)))
        for cid in ids:
            try:
                self.ctx.vectors.delete("messages", where={"conversation_id": cid})
            except Exception:
                pass
        return len(ids)
