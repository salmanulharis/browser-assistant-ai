"""Backend-side diagnostics. Lightweight connectivity checks are separate from
inference checks ("full" level) so periodic health checks never run the model."""

from __future__ import annotations

import os
import platform
import shutil
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import delete, func, select, text

from app.core.config import API_VERSION, APP_VERSION
from app.core.context import AppContext
from app.database.base import utcnow
from app.database.migrations import current_version, latest_version
from app.models.entities import DiagnosticResult, DiagnosticRun, Document
from app.schemas.misc import CheckResult
from app.schemas.settings import is_loopback_url
from app.services.ollama import OllamaClient, OllamaError, OllamaTimeout, model_summary

CheckFn = Callable[["DiagContext"], Awaitable[CheckResult]]
MAX_RUNS = 50


class DiagContext:
    """Per-run cache so dependent checks reuse results (e.g. the model list)."""

    def __init__(self, app: AppContext) -> None:
        self.app = app
        self.settings = app.settings.get()
        self.client: OllamaClient = app.ollama(self.settings)
        self.version: str | None = None
        self.version_error: Exception | None = None
        self.models: list[dict[str, Any]] | None = None
        self.models_error: Exception | None = None
        self._version_done = False
        self._models_done = False

    async def get_version(self) -> str | None:
        if not self._version_done:
            self._version_done = True
            try:
                self.version = await self.client.version()
            except Exception as exc:
                self.version_error = exc
        return self.version

    async def get_models(self) -> list[dict[str, Any]] | None:
        if not self._models_done:
            self._models_done = True
            try:
                self.models = await self.client.list_models()
            except Exception as exc:
                self.models_error = exc
        return self.models


def R(id: str, group: str, name: str, status: str, message: str, hint: str | None = None, **details: Any) -> CheckResult:
    return CheckResult(id=id, group=group, name=name, status=status, message=message, hint=hint, details=details)  # type: ignore[arg-type]


def _err(exc: Exception | None) -> tuple[str, str | None]:
    if exc is None:
        return "Unknown error", None
    return getattr(exc, "message", str(exc)), getattr(exc, "hint", None)


def _model_names(models: list[dict[str, Any]]) -> set[str]:
    names: set[str] = set()
    for m in models:
        for k in ("name", "model"):
            if m.get(k):
                names.add(m[k])
                if m[k].endswith(":latest"):
                    names.add(m[k][: -len(":latest")])
    return names


# ======================================================================
# Backend & storage checks
# ======================================================================
async def c_backend_api(d: DiagContext) -> CheckResult:
    return R("backend.api", "backend", "FastAPI backend", "healthy",
             f"Backend {APP_VERSION} (API {API_VERSION}) is running.",
             version=APP_VERSION, api_version=API_VERSION, python=sys.version.split()[0],
             os=f"{platform.system()} {platform.release()}",
             uptime_s=round((datetime.now(UTC) - d.app.started_at).total_seconds()))


async def c_backend_config(d: DiagContext) -> CheckResult:
    env = d.app.env
    if env.host not in {"127.0.0.1", "localhost", "::1"}:
        return R("backend.config", "backend", "Backend configuration", "failed",
                 f"Backend bound to non-loopback host {env.host}.", "Set LBA_HOST=127.0.0.1.")
    return R("backend.config", "backend", "Backend configuration", "healthy",
             f"Bound to {env.host}:{env.port} (localhost only).", host=env.host, port=env.port,
             max_upload_mb=env.max_upload_mb)


async def c_backend_auth(d: DiagContext) -> CheckResult:
    tok = d.app.api_token
    if not tok or len(tok) < 32:
        return R("backend.auth", "backend", "API authentication", "failed", "API token is missing or too short.",
                 "Re-run scripts/install.ps1 to generate a token.")
    return R("backend.auth", "backend", "API authentication", "healthy",
             "Token authentication is enforced and this request was authenticated.")


