import { BookMarked, Copy, Globe, MessageSquarePlus, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { composerBus } from '@/components/chat/Composer';
import { Badge, Button, ConfirmDialog, Empty, ErrorNote, Field, Input, Select, Spinner, Tabs, Textarea } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { api, describeError } from '@/services/api';
import { useApp } from '@/stores/app';
import { useChat } from '@/stores/chat';
import type { PromptItem } from '@/types/api';

interface Draft { id?: string; title: string; content: string; kind: 'prompt' | 'sample'; category: string; tags: string; pinned: boolean }

export function PromptsPage() {
  const [kind, setKind] = useState<'prompt' | 'sample'>('prompt');
  const [items, setItems] = useState<PromptItem[] | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<PromptItem | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string | null } | null>(null);
  const setPage = useApp((s) => s.setPage);
  const send = useChat((s) => s.send);
  const setToggles = useChat((s) => s.setToggles);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ kind });
      if (q) p.set('q', q);
      if (category) p.set('category', category);
      setItems(await api.get<PromptItem[]>(`/prompts?${p}`));
      setError(null);
    } catch (e) {
      setError(describeError(e));
      setItems([]);
    }
  }, [kind, q, category]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const categories = [...new Set((items ?? []).map((i) => i.category).filter(Boolean))] as string[];

  const save = async () => {
    if (!draft) return;
    const body = { title: draft.title, content: draft.content, kind: draft.kind, category: draft.category || null, tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean), pinned: draft.pinned };
    try {
      if (draft.id) await api.patch(`/prompts/${draft.id}`, body);
      else await api.post('/prompts', body);
      setDraft(null);
      toast('Saved.', 'ok');
      await load();
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };

  const use = (p: PromptItem, withPage: boolean) => {
    void api.post(`/prompts/${p.id}/use`).catch(() => undefined);
    setPage('chat');
    if (withPage) {
      setToggles({ page: true });
      void send(p.content);
    } else {
      setTimeout(() => composerBus.insert(p.content), 0);
    }
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <Tabs value={kind} onChange={(k) => { setKind(k); setCategory(''); }} items={[{ id: 'prompt', label: 'Prompts' }, { id: 'sample', label: 'Sample answers' }]} />
        <span className="flex-1" />
        <Button size="sm" variant="primary" onClick={() => setDraft({ title: '', content: '', kind, category: '', tags: '', pinned: false })}><Plus className="size-3.5" /> New</Button>
      </div>
      {kind === 'sample' && <p className="text-xs text-muted">Samples are reusable answers (introductions, project descriptions, cover-letter paragraphs). The assistant retrieves relevant ones when writing similar content or filling forms.</p>}
      <div className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search prompts" />
        <Select className="w-32" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </div>
      {draft && (
        <div className="space-y-2 rounded-lg border border-accent/40 p-3">
          <Field label="Title"><Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus /></Field>
          <Field label={draft.kind === 'sample' ? 'Sample text' : 'Prompt'}><Textarea rows={5} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Type">
              <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}>
                <option value="prompt">Prompt</option><option value="sample">Sample answer</option>
              </Select>
            </Field>
            <Field label="Category"><Input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} /></Field>
            <Field label="Tags (comma)"><Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} /></Field>
          </div>
          <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} /> Pin</label>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setDraft(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!draft.title.trim() || !draft.content.trim()} onClick={() => void save()}>Save</Button>
          </div>
        </div>
      )}
      <ErrorNote error={error} onRetry={() => void load()} />
      {items === null ? <Spinner /> : items.length === 0 ? (
        <Empty icon={<BookMarked className="size-6" />} title={kind === 'prompt' ? 'No prompts' : 'No sample answers yet'} />
      ) : (
        <ul className="space-y-1.5">
          {items.map((p) => (
            <li key={p.id} className="rounded-md border border-border p-2 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
                {p.category && <Badge>{p.category}</Badge>}
                {p.pinned && <Pin className="size-3 text-accent" aria-label="Pinned" />}
              </div>
              <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-muted">{p.content}</p>
              <div className="mt-1 flex items-center gap-0.5">
                <Button size="sm" variant="ghost" onClick={() => use(p, false)} title="Insert into chat"><MessageSquarePlus className="size-3.5" /> Insert</Button>
                {p.kind === 'prompt' && <Button size="sm" variant="ghost" onClick={() => use(p, true)} title="Run with the current page as context"><Globe className="size-3.5" /> Use with page</Button>}
                <span className="flex-1" />
                <Button size="icon" variant="ghost" aria-label="Copy" title="Copy" onClick={() => navigator.clipboard.writeText(p.content).then(() => toast('Copied.', 'ok'))}><Copy className="size-3.5" /></Button>
                <Button size="icon" variant="ghost" aria-label={p.pinned ? 'Unpin' : 'Pin'} title={p.pinned ? 'Unpin' : 'Pin'} onClick={() => void api.patch(`/prompts/${p.id}`, { pinned: !p.pinned }).then(load)}>{p.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</Button>
                <Button size="icon" variant="ghost" aria-label="Edit" title="Edit" onClick={() => setDraft({ id: p.id, title: p.title, content: p.content, kind: p.kind, category: p.category ?? '', tags: p.tags.join(', '), pinned: p.pinned })}><Pencil className="size-3.5" /></Button>
                <Button size="icon" variant="ghost" aria-label="Delete" title="Delete" onClick={() => setToDelete(p)}><Trash2 className="size-3.5" /></Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!toDelete} title="Delete?" danger confirmLabel="Delete" onConfirm={() => { const p = toDelete; setToDelete(null); if (p) void api.del(`/prompts/${p.id}`).then(load); }} onCancel={() => setToDelete(null)}>
        “{toDelete?.title}” will be removed.
      </ConfirmDialog>
    </div>
  );
}
