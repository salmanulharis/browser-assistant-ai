/**
 * Floating assistant. Registered at runtime by the background worker ONLY for
 * origins the user granted (never declared in the manifest for all sites).
 * UI is rendered inside a closed Shadow DOM for style isolation.
 */
import { createRoot } from 'react-dom/client';
import type { FloatingPublicConfig } from '@/types/messages';
import { FloatingApp } from './FloatingApp';
import css from './style.css?inline';

const HOST_ID = 'lba-floating-host';

export default defineContentScript({
  registration: 'runtime',
  matches: [],
  main() {
    const w = window as unknown as { __lbaFloatingLoaded?: boolean };
    if (w.__lbaFloatingLoaded || window.top !== window) return;
    w.__lbaFloatingLoaded = true;
    void mount(false);
    // When injected via the keyboard shortcut on a site without a registration.
    chrome.runtime.onMessage.addListener((msg: { type?: string; force?: boolean }) => {
      if (msg?.type === 'floating:toggle' && msg.force && !document.getElementById(HOST_ID)) void mount(true);
    });
  },
});

async function mount(force: boolean): Promise<void> {
  let config: FloatingPublicConfig | undefined;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'floating:config' });
    config = res?.config;
  } catch {
    return;
  }
  if (!config || (!config.enabled && !(force && config.reason !== 'excluded'))) return;
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-lba-ui', '');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; top: 0; left: 0; width: 0; height: 0;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  const container = document.createElement('div');
  shadow.append(style, container);
  document.documentElement.append(host);
  createRoot(container).render(<FloatingApp initial={{ ...config, enabled: true }} hostEl={host} startOpen={force} />);
}
