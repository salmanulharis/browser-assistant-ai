import { Download, FlaskConical, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from '@/components/common/toast';
import { Badge, Button, ConfirmDialog, ErrorNote, Field, Input, Section, Select } from '@/components/common/ui';
import { describeError } from '@/services/api';
import { formatSize, modelsOfKind, pullModel, testModel } from '@/services/ollama';
import { useApp } from '@/stores/app';
import type { AppSettings } from '@/types/api';

type Kind = 'chat' | 'embedding' | 'vision';
const KEY: Record<Kind, keyof AppSettings> = { chat: 'chat_model', embedding: 'embedding_model', vision: 'vision_model' };

export function ModelsSection({ save }: { save: (patch: Partial<AppSettings>) => Promise<void> }) {
  const settings = useApp((s) => s.settings);
  const models = useApp((s) => s.models);
  const loading = useApp((s) => s.modelsLoading);
  const refresh = useApp((s) => s.refreshModels);
  const [pullName, setPullName] = useState('');
  const [confirmPull, setConfirmPull] = useState<string | null>(null);
  const [pull, setPull] = useState<{ model: string; status: string; percent: number | null } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  if (!settings) return null;
  const list = models?.models ?? [];

  const doRefresh = () => refresh().catch((e) => toast(describeError(e).message, 'bad'));

  const startPull = async (model: string) => {
    setConfirmPull(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPull({ model, status: 'starting', percent: null });
    try {
      for await (const ev of pullModel(model, ctrl.signal)) {
        if (ev.event === 'progress') setPull({ model, status: String(ev.data.status ?? ''), percent: ev.data.percent ?? null });
        if (ev.event === 'done') toast(`Downloaded ${model}.`, 'ok');
      }
      await doRefresh();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) toast(`Download failed: ${describeError(e).message}`, 'bad');
      else toast('Download cancelled.');
    } finally {
      setPull(null);
      abort.current = null;
    }
  };

  const runTest = async (kind: Kind) => {
    const model = settings[KEY[kind]] as string;
    if (!model) return;
    setTesting(kind);
    try {
      const r = await testModel(model, kind);
      setTestResult((p) => ({ ...p, [kind]: `${r.ok ? '✓' : '✗'} ${Math.round(r.duration_ms)} ms – ${r.result}` }));
    } catch (e) {
      setTestResult((p) => ({ ...p, [kind]: `✗ ${describeError(e).message}` }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <Section
      title="Models"
      actions={<Button size="icon" variant="ghost" aria-label="Refresh models" title="Refresh model list" onClick={() => void doRefresh()} loading={loading}>{!loading && <RefreshCw className="size-3.5" />}</Button>}
    >
      {models && !models.reachable && <ErrorNote error={models.error ?? { message: `Ollama is not reachable at ${models.ollama_url}.`, hint: 'Start Ollama, then refresh.' }} />}
      <div className="space-y-2">
        {(['chat', 'embedding', 'vision'] as Kind[]).map((kind) => {
          const opts = modelsOfKind(list, kind);
          const value = settings[KEY[kind]] as string;
          const missing = value && !list.some((m) => m.name === value);
          return (
            <div key={kind}>
              <Field label={kind === 'chat' ? 'Chat model' : kind === 'embedding' ? 'Embedding model' : 'Vision model (optional)'}>
                <div className="flex gap-1.5">
                  <Select value={value} onChange={(e) => void save({ [KEY[kind]]: e.target.value } as Partial<AppSettings>)} aria-label={`${kind} model`}>
                    <option value="">{kind === 'vision' ? 'None' : 'Select a model…'}</option>
                    {opts.map((m) => <option key={m.name} value={m.name}>{m.name}{m.parameter_size ? ` · ${m.parameter_size}` : ''}</option>)}
                    {missing && <option value={value}>{value} (not installed)</option>}
                  </Select>
                  <Button size="icon" aria-label={`Test ${kind} model`} title="Send a short test request" disabled={!value || !!testing} loading={testing === kind} onClick={() => void runTest(kind)}>
                    {testing !== kind && <FlaskConical className="size-3.5" />}
                  </Button>
                </div>
              </Field>
              {missing && (
                <p className="mt-1 text-xs text-warn">
                  “{value}” is not installed. <button className="underline" onClick={() => setConfirmPull(value)}>Download it…</button>
                </p>
              )}
              {testResult[kind] && <p className="mt-1 line-clamp-3 text-xs text-muted">{testResult[kind]}</p>}
            </div>
          );
        })}
      </div>

      <h4 className="mt-3 mb-1 text-xs font-medium text-muted">Installed models ({list.length})</h4>
      {!list.length ? <p className="text-xs text-muted">No models discovered.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr><th className="py-1 pr-2 font-medium">Name</th><th className="pr-2 font-medium">Size</th><th className="pr-2 font-medium">Family</th><th className="pr-2 font-medium">Quant.</th><th className="font-medium">Use</th></tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.name} className="border-t border-border">
                  <td className="max-w-40 truncate py-1 pr-2" title={m.name}>{m.name}</td>
                  <td className="pr-2 whitespace-nowrap">{formatSize(m.size_bytes)}</td>
                  <td className="pr-2">{m.family ?? '—'}{m.parameter_size ? ` ${m.parameter_size}` : ''}</td>
                  <td className="pr-2">{m.quantization ?? '—'}</td>
                  <td className="space-x-0.5 whitespace-nowrap">
                    <Badge>{m.kind}</Badge>
                    {m.selected_as.map((s) => <Badge key={s} tone="accent">{s}</Badge>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!!models?.suggestions.length && (
        <div className="mt-3">
          <h4 className="mb-1 text-xs font-medium text-muted">Suggestions</h4>
          <ul className="space-y-1 text-xs">
            {models.suggestions.map((s) => (
              <li key={s.name} className="flex items-center gap-2">
                <span className="min-w-0 flex-1"><span className="font-mono">{s.name}</span> <span className="text-muted">– {s.why}</span></span>
                <Button size="sm" variant="ghost" disabled={!!pull} onClick={() => setConfirmPull(s.name)}><Download className="size-3" />Pull</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex gap-1.5">
        <Input placeholder="Model name, e.g. qwen3:4b-instruct" value={pullName} onChange={(e) => setPullName(e.target.value)} aria-label="Model to download" />
        <Button disabled={!pullName.trim() || !!pull} onClick={() => setConfirmPull(pullName.trim())}><Download className="size-3.5" />Pull</Button>
      </div>
      {pull && (
        <div className="mt-2 space-y-1 text-xs">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate">Downloading {pull.model}: {pull.status}{pull.percent != null ? ` (${pull.percent}%)` : ''}</span>
            <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>Cancel</Button>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-subtle"><div className="h-full bg-accent transition-all" style={{ width: `${pull.percent ?? 0}%` }} /></div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmPull}
        title="Download model?"
        confirmLabel="Download"
        onCancel={() => setConfirmPull(null)}
        onConfirm={() => confirmPull && void startPull(confirmPull)}
      >
        Ollama will download <span className="font-mono text-fg">{confirmPull}</span>. Models are usually several gigabytes; the download uses your
        bandwidth and disk space. Nothing is downloaded without this confirmation.
      </ConfirmDialog>
    </Section>
  );
}