async def c_backend_cors(d: DiagContext) -> CheckResult:
    origins = d.app.env.origins
    raw = d.app.env.allowed_origins
    if "*" in raw:
        return R("backend.cors", "backend", "CORS configuration", "failed",
                 "Wildcard origins are configured – they are ignored for security.",
                 "Set LBA_ALLOWED_ORIGINS to the exact chrome-extension://<id> origin.")
    if not origins:
        return R("backend.cors", "backend", "CORS configuration", "warning",
                 "No extension origin is allow-listed; browsers will block extension requests.",
                 "Run scripts/build.ps1 (it writes LBA_ALLOWED_ORIGINS to backend/.env) and restart the backend.")
    bad = [o for o in origins if not (o.startswith("chrome-extension://") or o.startswith("http://127.0.0.1") or o.startswith("http://localhost"))]
    if bad:
        return R("backend.cors", "backend", "CORS configuration", "warning",
                 f"Unexpected non-extension origins allowed: {', '.join(bad)}", "Remove origins you don't need.",
                 origins=origins)
    return R("backend.cors", "backend", "CORS configuration", "healthy",
             f"{len(origins)} exact origin(s) allowed.", origins=origins)


def _writable(path: Any) -> tuple[bool, str]:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".probe-{uuid.uuid4().hex}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True, ""
    except OSError as exc:
        return False, str(exc)


async def c_storage_dirs(d: DiagContext) -> CheckResult:
    env = d.app.env
    problems = []
    for label, p in (("data", env.data_dir), ("documents", env.documents_dir), ("backups", env.backups_dir), ("logs", env.logs_dir)):
        ok, err = _writable(p)
        if not ok:
            problems.append(f"{label} directory ({p}): {err}")
    if problems:
        return R("storage.dirs", "storage", "Storage directories", "failed", "; ".join(problems),
                 "Check folder permissions or set LBA_DATA_DIR to a writable location. No data was changed.")
    return R("storage.dirs", "storage", "Storage directories", "healthy",
             "Data, documents, backups and logs directories are writable.", data_dir=str(env.data_dir))


async def c_storage_sqlite(d: DiagContext) -> CheckResult:
    db = d.app.db
    if not db.path.exists():
        return R("storage.sqlite", "storage", "SQLite database", "failed", f"Database file not found at {db.path}.",
                 "Run scripts/install.ps1 or start the backend once to initialise it.")
    try:
        with db.engine.begin() as conn:
            conn.execute(text("SELECT 1")).scalar()
            conn.execute(text("CREATE TEMP TABLE IF NOT EXISTS _diag_probe (x INTEGER)"))
            conn.execute(text("INSERT INTO _diag_probe VALUES (1)"))
            conn.execute(text("DROP TABLE _diag_probe"))
            quick = conn.execute(text("PRAGMA quick_check")).scalar()
        # real write to the main DB file inside a rolled-back transaction
        with db.engine.connect() as conn:
            trans = conn.begin()
            conn.execute(text("INSERT INTO settings (key, value, updated_at) VALUES ('__diag_probe', '1', CURRENT_TIMESTAMP)"))
            trans.rollback()
    except Exception as exc:
        return R("storage.sqlite", "storage", "SQLite database", "failed", f"Database read/write failed: {exc}",
                 "Make sure no other program locks the file and the disk is not full. Your data was not modified.")
    ver, latest = current_version(db), latest_version()
    size = db.path.stat().st_size
    if quick != "ok":
        return R("storage.sqlite", "storage", "SQLite database", "failed", f"Integrity check reported: {quick}",
                 "Restore from a backup (scripts/backup.ps1 -Restore). The app never repairs data automatically.")
    if ver < latest:
        return R("storage.sqlite", "storage", "SQLite database", "warning", f"Schema version {ver} < {latest}.",
                 "Restart the backend to apply migrations.")
    return R("storage.sqlite", "storage", "SQLite database", "healthy",
             f"Readable, writable, integrity OK (schema v{ver}, {size / 1e6:.1f} MB).", schema_version=ver, size_bytes=size)


