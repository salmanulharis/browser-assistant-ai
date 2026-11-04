"""Document ingestion pipeline: validate → extract → normalise → chunk → embed → store."""

from __future__ import annotations

import hashlib
import io
import logging
import re
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from app.core.context import AppContext
from app.core.errors import AppError, NotFoundError, PayloadTooLarge
from app.models.entities import Document, DocumentChunk, SavedPage
from app.security.sanitize import safe_join, sanitize_filename
from app.services.text import chunk_sections, normalize_text

log = logging.getLogger(__name__)

SUPPORTED = {"pdf", "docx", "txt", "md", "markdown", "pptx", "xlsx", "html", "htm", "csv"}

Sections = list[tuple[str | None, str]]

# Magic-byte checks so a renamed binary is not processed as something else.
_ZIP_MAGIC = b"PK\x03\x04"
_PDF_MAGIC = b"%PDF"


class ExtractionError(AppError):
    code = "EXTRACTION_FAILED"
    status_code = 422


# ------------------------------------------------------------------ extract
def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try:
            text = data.decode(enc)
            if enc == "utf-16" and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
                continue
            return text
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def extract_pdf(data: bytes) -> Sections:
    import pymupdf

    sections: Sections = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        if doc.needs_pass:
            raise ExtractionError("The PDF is password protected.")
        for i, page in enumerate(doc, start=1):
            text = page.get_text("text") or ""
            if text.strip():
                sections.append((f"page {i}", text))
    if not sections:
        raise ExtractionError(
            "No extractable text found in the PDF.",
            hint="Scanned PDFs need OCR before they can be indexed.",
        )
    return sections


def extract_docx(data: bytes) -> Sections:
    import docx

    d = docx.Document(io.BytesIO(data))
    sections: Sections = []
    heading = None
    buf: list[str] = []

    def flush() -> None:
        if buf:
            sections.append((heading, "\n\n".join(buf)))
            buf.clear()

    for para in d.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name if para.style is not None else "") or ""
        if style.lower().startswith("heading") or style.lower() == "title":
            flush()
            heading = text[:100]
            buf.append(text)
        else:
            buf.append(text)
    flush()
    for t_idx, table in enumerate(d.tables, start=1):
        rows = []
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            rows.append(" | ".join(cells))
        if rows:
            sections.append((f"table {t_idx}", "\n".join(rows)))
    return sections


def extract_pptx(data: bytes) -> Sections:
    from pptx import Presentation

    prs = Presentation(io.BytesIO(data))
    sections: Sections = []
    for i, slide in enumerate(prs.slides, start=1):
        parts: list[str] = []
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                txt = "\n".join(p.text for p in shape.text_frame.paragraphs if p.text.strip())
                if txt.strip():
                    parts.append(txt)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    parts.append(" | ".join(c.text.strip() for c in row.cells))
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                parts.append(f"Notes: {notes}")
        if parts:
            sections.append((f"slide {i}", "\n".join(parts)))
    return sections


def extract_xlsx(data: bytes, rows_per_section: int = 40) -> Sections:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sections: Sections = []
    try:
        for ws in wb.worksheets:
            header: list[str] | None = None
            buf: list[str] = []
            start = 1
            for r_idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
                cells = ["" if v is None else str(v).strip() for v in row]
                if not any(cells):
                    continue
                if header is None:
                    header = cells
                    continue
                if any(header):
                    line = "; ".join(f"{h or f'col{i + 1}'}: {v}" for i, (h, v) in enumerate(zip(header, cells)) if v)
                else:
                    line = " | ".join(cells)
                buf.append(line)
                if len(buf) >= rows_per_section:
                    sections.append((f"{ws.title} rows {start}-{r_idx}", "\n".join(buf)))
                    buf, start = [], r_idx + 1
            if buf:
                sections.append((f"{ws.title} rows {start}+", "\n".join(buf)))
            elif header and not sections:
                sections.append((ws.title, " | ".join(header)))
    finally:
        wb.close()
    return sections


