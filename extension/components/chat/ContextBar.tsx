import { FileText, History, Layers, Library, SlidersHorizontal, StickyNote, TextSelect, User, X, Globe } from 'lucide-react';
import { useState } from 'react';
import { cx } from '@/components/common/ui';
import { useChat } from '@/stores/chat';
import { useApp } from '@/stores/app';
import type { ContextToggles } from '@/types/config';
import { TabPicker } from './TabPicker';

const SOURCES: { key: keyof ContextToggles; label: string; Icon: typeof Globe }[] = [
  { key: 'page', label: 'Page', Icon: Globe },
  { key: 'selection', label: 'Selection', Icon: TextSelect },
  { key: 'tabs', label: 'Tabs', Icon: Layers },
  { key: 'memory', label: 'Memory', Icon: User },
  { key: 'knowledge', label: 'Knowledge', Icon: Library },
  { key: 'history', label: 'History', Icon: History },
  { key: 'samples', label: 'Samples', Icon: StickyNote },
];

/** Per-source toggles + selected tabs + attached documents. */
export function ContextBar() {
  const toggles = useChat((s) => s.toggles);
  const setToggles = useChat((s) => s.setToggles);
  const selectedTabs = useChat((s) => s.selectedTabIds);
  const docs = useChat((s) => s.attachedDocs);
  const detach = useChat((s) => s.detachDoc);
  const notes = useChat((s) => s.notes);
  const multiTab = useApp((s) => s.config.multiTab);
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState(false);

  return (
    <div className="border-t border-border">
      {notes.length > 0 && (
        <ul className="space-y-0.5 px-3 pt-1.5 text-[0.7rem] text-warn">
          {notes.map((n, i) => <li key={i}>• {n}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1 px-2 pt-1.5">
        <button
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.7rem] text-muted hover:bg-subtle hover:text-fg"
          title="Choose context sources"
        >
          <SlidersHorizontal className="size-3" /> Sources
        </button>
        {SOURCES.filter((s) => toggles[s.key]).map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-[0.7rem] text-muted">
            <s.Icon className="size-3" aria-hidden /> {s.label}
          </span>
        ))}
        {multiTab && (
          <button onClick={() => setPicker(!picker)} className="inline-flex items-center gap-1 rounded border border-dashed border-border px-1.5 py-0.5 text-[0.7rem] text-muted hover:text-fg" aria-expanded={picker}>
            <Layers className="size-3" /> {selectedTabs.length ? `${selectedTabs.length} tab(s)` : 'Add tabs'}
          </button>
        )}
        {docs.map((d) => (
          <span key={d.id} className="inline-flex max-w-40 items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[0.7rem] text-accent">
            <FileText className="size-3 shrink-0" /> <span className="truncate">{d.name}</span>
            <button aria-label={`Detach ${d.name}`} onClick={() => detach(d.id)}><X className="size-3" /></button>
          </span>
        ))}
      </div>
      {expanded && (
        <div className="grid grid-cols-2 gap-x-3 px-3 py-1.5" role="group" aria-label="Context sources">
          {SOURCES.map((s) => (
            <label key={s.key} className={cx('flex items-center gap-1.5 py-0.5 text-xs', !toggles[s.key] && 'text-muted')}>
              <input type="checkbox" checked={toggles[s.key]} onChange={(e) => setToggles({ [s.key]: e.target.checked })} />
              <s.Icon className="size-3" aria-hidden /> {s.label}
            </label>
          ))}
        </div>
      )}
      {picker && (
        <div className="mx-2 mt-1 rounded-md border border-border bg-bg">
          <TabPicker onClose={() => setPicker(false)} />
        </div>
      )}
    </div>
  );
}