async def c_storage_chroma(d: DiagContext) -> CheckResult:
    try:
        d.app.vectors.heartbeat()
        cols = d.app.vectors.list_collections()
    except Exception as exc:
        return R("storage.chroma", "storage", "ChromaDB vector store", "failed", f"ChromaDB is unavailable: {exc}",
                 "Check the chroma folder in the data directory. Restore it from backup or re-index documents.")
    return R("storage.chroma", "storage", "ChromaDB vector store", "healthy",
             f"Available with {len(cols)} collection(s), {sum(c['count'] for c in cols)} vectors.", collections=cols)


async def c_storage_disk(d: DiagContext) -> CheckResult:
    usage = shutil.disk_usage(d.app.env.data_dir)
    free_gb = usage.free / 1e9
    details = {"free_gb": round(free_gb, 2), "total_gb": round(usage.total / 1e9, 1)}
    if free_gb < 0.2:
        return R("storage.disk", "storage", "Disk space", "failed", f"Only {free_gb:.2f} GB free.", "Free up disk space.", **details)
    if free_gb < 2:
        return R("storage.disk", "storage", "Disk space", "warning", f"{free_gb:.1f} GB free.", "Indexing and models need space.", **details)
    return R("storage.disk", "storage", "Disk space", "healthy", f"{free_gb:.1f} GB free.", **details)


async def c_storage_index(d: DiagContext) -> CheckResult:
    model = d.settings.embedding_model
    with d.app.db.session() as s:
        total = s.execute(select(func.count(Document.id))).scalar() or 0
        failed = s.execute(select(func.count(Document.id)).where(Document.status == "failed")).scalar() or 0
        stale = 0
        if model:
            stale = s.execute(select(func.count(Document.id)).where(
                Document.status == "indexed", Document.embedded_model != model)).scalar() or 0
    if stale:
        return R("storage.index", "storage", "Knowledge index consistency", "warning",
                 f"{stale} document(s) were indexed with a different embedding model.",
                 "Open Knowledge and re-index them so search uses the current model.", stale=stale, failed=failed)
    if failed:
        return R("storage.index", "storage", "Knowledge index consistency", "warning",
                 f"{failed} document(s) failed to index.", "Open Knowledge to see the error and re-index.", failed=failed)
    return R("storage.index", "storage", "Knowledge index consistency", "healthy", f"{total} document(s), all consistent.")


# ======================================================================
# Ollama checks
# ======================================================================
async def c_ollama_host(d: DiagContext) -> CheckResult:
    url = d.settings.ollama_url
    p = urlparse(url)
    if p.scheme not in {"http", "https"} or not p.hostname:
        return R("ollama.host", "ollama", "Configured Ollama host", "failed", f"'{url}' is not a valid URL.",
                 "Use http://127.0.0.1:11434")
    if d.settings.local_only and not is_loopback_url(url):
        return R("ollama.host", "ollama", "Configured Ollama host", "failed",
                 f"{url} is not local while local-only mode is enabled.", "Use a 127.0.0.1 address.")
    if not is_loopback_url(url):
        return R("ollama.host", "ollama", "Configured Ollama host", "warning",
                 f"{url} is not a loopback address; prompts leave this computer.",
                 "Prefer a local Ollama instance (127.0.0.1).", url=url)
    return R("ollama.host", "ollama", "Configured Ollama host", "healthy", f"{url} (local).", url=url)