def extract_markdown(text: str) -> Sections:
    sections: Sections = []
    heading: str | None = None
    buf: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            if "".join(buf).strip():
                sections.append((heading, "\n".join(buf)))
            heading, buf = m.group(2).strip()[:100], [line]
        else:
            buf.append(line)
    if "".join(buf).strip():
        sections.append((heading, "\n".join(buf)))
    return sections


def extract_html(text: str) -> Sections:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(text, "html.parser")
    for tag in soup(["script", "style", "noscript", "template", "iframe", "svg", "nav", "footer", "aside"]):
        tag.decompose()
    for tag in soup.select("[hidden], [aria-hidden=true]"):
        tag.decompose()
    title = soup.title.get_text(strip=True) if soup.title else None
    body = soup.body or soup
    blocks = [
        el.get_text(" ", strip=True)
        for el in body.find_all(["h1", "h2", "h3", "h4", "p", "li", "pre", "td", "th", "blockquote"])
    ]
    seen: set[str] = set()
    uniq = [b for b in blocks if b and not (b in seen or seen.add(b))]
    return [(title, "\n\n".join(uniq))] if uniq else []


def extract(ext: str, data: bytes) -> Sections:
    ext = ext.lower()
    try:
        if ext == "pdf":
            if not data.startswith(_PDF_MAGIC):
                raise ExtractionError("File content is not a valid PDF.")
            return extract_pdf(data)
        if ext in {"docx", "pptx", "xlsx"}:
            if not data.startswith(_ZIP_MAGIC):
                raise ExtractionError(f"File content is not a valid .{ext} (Office Open XML) file.")
            return {"docx": extract_docx, "pptx": extract_pptx, "xlsx": extract_xlsx}[ext](data)
        text = _decode(data)
        if "\x00" in text[:2000]:
            raise ExtractionError("File appears to be binary, not text.")
        if ext in {"md", "markdown"}:
            return extract_markdown(text)
        if ext in {"html", "htm"}:
            return extract_html(text)
        return [(None, text)]
    except ExtractionError:
        raise
    except Exception as exc:
        raise ExtractionError(f"Could not read the .{ext} file: {exc}") from exc


# ------------------------------------------------------------------ service
def document_to_dict(d: Document) -> dict[str, Any]:
    return {
        "id": d.id,
        "original_name": d.original_name,
        "extension": d.extension,
        "size_bytes": d.size_bytes,
        "collection": d.collection,
        "source_url": d.source_url,
        "status": d.status,
        "error": d.error,
        "chunk_count": d.chunk_count,
        "char_count": d.char_count,
        "embedded_model": d.embedded_model,
        "created_at": d.created_at,
        "updated_at": d.updated_at,
    }


