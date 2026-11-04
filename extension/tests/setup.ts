/**
 * Test setup: jest-dom matchers + an in-memory fake of the chrome.* APIs the
 * extension uses. Tests can tweak `fakeChrome` (granted permissions, storage).
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

type Listener = (...a: unknown[]) => void;
const event = () => {
  const ls = new Set<Listener>();
  return { addListener: (l: Listener) => ls.add(l), removeListener: (l: Listener) => ls.delete(l), hasListener: (l: Listener) => ls.has(l), _fire: (...a: unknown[]) => ls.forEach((l) => l(...a)) };
};

function area() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (k?: string | string[] | null) => {
      if (k == null) return { ...data };
      const keys = Array.isArray(k) ? k : [k];
      return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, data[x]]));
    }),
    set: vi.fn(async (o: Record<string, unknown>) => {
      const changes = Object.fromEntries(Object.entries(o).map(([key, v]) => [key, { oldValue: data[key], newValue: v }]));
      data = { ...data, ...o };
      storageChanged._fire(changes, 'local');
    }),
    remove: vi.fn(async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) delete data[x]; }),
    clear: vi.fn(async () => { data = {}; }),
    _reset: () => { data = {}; },
  };
}

const storageChanged = event();

export const fakeChrome = {
  granted: new Set<string>(['storage', 'activeTab', 'sidePanel', 'scripting', 'contextMenus']),
  origins: new Set<string>(['http://127.0.0.1/*', 'http://localhost/*']),
  grantNext: true,
  activeTab: { id: 1, url: 'https://example.com/page', title: 'Example', windowId: 1, active: true } as chrome.tabs.Tab | null,
};

const permissions = {
  contains: vi.fn(async (p: { permissions?: string[]; origins?: string[] }) =>
    (p.permissions ?? []).every((x) => fakeChrome.granted.has(x)) && (p.origins ?? []).every((x) => fakeChrome.origins.has(x))),
  request: vi.fn(async (p: { permissions?: string[]; origins?: string[] }) => {
    if (!fakeChrome.grantNext) return false;
    p.permissions?.forEach((x) => fakeChrome.granted.add(x));
    p.origins?.forEach((x) => fakeChrome.origins.add(x));
    permissions.onAdded._fire(p);
    return true;
  }),
  remove: vi.fn(async (p: { permissions?: string[]; origins?: string[] }) => {
    p.permissions?.forEach((x) => fakeChrome.granted.delete(x));
    p.origins?.forEach((x) => fakeChrome.origins.delete(x));
    permissions.onRemoved._fire(p);
    return true;
  }),
  getAll: vi.fn(async () => ({ permissions: [...fakeChrome.granted], origins: [...fakeChrome.origins] })),
  onAdded: event(),
  onRemoved: event(),
};

const local = area();
const session = area();

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    getManifest: () => ({ manifest_version: 3, version: '1.0.0', name: 'Local Browser AI' }),
    sendMessage: vi.fn(async () => ({ pong: true })),
    onMessage: event(),
    onConnect: event(),
    lastError: undefined,
    getURL: (p: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
  },
  storage: { local, session, onChanged: storageChanged },
  permissions,
  tabs: {
    query: vi.fn(async () => (fakeChrome.activeTab ? [fakeChrome.activeTab] : [])),
    get: vi.fn(async () => fakeChrome.activeTab),
    create: vi.fn(async () => ({})),
    onActivated: event(),
    onUpdated: event(),
    onRemoved: event(),
    sendMessage: vi.fn(async () => undefined),
  },
  windows: { WINDOW_ID_CURRENT: -2, onFocusChanged: event() },
  scripting: {
    executeScript: vi.fn(async () => [{ result: true }]),
    getRegisteredContentScripts: vi.fn(async () => []),
    registerContentScripts: vi.fn(async () => undefined),
    unregisterContentScripts: vi.fn(async () => undefined),
  },
  sidePanel: {
    getOptions: vi.fn(async () => ({ path: 'sidepanel.html', enabled: true })),
    getPanelBehavior: vi.fn(async () => ({ openPanelOnActionClick: true })),
    open: vi.fn(async () => undefined),
  },
};

// jsdom lacks <dialog> modal APIs and matchMedia.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
}
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, onchange: null, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
Element.prototype.scrollIntoView ??= function () {};
window.scrollTo = (() => {}) as typeof window.scrollTo;
window.scrollBy = (() => {}) as typeof window.scrollBy;
(globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };

afterEach(() => {
  cleanup();
  local._reset();
  session._reset();
  fakeChrome.grantNext = true;
});
