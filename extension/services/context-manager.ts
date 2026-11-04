/**
 * Assembles page / selection / multi-tab context for a chat request. Only reads
 * tabs the user explicitly selected; never scans every open tab.
 */
import { hasHostAccess } from '@/services/permissions';
import { PageAccessError, readPage } from '@/services/page-reader';
import { getTab, hostOf, isRestrictedUrl, type TabSummary } from '@/services/tabs';
import type { ContextToggles } from '@/types/config';
import type { PageContext } from '@/types/page';
import { isExcludedHost } from '@/utils/sensitive';

export interface ContextResult {
  page: PageContext | null;
  tabs: PageContext[];
  notes: string[];
}

/** Strip parts the backend does not need, keeping requests small. */
export function slimPage(p: PageContext, keepForms = false): PageContext {
  return { ...p, links: p.links.slice(0, 40), forms: keepForms ? p.forms : [] };
}

const cache = new Map<number, { hash: string; at: number; page: PageContext }>();

export async function readTabCached(tab: TabSummary, maxAgeMs = 4000): Promise<PageContext> {
  const hit = cache.get(tab.id);
  if (hit && Date.now() - hit.at < maxAgeMs && hit.page.url.split('#')[0] === tab.url.split('#')[0]) return hit.page;
  const page = await readPage(tab.id, tab.url);
  cache.set(tab.id, { hash: page.content_hash, at: Date.now(), page });
  return page;
}

export function invalidateTab(tabId: number): void {
  cache.delete(tabId);
}

export async function gatherContext(opts: {
  activeTab: TabSummary | null;
  toggles: ContextToggles;
  selectedTabIds: number[];
  excludedSites: string[];
  forceRead?: boolean;
  autoCapture: boolean;
}): Promise<ContextResult> {
  const notes: string[] = [];
  let page: PageContext | null = null;
  const t = opts.activeTab;
  const wantPage = opts.toggles.page || opts.toggles.selection;
  if (t && wantPage && !isRestrictedUrl(t.url)) {
    const excluded = t.url && isExcludedHost(hostOf(t.url), opts.excludedSites);
    if (excluded && !opts.forceRead) {
      notes.push(`Page context skipped: ${hostOf(t.url)} is on your excluded-sites list.`);
    } else if (!opts.autoCapture && !opts.forceRead) {
      notes.push('Automatic page capture is off (Settings → Privacy).');
    } else {
      try {
        page = await readTabCached(t);
        if (!opts.toggles.page) page = { ...page, main_text: '', paragraphs: [], lists: [], tables: [], code_blocks: [] };
        if (!opts.toggles.selection) page = { ...page, selected_text: '' };
      } catch (e) {
        if (e instanceof PageAccessError) notes.push(e.message);
        else notes.push(`Could not read the page: ${String(e)}`);
      }
    }
  }
  const tabs: PageContext[] = [];
  if (opts.toggles.tabs) {
    for (const id of opts.selectedTabIds.slice(0, 8)) {
      if (t && id === t.id) continue;
      const tab = await getTab(id);
      if (!tab) {
        notes.push('A selected tab was closed.');
        continue;
      }
      if (tab.url && !(await hasHostAccess(tab.url))) {
        notes.push(`No access to "${tab.title || hostOf(tab.url)}" – grant website access to include it.`);
        continue;
      }
      try {
        tabs.push(slimPage(await readTabCached(tab, 30_000)));
      } catch (e) {
        notes.push(`Could not read "${tab.title}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { page: page ? slimPage(page) : null, tabs, notes };
}
