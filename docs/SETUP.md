# Setup Guide

This guide takes you from a fresh Windows PC to a working Local Browser AI in about 15 minutes, plus
model download time. No administrator rights are needed.

- [1. Install the prerequisites](#1-install-the-prerequisites)
- [2. Get the code](#2-get-the-code)
- [3. Download the AI models](#3-download-the-ai-models)
- [4. Run the installer](#4-run-the-installer)
- [5. Start the services](#5-start-the-services)
- [6. Load the extension in Chrome](#6-load-the-extension-in-chrome)
- [7. First run](#7-first-run)
- [8. Everyday use](#8-everyday-use)
- [9. Updating](#9-updating)
- [10. Backups](#10-backups)
- [11. Configuration](#11-configuration)
- [12. Troubleshooting](#12-troubleshooting)
- [13. Uninstalling](#13-uninstalling)

---

## 1. Install the prerequisites

| Tool | Version | Download | Note |
|---|---|---|---|
| Google Chrome | 116 or newer | [google.com/chrome](https://www.google.com/chrome/) | Side panel support |
| Python | 3.11 or newer (3.12 recommended) | [python.org/downloads](https://www.python.org/downloads/) | Tick **"Add python.exe to PATH"** during setup |
| Node.js | 20 or newer (LTS) | [nodejs.org](https://nodejs.org/) | Builds the extension |
| Ollama | latest | [ollama.com/download](https://ollama.com/download) | Runs the AI models locally |
| Git | any | [git-scm.com](https://git-scm.com/download/win) | Optional; you can also download the ZIP |

Open a new **PowerShell** window and check that everything is found:

```powershell
python --version     # Python 3.11+  (or: py -3.12 --version)
node --version       # v20+
ollama --version
```

## 2. Get the code

```powershell
git clone https://github.com/salmanulharis/browser-assistant-ai.git
cd browser-assistant-ai
```

Without Git, use **Code → Download ZIP** on GitHub, extract it, and open PowerShell in the extracted
folder. Run every command in this guide from that folder: the one that contains `scripts\`, `backend\`
and `extension\`.

## 3. Download the AI models

You need one **chat** model and one **embedding** model:

```powershell
ollama pull qwen3:4b-instruct     # chat (~2.5 GB)
ollama pull nomic-embed-text      # embeddings for memory and document search (~270 MB)
```

Notes on choosing a chat model:

- `qwen3:4b-instruct` is the recommended default: small, fast, and reliable at the structured output
  that form filling needs.
- Avoid **"thinking"** variants (for example the plain `qwen3:4b` tag) for this app. They always reason
  before answering, which makes form filling slow and unreliable.
- Larger models answer better but are slower, especially on PCs without a GPU.
- A vision model is optional. Set one in **Settings → AI** if you want screenshot-based answers.

You can change models at any time in **Settings → AI**. The app never downloads a model without asking
first.

## 4. Run the installer

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

The installer:

1. Finds Python 3.11+ and creates a virtual environment in `backend\.venv`.
2. Installs the pinned backend dependencies.
3. Creates `backend\.env` from `backend\.env.example`.
4. Creates the data folder `%LOCALAPPDATA%\LocalBrowserAI`, generates the API token and sets up the database.
5. Checks Ollama and your models.
6. Builds the Chrome extension into `extension\.output\chrome-mv3`. It also gives the extension a fixed
   ID and allows exactly that ID in `backend\.env`.

Add `-Dev` to also install the test tools (pytest). Running the installer again is safe: it upgrades in
place and keeps your data.

## 5. Start the services

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

`start.ps1` starts Ollama if it isn't running, starts the backend on `http://127.0.0.1:8765`, and checks
both. When it finishes you should see green `[ok]` lines:

```
[ok]   Ollama 0.x is already running (left untouched).
[ok]   Backend started (pid 12345).
[ok]   Health: ok, version 1.0.0, API v1
```

The backend keeps running in the background after you close the window. To stop it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1             # stops only what start.ps1 started
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 -KeepOllama # leave Ollama running
```

## 6. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension\.output\chrome-mv3` folder.
4. Click the puzzle-piece icon in the toolbar and **pin** Local Browser AI.
5. Click the Local Browser AI icon, or press **Alt+Shift+A**, to open the side panel.

The side panel connects and pairs with the backend automatically; a green dot in the top-right corner
means it's connected.

## 7. First run

1. **Check that everything works.** Open the **Diagnostics** page in the side panel and click
   **Run all tests**. Everything should be *Healthy*; "No vision model selected" is optional and can be
   ignored.
2. **Check the models.** In **Settings → AI**, make sure the chat model is `qwen3:4b-instruct` and the
   embedding model is `nomic-embed-text`. The test buttons next to each one send a short request.
3. **Allow a website.** Open a website, then click **Grant website access** at the top of the chat.
   - If Chrome hides which site is open, the first click asks to see your tabs. Chrome words this as
     "Read your browsing history". The button then changes to **Allow <site>**; click it again to allow
     that one site.
   - Alternatively: puzzle-piece icon → **⋮** next to Local Browser AI → **This can read and change site
     data** → **On this site**.
4. **Add something about yourself** in **Memory** (for example your name, role and city). The assistant
   uses it to fill forms.

## 8. Everyday use

| You want to… | Do this |
|---|---|
| Ask about the page | Type your question in **Chat**. Toggle sources (Page, Selection, Tabs, Memory, Knowledge…) below the input |
| Fill or edit a page | Type the request in chat, e.g. *"Fill this form with my details"* or *"Set the role to Editor"*. Review the proposed changes, edit values if needed, click **Approve all** and **Apply** |
| Use an answer on the page | Click **Apply to page** under any answer |
| Fill a form field by field | Click the form icon in the chat header (**Fill a form**) |
| Compare tabs | Click **Add tabs** below the input and pick the tabs to include |
| Search your files | Upload them in **Knowledge**, then ask in chat (keep the *Knowledge* source on) |
| Quick actions on any allowed site | Use the floating button on the page, or select text and choose explain, summarize, rewrite… (**Alt+Shift+F** toggles it) |
| Send a page to the panel | Right-click → **Send this page to Local AI**, or press **Alt+Shift+R** |

Things the assistant never does on its own: submit forms, purchase or pay, log in, fill password,
payment or login fields, or tick terms/consent boxes. Always review the page and submit it yourself.

Planning a page edit usually takes 30–90 seconds on a PC without a GPU. The panel shows the elapsed
time, and **Cancel** stops it.

## 9. Updating

```powershell
git pull
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 -KeepOllama
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

Then click the reload icon on Local Browser AI in `chrome://extensions`. Your data is kept.

## 10. Backups

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1          # create a backup
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -List    # list backups
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -Restore "<path-to-backup.zip>"
```

A backup contains the database, vectors and uploaded documents. Restoring writes a safety backup of the
current data first. Backups can also be created and downloaded in **Settings → Privacy**.

## 11. Configuration

Process settings live in `backend\.env` (see [`backend/.env.example`](../backend/.env.example)):

| Variable | Default | Meaning |
|---|---|---|
| `LBA_PORT` | `8765` | Backend port (if you change it, also change **Settings → Connection → Backend URL**) |
| `LBA_ALLOWED_ORIGINS` | written by `build.ps1` | Exact extension origin allowed by CORS (no wildcards) |
| `LBA_OLLAMA_URL` | `http://127.0.0.1:11434` | Initial Ollama address (**Settings → AI** overrides it) |
| `LBA_DATA_DIR` | `%LOCALAPPDATA%\LocalBrowserAI` | Database, vectors, documents, backups and logs |
| `LBA_MAX_UPLOAD_MB` | `50` | Maximum document upload size |
| `LBA_ALLOW_PAIRING` | `true` | Let the extension fetch the token automatically |
| `LBA_LOG_LEVEL` | `INFO` | Backend log level |

Everything else is set in the side panel. **Settings** covers models, temperature, timeouts, RAG,
memory policy, retention, browser behaviour, privacy and appearance.

## 12. Troubleshooting

Run the environment check first:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\diagnose.ps1
```

| Problem | Fix |
|---|---|
| *"running scripts is disabled on this system"* | Always run scripts as `powershell -ExecutionPolicy Bypass -File scripts\<name>.ps1` |
| *"Python 3.11 or newer was not found"* | Install Python and tick **Add python.exe to PATH**, then open a **new** PowerShell window |
| Side panel says *"Cannot reach the local backend"* | Run `scripts\start.ps1`. If it still fails, check `%LOCALAPPDATA%\LocalBrowserAI\logs\backend.err.log` |
| *"Port 8765 is already used by …"* | Close that program, or set `LBA_PORT` in `backend\.env` and update **Settings → Connection** |
| Automatic pairing fails / CORS warning in Diagnostics | Run `scripts\build.ps1`, then `stop.ps1` and `start.ps1`. Or run `start.ps1 -ShowToken` and paste the token in **Settings → Connection** |
| *"Ollama server is not responding"* | Start the Ollama app (or `start.ps1`, which starts it) and check the URL in **Settings → AI** |
| *"Model … is not installed"* | `ollama pull <model>`, or use **Pull** in **Settings → AI** |
| *"Permission was not granted"* / *"Website access permission is required"* | See [First run, step 3](#7-first-run). Chrome's own pages (`chrome://`, Web Store) can never be accessed |
| Answers start with reasoning text, or page-edit plans come back empty | You're using a "thinking" model. Switch to `qwen3:4b-instruct` in **Settings → AI** |
| Planning *"timed out"* | Use a smaller model, raise **Settings → AI → Generation timeout**, and keep requests specific ("fill the first name and city") |
| A dropdown option was *"not one of the field's options"* | The value didn't match any option. Edit it in the review step to one of the listed options |
| Extension shows errors after `git pull` | Run `install.ps1`, then reload the extension in `chrome://extensions` |

Still stuck? Open **Diagnostics → Copy report** and include it in your issue. It contains no personal
data.

## 13. Uninstalling

1. Remove the extension in `chrome://extensions`.
2. Run `powershell -ExecutionPolicy Bypass -File scripts\stop.ps1`.
3. Delete the project folder.
4. To remove your data as well, delete `%LOCALAPPDATA%\LocalBrowserAI` (database, vectors, documents,
   backups and logs).
5. Optionally remove the models: `ollama rm qwen3:4b-instruct` and `ollama rm nomic-embed-text`.
