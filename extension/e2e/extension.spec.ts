/**
 * End-to-end: real Chromium + the built extension + a real backend process (temp data dir).
 * The chat test additionally needs a real local Ollama with a chat model and is skipped
 * (with the reason) otherwise.
 *
 *   npm run build && npm run test:e2e
 */
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, '..', '.output', 'chrome-mv3');
const backendDir = resolve(here, '..', '..', 'backend');
const python = join(backendDir, '.venv', 'Scripts', 'python.exe');
const BACKEND_PORT = 8799;
const PAGE_PORT = 8798;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/apply.html`;
const PROFILE_URL = `http://127.0.0.1:${PAGE_PORT}/profile.html`;
const extId: string = JSON.parse(readFileSync(resolve(here, '..', '.extension-key.json'), 'utf8')).id;

let backend: ChildProcess;
let pageServer: Server;
let context: BrowserContext;
let worker: Worker;
let dataDir: string;

async function waitFor(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ollamaChatModel(): Promise<string | null> {
  try {
    const tags = await (await fetch('http://127.0.0.1:11434/api/tags')).json() as { models: { name: string; capabilities?: string[] }[] };
    return tags.models.find((m) => !(m.capabilities ?? []).includes('embedding') && !/embed/.test(m.name))?.name ?? null;
  } catch {
    return null;
  }
}

test.beforeAll(async () => {
  test.skip(!existsSync(join(extDir, 'manifest.json')), 'Extension not built – run `npm run build` first.');
  test.skip(!existsSync(python), 'Backend venv missing – run scripts\\install.ps1 first.');

  const pages: Record<string, Buffer> = { '/apply.html': readFileSync(join(here, 'fixture.html')), '/profile.html': readFileSync(join(here, 'profile.html')) };
  pageServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pages[(req.url ?? '').split('?')[0]] ?? pages['/apply.html']);
  });
  await new Promise<void>((r) => pageServer.listen(PAGE_PORT, '127.0.0.1', r));

  dataDir = mkdtempSync(join(tmpdir(), 'lba-e2e-'));
  backend = spawn(python, ['-m', 'app.main'], {
    cwd: backendDir,
    env: { ...process.env, LBA_PORT: String(BACKEND_PORT), LBA_DATA_DIR: dataDir, LBA_ALLOWED_ORIGINS: `chrome-extension://${extId}` },
    stdio: 'ignore',
  });
  expect(await waitFor(`${BACKEND}/api/v1/health`, 30_000), 'backend did not start').toBe(true);

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // Point the extension at the test backend before any page loads.
  await worker.evaluate(async (url) => { await chrome.storage.local.set({ 'lba.config': { backendUrl: url } }); }, BACKEND);
});

test.afterAll(async () => {
  await context?.close();
  backend?.kill();
  await new Promise<void>((r) => (pageServer ? pageServer.close(() => r()) : r()));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* chroma may hold files briefly */ }
});

async function openPanel(): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  return p;
}

test('extension ID is pinned and manifest permissions are minimal', async () => {
  expect(worker.url()).toContain(extId);
  const m = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(m.manifest_version).toBe(3);
  expect(m.host_permissions).toEqual(['http://127.0.0.1/*', 'http://localhost/*']);
  expect(m.permissions).not.toContain('tabs');
});