async def c_ollama_reachable(d: DiagContext) -> CheckResult:
    t0 = time.perf_counter()
    ver = await d.get_version()
    ms = round((time.perf_counter() - t0) * 1000, 1)
    if ver is None:
        msg, hint = _err(d.version_error)
        host = urlparse(d.settings.ollama_url).netloc
        return R("ollama.reachable", "ollama", "Ollama server reachable", "failed",
                 f"Ollama server is not responding at {host}. ({msg})",
                 hint or "Check that Ollama is installed and running (start the Ollama app or `ollama serve`), "
                 "verify the configured port, then retry.",
                 code=getattr(d.version_error, "code", None))
    last = d.app.ollama_status.last_success
    return R("ollama.reachable", "ollama", "Ollama server reachable", "healthy",
             f"Ollama {ver} responded in {ms} ms with valid JSON.", version=ver, response_ms=ms,
             last_success=last.isoformat() if last else None)


async def c_ollama_models(d: DiagContext) -> CheckResult:
    if await d.get_version() is None:
        return R("ollama.models", "ollama", "Model listing", "skipped", "Skipped – Ollama is unreachable.")
    models = await d.get_models()
    if models is None:
        msg, hint = _err(d.models_error)
        return R("ollama.models", "ollama", "Model listing", "failed", f"Could not list models: {msg}", hint)
    if not models:
        return R("ollama.models", "ollama", "Model listing", "warning", "No models are installed.",
                 "Pull a chat model (e.g. `ollama pull qwen3:4b-instruct`) and an embedding model (`ollama pull nomic-embed-text`).")
    return R("ollama.models", "ollama", "Model listing", "healthy", f"{len(models)} model(s) installed.",
             models=[m.get("name") for m in models])


def _model_check(kind: str, cid: str, label: str, required: bool) -> CheckFn:
    async def check(d: DiagContext) -> CheckResult:
        name = getattr(d.settings, f"{kind}_model")
        if not name:
            status = "not_configured"
            hint = f"Select a {kind} model in Settings → AI." if required else "Optional – set one to enable image understanding."
            return R(cid, "ollama", label, status, f"No {kind} model selected.", hint)
        models = await d.get_models()
        if models is None:
            return R(cid, "ollama", label, "skipped", "Skipped – model list unavailable.")
        if name not in _model_names(models):
            return R(cid, "ollama", label, "failed", f"Model '{name}' is not installed.",
                     f"Install it from Diagnostics/Settings (Pull model) or run `ollama pull {name}`.", model=name)
        info = next((model_summary(m) for m in models if m.get("name") in (name, f"{name}:latest") or m.get("model") == name), {})
        caps = info.get("capabilities") or []
        if kind == "embedding" and caps and "embedding" not in caps:
            return R(cid, "ollama", label, "failed", f"'{name}' is not an embedding model.",
                     "Choose an embedding model such as nomic-embed-text.", model=name, capabilities=caps)
        if kind == "vision" and caps and "vision" not in caps:
            return R(cid, "ollama", label, "warning", f"'{name}' does not advertise vision support.",
                     "Choose a vision-capable model.", model=name, capabilities=caps)
        if kind == "chat" and info.get("kind") == "embedding":
            return R(cid, "ollama", label, "failed", f"'{name}' is an embedding model and cannot chat.",
                     "Choose a chat model.", model=name)
        return R(cid, "ollama", label, "healthy", f"'{name}' is installed.", model=name, **{k: v for k, v in info.items() if k in ("parameter_size", "quantization", "family")})
    return check


async def c_ollama_recent_errors(d: DiagContext) -> CheckResult:
    load = d.app.ollama_status.errors_for("chat") + d.app.ollama_status.errors_for("embedding")
    load = [e for e in load if e["code"] in {"OLLAMA_MODEL_LOAD_FAILED", "OLLAMA_TIMEOUT", "OLLAMA_MODEL_NOT_FOUND"}]
    pulls = d.app.ollama_status.errors_for("pull")
    if not load and not pulls:
        return R("ollama.errors", "ollama", "Model loading / download errors", "healthy", "No model loading or download failures recorded since startup.")
    msgs = [f"{e['code']}: {e['message']}" for e in (load[-3:] + pulls[-3:])]
    return R("ollama.errors", "ollama", "Model loading / download errors", "warning",
             f"{len(load)} loading and {len(pulls)} download failure(s) since startup. Latest: {msgs[-1]}",
             "Check free RAM/VRAM for loading failures; check connectivity/disk space for downloads.", recent=msgs)


