"""Shared fixtures.

Unit tests use ``FakeOllama`` – an httpx transport that implements the subset of the
Ollama HTTP API the backend uses. Its embeddings are deterministic bag-of-words
vectors, so semantic retrieval is genuinely exercised (similar texts → similar vectors).

Integration tests (tests/integration) talk to a REAL local Ollama and are skipped
with a clear reason when it is not reachable.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import EnvSettings
from app.main import create_app

CHAT_MODEL = "fake-chat:1b"
EMBED_MODEL = "fake-embed:latest"
ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
DIM = 64


def bow_embedding(text: str) -> list[float]:
    vec = [0.0] * DIM
    for tok in re.findall(r"[a-z0-9]+", text.lower()):
        if len(tok) < 3:
            continue
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        vec[h % DIM] += 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


class FakeOllama(httpx.AsyncBaseTransport):
    """Minimal Ollama API: /api/version, /api/tags, /api/show, /api/chat, /api/embed, /api/pull."""

    def __init__(self) -> None:
        self.up = True
        self.models = [
            {"name": CHAT_MODEL, "model": CHAT_MODEL, "size": 1_300_000_000,
             "details": {"family": "fake", "parameter_size": "1B", "quantization_level": "Q4_K_M"},
             "capabilities": ["completion"]},
            {"name": EMBED_MODEL, "model": EMBED_MODEL, "size": 270_000_000,
             "details": {"family": "nomic-bert", "parameter_size": "137M", "quantization_level": "F16"},
             "capabilities": ["embedding"]},
        ]
        self.reply = "Hello from the fake model."
        # Optional hook: (schema, messages) -> dict for structured (format=...) requests.
        self.json_reply: Callable[[dict[str, Any], list[dict[str, Any]]], dict[str, Any]] | None = None
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def chat_requests(self) -> list[dict[str, Any]]:
        return [b for p, b in self.requests if p == "/api/chat"]

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not self.up:
            raise httpx.ConnectError("connection refused", request=request)
        path = request.url.path
        body: dict[str, Any] = {}
        if request.content:
            try:
                body = json.loads(request.content)
            except json.JSONDecodeError:
                body = {}
        self.requests.append((path, body))
        names = {m["name"] for m in self.models}

        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.0.0-fake"})
        if path == "/api/tags":
            return httpx.Response(200, json={"models": self.models})
        if path == "/api/show":
            m = next((x for x in self.models if x["name"] == body.get("model")), None)
            if not m:
                return httpx.Response(404, json={"error": f"model '{body.get('model')}' not found"})
            return httpx.Response(200, json={"details": m["details"], "capabilities": m["capabilities"], "model_info": {}})
        if path == "/api/embed":
            if body.get("model") not in names:
                return httpx.Response(404, json={"error": f"model \"{body.get('model')}\" not found, try pulling it first"})
            inputs = body.get("input") or []
            if isinstance(inputs, str):
                inputs = [inputs]
            return httpx.Response(200, json={"model": body["model"], "embeddings": [bow_embedding(t) for t in inputs]})
        if path == "/api/chat":
            if body.get("model") not in names:
                return httpx.Response(404, json={"error": f"model \"{body.get('model')}\" not found, try pulling it first"})
            fmt = body.get("format")
            if isinstance(fmt, dict):
                content = json.dumps(self._structured(fmt, body.get("messages", [])))
            else:
                content = self.reply
            stats = {"total_duration": 1_000_000, "load_duration": 10, "eval_count": 5, "prompt_eval_count": 12}
            if body.get("stream"):
                words = re.findall(r"\S+\s*", content) or [content]
                lines = [json.dumps({"model": body["model"], "message": {"role": "assistant", "content": w}, "done": False}) for w in words]
                lines.append(json.dumps({"model": body["model"], "message": {"role": "assistant", "content": ""}, "done": True, **stats}))
                return httpx.Response(200, content=("\n".join(lines) + "\n").encode(), headers={"content-type": "application/x-ndjson"})
            return httpx.Response(200, json={"model": body["model"], "message": {"role": "assistant", "content": content}, "done": True, **stats})
        if path == "/api/pull":
            lines = [json.dumps({"status": "pulling manifest"}), json.dumps({"status": "downloading", "total": 100, "completed": 100}), json.dumps({"status": "success"})]
            return httpx.Response(200, content=("\n".join(lines) + "\n").encode())
        return httpx.Response(404, json={"error": "not found"})

    def _structured(self, schema: dict[str, Any], messages: list[dict[str, Any]]) -> dict[str, Any]:
        if self.json_reply:
            return self.json_reply(schema, messages)
        props = schema.get("properties", {})
        if "memories" in props:
            return {"memories": []}
        if "actions" in props:
            return {"task": "noop", "actions": []}
        if "fields" in props:
            return {"fields": []}
        return {}


@pytest.fixture()
def fake() -> FakeOllama:
    return FakeOllama()


@pytest.fixture()
def env(tmp_path: Path) -> EnvSettings:
    return EnvSettings(data_dir=tmp_path / "data", allowed_origins=ORIGIN, ollama_url="http://127.0.0.1:11434", _env_file=None)  # type: ignore[call-arg]


@pytest.fixture()
def client(env: EnvSettings, fake: FakeOllama) -> Iterator[TestClient]:
    app = create_app(env, transport=fake, autoselect=False)
    with TestClient(app) as c:
        token = app.state.api_token
        c.headers.update({"Authorization": f"Bearer {token}"})
        c.put("/api/v1/settings", json={"chat_model": CHAT_MODEL, "embedding_model": EMBED_MODEL, "min_relevance": 0.1}).raise_for_status()
        yield c


@pytest.fixture()
def anon(env: EnvSettings, fake: FakeOllama) -> Iterator[TestClient]:
    """Client without the Authorization header."""
    app = create_app(env, transport=fake, autoselect=False)
    with TestClient(app) as c:
        yield c


def sse_events(text: str) -> list[tuple[str, Any]]:
    """Parse an SSE body into (event, data) tuples."""
    out: list[tuple[str, Any]] = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        ev, data = "message", []
        for line in block.split("\n"):
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
        if data:
            raw = "\n".join(data)
            try:
                out.append((ev, json.loads(raw)))
            except json.JSONDecodeError:
                out.append((ev, raw))
    return out
