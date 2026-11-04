import { AlertTriangle, Ban, CheckCircle2, Crosshair, Play, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, ConfirmDialog, ErrorNote, Spinner, Textarea, cx } from '@/components/common/ui';
import { describeError } from '@/services/api';
import { executeApproved, highlightRef, localPolicy, planTask, reportResults, type ReviewedAction } from '@/services/browser-agent';
import { readTabCached } from '@/services/context-manager';
import type { TabSummary } from '@/services/tabs';
import { useApp } from '@/stores/app';
import type { BrowserTask } from '@/types/api';
import type { ElementInfo, ExecutionResult } from '@/types/page';

type Phase = 'idle' | 'planning' | 'review' | 'executing' | 'done';

function describe(a: ReviewedAction): string {
  const t = a.element?.label || a.element?.text || a.action.target?.label || a.action.target?.ref || '';
  switch (a.action.type) {
    case 'fill':
    case 'type': return `Fill “${t}”`;
    case 'select': return `Select in “${t}”`;
    case 'click': return `Click “${t}”`;
    case 'navigate': return `Open ${a.action.url}`;
    case 'scroll': return t ? `Scroll to “${t}”` : `Scroll ${a.action.direction ?? 'down'}`;
    default: return `${a.action.type[0].toUpperCase()}${a.action.type.slice(1)} “${t}”`;
  }
}