# ---------------------------------------------------------------- inference
async def c_embed_api(d: DiagContext) -> CheckResult:
    m = d.settings.embedding_model
    if not m:
        return R("ollama.embed_api", "inference", "Embedding API", "not_configured", "No embedding model selected.", "Select one in Settings → AI.")
    t0 = time.perf_counter()
    try:
        vec = await d.client.embed(m, ["diagnostic embedding test"])
    except OllamaError as exc:
        return R("ollama.embed_api", "inference", "Embedding API", "failed", exc.message, exc.hint, code=exc.code)
    ms = round((time.perf_counter() - t0) * 1000)
    dims = len(vec[0]) if vec and vec[0] else 0
    if not dims:
        return R("ollama.embed_api", "inference", "Embedding API", "failed", "Empty embedding returned.")
    return R("ollama.embed_api", "inference", "Embedding API", "healthy", f"{dims}-dimension embedding in {ms} ms.", dims=dims, response_ms=ms)


async def c_chat_api(d: DiagContext) -> CheckResult:
    m = d.settings.chat_model
    if not m:
        return R("ollama.chat_api", "inference", "Chat API / model usable", "not_configured", "No chat model selected.", "Select one in Settings → AI.")
    t0 = time.perf_counter()
    try:
        resp = await d.client.chat(m, [{"role": "user", "content": "Reply with the single word OK."}],
                                   options={"num_predict": 16, "temperature": 0})
    except OllamaError as exc:
        return R("ollama.chat_api", "inference", "Chat API / model usable", "failed", exc.message, exc.hint, code=exc.code)
    ms = round((time.perf_counter() - t0) * 1000)
    load_ms = round(resp.stats.get("load_duration", 0) / 1e6)
    if not (resp.content.strip() or resp.thinking.strip()):
        return R("ollama.chat_api", "inference", "Chat API / model usable", "warning", f"Model answered with empty text in {ms} ms.",
                 "The model may need a different prompt format; try another model.")
    return R("ollama.chat_api", "inference", "Chat API / model usable", "healthy",
             f"'{m}' responded in {ms} ms (load {load_ms} ms).", response_ms=ms, load_ms=load_ms, reply=resp.content.strip()[:40])


async def c_stream_api(d: DiagContext) -> CheckResult:
    m = d.settings.chat_model
    if not m:
        return R("ollama.stream", "inference", "Streaming responses", "not_configured", "No chat model selected.")
    t0 = time.perf_counter()
    first = None
    chunks = 0
    try:
        async for ch in d.client.chat_stream(m, [{"role": "user", "content": "Count from 1 to 5."}],
                                             options={"num_predict": 24, "temperature": 0}):
            if ch.content or ch.thinking:
                chunks += 1
                if first is None:
                    first = time.perf_counter()
    except OllamaError as exc:
        return R("ollama.stream", "inference", "Streaming responses", "failed", exc.message, exc.hint, code=exc.code)
    if chunks < 2:
        return R("ollama.stream", "inference", "Streaming responses", "warning", f"Only {chunks} chunk(s) streamed.")
    return R("ollama.stream", "inference", "Streaming responses", "healthy",
             f"{chunks} chunks streamed; first token after {round(((first or t0) - t0) * 1000)} ms.", chunks=chunks)


