"""ChromaDB wrapper. Vectors + references only; SQLite stays the source of truth."""

from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def _slug(model: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", model).strip("-").lower()
    return s[:60] or "model"


class VectorStore:
    PURPOSES = ("documents", "memories", "messages", "samples")

    def __init__(self, path: Path) -> None:
        self.path = path
        self._client: Any = None
        self._lock = threading.Lock()
        self.init_error: str | None = None

    @property
    def client(self) -> Any:
        if self._client is None:
            with self._lock:
                if self._client is None:
                    import chromadb
                    from chromadb.config import Settings as ChromaSettings

                    self.path.mkdir(parents=True, exist_ok=True)
                    try:
                        self._client = chromadb.PersistentClient(
                            path=str(self.path),
                            settings=ChromaSettings(anonymized_telemetry=False, allow_reset=False),
                        )
                        self.init_error = None
                    except Exception as exc:
                        self.init_error = str(exc)
                        raise
        return self._client

    def collection_name(self, purpose: str, model: str) -> str:
        if purpose not in self.PURPOSES:
            raise ValueError(f"unknown purpose {purpose}")
        return f"lba_{purpose}__{_slug(model)}"

    def collection(self, purpose: str, model: str) -> Any:
        return self.client.get_or_create_collection(
            name=self.collection_name(purpose, model),
            metadata={"hnsw:space": "cosine", "embedding_model": model},
            embedding_function=None,
        )

    def upsert(
        self,
        purpose: str,
        model: str,
        ids: list[str],
        embeddings: list[list[float]],
        metadatas: list[dict[str, Any]],
    ) -> None:
        if not ids:
            return
        col = self.collection(purpose, model)
        clean = [{k: v for k, v in m.items() if v is not None} or {"_": 1} for m in metadatas]
        col.upsert(ids=ids, embeddings=embeddings, metadatas=clean)

    def query(
        self,
        purpose: str,
        model: str,
        embedding: list[float],
        k: int,
        where: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        col = self.collection(purpose, model)
        count = col.count()
        if count == 0:
            return []
        res = col.query(
            query_embeddings=[embedding],
            n_results=min(k, count),
            where=where or None,
            include=["metadatas", "distances"],
        )
        out: list[dict[str, Any]] = []
        ids = (res.get("ids") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        for i, id_ in enumerate(ids):
            dist = float(dists[i]) if i < len(dists) else 1.0
            out.append(
                {
                    "id": id_,
                    "distance": dist,
                    "score": max(0.0, 1.0 - dist),  # cosine similarity
                    "metadata": metas[i] if i < len(metas) else {},
                }
            )
        return out

    def delete(self, purpose: str, *, ids: list[str] | None = None, where: dict[str, Any] | None = None) -> None:
        """Delete from every model-specific collection of ``purpose``."""
        prefix = f"lba_{purpose}__"
        for col_info in self.client.list_collections():
            name = col_info if isinstance(col_info, str) else col_info.name
            if not name.startswith(prefix):
                continue
            col = self.client.get_collection(name=name, embedding_function=None)
            if ids:
                col.delete(ids=ids)
            elif where:
                col.delete(where=where)

    def count(self, purpose: str, model: str) -> int:
        return int(self.collection(purpose, model).count())

    def heartbeat(self) -> int:
        return int(self.client.heartbeat())

    def list_collections(self) -> list[dict[str, Any]]:
        out = []
        for col_info in self.client.list_collections():
            name = col_info if isinstance(col_info, str) else col_info.name
            col = self.client.get_collection(name=name, embedding_function=None)
            out.append({"name": name, "count": col.count()})
        return out
