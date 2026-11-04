/**
 * Extension-side diagnostics. Never reports success for something it could not
 * observe: such checks return "not_verifiable".
 */
import { api, ApiError, describeError, health } from '@/services/api';
import { loadConfig } from '@/services/config';
import { canScript } from '@/services/page-reader';
import { grantedSiteOrigins, hasHostAccess, PERMISSION_INFO, permissionSnapshot } from '@/services/permissions';
import { getActiveTab, isRestrictedUrl } from '@/services/tabs';
import type { CheckResult, DiagnosticRun } from '@/types/api';
import { readSse } from '@/utils/sse';

type R = Omit<CheckResult, 'duration_ms'>;
const r = (id: string, group: string, name: string, status: CheckResult['status'], message: string, hint?: string, details?: Record<string, unknown>): R =>
  ({ id, group, name, status, message, hint: hint ?? null, details });

async function timed(fn: () => Promise<R>): Promise<CheckResult> {
  const t0 = performance.now();
  try {
    const res = await fn();
    return { ...res, duration_ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { id: 'ext.unknown', group: 'extension', name: 'Check', status: 'failed', message: describeError(e).message, duration_ms: Math.round(performance.now() - t0) };
  }
}

// ------------------------------------------------------------ extension
async function cRuntime(): Promise<R> {
  if (!chrome?.runtime?.id) return r('ext.runtime', 'extension', 'Extension runtime', 'failed', 'chrome.runtime is unavailable.', 'Reload the extension from chrome://extensions.');
  const m = chrome.runtime.getManifest();
  return r('ext.runtime', 'extension', 'Extension runtime', 'healthy', `Running version ${m.version} (id ${chrome.runtime.id}).`, undefined, { version: m.version });
}

async function cManifest(): Promise<R> {
  const m = chrome.runtime.getManifest();
  return m.manifest_version === 3
    ? r('ext.manifest', 'extension', 'Manifest version', 'healthy', 'Manifest V3.')
    : r('ext.manifest', 'extension', 'Manifest version', 'failed', `Manifest version ${m.manifest_version}.`, 'Rebuild the extension.');
}

async function cSidePanel(): Promise<R> {
  try {
    const opts = await chrome.sidePanel.getOptions({});
    const behavior = await chrome.sidePanel.getPanelBehavior();
    if (!opts.path) return r('ext.sidepanel', 'extension', 'Side panel registration', 'warning', 'No default side panel path.', 'Reload the extension.');
    return r('ext.sidepanel', 'extension', 'Side panel registration', 'healthy', `Registered (${opts.path}); opens on toolbar click: ${behavior.openPanelOnActionClick ? 'yes' : 'no'}.`);
  } catch (e) {
    return r('ext.sidepanel', 'extension', 'Side panel registration', 'failed', describeError(e).message, 'Requires Chrome 116 or newer.');
  }
}

async function cWorker(): Promise<R> {
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'ping' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]) as { pong?: boolean } | undefined;
    if (res?.pong) return r('ext.worker', 'extension', 'Background service worker', 'healthy', 'Service worker answered a ping (it sleeps when idle; that is normal).');
    return r('ext.worker', 'extension', 'Background service worker', 'not_verifiable', 'The service worker did not answer the ping.', 'Open chrome://extensions → Local Browser AI → "service worker" to inspect it.');
  } catch {
    return r('ext.worker', 'extension', 'Background service worker', 'warning', 'No response from the service worker within 3 s.', 'Reload the extension from chrome://extensions.');
  }
}

async function cContentScript(): Promise<R> {
  const tab = await getActiveTab();
  if (!tab) return r('ext.content', 'extension', 'Page access on active tab', 'not_verifiable', 'No active tab found.');
  if (isRestrictedUrl(tab.url)) return r('ext.content', 'extension', 'Page access on active tab', 'not_verifiable', 'The active tab is a protected browser page (chrome://, Web Store); extensions can never read it.', 'Switch to a normal website to test.');
  const probe = await canScript(tab.id, tab.url);
  if (probe.ok) return r('ext.content', 'extension', 'Page access on active tab', 'healthy', 'The page reader can be injected into the active tab.');
  if (probe.problem === 'permission') return r('ext.content', 'extension', 'Page access on active tab', 'permission_required', 'Website access permission is required to read this page.', 'Use "Grant website access" in the Permissions section or the chat header.');
  return r('ext.content', 'extension', 'Page access on active tab', 'failed', probe.message ?? 'Injection failed.');
}

