import { Eraser, FormInput, MousePointerClick, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AgentPanel } from '@/components/browser-actions/AgentPanel';
import { FormFillPanel } from '@/components/browser-actions/FormFillPanel';
import { Button, Empty, Select, cx } from '@/components/common/ui';
import { MemorySuggestions } from '@/components/memory/MemorySuggestions';
import { useActiveTab } from '@/hooks/useActiveTab';
import { modelsOfKind } from '@/services/ollama';
import { useApp } from '@/stores/app';
import { useChat } from '@/stores/chat';
import { Composer } from './Composer';
import { ContextBar } from './ContextBar';
import { MessageView } from './MessageView';
import { TabIndicator } from './TabIndicator';

const STARTERS = ['Summarize this page', 'What are the key points and action items here?', 'Explain the selected text simply', 'Draft a reply using my writing style'];

export function ChatPage() {
  const tabState = useActiveTab();
  const messages = useChat((s) => s.messages);
  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const regenerate = useChat((s) => s.regenerate);
  const newConversation = useChat((s) => s.newConversation);
  const clearContext = useChat((s) => s.clearContext);
  const modelOverride = useChat((s) => s.modelOverride);
  const setModelOverride = useChat((s) => s.setModelOverride);
  const models = useApp((s) => s.models);
  const settings = useApp((s) => s.settings);
  const automation = useApp((s) => s.config.automation);
  const [panel, setPanel] = useState<'none' | 'agent' | 'form'>('none');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const chatModels = models ? modelsOfKind(models.models, 'chat') : [];
  const current = modelOverride ?? settings?.chat_model ?? '';
  const canAct = tabState.access === 'granted' || tabState.access === 'temporary';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Select
          value={current}
          onChange={(e) => setModelOverride(e.target.value === settings?.chat_model ? null : e.target.value)}
          aria-label="Chat model"
          className="h-7 min-w-0 flex-1 text-xs"
          title="Model for this conversation"
        >
          {!current && <option value="">No model selected</option>}
          {chatModels.map((m) => (
            <option key={m.name} value={m.name}>{m.name}{m.parameter_size ? ` · ${m.parameter_size}` : ''}{m.name === settings?.chat_model ? ' (default)' : ''}</option>
          ))}
          {current && !chatModels.some((m) => m.name === current) && <option value={current}>{current} (not found)</option>}
        </Select>
        {automation && (
          <>
            <Button size="icon" variant={panel === 'form' ? 'secondary' : 'ghost'} aria-label="Fill a form" title={canAct ? 'Fill a form on this page' : 'Grant website access first'} disabled={!canAct} onClick={() => setPanel(panel === 'form' ? 'none' : 'form')}>
              <FormInput className="size-4" />
            </Button>
            <Button size="icon" variant={panel === 'agent' ? 'secondary' : 'ghost'} aria-label="Browser actions" title={canAct ? 'Plan browser actions (with approval)' : 'Grant website access first'} disabled={!canAct} onClick={() => setPanel(panel === 'agent' ? 'none' : 'agent')}>
              <MousePointerClick className="size-4" />
            </Button>
          </>
        )}
        <Button size="icon" variant="ghost" aria-label="Clear context" title="Clear tabs, attachments and captured page" onClick={clearContext}><Eraser className="size-4" /></Button>
        <Button size="icon" variant="ghost" aria-label="New conversation" title="New conversation" onClick={newConversation}><Plus className="size-4" /></Button>
      </div>
      <TabIndicator state={tabState} />
      {panel !== 'none' && tabState.tab && (
        <div className="max-h-[60%] overflow-auto border-b border-border bg-card">
          <div className="flex items-center justify-between px-3 pt-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{panel === 'agent' ? 'Browser actions' : 'Form filling'}</h2>
            <button aria-label="Close panel" className="text-muted hover:text-fg" onClick={() => setPanel('none')}><X className="size-4" /></button>
          </div>
          {panel === 'agent' ? <AgentPanel tab={tabState.tab} onClose={() => setPanel('none')} /> : <FormFillPanel tab={tabState.tab} onClose={() => setPanel('none')} />}
        </div>
      )}
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <Empty icon={<Sparkles className="size-6 text-accent" />} title="Ask about this page or anything else">
            <div className="mt-2 flex flex-col gap-1.5">
              {STARTERS.map((s) => (
                <button key={s} className="rounded-md border border-border px-2.5 py-1.5 text-left text-xs text-fg hover:bg-subtle" onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          </Empty>
        ) : (
          messages.map((m, i) => (
            <MessageView key={m.id} msg={m} isLast={i === messages.length - 1} onRegenerate={!streaming && m.role === 'assistant' ? () => void regenerate() : undefined} />
          ))
        )}
      </div>
      <MemorySuggestions />
      <div className={cx('shrink-0 bg-bg')}>
        <ContextBar />
        <Composer />
      </div>
    </div>
  );
}
