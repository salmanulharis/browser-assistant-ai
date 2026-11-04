import { ChevronDown, ChevronRight, ClipboardCopy, Download, ExternalLink, Play, RefreshCw, RotateCcw, Trash2, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/common/toast';
import { Badge, Button, ErrorNote, Section, StatusBadge, cx } from '@/components/common/ui';
import { api, describeError } from '@/services/api';
import { buildReport, reportToText, runBackendChecks, runExtensionChecks, summarize } from '@/services/diagnostics';
import { testModel } from '@/services/ollama';
import { useApp } from '@/stores/app';
import type { CheckResult, DiagnosticRun, DiagStatus } from '@/types/api';
import { PermissionsSection } from './PermissionsSection';

const GROUPS: { id: string; title: string }[] = [
  { id: 'ollama', title: 'Ollama server' },
  { id: 'inference', title: 'Model inference' },
  { id: 'backend', title: 'Backend' },
  { id: 'storage', title: 'Storage' },
  { id: 'connection', title: 'Connection & CORS' },
  { id: 'extension', title: 'Chrome extension' },
  { id: 'permissions', title: 'Permission checks' },
];

const BACKEND_GROUPS = new Set(['ollama', 'inference', 'backend', 'storage']);
const OLLAMA_DOCS = 'https://github.com/ollama/ollama/blob/main/docs/faq.md';

type ModelTest = { kind: 'chat' | 'embedding'; ok: boolean; ms: number; result: string } | null;

function overallStatus(o: string): DiagStatus {
  return o === 'healthy' ? 'healthy' : o === 'failed' ? 'failed' : o === 'testing' ? 'testing' : 'warning';
}

function CheckRow({ c, onRerun }: { c: CheckResult; onRerun?: () => void }) {
  const [open, setOpen] = useState(c.status === 'failed');
  const hasMore = !!(c.hint || (c.details && Object.keys(c.details).length));
  return (
    <li className="border-b border-border last:border-0">
      <div className="flex items-center gap-1.5 py-1.5">
        <button className="text-muted disabled:opacity-0" disabled={!hasMore} aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.85rem]">{c.name}</p>
          <p className={cx('text-xs', c.status === 'failed' ? 'text-bad' : 'text-muted')}>{c.message}</p>
        </div>
        {c.duration_ms ? <span className="text-[0.7rem] text-muted">{c.duration_ms} ms</span> : null}
        <StatusBadge status={c.status} />
        {onRerun && <Button size="icon" variant="ghost" aria-label={`Re-run ${c.name}`} title="Run this check again" onClick={onRerun}><RotateCcw className="size-3" /></Button>}
      </div>
      {open && hasMore && (
        <div className="mb-2 ml-5 space-y-1 text-xs">
          {c.hint && <p><span className="font-medium">Recommended fix: </span>{c.hint}</p>}
          {c.details && Object.keys(c.details).length > 0 && (
            <pre className="overflow-x-auto rounded bg-subtle p-1.5 text-[0.7rem] text-muted">{JSON.stringify(c.details, null, 1)}</pre>
          )}
        </div>
      )}
    </li>
  );
}

