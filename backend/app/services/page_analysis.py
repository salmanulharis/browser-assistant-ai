"""Turn structured page context into compact, relevant, prompt-ready text."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from app.schemas.page import PageContext
from app.services.text import bm25_rank, chunk_sections, normalize_text, truncate


@dataclass
class PageChunk:
    index: int
    section: str | None
    text: str
    score: float = 0.0


def _sections(page: PageContext) -> list[tuple[str | None, str]]:
    """Build (section, text) pairs from the richest representation available."""
    sections: list[tuple[str | None, str]] = []
    if page.main_text.strip():
        current: str | None = None
        buf: list[str] = []
        heads = {h.text.strip() for h in page.headings}
        for line in normalize_text(page.main_text).split("\n"):
            if line.strip() in heads:
                if buf:
                    sections.append((current, "\n".join(buf)))
                current, buf = line.strip()[:100], [line]
            else:
                buf.append(line)
        if buf:
            sections.append((current, "\n".join(buf)))
    elif page.paragraphs:
        sections.append((None, "\n\n".join(page.paragraphs)))
    for lst in page.lists[:50]:
        if lst:
            sections.append(("list", "\n".join(f"- {x}" for x in lst)))
    for t in page.tables[:20]:
        rows = [" | ".join(r) for r in t.rows[:60]]
        if rows:
            sections.append((f"table: {t.caption}" if t.caption else "table", "\n".join(rows)))
    for cb in page.code_blocks[:20]:
        sections.append((f"code {cb.language}".strip(), f"```{cb.language}\n{truncate(cb.code, 4000)}\n```"))
    return sections


def page_chunks(page: PageContext, chunk_tokens: int = 350) -> list[PageChunk]:
    chunks = chunk_sections(_sections(page), chunk_tokens=chunk_tokens, overlap_tokens=40)
    return [PageChunk(c.index, c.location, c.text) for c in chunks]


def select_relevant(page: PageContext, query: str, max_chars: int) -> tuple[list[PageChunk], bool]:
    """Pick chunks relevant to ``query`` within ``max_chars``. Returns (chunks, truncated)."""
    chunks = page_chunks(page)
    total = sum(len(c.text) for c in chunks)
    if total <= max_chars:
        return chunks, False
    ranked = bm25_rank(query, [c.text for c in chunks]) if query.strip() else []
    scores = {i: s for i, s in ranked}
    # Always favour the introduction a little: it usually frames the page.
    order = sorted(
        range(len(chunks)),
        key=lambda i: (scores.get(i, 0.0) + (0.5 if i == 0 else 0.0) + (0.2 if i == 1 else 0.0)),
        reverse=True,
    )
    picked: list[int] = []
    used = 0
    for i in order:
        size = len(chunks[i].text)
        if used + size > max_chars:
            continue
        picked.append(i)
        used += size
    out = [chunks[i] for i in sorted(picked)]
    for c in out:
        c.score = round(scores.get(c.index, 0.0), 3)
    return out, True


def page_header(page: PageContext) -> str:
    parts = [f"Title: {page.title}", f"URL: {page.url}"]
    if page.description:
        parts.append(f"Description: {truncate(page.description, 400)}")
    if page.headings:
        outline = "; ".join(h.text for h in page.headings[:25])
        parts.append(f"Outline: {truncate(outline, 800)}")
    return "\n".join(parts)


def page_context_text(page: PageContext, query: str, max_chars: int) -> tuple[str, bool]:
    chunks, truncated = select_relevant(page, query, max_chars)
    body = "\n\n".join((f"[{c.section}]\n" if c.section else "") + c.text for c in chunks)
    note = "\n\n(Only the parts of the page most relevant to the question are included.)" if truncated else ""
    return f"{page_header(page)}\n\n{body}{note}", truncated


def classify_page(page: PageContext) -> str:
    host = urlparse(page.url).hostname or ""
    fields = sum(len(f.fields) for f in page.forms)
    if fields >= 3:
        return "form"
    if page.code_blocks and len(page.code_blocks) >= 2:
        return "documentation"
    if any(k in host for k in ("github.", "gitlab.")):
        return "code-repository"
    if page.tables and len(page.tables) >= 2:
        return "data"
    words = len(page.main_text.split())
    if words > 600:
        return "article"
    return "general"
