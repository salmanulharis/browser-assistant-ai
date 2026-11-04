"""FastAPI application factory.

Run:  python -m app.main   (binds to 127.0.0.1 only)
"""

from __future__ import annotations

import asyncio
import logging
import logging.handlers
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import agent, chat, conversations, diagnostics, health, knowledge, memory, models, page, prompts, settings
from app.core.config import API_VERSION, APP_VERSION, EnvSettings, get_env
from app.core.context import AppContext
from app.core.errors import install_error_handlers
from app.database.base import Database
from app.database.migrations import migrate
from app.schemas.settings import AppSettings, SettingsUpdate
from app.security.auth import load_or_create_token
from app.services.conversations import ConversationService
from app.services.ollama import model_summary
from app.services.prompts_lib import PromptService
from app.services.settings import SettingsService
from app.services.vectorstore import VectorStore

log = logging.getLogger("app")


def _setup_logging(env: EnvSettings) -> None:
    root = logging.getLogger()
    if any(getattr(h, "_lba", False) for h in root.handlers):
        return
    root.setLevel(env.log_level.upper())
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    fh = logging.handlers.RotatingFileHandler(env.logs_dir / "backend.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    fh._lba = True  # type: ignore[attr-defined]
    root.addHandler(fh)
    for noisy in ("httpx", "chromadb", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


async def _autoselect_models(ctx: AppContext) -> None:
    """First run convenience: pick installed models when none are configured."""
    s = ctx.settings.get()
    if s.chat_model and s.embedding_model:
        return
    try:
        raw = await asyncio.wait_for(ctx.ollama(s).list_models(), timeout=5)
    except Exception as exc:
        log.info("Model auto-selection skipped: %s", exc)
        return
    infos = [model_summary(m) for m in raw]
    patch = SettingsUpdate()
    if not s.chat_model:
        chat = next((m["name"] for m in infos if m["kind"] in ("chat", "vision")), None)
        if chat:
            patch.chat_model = chat
    if not s.embedding_model:
        emb = next((m["name"] for m in infos if m["kind"] == "embedding"), None)
        if emb:
            patch.embedding_model = emb
    if patch.model_dump(exclude_none=True):
        ctx.settings.update(patch)
        log.info("Auto-selected models: %s", patch.model_dump(exclude_none=True))


def build_context(env: EnvSettings, transport: httpx.AsyncBaseTransport | None = None) -> AppContext:
    env.ensure_dirs()
    db = Database(env.db_path)
    migrate(db)
    defaults = AppSettings(ollama_url=env.ollama_url.rstrip("/"))
    return AppContext(
        env=env,
        db=db,
        settings=SettingsService(db, defaults),
        vectors=VectorStore(env.chroma_dir),
        api_token=load_or_create_token(env.token_path),
        ollama_transport=transport,
    )


def create_app(
    env: EnvSettings | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    autoselect: bool = True,
) -> FastAPI:
    env = env or get_env()
    ctx = build_context(env, transport)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        _setup_logging(env)
        PromptService(ctx).seed_defaults()
        try:
            removed = ConversationService(ctx).apply_retention()
            if removed:
                log.info("Retention removed %d conversations", removed)
        except Exception as exc:  # pragma: no cover
            log.warning("Retention failed: %s", exc)
        if autoselect:
            await _autoselect_models(ctx)
        log.info("Backend %s ready on %s:%s (data: %s)", APP_VERSION, env.host, env.port, env.data_dir)
        yield
        ctx.db.dispose()

    app = FastAPI(
        title="Local Browser AI – Backend",
        version=APP_VERSION,
        description="Local-only API for the Local Browser AI Chrome extension. All endpoints except "
        "`/health` and `/auth/pair` require `Authorization: Bearer <token>`.",
        lifespan=lifespan,
        docs_url=f"/api/{API_VERSION}/docs",
        openapi_url=f"/api/{API_VERSION}/openapi.json",
        redoc_url=None,
    )
    app.state.ctx = ctx
    app.state.api_token = ctx.api_token
    app.add_middleware(
        CORSMiddleware,
        allow_origins=env.origins,  # exact extension origin(s), never "*"
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )
    install_error_handlers(app)
    prefix = f"/api/{API_VERSION}"
    for r in (health.public, health.private, diagnostics.router, models.router, chat.router, conversations.router,
              memory.router, knowledge.router, page.router, agent.router, settings.router, prompts.router):
        app.include_router(r, prefix=prefix)
    return app


def run() -> None:
    import uvicorn

    env = get_env()
    uvicorn.run(create_app(env), host=env.host, port=env.port, log_level=env.log_level.lower(), access_log=False)


if __name__ == "__main__":
    run()
