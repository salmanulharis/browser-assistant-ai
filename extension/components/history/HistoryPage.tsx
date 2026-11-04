import { History, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, ConfirmDialog, Empty, ErrorNote, Input, Spinner, Tabs } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { api, describeError } from '@/services/api';
import { getActiveTab } from '@/services/tabs';
import { useApp } from '@/stores/app';
import { useChat } from '@/stores/chat';
import type { Conversation } from '@/types/api';

interface Hit { conversation_id: string; conversation_title: string; message_id: string; role: string; snippet: string; created_at: string }

const rel = (iso: string) => {
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  const mins = (Date.now() - d.getTime()) / 60000;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
};

export function HistoryPage() {
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'page'>('all');
  const [error, setError] = useState<{ message: string; hint?: string | null } | null>(null);
  const [toDelete, setToDelete] = useState<Conversation | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const loadConversation = useChat((s) => s.loadConversation);
  const currentId = useChat((s) => s.conversationId);
  const newConversation = useChat((s) => s.newConversation);
  const setPage = useApp((s) => s.setPage);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (scope === 'page') {
        const t = await getActiveTab();
        if (t?.url) params.set('page_url', t.url.split('#')[0]);
      }
      const [list, search] = await Promise.all([
        api.get<Conversation[]>(`/conversations?${params}`),
        q.length > 1 ? api.get<Hit[]>(`/conversations/search?q=${encodeURIComponent(q)}`) : Promise.resolve(null),
      ]);
      setItems(list);
      setHits(search);
      setError(null);
    } catch (e) {
      setError(describeError(e));
      setItems([]);
    }
  }, [q, scope]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const open = async (id: string) => {
    try {
      await loadConversation(id);
      setPage('chat');
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };

  const remove = async () => {
    const c = toDelete;
    setToDelete(null);
    if (!c) return;
    await api.del(`/conversations/${c.id}`).catch((e) => toast(describeError(e).message, 'bad'));
    if (c.id === currentId) newConversation();
    await load();
  };

  const rename = async () => {
    if (!renaming) return;
    await api.patch(`/conversations/${renaming.id}`, { title: renaming.title }).catch((e) => toast(describeError(e).message, 'bad'));
    setRenaming(null);
    await load();
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations and messages…" aria-label="Search history" />
        <Tabs value={scope} onChange={setScope} items={[{ id: 'all', label: 'All' }, { id: 'page', label: 'This page' }]} />
      </div>
      <ErrorNote error={error} onRetry={() => void load()} />
      {hits && hits.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted">Matching messages</p>
          {hits.slice(0, 10).map((h) => (
            <button key={h.message_id} className="block w-full rounded-md border border-border p-2 text-left text-xs hover:bg-subtle" onClick={() => void open(h.conversation_id)}>
              <span className="font-medium">{h.conversation_title}</span> <span className="text-muted">· {h.role}</span>
              <span className="mt-0.5 block line-clamp-2 text-muted">{h.snippet}</span>
            </button>
          ))}
        </div>
      )}
      {items === null ? <Spinner /> : items.length === 0 ? (
        <Empty icon={<History className="size-6" />} title="No conversations yet" />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-2.5 py-2 text-xs">
              <MessageSquare className="size-3.5 shrink-0 text-muted" />
              {renaming?.id === c.id ? (
                <Input className="h-7 text-xs" autoFocus value={renaming.title} onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(null); }} onBlur={() => void rename()} />
              ) : (
                <button className="min-w-0 flex-1 text-left" onClick={() => void open(c.id)}>
                  <span className={`block truncate font-medium ${c.id === currentId ? 'text-accent' : ''}`}>{c.title}</span>
                  <span className="block truncate text-muted">{c.message_count} messages · {rel(c.updated_at)}{c.page_title ? ` · ${c.page_title}` : ''}</span>
                </button>
              )}
              <Button size="icon" variant="ghost" aria-label="Rename" title="Rename" onClick={() => setRenaming({ id: c.id, title: c.title })}><Pencil className="size-3.5" /></Button>
              <Button size="icon" variant="ghost" aria-label="Delete" title="Delete" onClick={() => setToDelete(c)}><Trash2 className="size-3.5" /></Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!toDelete} title="Delete conversation?" danger confirmLabel="Delete" onConfirm={() => void remove()} onCancel={() => setToDelete(null)}>
        “{toDelete?.title}” and all its messages will be removed.
      </ConfirmDialog>
    </div>
  );
}