async function cFloating(): Promise<R> {
  const cfg = await loadConfig();
  if (!cfg.floating.enabled) return r('ext.floating', 'extension', 'Floating assistant', 'not_configured', 'Disabled in Settings → Browser.');
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['lba-floating'] });
  const origins = await grantedSiteOrigins();
  if (!origins.length) return r('ext.floating', 'extension', 'Floating assistant', 'permission_required', 'No websites have been granted access, so the floating assistant is not injected anywhere.', 'Grant website access for sites where you want it.');
  if (!scripts.length) return r('ext.floating', 'extension', 'Floating assistant', 'failed', `${origins.length} site(s) granted but the content script is not registered.`, 'Reload the extension.');
  const tab = await getActiveTab();
  if (tab && !isRestrictedUrl(tab.url) && tab.url && (await hasHostAccess(tab.url))) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!document.getElementById('lba-floating-host') });
      return res?.result
        ? r('ext.floating', 'extension', 'Floating assistant', 'healthy', `Registered for ${origins.length} site(s) and present on the active tab.`)
        : r('ext.floating', 'extension', 'Floating assistant', 'warning', `Registered for ${origins.length} site(s) but not present on the active tab.`, 'Reload the page; check it is not excluded or disabled for this site.');
    } catch { /* fall through */ }
  }
  return r('ext.floating', 'extension', 'Floating assistant', 'healthy', `Registered for ${origins.length} granted site(s).`, undefined, { sites: origins.length });
}

// ----------------------------------------------------------- permissions
async function cPermissions(): Promise<R[]> {
  const snap = await permissionSnapshot();
  const out: R[] = [];
  for (const p of PERMISSION_INFO) {
    if (p.name === 'host') continue;
    const granted = snap[p.name];
    out.push(r(`perm.${p.name}`, 'permissions', p.label, granted ? 'healthy' : p.required ? 'failed' : 'not_configured',
      granted ? 'Granted.' : p.required ? 'Missing – required.' : 'Not granted (optional).', granted ? undefined : p.troubleshooting, { permission: p.name }));
  }
  const tab = await getActiveTab();
  const sites = await grantedSiteOrigins();
  if (tab && tab.url && !isRestrictedUrl(tab.url)) {
    const has = await hasHostAccess(tab.url);
    out.push(r('perm.host', 'permissions', 'Website access (active tab)', has ? 'healthy' : 'permission_required',
      has ? `Granted for this site. ${sites.length} site(s) total.` : `Not granted for this site. ${sites.length} site(s) granted in total.`,
      has ? undefined : 'Website access permission is required to read this page permanently (temporary access works after clicking the toolbar icon).', { permission: 'host', sites: sites.length }));
  } else {
    out.push(r('perm.host', 'permissions', 'Website access', 'not_verifiable', `${sites.length} site(s) granted. The active tab cannot be checked.`, undefined, { permission: 'host', sites: sites.length }));
  }
  return out;
}

// --------------------------------------------------------- connectivity
async function cBackend(): Promise<R> {
  const cfg = await loadConfig();
  try {
    const h = await health(4000);
    return r('conn.backend', 'connection', 'Backend reachable', 'healthy', `Backend ${h.version} at ${cfg.backendUrl}.`);
  } catch (e) {
    return r('conn.backend', 'connection', 'Backend reachable', 'failed', describeError(e).message, 'Start the backend with scripts\\start.ps1 and check the URL in Settings → Connection.');
  }
}

async function cAuthAndCors(): Promise<R[]> {
  const cfg = await loadConfig();
  const out: R[] = [];
  if (!cfg.token) {
    out.push(r('conn.token', 'connection', 'API token', 'not_configured', 'The extension is not paired with the backend.', 'Settings → Connection → Pair automatically (or paste the token from scripts\\start.ps1).'));
  }
  let resp: Response | null = null;
  try {
    resp = await fetch(`${cfg.backendUrl.replace(/\/$/, '')}/api/v1/auth/check`, { headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {} });
  } catch (e) {
    out.push(r('conn.cors', 'connection', 'CORS / extension origin', 'skipped', `Skipped – backend unreachable (${describeError(e).message}).`));
    return out;
  }
  if (cfg.token) {
    out.push(resp.ok
      ? r('conn.token', 'connection', 'API token', 'healthy', 'The token is valid.')
      : r('conn.token', 'connection', 'API token', 'failed', `Backend rejected the token (HTTP ${resp.status}).`, 'Pair again in Settings → Connection. The token may have been regenerated.'));
  }
  // Chrome omits the Origin header on GET requests from an extension that holds host
  // permission, so the CORS answer must be probed with a POST (which always carries Origin).
  // POST /auth/pair is the request that actually depends on the allow-list.
  let acao: string | null = null;
  try {
    const probe = await fetch(`${cfg.backendUrl.replace(/\/$/, '')}/api/v1/auth/pair`, { method: 'POST' });
    acao = probe.headers.get('access-control-allow-origin');
  } catch { /* handled below as "not allow-listed" */ }
  const origin = location.origin;
  if (acao === origin) {
    out.push(r('conn.cors', 'connection', 'CORS / extension origin', 'healthy', `Backend allow-lists exactly ${origin}.`));
  } else if (acao === '*') {
    out.push(r('conn.cors', 'connection', 'CORS / extension origin', 'warning', 'Backend answered with a wildcard CORS origin.', 'Set LBA_ALLOWED_ORIGINS to the exact extension origin; wildcards are not safe.'));
  } else {
    out.push(r('conn.cors', 'connection', 'CORS / extension origin', 'warning',
      `Backend does not allow-list ${origin}. Requests still work through the extension's localhost host permission, but automatic pairing will fail.`,
      `Run scripts\\build.ps1 (writes LBA_ALLOWED_ORIGINS to backend\\.env) or add LBA_ALLOWED_ORIGINS=${origin} to backend\\.env, then restart the backend.`, { origin }));
  }
  const hostPerm = await chrome.permissions.contains({ origins: [`${new URL(cfg.backendUrl).origin}/*`] });
  out.push(hostPerm
    ? r('conn.preflight', 'connection', 'Preflight requirements', 'healthy', 'The extension holds host permission for the backend, so authenticated requests do not depend on CORS preflight.')
    : r('conn.preflight', 'connection', 'Preflight requirements', 'warning', 'No host permission for the backend URL; requests depend on CORS preflight succeeding.', 'Use http://127.0.0.1:<port> as the backend URL (covered by the manifest).'));
  return out;
}