export function DiagnosticsPage() {
  const settings = useApp((s) => s.settings);
  const models = useApp((s) => s.models);
  const refreshModels = useApp((s) => s.refreshModels);
  const checkConnection = useApp((s) => s.checkConnection);
  const [backend, setBackend] = useState<CheckResult[]>([]);
  const [ext, setExt] = useState<CheckResult[]>([]);
  const [backendError, setBackendError] = useState<{ message: string; hint?: string | null } | null>(null);
  const [running, setRunning] = useState<null | 'basic' | 'full' | 'partial'>(null);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [history, setHistory] = useState<DiagnosticRun[]>([]);
  const [modelTest, setModelTest] = useState<ModelTest>(null);
  const [testing, setTesting] = useState<null | 'chat' | 'embedding'>(null);
  const started = useRef(false);

  const loadHistory = useCallback(async () => {
    try {
      const h = await api.get<{ history: DiagnosticRun[] }>('/diagnostics?limit=10');
      setHistory(h.history);
    } catch { /* backend down: shown elsewhere */ }
  }, []);

  const run = useCallback(async (level: 'basic' | 'full', only?: string[]) => {
    setRunning(only ? 'partial' : level);
    try {
      const onlyBackend = only?.filter((id) => !id.startsWith('ext.') && !id.startsWith('perm.') && !id.startsWith('conn.'));
      const onlyExt = only?.filter((id) => !onlyBackend?.includes(id));
      const [b, e] = await Promise.all([
        !only || onlyBackend?.length ? runBackendChecks(level, onlyBackend?.length ? onlyBackend : undefined) : Promise.resolve(null),
        !only || onlyExt?.length ? runExtensionChecks() : Promise.resolve(null),
      ]);
      if (b) {
        if ('error' in b) {
          setBackendError(b.error);
          if (!only) setBackend([]);
        } else {
          setBackendError(null);
          setBackend((prev) => (only ? prev.map((x) => b.results.find((n) => n.id === x.id) ?? x).concat(b.results.filter((n) => !prev.some((x) => x.id === n.id))) : b.results));
        }
      }
      if (e) setExt((prev) => (only ? prev.map((x) => (onlyExt?.includes(x.id) ? e.find((n) => n.id === x.id) ?? x : x)) : e));
      setLastRun(new Date());
      void loadHistory();
      void checkConnection();
    } finally {
      setRunning(null);
    }
  }, [loadHistory, checkConnection]);

  // Automatic lightweight check when the page opens (no inference).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run('basic');
  }, [run]);

  const all = useMemo(() => [...backend, ...ext], [backend, ext]);
  const sum = summarize(all);
  const failedIds = all.filter((c) => c.status === 'failed').map((c) => c.id);
  const byGroup = (g: string) => all.filter((c) => c.group === g);
  const find = (id: string) => all.find((c) => c.id === id);
  const reach = find('ollama.reachable');
  const backendStatus: DiagStatus = backendError ? 'failed' : find('conn.backend')?.status ?? (backend.length ? 'healthy' : 'testing');

  const copyReport = async () => {
    try {
      const rep = await buildReport(all);
      await navigator.clipboard.writeText(reportToText(rep));
      toast('Diagnostic report copied (no personal data included).', 'ok');
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };
  const downloadReport = async () => {
    const rep = await buildReport(all);
    const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lba-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const clearHistory = async () => {
    try {
      await api.del('/diagnostics/history');
      setHistory([]);
      toast('Diagnostic history cleared.');
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };
  const runModelTest = async (kind: 'chat' | 'embedding') => {
    const model = kind === 'chat' ? settings?.chat_model : settings?.embedding_model;
    if (!model) {
      toast(`No ${kind} model selected. Choose one in Settings → AI.`, 'bad');
      return;
    }
    setTesting(kind);
    try {
      const r = await testModel(model, kind);
      setModelTest({ kind, ok: r.ok, ms: Math.round(r.duration_ms), result: r.result });
    } catch (e) {
      setModelTest({ kind, ok: false, ms: 0, result: describeError(e).message });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-3 p-3">
      {/* ---------------- summary ---------------- */}
      <Section
        title="Application health"
        actions={<StatusBadge status={running && !all.length ? 'testing' : overallStatus(sum.overall)} />}
      >
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-subtle py-1.5"><p className="text-lg font-semibold text-ok">{sum.healthy}</p><p className="text-[0.7rem] text-muted">Passed</p></div>
          <div className="rounded-md bg-subtle py-1.5"><p className="text-lg font-semibold text-warn">{sum.warnings}</p><p className="text-[0.7rem] text-muted">Warnings</p></div>
          <div className="rounded-md bg-subtle py-1.5"><p className="text-lg font-semibold text-bad">{sum.failed}</p><p className="text-[0.7rem] text-muted">Failed</p></div>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Backend</dt><dd><StatusBadge status={running && !all.length ? 'testing' : backendStatus} /></dd>
          <dt className="text-muted">Ollama</dt><dd><StatusBadge status={reach?.status ?? (backendError ? 'skipped' : 'testing')} /></dd>
          <dt className="text-muted">Last run</dt><dd>{lastRun ? lastRun.toLocaleTimeString() : '—'}</dd>
        </dl>
        <ErrorNote error={backendError} />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" loading={running === 'full'} disabled={!!running} onClick={() => void run('full')} title="Includes real model inference tests">
            <Play className="size-3" />Run all tests
          </Button>
          <Button size="sm" loading={running === 'basic'} disabled={!!running} onClick={() => void run('basic')} title="Connectivity only, no inference">
            <Zap className="size-3" />Quick check
          </Button>
          <Button size="sm" disabled={!!running || !failedIds.length} onClick={() => void run('full', failedIds)}>
            <RotateCcw className="size-3" />Re-run failed ({failedIds.length})
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void copyReport()}><ClipboardCopy className="size-3" />Copy report</Button>
          <Button size="sm" variant="ghost" onClick={() => void downloadReport()}><Download className="size-3" />Download report</Button>
        </div>
      </Section>

      {/* ---------------- Ollama ---------------- */}
      <Section title="Ollama connection">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">URL</dt><dd className="truncate font-mono">{settings?.ollama_url ?? models?.ollama_url ?? '—'}</dd>
          <dt className="text-muted">Version</dt><dd>{(reach?.details?.version as string) ?? models?.version ?? '—'}</dd>
          <dt className="text-muted">Installed models</dt><dd>{models?.models.length ?? '—'}</dd>
          <dt className="text-muted">Chat model</dt><dd className="truncate">{settings?.chat_model || <Badge tone="warn">not selected</Badge>}</dd>
          <dt className="text-muted">Embedding model</dt><dd className="truncate">{settings?.embedding_model || <Badge tone="warn">not selected</Badge>}</dd>
          <dt className="text-muted">Response time</dt><dd>{reach?.details?.response_ms != null ? `${reach.details.response_ms as number} ms` : '—'}</dd>
          <dt className="text-muted">Last success</dt><dd>{reach?.details?.last_success ? new Date(reach.details.last_success as string).toLocaleString() : '—'}</dd>
        </dl>
        {reach?.status === 'failed' && (
          <div className="mt-2 rounded-md border border-bad/30 bg-bad/8 p-2 text-xs">
            <p className="font-medium text-bad">{reach.message}</p>
            <ul className="mt-1 list-disc pl-4 text-fg/80">
              <li>Check whether Ollama is installed (ollama.com/download).</li>
              <li>Check whether Ollama is running (tray icon, or run <code>ollama serve</code>).</li>
              <li>Start Ollama, or run <code>scripts\start.ps1</code> which starts it for you.</li>
              <li>Verify the configured port in Settings → AI.</li>
              <li>Retry the connection.</li>
            </ul>
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" disabled={!!running} onClick={() => void run('basic', ['ollama.host', 'ollama.reachable', 'ollama.models', 'ollama.chat_model', 'ollama.embedding_model'])}>
            <RefreshCw className="size-3" />Test connection
          </Button>
          <Button size="sm" onClick={() => refreshModels().then(() => toast('Model list refreshed.'), (e) => toast(describeError(e).message, 'bad'))}>Refresh models</Button>
          <Button size="sm" loading={testing === 'chat'} disabled={!!testing} onClick={() => void runModelTest('chat')}>Test chat model</Button>
          <Button size="sm" loading={testing === 'embedding'} disabled={!!testing} onClick={() => void runModelTest('embedding')}>Test embedding model</Button>
          <Button size="sm" variant="ghost" onClick={() => void chrome.tabs.create({ url: OLLAMA_DOCS })}><ExternalLink className="size-3" />Ollama docs</Button>
        </div>
        {modelTest && (
          <div className={cx('mt-2 rounded-md border p-2 text-xs', modelTest.ok ? 'border-ok/30' : 'border-bad/30 text-bad')}>
            <p className="font-medium">{modelTest.kind === 'chat' ? 'Chat' : 'Embedding'} test {modelTest.ok ? `passed in ${modelTest.ms} ms` : 'failed'}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-fg/80">{modelTest.result}</p>
          </div>
        )}
      </Section>

      {/* ---------------- check groups ---------------- */}
      {GROUPS.map((g) => {
        const items = byGroup(g.id);
        if (!items.length && !(running && BACKEND_GROUPS.has(g.id))) return null;
        return (
          <Section key={g.id} title={g.title} actions={items.length ? <span className="text-[0.7rem] text-muted">{items.filter((x) => x.status === 'healthy').length}/{items.length}</span> : undefined}>
            {!items.length ? <p className="text-xs text-muted">Testing…</p> : (
              <ul>
                {items.map((c) => (
                  <CheckRow key={c.id} c={c} onRerun={running ? undefined : () => void run(g.id === 'inference' ? 'full' : 'basic', [c.id])} />
                ))}
              </ul>
            )}
          </Section>
        );
      })}
      {!byGroup('inference').length && !running && backend.length > 0 && (
        <p className="px-1 text-xs text-muted">Model inference tests (chat, embedding, streaming, timeout) only run with “Run all tests”, so they never load a model in the background.</p>
      )}

      <PermissionsSection />

      {/* ---------------- history ---------------- */}
      <Section title="Diagnostic history" actions={history.length ? <Button size="sm" variant="ghost" onClick={() => void clearHistory()}><Trash2 className="size-3" />Clear</Button> : undefined}>
        {!history.length ? <p className="text-xs text-muted">No stored runs.</p> : (
          <ul className="space-y-1 text-xs">
            {history.map((h) => (
              <li key={h.id} className="flex items-center gap-2">
                <span className="flex-1 text-muted">{new Date(h.started_at).toLocaleString()} · {h.level}</span>
                <span className="text-ok">{h.summary.healthy}</span>/<span className="text-warn">{h.summary.warnings}</span>/<span className="text-bad">{h.summary.failed}</span>
                <StatusBadge status={overallStatus(h.summary.overall)} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
