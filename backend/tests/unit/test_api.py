"""API tests against the real FastAPI app, real SQLite + ChromaDB (temp dir) and a fake Ollama transport."""

from __future__ import annotations

import io
import json
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import CHAT_MODEL, EMBED_MODEL, ORIGIN, FakeOllama, sse_events

API = "/api/v1"


# ------------------------------------------------------------------ auth/CORS
class TestAuth:
    def test_health_is_public_and_minimal(self, anon: TestClient) -> None:
        r = anon.get(f"{API}/health")
        assert r.status_code == 200
        assert set(r.json()) <= {"status", "app", "version", "api_version", "time"}

    def test_protected_endpoints_require_token(self, anon: TestClient) -> None:
        for path in ("/settings", "/memory", "/knowledge", "/conversations", "/diagnostics"):
            r = anon.get(f"{API}{path}")
            assert r.status_code == 401, path
            assert r.json()["error"]["code"]
        assert anon.get(f"{API}/settings", headers={"Authorization": "Bearer wrong"}).status_code == 401

    def test_pairing_only_for_allow_listed_origin(self, anon: TestClient) -> None:
        bad = anon.post(f"{API}/auth/pair", headers={"Origin": "https://evil.example"})
        assert bad.status_code == 403
        none = anon.post(f"{API}/auth/pair")
        assert none.status_code == 403
        ok = anon.post(f"{API}/auth/pair", headers={"Origin": ORIGIN})
        assert ok.status_code == 200 and len(ok.json()["token"]) >= 40

    def test_cors_exact_origin(self, anon: TestClient) -> None:
        pre = anon.options(f"{API}/chat/stream", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
        assert pre.status_code == 200
        assert pre.headers["access-control-allow-origin"] == ORIGIN
        other = anon.options(f"{API}/chat/stream", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        assert other.headers.get("access-control-allow-origin") != "https://evil.example"


# ---------------------------------------------------------------- settings
class TestSettings:
    def test_roundtrip_and_validation(self, client: TestClient) -> None:
        s = client.get(f"{API}/settings").json()
        assert s["chat_model"] == CHAT_MODEL and s["rag_top_k"] == 5 and s["chunk_size_tokens"] == 700
        r = client.put(f"{API}/settings", json={"temperature": 0.9, "rag_top_k": 7})
        assert r.status_code == 200 and r.json()["temperature"] == 0.9
        bad = client.put(f"{API}/settings", json={"temperature": 5})
        assert bad.status_code == 422 and "error" in bad.json()
        unknown = client.put(f"{API}/settings", json={"nope": 1})
        assert unknown.status_code == 422

    def test_local_only_rejects_remote_ollama(self, client: TestClient) -> None:
        r = client.put(f"{API}/settings", json={"ollama_url": "https://api.example.com"})
        assert r.status_code in (400, 422)


# ------------------------------------------------------------------ models
class TestModels:
    def test_discovery(self, client: TestClient) -> None:
        d = client.get(f"{API}/models").json()
        assert d["reachable"] and d["version"] == "0.0.0-fake"
        by = {m["name"]: m for m in d["models"]}
        assert by[CHAT_MODEL]["kind"] == "chat" and by[EMBED_MODEL]["kind"] == "embedding"
        assert by[CHAT_MODEL]["quantization"] == "Q4_K_M" and "chat" in by[CHAT_MODEL]["selected_as"]

    def test_model_test_endpoint(self, client: TestClient) -> None:
        r = client.post(f"{API}/models/test", json={"model": CHAT_MODEL, "kind": "chat"}).json()
        assert r["ok"] and r["duration_ms"] >= 0 and "fake model" in r["result"]
        e = client.post(f"{API}/models/test", json={"model": EMBED_MODEL, "kind": "embedding"}).json()
        assert e["ok"]

    def test_pull_requires_confirmation(self, client: TestClient) -> None:
        r = client.post(f"{API}/models/pull", json={"model": "qwen3:4b", "confirm": False})
        assert r.status_code == 428

    def test_unreachable_ollama_is_reported(self, client: TestClient, fake: FakeOllama) -> None:
        fake.up = False
        d = client.get(f"{API}/models").json()
        assert d["reachable"] is False and d["error"]["code"]


# ------------------------------------------------------------------ chat
class TestChat:
    PAGE = {"url": "https://docs.example.com/guide", "title": "Guide", "main_text": "The retry limit is configured with MAX_RETRIES and defaults to three.",
            "paragraphs": ["The retry limit is configured with MAX_RETRIES and defaults to three."]}

    def test_non_streaming_chat_persists_conversation(self, client: TestClient, fake: FakeOllama) -> None:
        r = client.post(f"{API}/chat", json={"message": "What is the retry limit?", "page": self.PAGE})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["content"] == fake.reply and body["model"] == CHAT_MODEL
        assert any(s["type"] == "page" for s in body["sources"])
        conv = client.get(f"{API}/conversations/{body['conversation_id']}").json()
        assert [m["role"] for m in conv["messages"]] == ["user", "assistant"]
        # page content reached the model, marked as untrusted data
        sent = json.dumps(fake.chat_requests()[-1]["messages"])
        assert "MAX_RETRIES" in sent

    def test_streaming_events(self, client: TestClient, fake: FakeOllama) -> None:
        fake.reply = "Three retries [S1]. Also [S7]."
        with client.stream("POST", f"{API}/chat/stream", json={"message": "retry limit?", "page": self.PAGE}) as r:
            assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
            text = "".join(r.iter_text())
        events = sse_events(text)
        names = [e for e, _ in events]
        assert names[0] == "meta" and "delta" in names and "done" in names
        streamed = "".join(d["text"] if isinstance(d, dict) and "text" in d else "" for e, d in events if e == "delta")
        assert "Three retries" in streamed
        done = next(d for e, d in events if e == "done")
        assert "S7" in done.get("invalid_citations", [])  # fabricated citation flagged

    def test_history_is_not_sent_in_full(self, client: TestClient, fake: FakeOllama) -> None:
        cid = None
        for i in range(14):
            r = client.post(f"{API}/chat", json={"message": f"message number {i}", "conversation_id": cid, "context": {"page": False}}).json()
            cid = r["conversation_id"]
        msgs = fake.chat_requests()[-1]["messages"]
        assert len([m for m in msgs if m["role"] in ("user", "assistant")]) <= 8 + 1

    def test_ollama_down_gives_structured_error(self, client: TestClient, fake: FakeOllama) -> None:
        fake.up = False
        r = client.post(f"{API}/chat", json={"message": "hi"})
        assert r.status_code in (502, 503)
        err = r.json()["error"]
        assert err["code"] and err["message"] and err.get("hint")

    def test_missing_model_error(self, client: TestClient) -> None:
        r = client.post(f"{API}/chat", json={"message": "hi", "model": "does-not-exist:7b"})
        assert r.status_code in (404, 502) and "not" in r.json()["error"]["message"].lower()

    def test_assist_stream(self, client: TestClient) -> None:
        with client.stream("POST", f"{API}/assist/stream", json={"action": "summarize", "text": "Long text " * 20}) as r:
            text = "".join(r.iter_text())
        assert "done" in [e for e, _ in sse_events(text)]


# ------------------------------------------------------------------ memory
class TestMemory:
    def test_crud_search_and_policies(self, client: TestClient) -> None:
        a = client.post(f"{API}/memory", json={"content": "I have six years of Python and FastAPI backend experience.", "category": "skills"})
        assert a.status_code == 201, a.text
        client.post(f"{API}/memory", json={"content": "I prefer concise answers in British English.", "category": "preferences"})
        client.post(f"{API}/memory", json={"content": "My cat is called Pixel.", "category": "profile"})
        hits = client.post(f"{API}/memory/search", json={"query": "python backend experience"}).json()
        assert hits and "Python" in hits[0]["memory"]["content"]

        mid = a.json()["id"]
        upd = client.patch(f"{API}/memory/{mid}", json={"pinned": True, "content": "I have seven years of Python and FastAPI backend experience."}).json()
        assert upd["pinned"] and "seven" in upd["content"]
        assert client.patch(f"{API}/memory/{mid}", json={"status": "disabled"}).json()["status"] == "disabled"
        hits2 = client.post(f"{API}/memory/search", json={"query": "python backend experience"}).json()
        assert all(h["memory"]["id"] != mid for h in hits2)  # disabled memories are not retrieved

        sens = client.post(f"{API}/memory", json={"content": "my password is hunter2"})
        assert sens.status_code == 422 and sens.json()["error"]["code"] == "SENSITIVE_CONTENT"

        exp = client.get(f"{API}/memory/export").json()
        assert len(exp["memories"]) == 3
        assert client.delete(f"{API}/memory/{mid}").status_code == 204
        assert client.get(f"{API}/memory/{mid}").status_code == 404
        imp = client.post(f"{API}/memory/import", json={"memories": exp["memories"]}).json()
        assert imp["imported"] == 1  # the deleted one comes back, duplicates skipped

    def test_memory_used_in_chat(self, client: TestClient, fake: FakeOllama) -> None:
        client.post(f"{API}/memory", json={"content": "My employer is Northwind Logistics.", "category": "profile"})
        r = client.post(f"{API}/chat", json={"message": "Who is my employer Northwind?", "context": {"page": False}}).json()
        assert any(s["type"] == "memory" for s in r["sources"])
        assert "Northwind Logistics" in json.dumps(fake.chat_requests()[-1]["messages"])


# --------------------------------------------------------------- knowledge
def _upload(client: TestClient, name: str, data: bytes, collection: str = "default") -> dict[str, Any]:
    r = client.post(f"{API}/knowledge/upload?wait=true", files=[("files", (name, io.BytesIO(data)))], data={"collection": collection})
    assert r.status_code == 201, r.text
    return r.json()


class TestKnowledge:
    def test_upload_index_search_cite_delete(self, client: TestClient, fake: FakeOllama) -> None:
        r = _upload(client, "handbook.md", b"# Leave policy\n\nEmployees receive twenty four vacation days per year.\n\n# Expenses\n\nSubmit expense receipts within thirty days.")
        doc = r["documents"][0]
        assert doc["status"] == "indexed" and doc["chunk_count"] >= 1 and doc["embedded_model"] == EMBED_MODEL
        _upload(client, "recipes.txt", b"Boil pasta for nine minutes and add garlic butter sauce.")

        hits = client.post(f"{API}/knowledge/search", json={"query": "how many vacation days do employees get"}).json()
        assert hits and hits[0]["document_name"] == "handbook.md"

        chat = client.post(f"{API}/chat", json={"message": "How many vacation days do employees get?", "context": {"page": False}}).json()
        assert any(s["type"] == "document" and s["title"].startswith("handbook") for s in chat["sources"])

        dup = _upload(client, "handbook-copy.md", b"# Leave policy\n\nEmployees receive twenty four vacation days per year.\n\n# Expenses\n\nSubmit expense receipts within thirty days.")
        assert dup["documents"][0]["duplicate"] is True

        detail = client.get(f"{API}/knowledge/{doc['id']}").json()
        assert detail["preview"]
        assert client.post(f"{API}/knowledge/{doc['id']}/reindex").json()["status"] == "indexed"
        assert client.delete(f"{API}/knowledge/{doc['id']}").status_code == 204
        hits = client.post(f"{API}/knowledge/search", json={"query": "vacation days employees"}).json()
        assert all(h["document_id"] != doc["id"] for h in hits)  # vectors removed too
        diag = client.post(f"{API}/diagnostics/run", json={"level": "basic", "checks": ["storage.index"]}).json()
        assert diag["results"][0]["status"] == "healthy"

    def test_rejections(self, client: TestClient) -> None:
        bad = _upload(client, "evil.exe", b"MZ....")
        assert bad["errors"][0]["code"] == "UNSUPPORTED_FILE_TYPE"
        fake_pdf = _upload(client, "fake.pdf", b"hello")
        assert fake_pdf["documents"][0]["status"] == "failed"
        trav = _upload(client, "../../outside.txt", b"traversal attempt content")
        assert trav["documents"][0]["original_name"] == "outside.txt"

    def test_collections_and_save_page(self, client: TestClient) -> None:
        _upload(client, "a.txt", b"alpha content about rockets", collection="space")
        r = client.post(f"{API}/knowledge/save-page", json={"url": "https://example.com/x", "title": "Example", "content": "Saved page body about rockets and engines.", "collection": "space"})
        assert r.status_code == 201
        cols = {c["name"]: c for c in client.get(f"{API}/knowledge/collections").json()}
        assert cols["space"]["document_count"] == 2


# ----------------------------------------------------------- agent / forms
class TestAgent:
    ELEMENTS = [
        {"ref": "f1", "tag": "input", "type": "text", "label": "Full name"},
        {"ref": "f2", "tag": "input", "type": "password", "label": "Password"},
        {"ref": "b1", "tag": "button", "type": "submit", "text": "Submit"},
    ]

    def test_plan_is_validated_and_logged(self, client: TestClient, fake: FakeOllama) -> None:
        fake.json_reply = lambda schema, msgs: {"task": "fill name", "actions": [
            {"type": "fill", "target": {"ref": "f1"}, "value": "Asha Rao", "reason": "name"},
            {"type": "fill", "target": {"ref": "f2"}, "value": "x", "reason": "pw"},
            {"type": "click", "target": {"ref": "b1"}, "reason": "submit"},
            {"type": "run_js", "value": "alert(1)"},
        ]}
        r = client.post(f"{API}/agent/plan", json={"task": "Fill my name", "url": "https://forms.example.com/a", "elements": self.ELEMENTS})
        assert r.status_code == 200, r.text
        task = r.json()
        assert [a["target"]["ref"] for a in task["plan"]["actions"]] == ["f1"]
        assert len(task["blocked"]) >= 2
        res = client.post(f"{API}/agent/tasks/{task['id']}/result", json={"status": "completed", "results": [{"index": 0, "status": "success", "message": "filled"}]})
        assert res.status_code == 200 and res.json()["status"] == "completed"
        got = client.get(f"{API}/agent/tasks/{task['id']}").json()
        assert got["logs"]

    def test_form_generation_skips_sensitive_fields(self, client: TestClient, fake: FakeOllama) -> None:
        fake.json_reply = lambda schema, msgs: {"fields": [{"ref": "f1", "value": "Asha Rao", "confidence": "high", "note": "", "source_ids": []}, {"ref": "f2", "value": "leaked", "confidence": "high"}]}
        fields = [
            {"ref": "f1", "tag": "input", "type": "text", "name": "name", "label": "Full name", "placeholder": "", "autocomplete": "", "required": True, "max_length": None, "options": [], "nearby_text": "", "has_value": False, "sensitive": None},
            {"ref": "f2", "tag": "input", "type": "password", "name": "pw", "label": "Password", "placeholder": "", "autocomplete": "", "required": True, "max_length": None, "options": [], "nearby_text": "", "has_value": False, "sensitive": "password field"},
        ]
        r = client.post(f"{API}/forms/generate", json={"url": "https://forms.example.com/a", "fields": fields})
        assert r.status_code == 200, r.text
        body = r.json()
        assert [s["ref"] for s in body["suggestions"]] == ["f1"]
        assert body["skipped"][0]["ref"] == "f2"
        # the password field was never described to the model, and a value returned for it is dropped
        prompt = " ".join(m["content"] for m in fake.chat_requests()[-1]["messages"])
        assert '"ref": "f1"' in prompt and '"ref": "f2"' not in prompt
        assert all(s["value"] != "leaked" for s in body["suggestions"])


# -------------------------------------------------------- prompts/convs/etc
class TestLibraryAndHistory:
    def test_prompts_crud(self, client: TestClient) -> None:
        seeded = client.get(f"{API}/prompts").json()
        assert seeded  # defaults seeded at startup
        p = client.post(f"{API}/prompts", json={"title": "Intro", "content": "I am a backend engineer.", "kind": "sample", "category": "profile"}).json()
        assert client.patch(f"{API}/prompts/{p['id']}", json={"pinned": True}).json()["pinned"]
        assert client.post(f"{API}/prompts/{p['id']}/use").json()["use_count"] == 1
        assert any(x["id"] == p["id"] for x in client.get(f"{API}/prompts?q=backend").json())
        assert client.delete(f"{API}/prompts/{p['id']}").status_code == 204

    def test_conversations_search_rename_delete(self, client: TestClient) -> None:
        cid = client.post(f"{API}/chat", json={"message": "Tell me about zebras", "context": {"page": False}}).json()["conversation_id"]
        assert client.get(f"{API}/conversations/search?q=zebras").json()
        assert client.patch(f"{API}/conversations/{cid}", json={"title": "Zebras"}).json()["title"] == "Zebras"
        assert client.delete(f"{API}/conversations/{cid}").status_code == 204
        assert client.get(f"{API}/conversations/{cid}").status_code == 404

    def test_backup_and_delete_all(self, client: TestClient) -> None:
        client.post(f"{API}/memory", json={"content": "Remember the launch date is in March."})
        b = client.post(f"{API}/backups")
        assert b.status_code == 201
        assert client.get(f"{API}/backups/{b.json()['name']}").status_code == 200
        assert client.get(f"{API}/backups/..%2F..%2Fapp.db").status_code in (400, 403, 404)
        assert client.post(f"{API}/data/delete-all", json={"confirm": "yes"}).status_code == 428
        r = client.post(f"{API}/data/delete-all", json={"confirm": "DELETE ALL MY DATA"}).json()
        assert r["deleted"] and client.get(f"{API}/memory").json() == []


# -------------------------------------------------------------- diagnostics
class TestDiagnostics:
    def test_full_run_with_fake_ollama(self, client: TestClient) -> None:
        d = client.post(f"{API}/diagnostics/run", json={"level": "full"}).json()
        by = {r["id"]: r for r in d["results"]}
        for cid in ("backend.api", "storage.sqlite", "storage.chroma", "ollama.reachable", "ollama.models", "ollama.chat_model", "ollama.embed_api", "ollama.chat_api", "ollama.stream"):
            assert by[cid]["status"] == "healthy", (cid, by[cid])
        assert by["ollama.vision_model"]["status"] == "not_configured"
        hist = client.get(f"{API}/diagnostics").json()
        assert hist["latest"]["id"] == d["id"]
        assert client.delete(f"{API}/diagnostics/history").json()["deleted"] >= 1

    def test_ollama_down_is_failed_with_guidance(self, client: TestClient, fake: FakeOllama) -> None:
        fake.up = False
        d = client.post(f"{API}/diagnostics/run", json={"level": "basic"}).json()
        by = {r["id"]: r for r in d["results"]}
        assert by["ollama.reachable"]["status"] == "failed"
        assert "not responding" in by["ollama.reachable"]["message"] and by["ollama.reachable"]["hint"]
        assert by["ollama.models"]["status"] == "skipped"
        assert d["summary"]["overall"] == "failed"

    def test_missing_selected_model(self, client: TestClient) -> None:
        client.put(f"{API}/settings", json={"chat_model": "ghost:1b"})
        d = client.post(f"{API}/diagnostics/run", json={"level": "basic", "checks": ["ollama.chat_model"]}).json()
        assert d["results"][0]["status"] == "failed" and "ollama pull ghost:1b" in d["results"][0]["hint"]

    def test_report_has_no_personal_data(self, client: TestClient) -> None:
        client.post(f"{API}/memory", json={"content": "My secret project codename is BLUEFIN."})
        token = client.headers["Authorization"].split()[1]
        rep = json.dumps(client.get(f"{API}/diagnostics/report").json())
        assert "BLUEFIN" not in rep and token not in rep
        assert "python" in rep.lower()

    def test_stream_self_test(self, client: TestClient) -> None:
        with client.stream("GET", f"{API}/diagnostics/stream-test") as r:
            events = sse_events("".join(r.iter_text()))
        assert events[-1][0] == "done"


def test_plan_schema_forces_a_real_target(client: TestClient, fake: FakeOllama) -> None:
    """Small models drop optional fields; the target ref must be required and limited to page refs."""
    seen: dict[str, Any] = {}

    def reply(schema: dict[str, Any], msgs: list[dict[str, Any]]) -> dict[str, Any]:
        seen["schema"] = schema
        return {"task": "t", "actions": [{"type": "fill", "target": {"ref": "f1"}, "value": "Asha", "direction": "top", "reason": "user"}]}

    fake.json_reply = reply
    r = client.post(f"{API}/agent/plan", json={"task": "Fill my name", "url": "https://forms.example.com/a",
                                               "elements": [{"ref": "f1", "tag": "input", "type": "text", "label": "Full name"}]}).json()
    item = seen["schema"]["properties"]["actions"]["items"]
    assert "target" in item["required"]
    assert item["properties"]["target"]["required"] == ["ref"]
    assert item["properties"]["target"]["properties"]["ref"]["enum"] == ["f1", ""]
    action = r["plan"]["actions"][0]
    assert action["target"]["ref"] == "f1" and "direction" not in action  # irrelevant fields dropped
