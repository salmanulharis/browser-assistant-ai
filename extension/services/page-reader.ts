/**
 * Injects the page agent (entrypoints/page-agent.ts) into a tab and calls it.
 * Works when the tab is covered by activeTab or an optional host permission.
 */
import type { ExtractOptions, PageAgent } from '@/lib/page-agent-core';
import type { PageContext } from '@/types/page';
import { isRestrictedUrl } from '@/services/tabs';

export type AccessProblem = 'restricted' | 'permission' | 'no-tab' | 'error';

export class PageAccessError extends Error {
  constructor(public kind: AccessProblem, message: string) {
    super(message);
  }
}

function classify(e: unknown, url?: string): PageAccessError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/cannot be scripted|chrome:\/\/|extensions gallery|Cannot access a chrome/i.test(msg) || isRestrictedUrl(url)) {
    return new PageAccessError('restricted', 'This is a browser-internal or protected page; extensions cannot read it.');
  }
  if (/Cannot access contents|must request permission|permission to access|Missing host permission/i.test(msg)) {
    return new PageAccessError('permission', 'Website access permission is required to read this page.');
  }
  if (/No tab with id|Frame with ID 0 was removed/i.test(msg)) return new PageAccessError('no-tab', 'The tab is no longer available.');
  return new PageAccessError('error', msg);
}

type AgentMethod = keyof PageAgent;

async function ensureAgent(tabId: number): Promise<void> {
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => typeof (globalThis as unknown as { __lbaAgent?: unknown }).__lbaAgent !== 'undefined',
  });
  if (!probe?.result) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['/page-agent.js'] });
  }
}

export async function callAgent<T>(tabId: number, method: AgentMethod, args: unknown[] = [], url?: string): Promise<T> {
  if (isRestrictedUrl(url)) throw classify(new Error('restricted'), url);
  try {
    await ensureAgent(tabId);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m: string, a: unknown[]) => {
        const agent = (globalThis as unknown as { __lbaAgent: Record<string, (...x: unknown[]) => unknown> }).__lbaAgent;
        return agent[m](...a);
      },
      args: [method, args],
    });
    return res?.result as T;
  } catch (e) {
    throw classify(e, url);
  }
}

export function readPage(tabId: number, url?: string, opts?: ExtractOptions): Promise<PageContext> {
  return callAgent<PageContext>(tabId, 'extract', [opts ?? {}], url);
}

export function readSelection(tabId: number, url?: string): Promise<string> {
  return callAgent<string>(tabId, 'selection', [], url);
}

/** Probe whether the page can be scripted right now (for diagnostics/indicators). */
export async function canScript(tabId: number, url?: string): Promise<{ ok: boolean; problem?: AccessProblem; message?: string }> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => true });
    return { ok: true };
  } catch (e) {
    const err = classify(e, url);
    return { ok: false, problem: err.kind, message: err.message };
  }
}
