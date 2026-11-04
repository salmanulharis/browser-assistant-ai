import { useCallback, useEffect, useState } from 'react';
import { canScript, type AccessProblem } from '@/services/page-reader';
import { hasHostAccess } from '@/services/permissions';
import { getActiveTab, isRestrictedUrl, type TabSummary } from '@/services/tabs';

export interface ActiveTabState {
  tab: TabSummary | null;
  access: 'checking' | 'granted' | 'temporary' | AccessProblem;
  refresh: () => void;
}

/** Tracks the active tab and whether the extension can read it (event driven). */
export function useActiveTab(): ActiveTabState {
  const [tab, setTab] = useState<TabSummary | null>(null);
  const [access, setAccess] = useState<ActiveTabState['access']>('checking');

  const refresh = useCallback(async () => {
    const t = await getActiveTab();
    setTab(t);
    if (!t) return setAccess('no-tab');
    if (isRestrictedUrl(t.url)) return setAccess('restricted');
    if (t.url && (await hasHostAccess(t.url))) return setAccess('granted');
    const probe = await canScript(t.id, t.url);
    setAccess(probe.ok ? 'temporary' : probe.problem ?? 'error');
  }, []);

  useEffect(() => {
    void refresh();
    const onActivated = () => void refresh();
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) => {
      if (t.active && (info.status === 'complete' || info.title || info.url)) void refresh();
    };
    const onFocus = () => void refresh();
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocus);
    chrome.permissions.onAdded.addListener(onFocus);
    chrome.permissions.onRemoved.addListener(onFocus);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocus);
      chrome.permissions.onAdded.removeListener(onFocus);
      chrome.permissions.onRemoved.removeListener(onFocus);
    };
  }, [refresh]);

  return { tab, access, refresh: () => void refresh() };
}