async def c_timeout_handling(d: DiagContext) -> CheckResult:
    m = d.settings.chat_model
    if not m or await d.get_version() is None:
        return R("ollama.timeout", "inference", "Timeout handling", "skipped", "Skipped – needs a reachable server and a chat model.")
    client = OllamaClient(d.settings.ollama_url, timeout=d.settings.request_timeout, generation_timeout=0.001,
                          transport=d.app.ollama_transport)
    try:
        await client.chat(m, [{"role": "user", "content": "Write a long story."}], options={"num_predict": 200})
    except OllamaTimeout:
        return R("ollama.timeout", "inference", "Timeout handling", "healthy", "A deliberately short timeout was detected and reported correctly.")
    except OllamaError as exc:
        return R("ollama.timeout", "inference", "Timeout handling", "warning", f"Unexpected error class: {exc.code}")
    return R("ollama.timeout", "inference", "Timeout handling", "warning", "The request completed faster than the 1 ms test timeout.")


BASIC_CHECKS: list[CheckFn] = [
    c_backend_api, c_backend_config, c_backend_auth, c_backend_cors,
    c_storage_dirs, c_storage_sqlite, c_storage_chroma, c_storage_disk, c_storage_index,
    c_ollama_host, c_ollama_reachable, c_ollama_models,
    _model_check("chat", "ollama.chat_model", "Selected chat model", True),
    _model_check("embedding", "ollama.embedding_model", "Selected embedding model", True),
    _model_check("vision", "ollama.vision_model", "Selected vision model", False),
    c_ollama_recent_errors,
]
FULL_CHECKS: list[CheckFn] = [c_embed_api, c_chat_api, c_stream_api, c_timeout_handling]

CHECK_IDS = {
    "backend.api": c_backend_api, "backend.config": c_backend_config, "backend.auth": c_backend_auth,
    "backend.cors": c_backend_cors, "storage.dirs": c_storage_dirs, "storage.sqlite": c_storage_sqlite,
    "storage.chroma": c_storage_chroma, "storage.disk": c_storage_disk, "storage.index": c_storage_index,
    "ollama.host": c_ollama_host, "ollama.reachable": c_ollama_reachable, "ollama.models": c_ollama_models,
    "ollama.chat_model": BASIC_CHECKS[12], "ollama.embedding_model": BASIC_CHECKS[13],
    "ollama.vision_model": BASIC_CHECKS[14], "ollama.errors": c_ollama_recent_errors,
    "ollama.embed_api": c_embed_api, "ollama.chat_api": c_chat_api, "ollama.stream": c_stream_api,
    "ollama.timeout": c_timeout_handling,
}


