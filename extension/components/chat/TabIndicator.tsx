import { Globe, Lock, ShieldAlert, X } from 'lucide-react';
import type { ActiveTabState } from '@/hooks/useActiveTab';
import { Badge, Button } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { requestHostAccess, requestPermission } from '@/services/permissions';

export const SITE_MENU_HINT =
  'You can also allow it from Chrome: click the puzzle icon → Local Browser AI → "This can read and change site data" → "On this site".';
import { hostOf } from '@/services/tabs';
import { useApp } from '@/stores/app';
import { useChat } from '@/stores/chat';
import { isExcludedHost } from '@/utils/sensitive';

/** Shows which page the assistant is looking at and whether it may read it. */
export function TabIndicator({ state }: { state: ActiveTabState }) {
  const { tab, access, refresh } = state;
  const handoff = useChat((s) => s.handoffPage);
  const setHandoff = useChat((s) => s.setHandoffPage);
  const forceRead = useChat((s) => s.forceRead);
  const setForceRead = useChat((s) => s.setForceRead);
  const excludedSites = useApp((s) => s.config.excludedSites);

  if (handoff) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-accent/5 px-3 py-1.5 text-xs">
        <Globe className="size-3.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{handoff.title || handoff.url}</p>
          <p className="truncate text-muted">{handoff.selected_text ? `Selection: “${handoff.selected_text.slice(0, 80)}”` : 'Captured page (used as context)'}</p>
        </div>
        <button aria-label="Stop using captured page" title="Use the active tab instead" className="text-muted hover:text-fg" onClick={() => setHandoff(null)}><X className="size-3.5" /></button>
      </div>
    );
  }
  if (!tab) return null;
  const host = hostOf(tab.url);
  const excluded = host && isExcludedHost(host, excludedSites);

  // chrome.permissions.request() must be the first async call in the click handler.
  const grant = () => {
    if (!tab.url) {
      // Chrome hides the URL until we have "tabs" or site access, so we cannot know which
      // site to request yet. Step 1: ask for "tabs" to see the site; step 2 is a second click.
      requestPermission('tabs')
        .then((ok) => {
          toast(ok ? 'Now click "Allow" to give access to this site.' : SITE_MENU_HINT, ok ? 'ok' : 'bad');
          refresh();
        })
        .catch((e: Error) => toast(e.message, 'bad'));
      return;
    }
    requestHostAccess(tab.url)
      .then((ok) => {
        toast(ok ? `Access granted for ${host}.` : `Access to ${host} was not granted. ${SITE_MENU_HINT}`, ok ? 'ok' : 'bad');
        refresh();
      })
      .catch((e: Error) => toast(e.message, 'bad'));
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
      {tab.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl) ? (
        <img src={tab.favIconUrl} alt="" className="size-3.5 shrink-0 rounded-sm" />
      ) : (
        <Globe className="size-3.5 shrink-0 text-muted" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={tab.title}>{tab.title || 'Current tab'}</p>
        <p className="truncate text-muted" title={tab.url}>{tab.url || (access === 'permission' ? 'URL hidden until access is granted' : '')}</p>
      </div>
      {access === 'granted' && !excluded && <Badge tone="ok">Can read</Badge>}
      {access === 'temporary' && !excluded && <Badge tone="accent" className="shrink-0" >Temporary access</Badge>}
      {excluded && (access === 'granted' || access === 'temporary') && (
        forceRead ? <Badge tone="warn">Reading once</Badge> : (
          <Button size="sm" variant="ghost" onClick={() => setForceRead(true)} title="This site is excluded from automatic capture">
            <ShieldAlert className="size-3.5" /> Read anyway
          </Button>
        )
      )}
      {access === 'permission' && (
        <Button size="sm" variant="primary" onClick={grant} title="Website access permission is required to read this page.">
          <Lock className="size-3.5" /> {tab.url && host ? `Allow ${host}` : 'Grant website access'}
        </Button>
      )}
      {access === 'restricted' && <Badge tone="neutral">Protected page</Badge>}
    </div>
  );
}
