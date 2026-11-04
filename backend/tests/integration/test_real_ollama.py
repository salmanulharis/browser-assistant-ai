"""End-to-end tests against a REAL local Ollama server (no mocks).

Skipped – never reported as passed – when Ollama is unreachable or has no suitable
chat/embedding model. Override the models with LBA_TEST_CHAT_MODEL / LBA_TEST_EMBED_MODEL.

    pytest tests/integration -m integration -v
"""

from __future__ import annotations

import io
import os
import re
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import EnvSettings
from app.main import create_app
from tests.conftest import sse_events

pytestmark = pytest.mark.integration

OLLAMA = os.environ.get("LBA_TEST_OLLAMA_URL", "http://127.0.0.1:11434")
API = "/api/v1"


def _discover() -> tuple[str, str] | str:
    try:
        tags = httpx.get(f"{OLLAMA}/api/tags", timeout=3, trust_env=False).json()
    except Exception as exc:
        return f"Ollama is not reachable at {OLLAMA} ({exc.__class__.__name__}). Start Ollama to run integration tests."
    models = tags.get("models", [])
    is_embed = lambda m: "embedding" in (m.get("capabilities") or []) or re.search(r"embed|bge|minilm|e5-", m["name"])  # noqa: E731
    chat = os.environ.get("LBA_TEST_CHAT_MODEL") or next((m["name"] for m in models if not is_embed(m)), None)
    emb = os.environ.get("LBA_TEST_EMBED_MODEL") or next((m["name"] for m in models if is_embed(m)), None)
    if not chat:
        return "No chat model installed in Ollama (e.g. `ollama pull qwen3:4b-instruct`)."
    if not emb:
        return "No embedding model installed in Ollama (e.g. `ollama pull nomic-embed-text`)."
    return chat, emb


_FOUND = _discover()
if isinstance(_FOUND, str):
    pytest.skip(_FOUND, allow_module_level=True)
CHAT, EMBED = _FOUND  # type: ignore[misc]


