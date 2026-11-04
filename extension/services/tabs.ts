export interface TabSummary {
  id: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  active: boolean;
}

const RESTRICTED = [/^chrome:/, /^chrome-extension:/, /^edge:/, /^about:/, /^devtools:/, /^view-source:/, /^file:/,
  /^https:\/\/chrome\.google\.com\/webstore/, /^https:\/\/chromewebstore\.google\.com/];

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return RESTRICTED.some((r) => r.test(url));
}

function summarize(t: chrome.tabs.Tab): TabSummary | null {
  if (t.id === undefined || t.id === chrome.tabs.TAB_ID_NONE) return null;
  return { id: t.id, windowId: t.windowId, title: t.title ?? '', url: t.url ?? t.pendingUrl ?? '', favIconUrl: t.favIconUrl, active: !!t.active };
}

export async function getActiveTab(): Promise<TabSummary | null> {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t ? summarize(t) : null;
}

/** Lists tabs in the current window. Titles/URLs need the optional "tabs" permission or host access. */
export async function listTabs(): Promise<TabSummary[]> {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  return tabs.map(summarize).filter((t): t is TabSummary => !!t);
}

export async function getTab(id: number): Promise<TabSummary | null> {
  try {
    return summarize(await chrome.tabs.get(id));
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
