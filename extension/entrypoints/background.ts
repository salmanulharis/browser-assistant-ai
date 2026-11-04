/**
 * Background service worker:
 *  - side panel behaviour, context menus, keyboard commands
 *  - registers the floating assistant ONLY for origins the user granted
 *  - validated message router for content scripts (they never get the API token)
 *  - streams quick-action responses to the floating assistant over a Port
 */
import { api, describeError, stream } from '@/services/api';
import { loadConfig, saveConfig } from '@/services/config';
import { grantedSiteOrigins } from '@/services/permissions';
import { hostOf } from '@/services/tabs';
import { CONFIG_KEY } from '@/types/config';
import { AssistStartSchema, ContentMessageSchema, PENDING_KEY, type FloatingPublicConfig, type Pending } from '@/types/messages';
import { isExcludedHost } from '@/utils/sensitive';

const FLOATING_ID = 'lba-floating';
const FLOATING_JS = 'content-scripts/floating.js';

export default defineBackground(() => {
  // Keep the token away from content scripts: restrict storage areas to trusted contexts.
  for (const area of [chrome.storage.local, chrome.storage.session]) {
    try {
      (area as chrome.storage.StorageArea & { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> })
        .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
        ?.catch(() => undefined);
    } catch {
      /* not supported for this area */
    }
  }

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'lba-ask-selection', title: 'Ask Local AI about "%s"', contexts: ['selection'] });
      chrome.contextMenus.create({ id: 'lba-read-page', title: 'Send this page to Local AI', contexts: ['page'] });
    });
    void syncFloating();
  });
  chrome.runtime.onStartup.addListener(() => void syncFloating());
  chrome.permissions.onAdded.addListener(() => void syncFloating());
  chrome.permissions.onRemoved.addListener(() => void syncFloating());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[CONFIG_KEY]) void syncFloating();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    // open() must run synchronously within the user gesture.
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
    const pending: Pending =
      info.menuItemId === 'lba-ask-selection'
        ? { kind: 'selection', text: (info.selectionText ?? '').slice(0, 20000), url: tab.url ?? '', title: tab.title ?? '', tabId: tab.id, at: Date.now() }
        : { kind: 'read', tabId: tab.id, at: Date.now() };
    void chrome.storage.session.set({ [PENDING_KEY]: pending });
  });

  chrome.commands.onCommand.addListener((command, tab) => {
    if (!tab?.id) return;
    const tabId = tab.id;
    if (command === 'read-page') {
      chrome.sidePanel.open({ tabId }).catch(() => undefined);
      void chrome.storage.session.set({ [PENDING_KEY]: { kind: 'read', tabId, at: Date.now() } satisfies Pending });
    } else if (command === 'toggle-floating') {
      chrome.tabs.sendMessage(tabId, { type: 'floating:toggle' }).catch(async () => {
        // Not injected yet: the keyboard shortcut grants activeTab, so inject once.
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: [FLOATING_JS] });
          await chrome.tabs.sendMessage(tabId, { type: 'floating:toggle', force: true });
        } catch {
          /* restricted page */
        }
      });
    }
  });

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    // Liveness probe from extension pages (Diagnostics).
    if (!sender.tab && (raw as { type?: string })?.type === 'ping') {
      sendResponse({ pong: true, at: Date.now() });
      return false;
    }
    // Only content scripts in tabs use this router; extension pages call the API directly.
    if (!sender.tab?.id || !sender.url) return false;
    const parsed = ContentMessageSchema.safeParse(raw);
    if (!parsed.success) {
      sendResponse({ ok: false, error: 'Invalid message' });
      return false;
    }
    handleContentMessage(parsed.data, sender)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: describeError(e).message, hint: describeError(e).hint }));
    return true;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'lba-assist' || port.sender?.id !== chrome.runtime.id || !port.sender?.tab) {
      port.disconnect();
      return;
    }
    const ctrl = new AbortController();
    port.onDisconnect.addListener(() => ctrl.abort());
    port.onMessage.addListener(async (msg) => {
      if (msg?.type === 'stop') return ctrl.abort();
      const parsed = AssistStartSchema.safeParse(msg);
      if (!parsed.success) return port.postMessage({ type: 'error', message: 'Invalid request' });
      try {
        for await (const ev of stream('/assist/stream', {
          action: parsed.data.action,
          text: parsed.data.text,
          instructions: parsed.data.instructions,
          page: parsed.data.page ? { url: parsed.data.page.url, title: parsed.data.page.title } : null,
        }, ctrl.signal)) {
          port.postMessage({ type: 'event', event: ev.event, data: ev.data });
        }
        port.postMessage({ type: 'end' });
      } catch (e) {
        if (!ctrl.signal.aborted) {
          const d = describeError(e);
          port.postMessage({ type: 'error', message: d.message, hint: d.hint });
        }
      }
    });
  });
});

async function handleContentMessage(msg: ReturnType<typeof ContentMessageSchema.parse>, sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  const tabId = sender.tab!.id!;
  const host = hostOf(sender.url ?? '');
  switch (msg.type) {
    case 'floating:config': {
      const cfg = await loadConfig();
      const excluded = isExcludedHost(host, cfg.excludedSites) || cfg.floating.disabledSites.includes(host);
      const out: FloatingPublicConfig = {
        enabled: cfg.floating.enabled && !excluded,
        reason: !cfg.floating.enabled ? 'disabled' : excluded ? 'excluded' : undefined,
        position: cfg.floating.position,
        offset: cfg.floating.offset,
        connected: !!cfg.token,
      };
      return { config: out };
    }
    case 'floating:savePosition': {
      const cfg = await loadConfig();
      await saveConfig({ floating: { ...cfg.floating, offset: msg.offset } });
      return {};
    }
    case 'floating:disableSite': {
      const cfg = await loadConfig();
      if (host && !cfg.floating.disabledSites.includes(host)) {
        await saveConfig({ floating: { ...cfg.floating, disabledSites: [...cfg.floating.disabledSites, host] } });
      }
      return {};
    }
    case 'floating:openPanel': {
      await chrome.sidePanel.open({ tabId }).catch(() => undefined);
      return {};
    }
    case 'floating:sendToPanel': {
      await chrome.storage.session.set({ [PENDING_KEY]: { kind: 'page', page: msg.page, tabId, at: Date.now() } satisfies Pending });
      let opened = true;
      await chrome.sidePanel.open({ tabId }).catch(() => (opened = false));
      return { opened };
    }
    case 'floating:generateField': {
      const res = await api.post('/forms/generate', {
        url: msg.page.url,
        title: msg.page.title,
        fields: [msg.field],
        target_refs: [msg.field.ref],
        instructions: msg.instructions,
      }, { timeoutMs: 300_000 });
      return { result: res };
    }
  }
}

/** (Re)register the floating assistant for granted origins only. */
async function syncFloating(): Promise<void> {
  try {
    const cfg = await loadConfig();
    const origins = await grantedSiteOrigins();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [FLOATING_ID] });
    if (!cfg.floating.enabled || origins.length === 0) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [FLOATING_ID] });
      return;
    }
    const script: chrome.scripting.RegisteredContentScript = {
      id: FLOATING_ID,
      matches: origins,
      js: [FLOATING_JS],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    };
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch (e) {
    console.warn('[LBA] floating registration failed', e);
  }
}