@pytest.fixture(scope="module")
def real(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    data: Path = tmp_path_factory.mktemp("lba-int")
    env = EnvSettings(data_dir=data, ollama_url=OLLAMA, allowed_origins="chrome-extension://abcdefghijklmnopabcdefghijklmnop", _env_file=None)  # type: ignore[call-arg]
    app = create_app(env, autoselect=False)
    with TestClient(app) as c:
        c.headers["Authorization"] = f"Bearer {app.state.api_token}"
        c.put(f"{API}/settings", json={"chat_model": CHAT, "embedding_model": EMBED, "temperature": 0, "think": False}).raise_for_status()
        yield c


def test_discovery_and_model_tests(real: TestClient) -> None:
    d = real.get(f"{API}/models").json()
    assert d["reachable"] and d["version"]
    names = [m["name"] for m in d["models"]]
    assert CHAT in names and EMBED in names
    emb = real.post(f"{API}/models/test", json={"model": EMBED, "kind": "embedding"}).json()
    assert emb["ok"], emb


def test_streaming_chat(real: TestClient) -> None:
    with real.stream("POST", f"{API}/chat/stream", json={"message": "Reply with exactly the word: pineapple", "context": {"page": False, "memory": False, "knowledge": False, "history": False, "samples": False}}) as r:
        assert r.status_code == 200
        events = sse_events("".join(r.iter_text()))
    names = [e for e, _ in events]
    assert "error" not in names, events
    assert names.count("delta") >= 1 and "done" in names
    text = "".join(d.get("text", "") for e, d in events if e == "delta" and isinstance(d, dict))
    assert "pineapple" in text.lower()


def test_full_flow_page_memory_document_form(real: TestClient) -> None:
    """Read page → ask → memory retrieval → document retrieval → form content generation."""
    # webpage question
    page = {"url": "https://shop.example.com/kettle", "title": "Steel Kettle K-200",
            "main_text": "The K-200 kettle holds 1.7 litres and boils water in 3 minutes. Warranty: 2 years.",
            "paragraphs": ["The K-200 kettle holds 1.7 litres and boils water in 3 minutes.", "Warranty: 2 years."]}
    a = real.post(f"{API}/chat", json={"message": "What is the capacity of this kettle?", "page": page}).json()
    assert "1.7" in a["content"], a["content"]
    assert any(s["type"] == "page" for s in a["sources"])

    # saved memory
    real.post(f"{API}/memory", json={"content": "My name is Meera Iyer and I have 7 years of experience as a data engineer.", "category": "profile"}).raise_for_status()
    m = real.post(f"{API}/chat", json={"message": "How many years of experience do I have as a data engineer?", "context": {"page": False}}).json()
    assert any(s["type"] == "memory" for s in m["sources"]), m["sources"]
    assert re.search(r"\b7\b|seven", m["content"].lower()), m["content"]

    # document knowledge
    doc = b"# Office handbook\n\nThe office Wi-Fi network is called ORCHID-5G. Visitors must sign in at reception on floor 3."
    up = real.post(f"{API}/knowledge/upload?wait=true", files=[("files", ("handbook.md", io.BytesIO(doc)))]).json()
    assert up["documents"][0]["status"] == "indexed", up
    k = real.post(f"{API}/chat", json={"message": "What is the office Wi-Fi network called?", "context": {"page": False}}).json()
    assert any(s["type"] == "document" for s in k["sources"]), k["sources"]
    assert "orchid" in k["content"].lower(), k["content"]

    # form content generation using memory; password field must be skipped
    fields = [
        {"ref": "n1", "tag": "input", "type": "text", "name": "full_name", "label": "Full name", "placeholder": "", "autocomplete": "", "required": True, "max_length": None, "options": [], "nearby_text": "", "has_value": False, "sensitive": None},
        {"ref": "y1", "tag": "input", "type": "text", "name": "years", "label": "Years of experience", "placeholder": "", "autocomplete": "", "required": True, "max_length": None, "options": [], "nearby_text": "", "has_value": False, "sensitive": None},
        {"ref": "p1", "tag": "input", "type": "password", "name": "password", "label": "Password", "placeholder": "", "autocomplete": "", "required": True, "max_length": None, "options": [], "nearby_text": "", "has_value": False, "sensitive": "password field"},
    ]
    f = real.post(f"{API}/forms/generate", json={"url": "https://jobs.example.com/apply", "title": "Apply", "fields": fields}).json()
    by = {s["ref"]: s["value"] for s in f["suggestions"]}
    assert "p1" not in by and any(x["ref"] == "p1" for x in f["skipped"])
    assert "meera" in by.get("n1", "").lower(), f
    assert "7" in by.get("y1", "") or "seven" in by.get("y1", "").lower(), f


def test_agent_plan_against_real_model(real: TestClient) -> None:
    elements = [
        {"ref": "e1", "tag": "input", "type": "text", "label": "City"},
        {"ref": "e2", "tag": "button", "type": "submit", "text": "Submit"},
    ]
    r = real.post(f"{API}/agent/plan", json={"task": "Type Chennai into the City field", "url": "https://forms.example.com/x", "elements": elements})
    assert r.status_code == 200, r.text
    task = r.json()
    for a in task["plan"]["actions"]:
        assert not (a.get("type") == "click" and (a.get("target") or {}).get("ref") == "e2"), "submit click must be blocked"
    assert any(a.get("type") in ("type", "fill") and (a.get("target") or {}).get("ref") == "e1" for a in task["plan"]["actions"]), task


def test_full_diagnostics(real: TestClient) -> None:
    d = real.post(f"{API}/diagnostics/run", json={"level": "full"}).json()
    by = {r["id"]: r["status"] for r in d["results"]}
    for cid in ("ollama.reachable", "ollama.models", "ollama.chat_model", "ollama.embedding_model", "ollama.embed_api", "ollama.chat_api", "ollama.stream"):
        assert by[cid] == "healthy", (cid, d["results"])
    assert d["summary"]["failed"] == 0