test('side panel pairs with the backend and every page renders', async () => {
  const p = await openPanel();
  await expect(p.getByTitle('Backend: ok')).toBeVisible();
  const token = await p.evaluate(async () => ((await chrome.storage.local.get('lba.config'))['lba.config'] as { token: string }).token);
  expect(token.length).toBeGreaterThan(40);
  for (const [label, marker] of [
    ['Knowledge', /Upload|documents/i], ['Memory', /memor/i], ['History', /conversation/i], ['Prompts', /prompt/i],
    ['Settings', /Backend URL/], ['Diagnostics', /Application health/],
  ] as const) {
    await p.getByRole('button', { name: new RegExp(`^${label}`) }).first().click();
    await expect(p.locator('main')).toContainText(marker);
  }
  // Diagnostics: backend + storage checks really pass against the live backend.
  await expect(p.getByText('Readable, writable, integrity OK', { exact: false })).toBeVisible({ timeout: 60_000 });
  await expect(p.getByText(/Backend allow-lists exactly chrome-extension:\/\//)).toBeVisible();
});

test('page reader extracts the page and the executor fills fields but never submits or touches passwords', async () => {
  const site = await context.newPage();
  await site.goto(PAGE_URL);
  const panel = await openPanel();
  const out = await panel.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url)!;
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['/page-agent.js'] });
    const call = async (method: string, args: unknown[] = []) => (await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: (m: string, a: unknown[]) => (globalThis as unknown as { __lbaAgent: Record<string, (...x: unknown[]) => unknown> }).__lbaAgent[m](...a),
      args: [method, args],
    }))[0].result as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const page = await call('extract', [{ useReadability: false }]);
    const forms = await call('forms');
    const by = Object.fromEntries(forms[0].fields.map((f: { name: string; ref: string }) => [f.name, f]));
    const fill = await call('fill', [by.full_name.ref, 'Meera Iyer']);
    const pw = await call('fill', [by.password.ref, 'hunter2']);
    const els = await call('elements');
    const submitRef = els.find((e: { type: string }) => e.type === 'submit').ref;
    const click = await call('execute', [{ type: 'click', target: { ref: submitRef }, reason: '', requires_confirmation: false }]);
    return { title: page.title, text: page.main_text, forms, fill, pw, click };
  }, PAGE_URL);

  expect(out.title).toContain('Acme Careers');
  expect(out.text).toContain('streaming data platform');
  expect(out.forms[0].fields.find((f: { name: string }) => f.name === 'password').sensitive).toBeTruthy();
  expect(out.fill.status).toBe('success');
  expect(out.pw.status).toBe('blocked');
  expect(out.click.status).toBe('blocked');
  await expect(site.locator('#name')).toHaveValue('Meera Iyer');
  await expect(site.locator('#pw')).toHaveValue('');
  expect(await site.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted)).toBe(false);
});

test('real chat through the side panel UI streams an answer from Ollama', async () => {
  const model = await ollamaChatModel();
  test.skip(!model, 'Ollama is not running or has no chat model installed – real chat E2E skipped.');
  const p = await openPanel();
  await expect(p.getByTitle('Backend: ok')).toBeVisible();
  const settings = await p.evaluate(async ([url, m]) => {
    const cfg = (await chrome.storage.local.get('lba.config'))['lba.config'] as { token: string };
    const r = await fetch(`${url}/api/v1/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_model: m, temperature: 0 }) });
    return r.status;
  }, [BACKEND, model] as const);
  expect(settings).toBe(200);
  await p.reload();
  await p.getByRole('textbox', { name: 'Message' }).fill('What is seventeen plus twenty-five? Reply with only the number in digits.');
  await p.getByRole('button', { name: 'Send message' }).click();
  // The assertion targets the ASSISTANT message (the question does not contain the answer).
  await expect(p.locator('.prose-chat').last()).toContainText('42', { timeout: 200_000 });
  // persisted in history
  await p.getByRole('button', { name: /^History/ }).first().click();
  await expect(p.locator('main')).toContainText(/seventeen plus twenty-five/i);
});

test('chat request "fill the form" is planned, approved and applied to the real page', async () => {
  const model = await ollamaChatModel();
  test.skip(!model, 'Ollama is not running or has no chat model installed – chat-driven filling skipped.');
  const site = await context.newPage();
  await site.goto(PAGE_URL);
  const p = await openPanel();
  await expect(p.getByTitle('Backend: ok')).toBeVisible();
  await p.evaluate(async ([url, m]) => {
    const cfg = (await chrome.storage.local.get('lba.config'))['lba.config'] as { token: string };
    await fetch(`${url}/api/v1/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_model: m, temperature: 0 }) });
  }, [BACKEND, model] as const);
  await p.reload();
  // In the real side panel the active tab is the website; here the panel itself is a tab,
  // so point "active tab" at the form page. Planning, policy and execution are all real.
  await p.evaluate(async (url) => {
    const all = await chrome.tabs.query({});
    const target = [...all].reverse().find((t) => t.url === url)!; // newest tab with the form
    const original = chrome.tabs.query.bind(chrome.tabs);
    (chrome.tabs as { query: unknown }).query = async (q: chrome.tabs.QueryInfo) => (q.active ? [target] : original(q));
  }, PAGE_URL);

  await p.getByRole('textbox', { name: 'Message' }).fill('Fill the full name field with Meera Iyer and the years of experience field with 7');
  await p.getByRole('button', { name: 'Send message' }).click();
  await expect(p.getByText('Page edit')).toBeVisible();
  // Nothing changes before approval.
  await expect(p.getByRole('button', { name: /Apply \d+ approved/ })).toBeVisible({ timeout: 200_000 });
  await expect(site.locator('#name')).toHaveValue('');
  const approveAll = p.getByRole('button', { name: 'Approve all' });
  if (await approveAll.isVisible()) await approveAll.click();
  await p.getByRole('button', { name: /Apply \d+ approved/ }).click();
  await expect(p.getByText('Finished. Review the page and submit any form yourself.')).toBeVisible({ timeout: 30_000 });

  await expect(site.locator('#name')).toHaveValue('Meera Iyer');
  await expect(site.locator('#years')).toHaveValue(/7/);
  await expect(site.locator('#pw')).toHaveValue('');
  expect(await site.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted)).toBe(false);
});

