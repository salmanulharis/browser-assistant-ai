import { Globe, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/common/toast';
import { Badge, Button, Section, StatusBadge } from '@/components/common/ui';
import {
  grantedSiteOrigins, hasHostAccess, PERMISSION_INFO, permissionSnapshot, removeHostAccess, removePermission,
  requestHostAccess, requestPermission, type PermissionName,
} from '@/services/permissions';
import { SITE_MENU_HINT } from '@/components/chat/TabIndicator';
import { getActiveTab, hostOf, isRestrictedUrl, type TabSummary } from '@/services/tabs';

interface Snapshot { perms: Record<string, boolean>; sites: string[]; tab: TabSummary | null; tabAccess: boolean | null; urlHidden: boolean }

async function snapshot(): Promise<Snapshot> {
  const [perms, sites, tab] = await Promise.all([permissionSnapshot(), grantedSiteOrigins(), getActiveTab()]);
  // Without "tabs" or site access Chrome hides the URL: we know there is a tab, not which site.
  const urlHidden = !!tab && !tab.url;
  const tabAccess = urlHidden ? false : tab?.url && !isRestrictedUrl(tab.url) ? await hasHostAccess(tab.url) : null;
  return { perms, sites, tab, tabAccess, urlHidden };
}

/** Lists every permission with status, purpose, dependent features and a grant/revoke control. */
export function PermissionsSection({ onChange }: { onChange?: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const refresh = useCallback(async () => setSnap(await snapshot()), []);

  useEffect(() => {
    void refresh();
    const l = () => { void refresh(); onChange?.(); };
    chrome.permissions.onAdded.addListener(l);
    chrome.permissions.onRemoved.addListener(l);
    return () => {
      chrome.permissions.onAdded.removeListener(l);
      chrome.permissions.onRemoved.removeListener(l);
    };
  }, [refresh, onChange]);

  // NOTE: chrome.permissions.request() must be the first async call inside the click handler.
  const grant = (name: PermissionName) => {
    requestPermission(name)
      .then((ok) => toast(ok ? `${name} permission granted.` : `${name} permission was not granted.`, ok ? 'ok' : 'neutral'))
      .catch((e: Error) => toast(chrome.runtime.lastError?.message ?? e.message, 'bad'))
      .finally(() => void refresh());
  };
  const revoke = (name: PermissionName) => {
    removePermission(name)
      .then((ok) => toast(ok ? `${name} permission removed.` : 'Could not remove the permission.'))
      .catch((e: Error) => toast(e.message, 'bad'))
      .finally(() => void refresh());
  };
  const grantSite = () => {
    const url = snap?.tab?.url;
    if (!url) {
      // Step 1: reveal which site is open (needs "tabs"); the next click requests that site.
      requestPermission('tabs')
        .then((ok) => toast(ok ? 'Now click "Allow" to give access to this site.' : SITE_MENU_HINT, ok ? 'ok' : 'bad'))
        .catch((e: Error) => toast(e.message, 'bad'))
        .finally(() => void refresh());
      return;
    }
    requestHostAccess(url)
      .then((ok) => toast(ok ? 'Website access granted. Reload the page to show the floating assistant.' : `Website access was not granted. ${SITE_MENU_HINT}`, ok ? 'ok' : 'neutral'))
      .catch((e: Error) => toast(chrome.runtime.lastError?.message ?? e.message, 'bad'))
      .finally(() => void refresh());
  };
  const revokeSite = (pattern: string) => {
    removeHostAccess(pattern).then(() => toast(`Access removed for ${pattern.replace(/\/\*$/, '')}.`)).finally(() => void refresh());
  };

  return (
    <Section title="Permissions" actions={<Button size="icon" variant="ghost" aria-label="Refresh permissions" onClick={() => void refresh()}><RefreshCw className="size-3.5" /></Button>}>
      {!snap ? <p className="text-xs text-muted">Checking…</p> : (
        <div className="space-y-2.5">
          {PERMISSION_INFO.filter((p) => p.name !== 'host').map((p) => {
            const granted = snap.perms[p.name];
            return (
              <div key={p.name} className="rounded-md border border-border p-2">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[0.85rem] font-medium">{p.label}</span>
                  <StatusBadge status={granted ? 'healthy' : p.required ? 'failed' : 'not_configured'} />
                </div>
                <p className="mt-1 text-xs text-muted">{p.why}</p>
                <p className="text-xs text-muted"><span className="font-medium text-fg/80">Used by:</span> {p.features}</p>
                {!granted && <p className="mt-1 text-xs text-warn">{p.troubleshooting}</p>}
                {!p.required && (
                  <div className="mt-1.5">
                    {granted
                      ? <Button size="sm" variant="ghost" onClick={() => revoke(p.name as PermissionName)}>Revoke</Button>
                      : <Button size="sm" onClick={() => grant(p.name as PermissionName)}>Grant {p.label.replace(' (optional)', '')}</Button>}
                  </div>
                )}
              </div>
            );
          })}

          <div className="rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <Globe className="size-3.5 text-muted" aria-hidden />
              <span className="flex-1 text-[0.85rem] font-medium">Website access (per site)</span>
              <StatusBadge status={snap.tabAccess === null ? 'not_verifiable' : snap.tabAccess ? 'healthy' : 'permission_required'} />
            </div>
            <p className="mt-1 text-xs text-muted">{PERMISSION_INFO.find((p) => p.name === 'host')?.why}</p>
            {snap.tabAccess === false && snap.tab && (
              <div className="mt-1.5 space-y-1">
                <p className="text-xs text-warn">Website access permission is required to read this page.</p>
                <Button size="sm" variant="primary" onClick={grantSite}>{snap.urlHidden ? 'Grant website access' : `Allow ${hostOf(snap.tab.url)}`}</Button>
                {snap.urlHidden && <p className="text-xs text-muted">Chrome hides which site is open until you allow it. The first click asks to see the site, the second grants access to it.</p>}
              </div>
            )}
            {snap.tabAccess === null && <p className="mt-1 text-xs text-muted">The active tab is a browser page that extensions cannot access.</p>}
            {snap.sites.length > 0 && (
              <ul className="mt-2 space-y-1">
                {snap.sites.map((s) => (
                  <li key={s} className="flex items-center gap-2 text-xs">
                    <Badge>{s.replace(/\/\*$/, '')}</Badge>
                    <span className="flex-1" />
                    <Button size="icon" variant="ghost" aria-label={`Revoke access for ${s}`} onClick={() => revokeSite(s)}><Trash2 className="size-3.5" /></Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
