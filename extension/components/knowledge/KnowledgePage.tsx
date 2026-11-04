import { FileText, Library, MessageSquarePlus, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ConfirmDialog, Empty, ErrorNote, Input, Select, Spinner, cx } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { api, describeError } from '@/services/api';
import { readTabCached } from '@/services/context-manager';
import { getActiveTab } from '@/services/tabs';
import { useApp } from '@/stores/app';
import { useChat } from '@/stores/chat';
import type { DocumentInfo, KnowledgeHit } from '@/types/api';

const STATUS_TONE = { indexed: 'ok', processing: 'accent', pending: 'neutral', failed: 'bad' } as const;
const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function KnowledgePage() {
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [collections, setCollections] = useState<{ name: string; document_count: number }[]>([]);
  const [collection, setCollection] = useState('');
  const [uploadCollection, setUploadCollection] = useState('default');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string | null } | null>(null);
  const [preview, setPreview] = useState<DocumentInfo | null>(null);
  const [toDelete, setToDelete] = useState<DocumentInfo | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const embeddingModel = useApp((s) => s.settings?.embedding_model);
  const attach = useChat((s) => s.attachDoc);
  const setPage = useApp((s) => s.setPage);

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([
        api.get<DocumentInfo[]>(`/knowledge${collection ? `?collection=${encodeURIComponent(collection)}` : ''}`),
        api.get<{ name: string; document_count: number }[]>('/knowledge/collections'),
      ]);
      setDocs(d);
      setCollections(c);
      setError(null);
    } catch (e) {
      setError(describeError(e));
      setDocs([]);
    }
  }, [collection]);

  useEffect(() => { void load(); }, [load]);

  // Poll only while something is being indexed.
  useEffect(() => {
    if (!docs?.some((d) => d.status === 'pending' || d.status === 'processing')) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [docs, load]);

  const upload = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append('files', f));
      fd.append('collection', uploadCollection || 'default');
      const res = await api.post<{ documents: DocumentInfo[]; errors: { filename: string; message: string }[] }>('/knowledge/upload', fd, { timeoutMs: 180_000 });
      const dup = res.documents.filter((d) => d.duplicate).length;
      if (res.documents.length) toast(`Uploaded ${res.documents.length - dup} file(s)${dup ? `, ${dup} already present` : ''}.`, 'ok');
      res.errors.forEach((e) => toast(`${e.filename}: ${e.message}`, 'bad'));
      await load();
    } catch (e) {
      toast(describeError(e).message, 'bad');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const savePage = async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    try {
      const page = await readTabCached(tab, 0);
      const content = page.main_text || page.paragraphs.join('\n\n');
      await api.post('/knowledge/save-page', { url: page.url, title: page.title || tab.title, content, collection: 'web-pages' });
      toast('Page saved to the knowledge base.', 'ok');
      await load();
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };

  const search = async () => {
    if (!query.trim()) return setHits(null);
    setSearching(true);
    try {
      setHits(await api.post<KnowledgeHit[]>('/knowledge/search', { query, collection: collection || null }, { timeoutMs: 60_000 }));
    } catch (e) {
      toast(describeError(e).message, 'bad');
    } finally {
      setSearching(false);
    }
  };

  const reindex = async (d: DocumentInfo) => {
    setDocs((cur) => cur?.map((x) => (x.id === d.id ? { ...x, status: 'processing' } : x)) ?? null);
    try {
      const r = await api.post<DocumentInfo>(`/knowledge/${d.id}/reindex`, undefined, { timeoutMs: 600_000 });
      toast(r.status === 'indexed' ? `Re-indexed ${r.original_name}.` : `Re-index failed: ${r.error}`, r.status === 'indexed' ? 'ok' : 'bad');
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
    await load();
  };

  const remove = async () => {
    const d = toDelete;
    setToDelete(null);
    if (!d) return;
    try {
      await api.del(`/knowledge/${d.id}`);
      toast('Document and its vectors deleted.', 'ok');
      await load();
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };

  const openPreview = async (d: DocumentInfo) => {
    try {
      setPreview(await api.get<DocumentInfo>(`/knowledge/${d.id}?preview=8`));
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(Array.from(e.dataTransfer.files)); }}
        className={cx('rounded-lg border border-dashed p-3 text-center text-xs', drag ? 'border-accent bg-accent/5' : 'border-border')}
      >
        <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.html,.htm" onChange={(e) => void upload(e.target.files)} />
        <p className="mb-2 text-muted">Drop PDF, DOCX, PPTX, XLSX, TXT or Markdown files here</p>
        <div className="flex items-center justify-center gap-2">
          <Input className="h-7 w-32 text-xs" value={uploadCollection} onChange={(e) => setUploadCollection(e.target.value)} placeholder="collection" aria-label="Upload collection" list="lba-collections" />
          <datalist id="lba-collections">{collections.map((c) => <option key={c.name} value={c.name} />)}</datalist>
          <Button size="sm" variant="primary" loading={uploading} onClick={() => fileRef.current?.click()}><Upload className="size-3.5" /> Upload</Button>
          <Button size="sm" onClick={() => void savePage()} title="Save the current page's text into the knowledge base">Save current page</Button>
        </div>
        {!embeddingModel && <p className="mt-2 text-warn">No embedding model selected – documents will be stored but not searchable until you choose one in Settings.</p>}
      </div>

      <div className="flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} placeholder="Search your documents…" aria-label="Search knowledge" />
        <Button onClick={() => void search()} loading={searching} aria-label="Search"><Search className="size-4" /></Button>
      </div>
      {hits && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted">{hits.length ? `${hits.length} relevant passage(s)` : 'No passages above the relevance threshold.'}</p>
          {hits.map((h) => (
            <div key={`${h.document_id}:${h.chunk_index}`} className="rounded-md border border-border p-2 text-xs">
              <div className="mb-1 flex items-center gap-2"><FileText className="size-3 text-muted" /><span className="flex-1 truncate font-medium">{h.document_name}</span><span className="text-muted">{h.location ?? `chunk ${h.chunk_index + 1}`}</span><Badge tone="accent">{h.score.toFixed(2)}</Badge></div>
              <p className="line-clamp-4 text-muted">{h.content}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[0.9rem] font-semibold">Documents</h2>
        <Select className="h-7 w-36 text-xs" value={collection} onChange={(e) => setCollection(e.target.value)} aria-label="Filter by collection">
          <option value="">All collections</option>
          {collections.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.document_count})</option>)}
        </Select>
        <Button size="icon" variant="ghost" aria-label="Refresh" onClick={() => void load()}><RefreshCw className="size-3.5" /></Button>
      </div>
      <ErrorNote error={error} onRetry={() => void load()} />
      {docs === null ? <Spinner /> : docs.length === 0 ? (
        <Empty icon={<Library className="size-6" />} title="No documents yet">Upload files to let the assistant answer from them with citations.</Empty>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {docs.map((d) => {
            const stale = d.status === 'indexed' && embeddingModel && d.embedded_model && d.embedded_model !== embeddingModel;
            return (
              <li key={d.id} className="px-2.5 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <button className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => void openPreview(d)} title="Preview">{d.original_name}</button>
                  <Badge tone={STATUS_TONE[d.status]}>{d.status === 'processing' ? 'indexing…' : d.status}</Badge>
                  <Button size="icon" variant="ghost" title="Use in chat" aria-label={`Use ${d.original_name} in chat`} onClick={() => { attach({ id: d.id, name: d.original_name }); setPage('chat'); }}><MessageSquarePlus className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" title="Re-index" aria-label={`Re-index ${d.original_name}`} onClick={() => void reindex(d)}><RefreshCw className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" title="Delete" aria-label={`Delete ${d.original_name}`} onClick={() => setToDelete(d)}><Trash2 className="size-3.5" /></Button>
                </div>
                <p className="mt-0.5 text-muted">{d.collection} · {fmtBytes(d.size_bytes)} · {d.chunk_count} chunks{d.source_url ? ` · ${new URL(d.source_url).hostname}` : ''}</p>
                {d.error && <p className="mt-0.5 text-bad">{d.error}</p>}
                {stale && <p className="mt-0.5 text-warn">Indexed with {d.embedded_model}; re-index to use {embeddingModel}.</p>}
              </li>
            );
          })}
        </ul>
      )}
      {preview && (
        <div className="rounded-lg border border-border p-2 text-xs">
          <div className="mb-1 flex items-center"><h3 className="flex-1 font-semibold">{preview.original_name}</h3><Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Close</Button></div>
          {(preview.preview ?? []).map((c) => (
            <div key={c.chunk_index} className="border-t border-border py-1.5">
              <p className="text-muted">Chunk {c.chunk_index + 1}{c.location ? ` · ${c.location}` : ''} · ~{c.token_estimate} tokens</p>
              <p className="line-clamp-6 whitespace-pre-wrap">{c.content}</p>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!toDelete} title="Delete document?" danger confirmLabel="Delete" onConfirm={() => void remove()} onCancel={() => setToDelete(null)}>
        “{toDelete?.original_name}”, its chunks and vector records will be permanently removed.
      </ConfirmDialog>
    </div>
  );
}
