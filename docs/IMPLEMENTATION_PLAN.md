# Implementation Plan

## Workspace findings (2026-11-04)

- Workspace was empty and not a Git repository; `git init` was run, nothing else existed to preserve.
- Toolchain: Python 3.12.10 (also 3.13), Node 24.19, npm 11.17, no pnpm.
- Ollama 0.40.13 running at `127.0.0.1:11434` with `R4C3R/qwen3-8b-heretic:q4_k_m` (chat, no `thinking` capability flag) and `nomic-embed-text:latest` (embedding).
- The workspace root is used as the monorepo root (the spec's `local-browser-ai/` folder == this folder).

## Key architecture decisions

| Area | Decision | Reason |
|---|---|---|
| Extension ID / CORS | `scripts/extension-key.mjs` generates an RSA key once (gitignored) → `manifest.key` → **deterministic extension ID**. The backend allow-lists exactly `chrome-extension://<id>`. | Exact CORS origin for an unpacked extension without wildcards. |
| Auth | 256-bit token generated at install in the data dir. Every API call needs `Authorization: Bearer`. Pairing: `POST /api/v1/auth/pair` returns the token only to a request whose `Origin` is the allow-listed extension origin (web pages cannot forge `Origin`); manual paste is also supported. Token stored in `chrome.storage.local`, used only by background/side panel – content scripts never talk to the backend. | No credentials in source; no copy/paste friction. |
| Data location | `%LOCALAPPDATA%\LocalBrowserAI` (override `LBA_DATA_DIR`). | Keeps DB, vectors, uploads and logs out of the source tree. |
| Migrations | Small versioned migration runner (`schema_migrations` table, ordered Python migrations). | Proper, ordered, idempotent migrations without Alembic's config overhead. |
| Vectors | ChromaDB persistent client; collection per (purpose, embedding model) so dimensions never clash. SQLite is the source of truth; chunks can be re-embedded. | Model changes don't corrupt the index. |
| Page access | Optional host permissions per site (`chrome.permissions.request`) + `activeTab`. Page reader is an injected unlisted script (Mozilla Readability + structured extraction) run via `chrome.scripting`. | No `<all_urls>` at install. |
| Floating assistant | Content script registered at runtime (`chrome.scripting.registerContentScripts`) only for granted origins, Shadow DOM UI. | Not injected everywhere. |
| Browser agent | Backend plans (Ollama structured JSON output → Pydantic validation → policy filter); extension re-validates with Zod, shows plan, executes only approved actions, revalidates element fingerprints, posts results. No `eval`, no submit, no password/payment fields. | Plan-review-execute. |
| Streaming | SSE (`text/event-stream`) from FastAPI; side panel reads via `fetch` stream; floating UI streams via a `runtime.Port` relayed by the background worker. | |
| UI | Hand-written accessible primitives on Tailwind v4 + Lucide (no Radix dependency tree). | Fewer deps, full keyboard support. |

## Phases

1. Foundation – repo, backend skeleton, config, auth, Ollama client, SSE chat, diagnostics base, WXT side panel + API client.
2. Page understanding – injected reader, chunking + relevance selection, floating assistant, selection actions.
3. Memory & knowledge – schema, documents pipeline, Chroma, retrieval, personal/auto memory, conversation summaries.
4. Forms & agent – detection, field generation, planner, approval UI, safe executor, action logs.
5. Advanced – multi-tab, prompt/sample library, site preferences, vision, export/import, backup/restore.
6. Production – tests (unit/integration/e2e), scripts, docs, security review.

## Risks

- ChromaDB native wheels on Windows / Python 3.12 (verified at install time).
- `activeTab` is not granted by side-panel interaction alone; diagnostics surfaces this and offers per-site host permission.
- Small local models produce imperfect JSON; mitigated with Ollama `format` JSON-schema constrained output + Pydantic validation + one retry.
- Chrome-internal state (service worker lifecycle) is partly unobservable → reported as "Not directly verifiable".

## Status (2026-11-04, completion pass)

Audit of the existing code against the build spec found the backend, the extension's services and stores, and
most pages already implemented. The following were missing and have been added:

- `extension/entrypoints/sidepanel/`: side panel shell with 7-page navigation, connection banner, theme and
  font size, Alt+1..7 shortcuts, and optional periodic connectivity checks (no inference).
- `extension/components/diagnostics/`: Diagnostics page (summary, Ollama panel with guidance, grouped checks,
  re-run failed/single, model tests, copy/download sanitised report, history) and a Permissions section
  (contains/request/remove, per-site access, denial handling).
- `extension/components/settings/`: Settings (Connection/pairing, AI and models with confirmed pull and tests,
  generation and RAG, Memory, Browser, Privacy with backups, export/import and delete-all, Appearance).
- `extension/entrypoints/options/`: full-tab settings page.
- `extension/tsconfig.json` (strict TypeScript was not actually running before), two type fixes.
- A diagnostics bug: the CORS check probed with GET, but Chrome omits `Origin` on GET from extensions that
  hold host permission, so it reported a false "not allow-listed" warning. It now probes with POST.
- `scripts/*.ps1` (install, start, stop, diagnose, build, backup and the shared common.ps1), ASCII-only
  for Windows PowerShell 5.1.
- `.gitignore`, `backend/.env.example`, `README.md`.
- Tests: backend unit (fake Ollama transport) and integration (real Ollama), extension Vitest, and
  Playwright E2E with the real built extension and backend.