async function cStream(): Promise<R> {
  const cfg = await loadConfig();
  try {
    const resp = await fetch(`${cfg.backendUrl.replace(/\/$/, '')}/api/v1/diagnostics/stream-test`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!resp.ok || !resp.body) return r('conn.stream', 'connection', 'Streaming endpoint (SSE)', 'failed', `HTTP ${resp.status}.`);
    let n = 0;
    let done = false;
    for await (const ev of readSse(resp.body)) {
      n++;
      if (ev.event === 'done') done = true;
    }
    return done
      ? r('conn.stream', 'connection', 'Streaming endpoint (SSE)', 'healthy', `Received ${n} streamed events.`)
      : r('conn.stream', 'connection', 'Streaming endpoint (SSE)', 'warning', `Stream ended early after ${n} events.`, 'A proxy or antivirus may be buffering localhost traffic.');
  } catch (e) {
    return r('conn.stream', 'connection', 'Streaming endpoint (SSE)', 'failed', describeError(e).message);
  }
}

// --------------------------------------------------------------- runner
export async function runExtensionChecks(): Promise<CheckResult[]> {
  const singles = await Promise.all([cRuntime, cManifest, cSidePanel, cWorker, cContentScript, cFloating, cBackend, cStream].map(timed));
  const multi = await Promise.all([cPermissions(), cAuthAndCors()]);
  return [...singles, ...multi.flat().map((x) => ({ ...x, duration_ms: 0 }))];
}

export async function runBackendChecks(level: 'basic' | 'full', checks?: string[]): Promise<DiagnosticRun | { error: ReturnType<typeof describeError> }> {
  try {
    return await api.post<DiagnosticRun>('/diagnostics/run', { level, checks: checks ?? null }, { timeoutMs: level === 'full' || checks ? 600_000 : 60_000 });
  } catch (e) {
    return { error: describeError(e) };
  }
}

export function summarize(results: CheckResult[]) {
  const failed = results.filter((x) => x.status === 'failed').length;
  const warnings = results.filter((x) => ['warning', 'not_configured', 'permission_required'].includes(x.status)).length;
  const healthy = results.filter((x) => x.status === 'healthy').length;
  return { failed, warnings, healthy, overall: failed ? 'failed' : warnings ? 'warning' : 'healthy' } as const;
}

/** Sanitised report – no token, memories, documents, conversations, URLs or form values. */
export async function buildReport(results: CheckResult[]): Promise<Record<string, unknown>> {
  let backend: unknown = null;
  try {
    backend = await api.get('/diagnostics/report', { timeoutMs: 15000 });
  } catch (e) {
    backend = { unavailable: describeError(e).message, code: e instanceof ApiError ? e.code : undefined };
  }
  const perms = await permissionSnapshot();
  const sites = await grantedSiteOrigins();
  const cfg = await loadConfig();
  return {
    generated_at: new Date().toISOString(),
    extension_version: chrome.runtime.getManifest().version,
    manifest_version: chrome.runtime.getManifest().manifest_version,
    browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent,
    platform: navigator.platform,
    backend_url_is_local: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.backendUrl.replace(/\/$/, '')),
    paired: !!cfg.token,
    permissions: perms,
    granted_site_count: sites.length,
    floating_enabled: cfg.floating.enabled,
    checks: results.map((x) => ({ id: x.id, status: x.status, message: redact(x.message), duration_ms: x.duration_ms })),
    backend,
  };
}

function redact(s: string): string {
  return s.replace(/https?:\/\/(?!127\.0\.0\.1|localhost)[^\s)]+/g, '[url]').replace(/chrome-extension:\/\/[a-p]{32}/g, 'chrome-extension://[id]');
}

export function reportToText(rep: Record<string, unknown>): string {
  return '```json\n' + JSON.stringify(rep, null, 2) + '\n```';
}
