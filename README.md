# Local Browser AI

**A private AI assistant for Google Chrome, powered by your own local [Ollama](https://ollama.com) models.**

It reads the page you are on, answers questions with checked citations, remembers what you tell it,
searches your own documents, drafts content, and fills or edits forms for you. You approve every change
before it happens. Everything runs on your computer: no cloud AI, no accounts, no telemetry.

![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.162-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Ollama](https://img.shields.io/badge/LLM-Ollama%20(local)-000000)

> **New here?** Follow the step-by-step **[Setup Guide](docs/SETUP.md)**. It takes about 15 minutes on Windows.

---

## Highlights

- **Chat about any page.** Ask about the current page, selected text or several tabs at once. Answers
  stream in, cite their sources, and citations are checked against what was actually provided.
- **Fill and edit pages from chat.** Say *"fill this form with my details"*, *"set the country to India"*
  or *"turn off the toolbar"*. The assistant proposes each change (field, value, reason). You edit or
  approve, then click **Apply**. It handles text fields, dropdowns (including long country lists and
  script-driven dropdowns), radio buttons, checkboxes, switches, dates, times, numbers and rich text
  editors.
- **Never unsafe.** It never submits forms, buys, pays or logs in. It never reads or fills password,
  payment or login fields, and never ticks *"I agree to the terms"* boxes for you.
- **Personal memory.** Save facts about yourself (skills, projects, writing style) or let it suggest
  memories from conversations. Memories are filtered for sensitive data and need your confirmation by default.
- **Your documents (RAG).** Search PDF, Word, PowerPoint, Excel, Markdown, text, HTML and CSV files
  locally, with source references.
- **Floating assistant.** An optional on-page launcher for explain, summarize, rewrite, grammar,
  translate and fill-this-field. It appears only on sites you allow.
- **Diagnostics built in.** One page checks Ollama, models, backend, storage, CORS, Chrome permissions
  and the extension, and tells you how to fix anything that fails.

## Quick start

**Prerequisites:** Windows 10/11, Chrome 116+, [Python 3.11+](https://www.python.org/downloads/),
[Node.js 20+](https://nodejs.org/) and [Ollama](https://ollama.com/download).

```powershell
git clone https://github.com/salmanulharis/browser-assistant-ai.git
cd browser-assistant-ai

ollama pull qwen3:4b-instruct     # chat model (~2.5 GB)
ollama pull nomic-embed-text      # embedding model (~270 MB)

powershell -ExecutionPolicy Bypass -File scripts\install.ps1   # backend + extension build
powershell -ExecutionPolicy Bypass -File scripts\start.ps1     # starts Ollama (if needed) + backend
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, choose
`extension\.output\chrome-mv3`, and click the toolbar icon to open the side panel. It pairs with the
backend automatically.

See the **[Setup Guide](docs/SETUP.md)** for detailed step-by-step instructions, first-use tips,
updating and troubleshooting.

## How it works

```
┌──────────────────────── Chrome ────────────────────────┐
│  Side panel (React)        Floating assistant (Shadow   │
│  chat · knowledge · memory  DOM, only on allowed sites) │
│            │                        │                   │
│            └──── service worker ────┘   page agent      │
│                 (holds the token)       (reads/fills    │
│                        │                 the page after │
└────────────────────────┼─────────────── approval) ──────┘
                         │ HTTP + SSE · Bearer token · exact-origin CORS
              ┌──────────▼──────────┐
              │ FastAPI backend     │  127.0.0.1:8765 only
              │ planning · RAG ·    │── SQLite (source of truth)
              │ memory · diagnostics│── ChromaDB (vectors)
              └──────────┬──────────┘
                         │ HTTP
              ┌──────────▼──────────┐
              │ Ollama              │  127.0.0.1:11434
              │ chat · embeddings   │
              └─────────────────────┘
```

- **The backend plans; the extension executes.** Page edits are produced as a schema-constrained JSON
  plan, then checked by a safety policy on the backend and again in the extension. Nothing runs until
  you approve it, and every element is re-checked before it is touched.
- **Prompts are kept small** (only relevant fields and controls, capped context), so planning stays
  usable on CPU-only machines.
- **Data stays local** in `%LOCALAPPDATA%\LocalBrowserAI`: database, vectors, uploaded documents, backups
  and logs. None of it is stored in the repository.

## Tech stack

| Layer | Technologies |
|---|---|
| Extension | WXT, React 19, TypeScript (strict), Tailwind CSS 4, Zustand, Zod, Lucide, Mozilla Readability |
| Backend | Python 3.11+, FastAPI, Uvicorn, Pydantic 2, SQLAlchemy 2, SQLite, ChromaDB, HTTPX |
| Documents | PyMuPDF, python-docx, python-pptx, openpyxl, BeautifulSoup4 |
| AI | Ollama HTTP API (chat, streaming, structured output, embeddings) |
| Tests | Pytest, Vitest + Testing Library, Playwright |
| Ops | PowerShell scripts for install, start, stop, diagnose, build and backup |

## Features in detail

| Area | Details |
|---|---|
| Side panel | Chat, Knowledge, Memory, History, Prompts, Diagnostics, Settings (Alt+1…7) |
| Chat | Streaming Markdown with code highlighting; copy, regenerate and stop; model selector; per-source context toggles (page, selection, tabs, memory, knowledge, history, samples); attach documents; reference other tabs; checked citations |
| Page edits | Plan → review → apply, inline in chat or from the Browser actions panel; **Apply to page** on any answer; editable values; warnings for values not found in your data; cancel at any time |
| Form filling | Field detection (labels, placeholders, required, options, help text); per-field generate, regenerate, edit, copy and approve; works with React/Vue-controlled inputs |
| Memory | Categories, pin, disable, expiry, import/export; automatic suggestions (ask, auto or off) with duplicate and sensitive-data filtering; conversation summaries and cross-conversation search |
| Knowledge | Upload, chunk (700/100 tokens by default), embed, collections, preview, re-index, delete (including vectors), semantic search with citations |
| Prompt library | Prompts and reusable sample answers; relevant samples are used automatically when drafting |
| Diagnostics | Quick checks (no model inference) and full checks; re-run failed or single checks; permission manager; sanitised copy/download report; history |
| Privacy | Local-only mode, per-site access, default exclusions for banking, payment, email and identity sites, backups, delete all data |

## Development

```powershell
# backend (from backend\)
.venv\Scripts\python -m pytest tests\unit            # fake Ollama transport, real SQLite + ChromaDB
.venv\Scripts\python -m pytest tests\integration -v  # needs a running Ollama; skipped otherwise

# extension (from extension\)
npm run compile      # strict type check
npm test             # unit tests (Vitest, jsdom)
npm run build        # production build -> .output\chrome-mv3
npm run test:e2e     # Playwright: real Chromium + built extension + real backend (+ Ollama)
```

| Suite | Covers |
|---|---|
| `backend/tests/unit` | Security (loopback-only binding, exact CORS, token, path and filename sanitising, sensitive data), text chunking and ranking, every document format, planner policy and field-type handling, every API group |
| `backend/tests/integration` | Against a real Ollama: model discovery, streaming chat, page → memory → document → form flow, agent planning, full diagnostics |
| `extension/tests/unit` | Page extraction, form detection, every field type (selects, radios, checkboxes, switches, dates, numbers, custom dropdowns, rich text), safety refusals, chat intent detection, side panel, diagnostics, permissions |
| `extension/e2e` | Pinned extension ID and minimal permissions, pairing, every page rendering, real page reading and filling, a real streamed chat, chat-driven form filling across all field types |

## Security and privacy

- The backend binds only to `127.0.0.1`/`localhost`/`::1`. Every endpoint except `/health` and
  `/auth/pair` needs a bearer token.
- CORS allows only the exact extension origin; wildcards are rejected. The token is handed out only to
  that origin and is stored in `chrome.storage.local`. Content scripts never see it.
- Website access is optional and granted per site. The manifest requires access to localhost only.
- Page content is treated as untrusted data, so instructions found on pages are ignored. Uploads are
  type-, content- and size-checked, and file paths are confined to the data directory.
- Diagnostic reports exclude tokens, memories, documents, conversations, URLs and form values.

## Known limitations

- Speed depends on your hardware. On a CPU-only PC a page-edit plan typically takes 30–90 seconds with a
  4B model.
- Pages such as `chrome://` and the Chrome Web Store can never be read by extensions. The WordPress block
  editor's content area runs in an embedded frame and isn't reachable yet; regular admin forms work.
- File uploads, CAPTCHAs, passwords, payment and login fields are deliberately not automated.
- Some Chrome internals (for example whether the service worker is asleep) can't be observed and are
  reported as **Not directly verifiable**.

## Repository layout

```
backend/     FastAPI app: api/, core/, database/, models/, schemas/, services/, prompts/, security/; tests/
extension/   WXT + React: entrypoints/ (background, sidepanel, options, floating.content, page-agent),
             components/, services/, stores/, hooks/, lib/, types/, utils/; tests/ (unit), e2e/
scripts/     install, start, stop, diagnose, build, backup (+ shared common.ps1)
docs/        SETUP.md (setup guide), IMPLEMENTATION_PLAN.md (architecture decisions)
```