def summarize(results: list[CheckResult]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    failed = counts.get("failed", 0)
    warn = counts.get("warning", 0) + counts.get("not_configured", 0) + counts.get("permission_required", 0)
    overall = "failed" if failed else ("warning" if warn else "healthy")
    by_id = {r.id: r.status for r in results}
    return {
        "overall": overall,
        "healthy": counts.get("healthy", 0),
        "warnings": warn,
        "failed": failed,
        "counts": counts,
        "backend": "healthy",
        "ollama": by_id.get("ollama.reachable", "unknown"),
    }


class DiagnosticsService:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx

    async def run(self, level: str = "basic", only: list[str] | None = None) -> dict[str, Any]:
        d = DiagContext(self.ctx)
        if only:
            fns = [CHECK_IDS[c] for c in only if c in CHECK_IDS]
        else:
            fns = BASIC_CHECKS + (FULL_CHECKS if level == "full" else [])
        started = utcnow()
        results: list[CheckResult] = []
        for fn in fns:
            t0 = time.perf_counter()
            try:
                r = await fn(d)
            except Exception as exc:  # a check must never crash the run
                name = fn.__name__.removeprefix("c_")
                r = R(f"check.{name}", "backend", name, "failed", f"Check crashed: {exc}")
            r.duration_ms = round((time.perf_counter() - t0) * 1000, 1)
            results.append(r)
        summary = summarize(results)
        with self.ctx.db.session() as s:
            run = DiagnosticRun(level=level if not only else "partial", started_at=started, finished_at=utcnow(), summary=summary)
            s.add(run)
            s.flush()
            for r in results:
                s.add(DiagnosticResult(run_id=run.id, check_id=r.id, group=r.group, name=r.name, status=r.status,
                                       message=r.message, hint=r.hint, duration_ms=r.duration_ms, details=_jsonable(r.details)))
            run_id = run.id
            # prune history
            old = list(s.execute(select(DiagnosticRun.id).order_by(DiagnosticRun.started_at.desc()).offset(MAX_RUNS)).scalars())
            if old:
                s.execute(delete(DiagnosticRun).where(DiagnosticRun.id.in_(old)))
        return {"id": run_id, "level": level, "started_at": started, "finished_at": utcnow(), "summary": summary,
                "results": [r.model_dump() for r in results]}

    def history(self, limit: int = 10) -> list[dict[str, Any]]:
        with self.ctx.db.session() as s:
            runs = s.execute(select(DiagnosticRun).order_by(DiagnosticRun.started_at.desc()).limit(limit)).scalars()
            out = []
            for run in runs:
                out.append({
                    "id": run.id, "level": run.level, "started_at": run.started_at, "finished_at": run.finished_at,
                    "summary": run.summary,
                    "results": [
                        {"id": r.check_id, "group": r.group, "name": r.name, "status": r.status, "message": r.message,
                         "hint": r.hint, "duration_ms": r.duration_ms, "details": r.details}
                        for r in run.results
                    ],
                })
            return out

    def clear_history(self) -> int:
        with self.ctx.db.session() as s:
            n = s.execute(select(func.count(DiagnosticRun.id))).scalar() or 0
            s.execute(delete(DiagnosticRun))
            return int(n)

    async def report(self) -> dict[str, Any]:
        """Sanitised report: no tokens, memories, documents, conversations or form values."""
        s = self.ctx.settings.get()
        d = DiagContext(self.ctx)
        ver = await d.get_version()
        models = await d.get_models() if ver else None
        hist = self.history(1)
        return {
            "generated_at": datetime.now(UTC).isoformat(),
            "app_version": APP_VERSION,
            "backend_version": APP_VERSION,
            "api_version": API_VERSION,
            "python_version": sys.version.split()[0],
            "os": f"{platform.system()} {platform.release()} ({platform.machine()})",
            "ollama": {
                "endpoint": f"{urlparse(s.ollama_url).hostname}:{urlparse(s.ollama_url).port or ''}",
                "version": ver,
                "reachable": ver is not None,
                "installed_models": [m.get("name") for m in models] if models else [],
                "chat_model": s.chat_model or None,
                "embedding_model": s.embedding_model or None,
                "vision_model": s.vision_model or None,
                "recent_error_codes": [e["code"] for e in list(self.ctx.ollama_status.recent_errors)[-10:]],
                "last_success": self.ctx.ollama_status.last_success.isoformat() if self.ctx.ollama_status.last_success else None,
            },
            "backend": {
                "host": self.ctx.env.host,
                "port": self.ctx.env.port,
                "allowed_origin_count": len(self.ctx.env.origins),
                "schema_version": current_version(self.ctx.db),
                "data_dir_set_by_env": "LBA_DATA_DIR" in os.environ,
            },
            "last_run": {
                "time": hist[0]["started_at"].isoformat() if hist else None,
                "summary": hist[0]["summary"] if hist else None,
                "checks": [{"id": r["id"], "status": r["status"], "message": r["message"]} for r in hist[0]["results"]] if hist else [],
            },
        }


def _jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return str(v)


async def stream_self_test() -> Any:
    """Small SSE generator used by the extension's streaming endpoint check."""
    import asyncio

    for i in range(3):
        yield {"event": "tick", "data": {"n": i + 1}}
        await asyncio.sleep(0.05)
    yield {"event": "done", "data": {"ok": True}}


__all__ = ["DiagnosticsService", "stream_self_test"]
