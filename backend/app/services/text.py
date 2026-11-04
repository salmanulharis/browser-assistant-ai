"""Text normalisation, token estimation, chunking and lexical relevance scoring."""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass

_WS = re.compile(r"[ \t  -​]+")
_MANY_NL = re.compile(r"\n{3,}")
_SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-']*")

STOPWORDS = frozenset(
    """a an and are as at be but by for from has have he her his i if in into is it its
    me my no not of on or our she so that the their them then there these they this to
    was we were what when where which who why will with you your can could would should
    do does did about how please tell give show also than just more most some any""".split()
)


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(_WS.sub(" ", line).strip() for line in text.split("\n"))
    text = _MANY_NL.sub("\n\n", text)
    return text.strip()


def estimate_tokens(text: str) -> int:
    """Cheap token estimate (~4 chars/token for English, never below word count)."""
    if not text:
        return 0
    return max(len(text) // 4, len(text.split()))


@dataclass
class Chunk:
    index: int
    text: str
    location: str | None
    tokens: int


def _split_long(paragraph: str, max_tokens: int) -> list[str]:
    if estimate_tokens(paragraph) <= max_tokens:
        return [paragraph]
    sentences = _SENT.split(paragraph)
    pieces: list[str] = []
    buf = ""
    for s in sentences:
        if estimate_tokens(s) > max_tokens:
            # hard split very long sentences by words
            words = s.split()
            step = max(1, max_tokens * 3 // 4)
            for i in range(0, len(words), step):
                pieces.append(" ".join(words[i : i + step]))
            continue
        cand = f"{buf} {s}".strip()
        if estimate_tokens(cand) > max_tokens and buf:
            pieces.append(buf)
            buf = s
        else:
            buf = cand
    if buf:
        pieces.append(buf)
    return pieces


def chunk_sections(
    sections: list[tuple[str | None, str]], chunk_tokens: int = 700, overlap_tokens: int = 100
) -> list[Chunk]:
    """Chunk ``(location, text)`` sections into overlapping chunks.

    Paragraph boundaries are respected where possible; overlap is taken from the
    tail of the previous chunk.
    """
    overlap_tokens = min(overlap_tokens, chunk_tokens // 2)
    chunks: list[Chunk] = []
    buf: list[str] = []
    buf_loc: str | None = None

    def flush() -> None:
        nonlocal buf
        text = "\n\n".join(buf).strip()
        if text:
            chunks.append(Chunk(len(chunks), text, buf_loc, estimate_tokens(text)))
        if overlap_tokens and text:
            tail_words = text.split()
            keep = max(1, int(overlap_tokens * 0.75))
            buf = [" ".join(tail_words[-keep:])]
        else:
            buf = []

    for loc, text in sections:
        text = normalize_text(text)
        if not text:
            continue
        for para in text.split("\n\n"):
            for piece in _split_long(para, chunk_tokens - overlap_tokens):
                current = estimate_tokens("\n\n".join(buf))
                if buf and current + estimate_tokens(piece) > chunk_tokens:
                    flush()
                if not buf or (len(buf) == 1 and chunks and buf_loc != loc):
                    buf_loc = loc
                buf.append(piece)
    if buf:
        text = "\n\n".join(buf).strip()
        # avoid emitting a chunk that is only the overlap tail
        if text and (not chunks or not chunks[-1].text.endswith(text)):
            chunks.append(Chunk(len(chunks), text, buf_loc, estimate_tokens(text)))
    return chunks


def tokenize(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text or "") if w.lower() not in STOPWORDS and len(w) > 1]


def bm25_rank(query: str, docs: list[str], k1: float = 1.4, b: float = 0.75) -> list[tuple[int, float]]:
    """Return ``(index, score)`` sorted by BM25 relevance (score 0 = no overlap)."""
    q = tokenize(query)
    if not docs:
        return []
    tokenized = [tokenize(d) for d in docs]
    avgdl = sum(len(t) for t in tokenized) / max(1, len(tokenized)) or 1.0
    df: Counter[str] = Counter()
    for t in tokenized:
        df.update(set(t))
    n = len(docs)
    scores: list[tuple[int, float]] = []
    for i, toks in enumerate(tokenized):
        tf = Counter(toks)
        score = 0.0
        for term in set(q):
            if term not in tf:
                continue
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            freq = tf[term]
            score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * len(toks) / avgdl))
        scores.append((i, score))
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


def truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp > max_chars * 0.8 else cut) + " …"