test('chat fills every field type: large select, radio, checkboxes, date and number (real model)', async () => {
  const model = await ollamaChatModel();
  test.skip(!model, 'Ollama is not running or has no chat model installed – field-type filling skipped.');
  const site = await context.newPage();
  await site.goto(PROFILE_URL);
  const p = await openPanel();
  await expect(p.getByTitle('Backend: ok')).toBeVisible();
  await p.evaluate(async ([url, m]) => {
    const cfg = (await chrome.storage.local.get('lba.config'))['lba.config'] as { token: string };
    await fetch(`${url}/api/v1/settings`, { method: 'PUT', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_model: m, temperature: 0 }) });
  }, [BACKEND, model] as const);
  await p.reload();
  await p.evaluate(async (url) => {
    const all = await chrome.tabs.query({});
    const target = [...all].reverse().find((t) => t.url === url)!;
    const original = chrome.tabs.query.bind(chrome.tabs);
    (chrome.tabs as { query: unknown }).query = async (q: chrome.tabs.QueryInfo) => (q.active ? [target] : original(q));
  }, PROFILE_URL);

  await p.getByRole('textbox', { name: 'Message' }).fill(
    'Fill this form: country India, Modern admin color scheme, enable keyboard shortcuts, turn off the toolbar, date of birth 15 March 1995, 7 years of experience');
  await p.getByRole('button', { name: 'Send message' }).click();
  await expect(p.getByRole('button', { name: /Apply \d+ approved/ })).toBeVisible({ timeout: 200_000 });
  const approveAll = p.getByRole('button', { name: 'Approve all' });
  if (await approveAll.isVisible()) await approveAll.click();
  await p.getByRole('button', { name: /Apply \d+ approved/ }).click();
  await expect(p.getByText('Finished. Review the page and submit any form yourself.')).toBeVisible({ timeout: 30_000 });

  await expect(site.locator('#country')).toHaveValue('IN');
  await expect(site.locator('input[value="modern"]')).toBeChecked();
  await expect(site.locator('#kbd')).toBeChecked();
  await expect(site.locator('#bar')).not.toBeChecked();
  await expect(site.locator('#dob')).toHaveValue('1995-03-15');
  await expect(site.locator('#years')).toHaveValue('7');
  await expect(site.locator('#terms')).not.toBeChecked();
  expect(await site.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted)).toBe(false);
});
