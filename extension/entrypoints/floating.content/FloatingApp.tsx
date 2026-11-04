import { useCallback, useEffect, useRef, useState } from 'react';
import { describeField, extractPage, setFieldValue } from '@/lib/page-agent-core';
import type { FloatingPublicConfig } from '@/types/messages';
import type { FormField } from '@/types/page';
import { sensitiveFieldReason } from '@/utils/sensitive';

type Action = 'explain' | 'summarize' | 'rewrite' | 'grammar' | 'translate' | 'generate' | 'ask' | 'key_points';
const SELECTION_ACTIONS: { id: Action; label: string }[] = [
  { id: 'explain', label: 'Explain' },
  { id: 'summarize', label: 'Summarize' },
  { id: 'rewrite', label: 'Rewrite' },
  { id: 'grammar', label: 'Fix grammar' },
  { id: 'translate', label: 'Translate' },
];

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICONS = {
  spark: 'M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z',
  min: 'M5 12h14',
  close: 'M18 6 6 18M6 6l12 12',
  panel: 'M3 4h18v16H3zM15 4v16',
  stop: 'M6 6h12v12H6z',
};

function sendMessage<T = Record<string, unknown>>(msg: unknown): Promise<T & { ok: boolean; error?: string; hint?: string }> {
  return chrome.runtime.sendMessage(msg);
}

function isEditable(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return ['text', 'email', 'search', 'url', 'tel', 'number', ''].includes(el.type);
  return (el as HTMLElement).isContentEditable;
}