class DocumentService:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx

    # ----------------------------------------------------------- creation
    def validate(self, filename: str, size: int) -> str:
        ext = Path(filename).suffix.lower().lstrip(".")
        if ext not in SUPPORTED:
            raise AppError(
                f"Unsupported file type '.{ext}'.",
                code="UNSUPPORTED_FILE_TYPE",
                status_code=415,
                hint="Supported: PDF, DOCX, PPTX, XLSX, TXT, Markdown, HTML, CSV.",
            )
        limit = self.ctx.env.max_upload_mb * 1024 * 1024
        if size > limit:
            raise PayloadTooLarge(
                f"File is larger than the {self.ctx.env.max_upload_mb} MB limit.",
                hint="Split the document or raise LBA_MAX_UPLOAD_MB in backend/.env.",
            )
        if size == 0:
            raise AppError("File is empty.", code="EMPTY_FILE")
        return ext

    def create(
        self, filename: str, data: bytes, collection: str = "default", source_url: str | None = None
    ) -> tuple[dict[str, Any], bool]:
        """Persist the upload. Returns (document, created). Duplicates are not re-added."""
        ext = self.validate(filename, len(data))
        collection = (collection or "default").strip()[:100] or "default"
        digest = hashlib.sha256(data).hexdigest()
        with self.ctx.db.session() as s:
            existing = s.execute(
                select(Document).where(Document.sha256 == digest, Document.collection == collection)
            ).scalar_one_or_none()
            if existing:
                return document_to_dict(existing), False
            safe = sanitize_filename(filename)
            doc = Document(
                original_name=safe,
                stored_name="",
                extension=ext,
                size_bytes=len(data),
                sha256=digest,
                collection=collection,
                source_url=source_url,
                status="pending",
            )
            s.add(doc)
            s.flush()
            doc.stored_name = f"{doc.id}_{safe}"
            path = safe_join(self.ctx.env.documents_dir, doc.stored_name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return document_to_dict(doc), True

    # --------------------------------------------------------- processing
    async def process(self, doc_id: str) -> dict[str, Any]:
        s_cfg = self.ctx.settings.get()
        with self.ctx.db.session() as s:
            doc = s.get(Document, doc_id)
            if not doc:
                raise NotFoundError("Document not found.")
            doc.status, doc.error = "processing", None
            path = safe_join(self.ctx.env.documents_dir, doc.stored_name)
            ext = doc.extension
        try:
            data = path.read_bytes()
            sections = extract(ext, data)
            chunks = chunk_sections(sections, s_cfg.chunk_size_tokens, s_cfg.chunk_overlap_tokens)
            if not chunks:
                raise ExtractionError("No text content could be extracted from the document.")
            total_chars = sum(len(normalize_text(t)) for _, t in sections)
            with self.ctx.db.session() as s:
                doc = s.get(Document, doc_id)
                assert doc is not None
                for old in list(doc.chunks):
                    s.delete(old)
                s.flush()
                for c in chunks:
                    s.add(
                        DocumentChunk(
                            document_id=doc_id,
                            chunk_index=c.index,
                            content=c.text,
                            location=c.location,
                            token_estimate=c.tokens,
                        )
                    )
                doc.chunk_count, doc.char_count = len(chunks), total_chars
            await self._embed_chunks(doc_id)
        except Exception as exc:
            msg = getattr(exc, "message", None) or str(exc)
            log.warning("Document %s processing failed: %s", doc_id, msg)
            with self.ctx.db.session() as s:
                doc = s.get(Document, doc_id)
                if doc:
                    doc.status, doc.error = "failed", msg[:2000]
            raise
        return self.get(doc_id)

    async def _embed_chunks(self, doc_id: str) -> None:
        s_cfg = self.ctx.settings.get()
        embedder = self.ctx.embedder(s_cfg)
        with self.ctx.db.session() as s:
            doc = s.get(Document, doc_id)
            assert doc is not None
            rows = [(c.chunk_index, c.content, c.location) for c in doc.chunks]
            name, collection = doc.original_name, doc.collection
        self.ctx.vectors.delete("documents", where={"document_id": doc_id})
        vectors = await embedder.embed_documents([r[1] for r in rows])
        self.ctx.vectors.upsert(
            "documents",
            embedder.model,
            ids=[f"{doc_id}:{r[0]}" for r in rows],
            embeddings=vectors,
            metadatas=[
                {
                    "document_id": doc_id,
                    "chunk_index": r[0],
                    "collection": collection,
                    "name": name,
                    "location": r[2],
                }
                for r in rows
            ],
        )
        with self.ctx.db.session() as s:
            doc = s.get(Document, doc_id)
            assert doc is not None
            doc.status, doc.error, doc.embedded_model = "indexed", None, embedder.model

    # ------------------------------------------------------------- queries
    def get(self, doc_id: str, preview_chunks: int = 0) -> dict[str, Any]:
        with self.ctx.db.session() as s:
            doc = s.get(Document, doc_id)
            if not doc:
                raise NotFoundError("Document not found.")
            out = document_to_dict(doc)
            if preview_chunks:
                out["preview"] = [
                    {
                        "chunk_index": c.chunk_index,
                        "content": c.content,
                        "location": c.location,
                        "token_estimate": c.token_estimate,
                    }
                    for c in doc.chunks[:preview_chunks]
                ]
            return out

    def list(self, collection: str | None = None, q: str | None = None) -> list[dict[str, Any]]:
        with self.ctx.db.session() as s:
            stmt = select(Document).order_by(Document.created_at.desc())
            if collection:
                stmt = stmt.where(Document.collection == collection)
            if q:
                stmt = stmt.where(Document.original_name.ilike(f"%{q}%"))
            return [document_to_dict(d) for d in s.execute(stmt).scalars()]

    def collections(self) -> list[dict[str, Any]]:
        with self.ctx.db.session() as s:
            rows = s.execute(
                select(Document.collection, func.count(Document.id)).group_by(Document.collection)
            ).all()
            return [{"name": r[0], "document_count": int(r[1])} for r in rows]

    def delete(self, doc_id: str) -> None:
        with self.ctx.db.session() as s:
            doc = s.get(Document, doc_id)
            if not doc:
                raise NotFoundError("Document not found.")
            stored = doc.stored_name
            s.delete(doc)
        # Vector records for this document are removed from all model collections.
        try:
            self.ctx.vectors.delete("documents", where={"document_id": doc_id})
        except Exception as exc:  # pragma: no cover - logged, row already gone
            log.error("Failed to delete vectors for %s: %s", doc_id, exc)
        try:
            safe_join(self.ctx.env.documents_dir, stored).unlink(missing_ok=True)
        except OSError as exc:  # pragma: no cover
            log.warning("Could not delete stored file %s: %s", stored, exc)

    async def search(
        self,
        query: str,
        top_k: int | None = None,
        collection: str | None = None,
        document_ids: list[str] | None = None,
        min_score: float | None = None,
    ) -> list[dict[str, Any]]:
        s_cfg = self.ctx.settings.get()
        k = top_k or s_cfg.rag_top_k
        threshold = s_cfg.min_relevance if min_score is None else min_score
        embedder = self.ctx.embedder(s_cfg)
        qvec = await embedder.embed_query(query)
        filters: list[dict[str, Any]] = []
        if collection:
            filters.append({"collection": collection})
        if document_ids:
            filters.append({"document_id": {"$in": list(document_ids)}})
        where = filters[0] if len(filters) == 1 else ({"$and": filters} if filters else None)
        hits = self.ctx.vectors.query("documents", embedder.model, qvec, k * 2, where)
        hits = [h for h in hits if h["score"] >= threshold][:k]
        if not hits:
            return []
        keys = {(h["metadata"].get("document_id"), h["metadata"].get("chunk_index")) for h in hits}
        with self.ctx.db.session() as s:
            rows = s.execute(
                select(DocumentChunk, Document.original_name)
                .join(Document, Document.id == DocumentChunk.document_id)
                .where(DocumentChunk.document_id.in_({k[0] for k in keys}))
            ).all()
            by_key = {(c.document_id, c.chunk_index): (c, name) for c, name in rows}
        results = []
        for h in hits:
            key = (h["metadata"].get("document_id"), h["metadata"].get("chunk_index"))
            if key not in by_key:  # stale vector – SQLite is the source of truth
                continue
            chunk, name = by_key[key]
            results.append(
                {
                    "document_id": chunk.document_id,
                    "document_name": name,
                    "chunk_index": chunk.chunk_index,
                    "location": chunk.location,
                    "content": chunk.content,
                    "score": round(h["score"], 4),
                }
            )
        return results

    def save_page(self, url: str, title: str, content: str, collection: str) -> tuple[dict[str, Any], bool]:
        name = sanitize_filename((title or "page")[:80]) + ".txt"
        body = f"{title}\nSource: {url}\n\n{content}"
        doc, created = self.create(name, body.encode("utf-8"), collection, source_url=url)
        with self.ctx.db.session() as s:
            s.add(SavedPage(url=url, title=title[:500], content=content, document_id=doc["id"]))
        return doc, created
