import { Layers, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Empty, Spinner } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { hasHostAccess, hasPermission, requestHostAccess, requestPermission } from '@/services/permissions';
import { hostOf, isRestrictedUrl, listTabs, type TabSummary } from '@/services/tabs';
import { useChat } from '@/stores/chat';

/** Explicit tab selection for multi-tab context. Never reads tabs that aren't selected. */
export function TabPicker({ onClose }: { onClose: () => void }) {
  const selected = useChat((s) => s.selectedTabIds);
  const setSelected = useChat((s) => s.setSelectedTabs);
  const [tabsPerm, setTabsPerm] = useState<boolean | null>(null);
  const [tabs, setTabs] = useState<(TabSummary & { access: boolean })[] | null>(null);

  const load = async () => {
    const all = await listTabs();
    setTabs(await Promise.all(all.map(async (t) => ({ ...t, access: !!t.url && (await hasHostAccess(t.url)) }))));
  };

  useEffect(() => {
    void hasPermission('tabs').then((ok) => {
      setTabsPerm(ok);
      if (ok) void load();
    });
  }, []);

  if (tabsPerm === null) return <div className="p-4"><Spinner /></div>;
  if (!tabsPerm) {
    return (
      <div className="space-y-2 p-3 text-xs">
        <p>To choose other tabs, the extension needs the optional <b>Tabs</b> permission (titles and URLs of open tabs). Pages are only read after you select them.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => requestPermission('tabs').then((ok) => { setTabsPerm(ok); if (ok) void load(); else toast('Permission not granted.', 'bad'); })}>Allow tab list</Button>
          <Button size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    );
  }
  if (!tabs) return <div className="p-4"><Spinner /></div>;
  const toggle = (id: number) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].slice(0, 8));
  const candidates = tabs.filter((t) => !t.active && !isRestrictedUrl(t.url));
  return (
    <div className="max-h-72 overflow-auto p-1">
      {candidates.length === 0 && <Empty icon={<Layers className="size-5" />} title="No other tabs in this window" />}
      {candidates.map((t) => (
        <div key={t.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-subtle">
          <input id={`tab-${t.id}`} type="checkbox" checked={selected.includes(t.id)} disabled={!t.access} onChange={() => toggle(t.id)} />
          <label htmlFor={`tab-${t.id}`} className="min-w-0 flex-1 text-xs">
            <span className="block truncate font-medium">{t.title}</span>
            <span className="block truncate text-muted">{hostOf(t.url)}</span>
          </label>
          {!t.access && (
            <Button size="sm" variant="ghost" title="Grant access to read this site" onClick={() => requestHostAccess(t.url).then((ok) => { if (ok) void load(); })}>
              <Lock className="size-3" /> Allow
            </Button>
          )}
        </div>
      ))}
      <div className="flex justify-end gap-2 p-1">
        {selected.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button>}
        <Button size="sm" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}
