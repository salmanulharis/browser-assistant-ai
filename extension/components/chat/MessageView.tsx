import { Brain, Check, ChevronDown, Copy, FileText, Globe, History, Layers, Library, MousePointerClick, RefreshCw, StickyNote, TextSelect, User } from 'lucide-react';
import { AgentPanel } from '@/components/browser-actions/AgentPanel';
import { useApp } from '@/stores/app';
import { useChat } from '@/stores/chat';
import { useMemo, useState } from 'react';
import { Badge, cx, ErrorNote } from '@/components/common/ui';
import type { ChatMsg } from '@/stores/chat';
import type { Source, SourceType } from '@/types/api';
import { Markdown } from './Markdown';

export const SOURCE_META: Record<SourceType, { label: string; Icon: typeof Globe }> = {
  page: { label: 'Webpage', Icon: Globe },
  selection: { label: 'Selection', Icon: TextSelect },
  tab: { label: 'Tab', Icon: Layers },
  memory: { label: 'Your saved info', Icon: User },
  document: { label: 'Document', Icon: FileText },
  conversation: { label: 'Earlier chat', Icon: History },
  sample: { label: 'Sample', Icon: StickyNote },
  instruction: { label: 'Instruction', Icon: Library },
};

function SourceList({ sources, highlight }: { sources: Source[]; highlight: string | null }) {
  const [open, setOpen] = useState(false);
  const cited = sources.filter((s) => s.cited);
  const shown = open ? sources : cited.length ? cited : sources.slice(0, 3);
  return (
    <div className="mt-2 space-y-1">
      <button className="flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronDown className={cx('size-3 transition-transform', !open && '-rotate-90')} />
        {sources.length} source{sources.length === 1 ? '' : 's'} provided{cited.length ? ` · ${cited.length} cited` : ' · none cited'}
      </button>
      <ul className="space-y-1">
        {shown.map((s) => {
          const meta = SOURCE_META[s.type] ?? SOURCE_META.page;
          return (
            <li key={s.id} id={`src-${s.id}`} className={cx('rounded-md border px-2 py-1 text-xs', highlight === s.id ? 'border-accent bg-accent/5' : 'border-border')}>
              <div className="flex items-center gap-1.5">
                <Badge tone={s.cited ? 'accent' : 'neutral'}>{s.id}</Badge>
                <meta.Icon className="size-3 text-muted" aria-hidden />
                <span className="text-muted">{meta.label}</span>
                <span className="min-w-0 flex-1 truncate font-medium" title={s.title}>{s.title}</span>
                {s.location && <span className="shrink-0 text-muted">{s.location}</span>}
              </div>
              {open && s.snippet && <p className="mt-0.5 line-clamp-3 text-muted">{s.snippet}</p>}
              {open && s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" className="block truncate text-accent">{s.url}</a>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function MessageView({ msg, isLast, onRegenerate }: { msg: ChatMsg; isLast: boolean; onRegenerate?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const validIds = useMemo(() => new Set((msg.sources ?? []).map((s) => s.id)), [msg.sources]);
  const automation = useApp((s) => s.config.automation);
  const busy = useChat((s) => s.streaming);

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap rounded-lg bg-subtle px-3 py-2 text-[0.92rem]">{msg.content}</div>
      </div>
    );
  }
  if (msg.action) {
    return (
      <div className="space-y-1">
        <p className="flex items-center gap-1 text-xs font-medium text-muted"><MousePointerClick className="size-3.5" /> Page edit</p>
        <AgentPanel tab={msg.action.tab} initialTask={msg.action.task} autoStart embedded onClose={() => {}} />
      </div>
    );
  }
  const stopped = Boolean(msg.stats?.stopped);
  return (
    <div className="group space-y-1">
      {msg.thinking && (
        <div>
          <button className="flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => setShowThinking(!showThinking)} aria-expanded={showThinking}>
            <Brain className="size-3" /> {msg.streaming && !msg.content ? 'Reasoning…' : 'Reasoning'}
            <ChevronDown className={cx('size-3 transition-transform', !showThinking && '-rotate-90')} />
          </button>
          {showThinking && <p className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-2 text-xs text-muted">{msg.thinking}</p>}
        </div>
      )}
      {msg.content ? (
        <Markdown
          text={msg.content}
          validIds={validIds}
          onCite={(id) => {
            setHighlight(id);
            document.getElementById(`src-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }}
        />
      ) : msg.streaming ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="inline-flex gap-0.5">
            {[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted" style={{ animationDelay: `${i * 150}ms` }} />)}
          </span>
          {msg.sources?.length ? `Using ${msg.sources.length} source(s) · loading model…` : 'Waiting for the model…'}
        </div>
      ) : null}
      <ErrorNote error={msg.error ?? null} onRetry={isLast ? onRegenerate : undefined} />
      {!!msg.invalidCitations?.length && (
        <p className="text-xs text-bad">The answer referenced sources that were not provided ({msg.invalidCitations.join(', ')}); they are struck through.</p>
      )}
      {!!msg.sources?.length && !msg.streaming && <SourceList sources={msg.sources} highlight={highlight} />}
      {!msg.streaming && msg.content && (
        <div className="flex items-center gap-1 pt-0.5 text-muted opacity-70 transition-opacity group-hover:opacity-100">
          <button className="rounded p-1 hover:bg-subtle hover:text-fg" aria-label="Copy response" title="Copy" onClick={() => navigator.clipboard.writeText(msg.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          {isLast && onRegenerate && (
            <button className="rounded p-1 hover:bg-subtle hover:text-fg" aria-label="Regenerate response" title="Regenerate" onClick={onRegenerate}>
              <RefreshCw className="size-3.5" />
            </button>
          )}
          {automation && (
            <button
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-subtle hover:text-fg disabled:opacity-50"
              title="Put this answer into the matching fields on the current page (you review every change first)"
              disabled={busy}
              onClick={() => void useChat.getState().act('Fill the matching fields on this page using these details.', { display: 'Apply this answer to the page', reference: msg.content })}
            >
              <MousePointerClick className="size-3.5" /> Apply to page
            </button>
          )}
          <span className="ml-1 text-[0.7rem]">
            {msg.model ? msg.model.split('/').pop() : ''}
            {typeof msg.stats?.duration_ms === 'number' ? ` · ${(Number(msg.stats.duration_ms) / 1000).toFixed(1)}s` : ''}
            {typeof msg.stats?.tokens_per_second === 'number' ? ` · ${msg.stats.tokens_per_second} tok/s` : ''}
            {stopped ? ' · stopped' : ''}
          </span>
        </div>
      )}
    </div>
  );
}
