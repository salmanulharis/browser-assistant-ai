import { Brain, Check, Download, Pencil, Pin, PinOff, Plus, Power, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ConfirmDialog, Empty, ErrorNote, Field, Input, Select, Spinner, Tabs, Textarea } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { api, ApiError, describeError } from '@/services/api';
import type { Memory, MemoryCategory } from '@/types/api';

type StatusTab = 'active' | 'pending' | 'disabled';
interface Draft { id?: string; content: string; title: string; category: string; pinned: boolean; expires: string }
const emptyDraft: Draft = { content: '', title: '', category: 'profile', pinned: false, expires: '' };

export function MemoryPage() {
  const [tab, setTab] = useState<StatusTab>('active');
  const [items, setItems] = useState<Memory[] | null>(null);
  const [cats, setCats] = useState<MemoryCategory[]>([]);
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sensitiveConfirm, setSensitiveConfirm] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Memory | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string | null } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ status: tab });
      if (q) params.set('q', q);
      if (catFilter) params.set('category', catFilter);
      const [list, c, pending] = await Promise.all([
        api.get<Memory[]>(`/memory?${params}`),
        api.get<MemoryCategory[]>('/memory/categories'),
        api.get<Memory[]>('/memory?status=pending'),
      ]);
      setItems(list);
      setCats(c);
      setPendingCount(pending.length);
      setError(null);
    } catch (e) {
      setError(describeError(e));
      setItems([]);
    }
  }, [tab, q, catFilter]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const save = async (allowSensitive = false) => {
    if (!draft || !draft.content.trim()) return;
    const body = {
      content: draft.content,
      title: draft.title || null,
      category: draft.category || null,
      pinned: draft.pinned,
      expires_at: draft.expires ? new Date(draft.expires).toISOString() : null,
    };
    try {
      if (draft.id) await api.patch(`/memory/${draft.id}`, { ...body, clear_expiry: !draft.expires });
      else await api.post(`/memory${allowSensitive ? '?allow_sensitive=true' : ''}`, body);
      toast('Memory saved.', 'ok');
      setDraft(null);
      setSensitiveConfirm(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SENSITIVE_CONTENT') setSensitiveConfirm(e.message);
      else toast(describeError(e).message, 'bad');
    }
  };

  const patch = async (m: Memory, body: Record<string, unknown>, msg: string) => {
    try {
      await api.patch(`/memory/${m.id}`, body);
      toast(msg, 'ok');
      await load();
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };

  const remove = async () => {
    const m = toDelete;
    setToDelete(null);
    if (!m) return;
    try {
      await api.del(`/memory/${m.id}`);
      await load();
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };

  const exportAll = async () => {
    const data = await api.get('/memory/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `local-ai-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const memories = (json.memories ?? json).map((m: Partial<Memory>) => ({
        content: m.content, title: m.title ?? null, category: m.category ?? null, pinned: !!m.pinned, expires_at: m.expires_at ?? null,
        status: m.status === 'disabled' ? 'disabled' : m.status === 'pending' ? 'pending' : 'active',
      }));
      const r = await api.post<{ imported: number }>('/memory/import', { memories });
      toast(`Imported ${r.imported} memories (duplicates skipped).`, 'ok');
      await load();
    } catch (e) {
      toast(`Import failed: ${describeError(e).message}`, 'bad');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onChange={setTab} items={[
          { id: 'active', label: 'Active' },
          { id: 'pending', label: <>Suggested{pendingCount ? <Badge tone="accent" className="ml-1">{pendingCount}</Badge> : null}</> },
          { id: 'disabled', label: 'Disabled' },
        ]} />
        <span className="flex-1" />
        <Button size="sm" variant="primary" onClick={() => setDraft({ ...emptyDraft })}><Plus className="size-3.5" /> Add</Button>
        <Button size="icon" variant="ghost" title="Export JSON" aria-label="Export memories" onClick={() => void exportAll()}><Download className="size-3.5" /></Button>
        <Button size="icon" variant="ghost" title="Import JSON" aria-label="Import memories" onClick={() => importRef.current?.click()}><Upload className="size-3.5" /></Button>
        <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
      </div>
      <div className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories…" aria-label="Search memories" />
        <Select className="w-32" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} aria-label="Category filter">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </Select>
      </div>

      {draft && (
        <div className="space-y-2 rounded-lg border border-accent/40 p-3">
          <Field label="What should the assistant remember?">
            <Textarea rows={3} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="e.g. I'm a frontend developer with 6 years of React experience." autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Title (optional)"><Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field>
            <Field label="Category">
              <Select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Expires (optional)"><Input type="date" value={draft.expires} onChange={(e) => setDraft({ ...draft, expires: e.target.value })} /></Field>
            <label className="flex items-end gap-1.5 pb-1.5 text-xs"><input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} /> Pin (always include)</label>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setDraft(null)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={() => void save()} disabled={!draft.content.trim()}>Save</Button>
          </div>
        </div>
      )}

      <ErrorNote error={error} onRetry={() => void load()} />
      {items === null ? <Spinner /> : items.length === 0 ? (
        <Empty icon={<Brain className="size-6" />} title={tab === 'pending' ? 'No suggestions waiting' : 'Nothing here yet'}>
          {tab === 'active' ? 'Add facts about yourself – skills, projects, preferences – to personalise answers and form filling.' : null}
        </Empty>
      ) : (
        <ul className="space-y-1.5">
          {items.map((m) => (
            <li key={m.id} className="rounded-md border border-border p-2 text-xs">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {m.title && <p className="font-medium">{m.title}</p>}
                  <p className="whitespace-pre-wrap">{m.content}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.category && <Badge>{m.category}</Badge>}
                    {m.pinned && <Badge tone="accent">pinned</Badge>}
                    {m.source !== 'user' && <Badge>{m.source}</Badge>}
                    {m.expires_at && <Badge tone={new Date(m.expires_at) < new Date() ? 'bad' : 'warn'}>expires {new Date(m.expires_at).toLocaleDateString()}</Badge>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-0.5">
                  {m.status === 'pending' ? (
                    <>
                      <Button size="icon" variant="ghost" title="Approve" aria-label="Approve memory" onClick={() => void patch(m, { status: 'active' }, 'Saved.')}><Check className="size-3.5 text-ok" /></Button>
                      <Button size="icon" variant="ghost" title="Reject" aria-label="Reject memory" onClick={() => setToDelete(m)}><X className="size-3.5" /></Button>
                    </>
                  ) : (
                    <>
                      <Button size="icon" variant="ghost" title={m.pinned ? 'Unpin' : 'Pin'} aria-label={m.pinned ? 'Unpin' : 'Pin'} onClick={() => void patch(m, { pinned: !m.pinned }, m.pinned ? 'Unpinned.' : 'Pinned.')}>
                        {m.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                      </Button>
                      <Button size="icon" variant="ghost" title={m.status === 'active' ? 'Disable' : 'Enable'} aria-label={m.status === 'active' ? 'Disable' : 'Enable'} onClick={() => void patch(m, { status: m.status === 'active' ? 'disabled' : 'active' }, m.status === 'active' ? 'Disabled.' : 'Enabled.')}>
                        <Power className="size-3.5" />
                      </Button>
                    </>
                  )}
                  <Button size="icon" variant="ghost" title="Edit" aria-label="Edit memory" onClick={() => setDraft({ id: m.id, content: m.content, title: m.title ?? '', category: m.category ?? '', pinned: m.pinned, expires: m.expires_at ? m.expires_at.slice(0, 10) : '' })}><Pencil className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" title="Delete" aria-label="Delete memory" onClick={() => setToDelete(m)}><Trash2 className="size-3.5" /></Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!toDelete} title="Delete this memory?" danger confirmLabel="Delete" onConfirm={() => void remove()} onCancel={() => setToDelete(null)}>
        It will be removed permanently from the database and the vector index.
      </ConfirmDialog>
      <ConfirmDialog open={!!sensitiveConfirm} title="Save sensitive information?" danger confirmLabel="Save anyway" onConfirm={() => void save(true)} onCancel={() => setSensitiveConfirm(null)}>
        {sensitiveConfirm} Stored memories may be included in prompts to your local model.
      </ConfirmDialog>
    </div>
  );
}