export function FloatingApp({ initial, hostEl, startOpen = false }: { initial: FloatingPublicConfig; hostEl: HTMLElement; startOpen?: boolean }) {
  const [cfg] = useState(initial);
  const [open, setOpen] = useState(startOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const [selection, setSelection] = useState('');
  const [question, setQuestion] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [field, setField] = useState<{ el: HTMLElement; info: FormField } | null>(null);
  const [fieldValue, setFieldValueState] = useState<string | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(initial.offset);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  // --- selection + focused field tracking (event driven, no DOM polling) ---
  useEffect(() => {
    let t: number | undefined;
    const onSel = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const active = document.activeElement;
        if (active && hostEl.contains(active)) return;
        const s = window.getSelection()?.toString().trim() ?? '';
        if (s) setSelection(s.slice(0, 20000));
      }, 200);
    };
    const onFocus = (e: FocusEvent) => {
      const el = e.target as Element;
      if (hostEl.contains(el) || el === hostEl || !isEditable(el)) return;
      const info = describeField(el);
      if (info && !info.sensitive && !sensitiveFieldReason(info)) setField({ el: el as HTMLElement, info });
    };
    const onMsg = (msg: { type?: string }) => {
      if (msg?.type === 'floating:toggle') {
        setHidden(false);
        setOpen((o) => !o);
      }
    };
    document.addEventListener('selectionchange', onSel);
    document.addEventListener('focusin', onFocus, true);
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      document.removeEventListener('selectionchange', onSel);
      document.removeEventListener('focusin', onFocus, true);
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, [hostEl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const stop = useCallback(() => {
    portRef.current?.postMessage({ type: 'stop' });
    portRef.current?.disconnect();
    portRef.current = null;
    setBusy(false);
  }, []);

  const run = useCallback((action: Action, text: string, instructions = '') => {
    stop();
    setOutput('');
    setError(null);
    setNotice('');
    setBusy(true);
    const port = chrome.runtime.connect({ name: 'lba-assist' });
    portRef.current = port;
    port.onMessage.addListener((m) => {
      if (m.type === 'event' && m.event === 'delta') setOutput((o) => o + (m.data?.text ?? ''));
      else if (m.type === 'end') setBusy(false);
      else if (m.type === 'error') {
        setError({ message: m.message, hint: m.hint });
        setBusy(false);
      }
    });
    port.onDisconnect.addListener(() => setBusy(false));
    port.postMessage({ type: 'start', action, text, instructions, page: { url: location.href.split('#')[0], title: document.title } });
  }, [stop]);

  const ask = () => {
    const q = question.trim();
    if (!q && !selection) return;
    if (selection) run('ask', selection, q || 'Explain this.');
    else {
      const page = extractPage(document, { includeForms: false, includeLinks: false });
      run('ask', page.main_text.slice(0, 12000), q);
    }
  };

  const generate = () => {
    if (!question.trim()) return;
    run('generate', selection, question.trim());
  };

  const insertOutput = () => {
    if (!field || !output) return;
    if (!field.el.isConnected) return setError({ message: 'The field is no longer on the page.' });
    try {
      setFieldValue(field.el, output.trim());
      setNotice('Inserted into the field. Nothing was submitted.');
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    }
  };

  const generateForField = async () => {
    if (!field) return;
    setBusy(true);
    setError(null);
    setFieldValueState(null);
    const res = await sendMessage<{ result?: { suggestions: { value: string; note: string }[]; skipped: { reason: string }[] } }>({
      type: 'floating:generateField', field: field.info, page: { url: location.href.split('#')[0], title: document.title }, instructions: question,
    }).catch((e) => ({ ok: false, error: String(e) }) as { ok: false; error: string; result?: undefined });
    setBusy(false);
    if (!res.ok) return setError({ message: res.error ?? 'Failed', hint: (res as { hint?: string }).hint });
    const s = res.result?.suggestions?.[0];
    if (!s) return setError({ message: res.result?.skipped?.[0]?.reason ?? 'No value could be generated.' });
    setFieldValueState(s.value);
    if (s.note) setNotice(s.note);
  };

  const approveFieldValue = () => {
    if (!field || fieldValue == null) return;
    try {
      setFieldValue(field.el, fieldValue);
      setNotice('Value inserted. Review it before submitting the form yourself.');
      setFieldValueState(null);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    }
  };

  const sendToPanel = async () => {
    const page = extractPage(document);
    const res = await sendMessage<{ opened?: boolean }>({ type: 'floating:sendToPanel', page });
    setNotice(res.ok && res.opened ? 'Sent to the side panel.' : 'Page sent. Open the side panel from the toolbar icon to continue.');
  };

  // --- dragging ---
  const onPointerDown = (e: React.PointerEvent) => {
    const rect = (rootRef.current ?? hostEl).getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, moved: false };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) {
      const x = Math.min(Math.max(0, d.ox + dx), window.innerWidth - 44);
      const y = Math.min(Math.max(0, d.oy + dy), window.innerHeight - 44);
      setPos({ x, y });
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && pos) void sendMessage({ type: 'floating:savePosition', offset: pos });
    else if (d && !d.moved) setOpen((o) => !o);
  };

  if (hidden) return null;
  const [vert, horiz] = cfg.position.split('-') as ['top' | 'bottom', 'left' | 'right'];
  const placement = pos
    ? { left: pos.x, top: pos.y }
    : { [vert]: 20, [horiz]: 20 };
  const panelV = pos ? (pos.y > window.innerHeight / 2 ? 'bottom' : 'top') : vert;
  const panelH = pos ? (pos.x > window.innerWidth / 2 ? 'right' : 'left') : horiz;

  return (
    <div className="root" ref={rootRef} style={placement as React.CSSProperties}>
      {open && (
        <div className={`panel ${panelV} ${panelH}`} role="dialog" aria-label="Local AI assistant">
          <div className="head">
            <Icon d={ICONS.spark} />
            <span className="title">Local AI</span>
            <button className="icon-btn" title="Send this page to the side panel" aria-label="Send page to side panel" onClick={sendToPanel}><Icon d={ICONS.panel} /></button>
            <button className="icon-btn" title="Minimize" aria-label="Minimize" onClick={() => setOpen(false)}><Icon d={ICONS.min} /></button>
            <button className="icon-btn" title="Hide on this page" aria-label="Close" onClick={() => { stop(); setHidden(true); }}><Icon d={ICONS.close} /></button>
          </div>
          <div className="body">
            {!cfg.connected && <div className="err">Not paired with the backend yet – open the side panel → Settings → Connection.</div>}
            {selection && (
              <>
                <div className="label">Selection</div>
                <div className="sel">{selection.slice(0, 300)}</div>
                <div className="chips">
                  {SELECTION_ACTIONS.map((a) => (
                    <button key={a.id} className="chip" disabled={busy} onClick={() => run(a.id, selection)}>{a.label}</button>
                  ))}
                  <button className="chip" onClick={() => setSelection('')}>Clear</button>
                </div>
              </>
            )}
            <textarea
              value={question}
              placeholder={selection ? 'Ask about the selection…' : 'Ask about this page, or describe content to generate…'}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask();
                }
              }}
              aria-label="Question"
            />
            <div className="row">
              <button className="btn primary" disabled={busy || (!question.trim() && !selection)} onClick={ask}>Ask AI</button>
              <button className="btn" disabled={busy || !question.trim()} onClick={generate}>Generate</button>
              {field && <button className="btn" disabled={busy} onClick={generateForField} title={`Fill "${field.info.label || field.info.name}"`}>Fill field</button>}
              <span className="spacer" />
              {busy && <button className="icon-btn" aria-label="Stop" title="Stop" onClick={stop}><Icon d={ICONS.stop} /></button>}
            </div>
            {field && <div className="muted">Field: {field.info.label || field.info.name || field.info.placeholder || 'focused field'}</div>}
            {fieldValue != null && (
              <>
                <div className="label">Proposed value – review before inserting</div>
                <textarea value={fieldValue} onChange={(e) => setFieldValueState(e.target.value)} aria-label="Proposed value" />
                <div className="row">
                  <button className="btn primary" onClick={approveFieldValue}>Insert</button>
                  <button className="btn" onClick={generateForField}>Regenerate</button>
                  <button className="btn" onClick={() => setFieldValueState(null)}>Cancel</button>
                </div>
              </>
            )}
            {(output || busy) && fieldValue == null && (
              <>
                <div className="out" aria-live="polite">{output || 'Thinking…'}</div>
                {!busy && output && (
                  <div className="row">
                    <button className="btn" onClick={() => navigator.clipboard.writeText(output).then(() => setNotice('Copied.'))}>Copy</button>
                    {field && <button className="btn" onClick={insertOutput}>Insert into field</button>}
                  </div>
                )}
              </>
            )}
            {error && <div className="err">{error.message}{error.hint ? ` – ${error.hint}` : ''}</div>}
            {notice && <div className="ok">{notice}</div>}
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => { void sendMessage({ type: 'floating:disableSite' }); setHidden(true); }}>
              Disable on this site
            </button>
          </div>
        </div>
      )}
      <button
        className="launcher"
        aria-label={open ? 'Close Local AI assistant' : 'Open Local AI assistant'}
        aria-expanded={open}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        <Icon d={ICONS.spark} size={18} />
      </button>
    </div>
  );
}