export function AgentPanel({ tab, onClose, initialTask = '', autoStart = false, embedded = false }: {
  tab: TabSummary; onClose: () => void; initialTask?: string; autoStart?: boolean; embedded?: boolean;
}) {
  const approvalMode = useApp((s) => s.config.approvalMode);
  const [taskText, setTaskText] = useState(initialTask);
  const [closed, setClosed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [task, setTask] = useState<BrowserTask | null>(null);
  const [items, setItems] = useState<ReviewedAction[]>([]);
  const [elements, setElements] = useState<ElementInfo[]>([]);
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<Record<number, ExecutionResult>>({});
  const [error, setError] = useState<{ message: string; hint?: string | null } | null>(null);
  const [confirmNav, setConfirmNav] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const planAbort = useRef<AbortController | null>(null);
  // The backend may retry once when the model returns invalid JSON, so allow two generations.
  const generationTimeout = useApp((s) => s.settings?.generation_timeout ?? 300);

  // Elapsed-time indicator while the local model plans (it can take a while on CPU-only machines).
  useEffect(() => {
    if (phase !== 'planning') return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Stop an in-flight planning request if the card/panel goes away.
  useEffect(() => () => planAbort.current?.abort(), []);

  const started = useRef(false);
  useEffect(() => {
    if (autoStart && !started.current && initialTask.trim()) {
      started.current = true;
      void plan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plan = async () => {
    setError(null);
    setResults({});
    setPhase('planning');
    planAbort.current?.abort();
    const ctrl = new AbortController();
    planAbort.current = ctrl;
    try {
      let summary = '';
      try {
        summary = (await readTabCached(tab)).main_text.slice(0, 6000);
      } catch { /* summary optional */ }
      const r = await planTask({
        tabId: tab.id, url: tab.url, title: tab.title, task: taskText, pageSummary: summary,
        signal: ctrl.signal, timeoutMs: (generationTimeout * 2 + 60) * 1000,
      });
      if (ctrl.signal.aborted) return;
      setTask(r.task);
      setItems(r.reviewed);
      setElements(r.elements);
      setApproved(approvalMode === 'plan' ? new Set(r.reviewed.filter((i) => !i.localBlock).map((i) => i.index)) : new Set());
      setPhase('review');
    } catch (e) {
      if (ctrl.signal.aborted) {
        setPhase('idle');
        return;
      }
      setError(describeError(e));
      setPhase('idle');
    }
  };

  const editValue = (index: number, value: string) => {
    setItems((cur) => cur.map((it) => {
      if (it.index !== index) return it;
      const action = { ...it.action, value };
      return { ...it, action, localBlock: localPolicy(action, it.element, tab.url) ?? undefined };
    }));
  };

  const start = () => {
    const needsConfirm = items.some((i) => approved.has(i.index) && i.action.requires_confirmation);
    if (needsConfirm) setConfirmNav(true);
    else void execute();
  };

  const execute = async () => {
    setConfirmNav(false);
    if (!task) return;
    abort.current = new AbortController();
    setPhase('executing');
    const out: Record<number, ExecutionResult> = {};
    let halted = false;
    for (const it of items) {
      if (!approved.has(it.index)) {
        out[it.index] = { status: 'skipped', message: 'Not approved.' };
        continue;
      }
      if (halted || abort.current.signal.aborted) {
        out[it.index] = { status: 'cancelled', message: halted ? 'Stopped after a page change.' : 'Cancelled.' };
        continue;
      }
      try {
        out[it.index] = await executeApproved(tab.id, tab.url, it, abort.current.signal);
      } catch (e) {
        out[it.index] = { status: 'failed', message: describeError(e).message };
      }
      setResults({ ...out });
      if (out[it.index].status === 'target_changed') halted = true; // reconfirm required
      await new Promise((r) => setTimeout(r, 250));
    }
    const statuses = Object.values(out).filter((r) => r.status !== 'skipped');
    const ok = statuses.filter((r) => r.status === 'success').length;
    const final = abort.current.signal.aborted ? 'cancelled' : ok === statuses.length && ok > 0 ? 'completed' : ok > 0 ? 'partial' : 'failed';
    try {
      await reportResults(task.id, final, Object.entries(out).map(([i, r]) => ({ index: Number(i), status: r.status, message: r.message })));
    } catch { /* logging failure must not hide results */ }
    setPhase('done');
  };

  const cancel = async () => {
    abort.current?.abort();
    planAbort.current?.abort();
    if (task && (phase === 'review')) {
      try { await reportResults(task.id, 'cancelled', []); } catch { /* ignore */ }
    }
    if (embedded) setClosed(true);
    onClose();
  };

  if (closed) return <p className="text-xs text-muted">Cancelled – nothing was changed on the page.</p>;

  return (
    <div className={cx('space-y-2', embedded ? 'rounded-lg border border-border bg-card p-2.5' : 'p-3')}>
      {embedded ? (
        <p className="text-xs text-muted">Proposed changes for <span className="font-medium text-fg">{tab.title || tab.url}</span>. Review and edit the values, then apply. Nothing is submitted.</p>
      ) : (
        <>
          <p className="text-xs text-muted">Describe what to do on this page. You will review every step; nothing is submitted, purchased or sent automatically.</p>
          <Textarea rows={2} value={taskText} onChange={(e) => setTaskText(e.target.value)} placeholder="e.g. Fill the experience fields using my profile" disabled={phase === 'planning' || phase === 'executing'} aria-label="Task" />
        </>
      )}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={() => void plan()} disabled={!taskText.trim() || phase === 'planning' || phase === 'executing'} loading={phase === 'planning'}>
          {phase === 'review' || phase === 'done' ? 'Re-plan' : embedded ? 'Plan again' : 'Plan actions'}
        </Button>
        <Button size="sm" onClick={() => void cancel()}>{phase === 'executing' ? 'Stop' : 'Cancel'}</Button>
      </div>
      <ErrorNote error={error} />
      {phase === 'planning' && (
        <p className="flex items-center gap-2 text-xs text-muted" role="status">
          <Spinner /> Planning with the local model… {elapsed}s
          {elapsed >= 20 && <span>(local models can take a minute; Cancel stops it)</span>}
        </p>
      )}
      {(phase === 'review' || phase === 'executing' || phase === 'done') && task && (
        <div className="space-y-1.5">
          <p className="text-xs"><b>Plan:</b> {task.plan.task}</p>
          {items.length === 0 && <p className="text-xs text-muted">The planner proposed no safe actions for this task.</p>}
          <ol className="space-y-1">
            {items.map((it) => {
              const res = results[it.index];
              const blocked = !!it.localBlock;
              return (
                <li key={it.index} className={cx('rounded-md border p-2 text-xs', blocked ? 'border-bad/30 bg-bad/5' : 'border-border')}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Approve step ${it.index + 1}`}
                      disabled={blocked || phase !== 'review'}
                      checked={approved.has(it.index)}
                      onChange={(e) => {
                        const n = new Set(approved);
                        e.target.checked ? n.add(it.index) : n.delete(it.index);
                        setApproved(n);
                      }}
                    />
                    <span className="flex-1 font-medium">{it.index + 1}. {describe(it)}</span>
                    {it.action.target?.ref && (
                      <button className="text-muted hover:text-fg" title="Show on page" aria-label="Highlight element" onClick={() => void highlightRef(tab.id, tab.url, it.action.target!.ref!)}>
                        <Crosshair className="size-3.5" />
                      </button>
                    )}
                    {res && <ResultIcon r={res} />}
                  </div>
                  {(it.action.type === 'fill' || it.action.type === 'type') && (
                    <Textarea className="mt-1 text-xs" rows={2} value={it.action.value ?? ''} disabled={phase !== 'review'} onChange={(e) => editValue(it.index, e.target.value)} aria-label="Value to insert" />
                  )}
                  {it.action.type === 'select' && <p className="mt-0.5">Value: <code>{it.action.value}</code></p>}
                  {it.action.reason && <p className="mt-0.5 text-muted">{it.action.reason}</p>}
                  {it.action.warning && <p className="mt-0.5 flex items-center gap-1 text-warn"><AlertTriangle className="size-3" /> {it.action.warning}</p>}
                  {blocked && <p className="mt-0.5 flex items-center gap-1 text-bad"><Ban className="size-3" /> Blocked: {it.localBlock}</p>}
                  {res && res.status !== 'success' && <p className={cx('mt-0.5', res.status === 'target_changed' ? 'text-warn' : 'text-muted')}>{res.message}</p>}
                  {res?.data && <p className="mt-0.5 rounded bg-subtle p-1">{res.data}</p>}
                </li>
              );
            })}
          </ol>
          {task.blocked.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">{task.blocked.length} action(s) blocked by the safety policy</summary>
              <ul className="mt-1 space-y-0.5">
                {task.blocked.map((b, i) => <li key={i} className="text-bad">• {String(b.action.type ?? 'action')}: {b.reason}</li>)}
              </ul>
            </details>
          )}
          {phase === 'review' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" disabled={approved.size === 0} onClick={start}>
                <Play className="size-3.5" /> {embedded ? 'Apply' : 'Run'} {approved.size} approved step{approved.size === 1 ? '' : 's'}
              </Button>
              {items.some((i) => !i.localBlock) && approved.size < items.filter((i) => !i.localBlock).length && (
                <Button size="sm" variant="ghost" onClick={() => setApproved(new Set(items.filter((i) => !i.localBlock).map((i) => i.index)))}>Approve all</Button>
              )}
            </div>
          )}
          {phase === 'done' && <p className="text-xs text-muted">Finished. Review the page and submit any form yourself.</p>}
          {Object.values(results).some((r) => r.status === 'target_changed') && (
            <p className="text-xs text-warn">The page changed during execution. Re-plan to continue with fresh targets.</p>
          )}
        </div>
      )}
      <ConfirmDialog open={confirmNav} title="Leave this site?" confirmLabel="Allow navigation" onConfirm={() => void execute()} onCancel={() => setConfirmNav(false)}>
        One or more approved steps navigate to a different website. Continue only if you expected that.
      </ConfirmDialog>
    </div>
  );
}

function ResultIcon({ r }: { r: ExecutionResult }) {
  if (r.status === 'success') return <CheckCircle2 className="size-3.5 text-ok" aria-label="Succeeded" />;
  if (r.status === 'skipped') return <Badge>skipped</Badge>;
  if (r.status === 'target_changed') return <AlertTriangle className="size-3.5 text-warn" aria-label="Target changed" />;
  return <XCircle className="size-3.5 text-bad" aria-label={r.status} />;
}
