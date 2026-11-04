import { BookMarked, Paperclip, SendHorizontal, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { api, describeError } from '@/services/api';
import { useChat } from '@/stores/chat';
import type { DocumentInfo, PromptItem } from '@/types/api';

export const composerBus = { insert: (_text: string) => {} };

export function Composer() {
  const [text, setText] = useState('');
  const [prompts, setPrompts] = useState<PromptItem[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const attach = useChat((s) => s.attachDoc);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    composerBus.insert = (t: string) => {
      setText((cur) => (cur ? `${cur}\n${t}` : t));
      ref.current?.focus();
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || streaming) return;
    setText('');
    void send(t);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append('files', f));
      fd.append('collection', 'chat-attachments');
      const res = await api.post<{ documents: DocumentInfo[]; errors: { filename: string; message: string }[] }>('/knowledge/upload', fd, { timeoutMs: 120_000 });
      res.documents.forEach((d) => attach({ id: d.id, name: d.original_name }));
      res.errors.forEach((e) => toast(`${e.filename}: ${e.message}`, 'bad'));
      if (res.documents.length) toast(`Attached ${res.documents.length} document(s). Indexing runs in the background.`, 'ok');
    } catch (e) {
      toast(describeError(e).message, 'bad');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const openPrompts = async () => {
    if (prompts) return setPrompts(null);
    try {
      setPrompts((await api.get<PromptItem[]>('/prompts?kind=prompt')).slice(0, 30));
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };

  return (
    <div className="relative px-2 pb-2 pt-1.5">
      {prompts && (
        <div className="absolute inset-x-2 bottom-full mb-1 max-h-60 overflow-auto rounded-md border border-border bg-bg p-1 shadow-lg" role="listbox" aria-label="Prompts">
          {prompts.length === 0 && <p className="p-2 text-xs text-muted">No prompts yet – add some on the Prompts page.</p>}
          {prompts.map((p) => (
            <button key={p.id} role="option" aria-selected={false} className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-subtle"
              onClick={() => { setText(p.content); setPrompts(null); void api.post(`/prompts/${p.id}/use`); ref.current?.focus(); }}>
              <span className="font-medium">{p.title}</span>
              <span className="block truncate text-muted">{p.content}</span>
            </button>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-border bg-bg focus-within:border-accent">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about this page, your documents, or anything…"
          aria-label="Message"
          className="block max-h-44 w-full resize-none bg-transparent px-3 py-2 text-[0.92rem] outline-none placeholder:text-muted"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.html,.htm" onChange={(e) => void upload(e.target.files)} />
          <Button size="icon" variant="ghost" aria-label="Attach document" title="Attach document" loading={uploading} onClick={() => fileRef.current?.click()}>
            {!uploading && <Paperclip className="size-4" />}
          </Button>
          <Button size="icon" variant="ghost" aria-label="Insert prompt" title="Insert a saved prompt" onClick={() => void openPrompts()}>
            <BookMarked className="size-4" />
          </Button>
          <span className="flex-1" />
          {streaming ? (
            <Button size="sm" variant="secondary" onClick={stop} aria-label="Stop generation"><Square className="size-3.5" /> Stop</Button>
          ) : (
            <Button size="icon" variant="primary" onClick={submit} disabled={!text.trim()} aria-label="Send message"><SendHorizontal className="size-4" /></Button>
          )}
        </div>
      </div>
    </div>
  );
}
