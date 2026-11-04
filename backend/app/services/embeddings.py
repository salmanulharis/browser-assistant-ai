"""Embedding generation through Ollama (batched, with model-specific prefixes)."""

from __future__ import annotations

from app.services.ollama import OllamaClient

BATCH = 32


def _prefixes(model: str) -> tuple[str, str]:
    m = model.lower()
    if "nomic-embed" in m:
        return "search_document: ", "search_query: "
    if "mxbai-embed" in m:
        return "", "Represent this sentence for searching relevant passages: "
    if "snowflake-arctic-embed" in m:
        return "", "Represent this sentence for searching relevant passages: "
    return "", ""


class Embedder:
    def __init__(self, client: OllamaClient, model: str) -> None:
        self.client = client
        self.model = model

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        doc_prefix, _ = _prefixes(self.model)
        out: list[list[float]] = []
        for i in range(0, len(texts), BATCH):
            batch = [doc_prefix + t for t in texts[i : i + BATCH]]
            out.extend(await self.client.embed(self.model, batch))
        return out

    async def embed_query(self, text: str) -> list[float]:
        _, q_prefix = _prefixes(self.model)
        return (await self.client.embed(self.model, [q_prefix + text]))[0]
