import { Archive, Download, KeyRound, Link2, Trash2, Upload } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from '@/components/common/toast';
import { Badge, Button, ConfirmDialog, ErrorNote, Field, Input, Section, Select, Switch, Tabs, Textarea, cx } from '@/components/common/ui';
import { PermissionsSection } from '@/components/diagnostics/PermissionsSection';
import { api, describeError, health } from '@/services/api';
import { loadConfig } from '@/services/config';
import { useApp } from '@/stores/app';
import type { AppSettings, MemoryCategory } from '@/types/api';
import type { ContextToggles, ExtensionConfig } from '@/types/config';
import { ModelsSection } from './ModelsSection';

type Tab = 'connection' | 'ai' | 'memory' | 'browser' | 'privacy' | 'appearance';
const TABS: { id: Tab; label: string }[] = [
  { id: 'connection', label: 'Connection' },
  { id: 'ai', label: 'AI' },
  { id: 'memory', label: 'Memory' },
  { id: 'browser', label: 'Browser' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'appearance', label: 'Appearance' },
];

const DELETE_PHRASE = 'DELETE ALL MY DATA';

/** Number input that validates and commits on blur / Enter. */
function NumberField({ label, hint, value, min, max, step = 1, onCommit }: {
  label: string; hint?: string; value: number; min: number; max: number; step?: number; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < min || n > max) {
      toast(`${label} must be between ${min} and ${max}.`, 'bad');
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <Field label={label} hint={hint}>
      <Input type="number" inputMode="decimal" min={min} max={max} step={step} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </Field>
  );
}

/** Text input committing on blur / Enter. */
function TextField({ label, hint, value, onCommit, placeholder, mono }: { label: string; hint?: string; value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onCommit(draft.trim());
  return (
    <Field label={label} hint={hint}>
      <Input className={cx(mono && 'font-mono')} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </Field>
  );
}

function SiteList({ label, hint, items, onChange }: { label: string; hint: string; items: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState(items.join('\n'));
  useEffect(() => setDraft(items.join('\n')), [items]);
  return (
    <Field label={label} hint={hint}>
      <Textarea
        rows={4}
        className="font-mono text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = [...new Set(draft.split(/[\n,]/).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
          if (next.join('\n') !== items.join('\n')) onChange(next);
        }}
      />
    </Field>
  );
}

function useSaver() {
  const updateSettings = useApp((s) => s.updateSettings);
  const updateConfig = useApp((s) => s.updateConfig);
  const saveBackend = async (patch: Partial<AppSettings>) => {
    try {
      await updateSettings(patch);
      toast('Saved.', 'ok');
    } catch (e) {
      const d = describeError(e);
      toast(d.hint ? `${d.message} ${d.hint}` : d.message, 'bad');
    }
  };
  const saveExt = async (patch: Partial<ExtensionConfig>) => {
    try {
      await updateConfig(patch);
    } catch (e) {
      toast(describeError(e).message, 'bad');
    }
  };
  return { saveBackend, saveExt };
}

function NeedsBackend({ children }: { children: ReactNode }) {
  const settings = useApp((s) => s.settings);
  const connection = useApp((s) => s.connection);
  if (!settings) {
    return <ErrorNote error={{ message: connection === 'ok' ? 'Loading settings…' : 'These settings are stored by the local backend, which is not connected.', hint: connection === 'ok' ? null : 'Fix the connection in the Connection tab first.' }} />;
  }
  return <>{children}</>;
}

// ------------------------------------------------------------- Connection
function ConnectionTab() {
  const config = useApp((s) => s.config);
  const connection = useApp((s) => s.connection);
  const backendVersion = useApp((s) => s.backendVersion);
  const check = useApp((s) => s.checkConnection);
  const tryPair = useApp((s) => s.tryPair);
  const init = useApp((s) => s.init);
  const { saveExt } = useSaver();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const testUrl = async () => {
    setBusy(true);
    try {
      const h = await health(3000);
      toast(`Backend ${h.version} is reachable.`, 'ok');
    } catch (e) {
      toast(describeError(e).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const pairNow = async () => {
    setBusy(true);
    const ok = await tryPair();
    setBusy(false);
    if (ok) {
      toast('Paired with the backend.', 'ok');
      await init();
    } else {
      toast('Automatic pairing failed. The backend must allow-list this extension origin (run scripts\\build.ps1), or paste the token manually.', 'bad');
    }
  };
  const saveToken = async () => {
    await saveExt({ token: token.trim() });
    setToken('');
    const c = await check();
    toast(c === 'ok' ? 'Token accepted.' : 'The backend rejected this token.', c === 'ok' ? 'ok' : 'bad');
    if (c === 'ok') await init();
  };

  return (
    <div className="space-y-3">
      <Section title="Backend" actions={<Badge tone={connection === 'ok' ? 'ok' : connection === 'checking' ? 'neutral' : 'bad'}>{connection === 'ok' ? `Connected · ${backendVersion}` : connection}</Badge>}>
        <div className="space-y-2">
          <TextField label="Backend URL" mono value={config.backendUrl} hint="Must be http://127.0.0.1:<port> or http://localhost:<port>. Default port 8765."
            onCommit={(v) => {
              if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/.test(v)) {
                toast('Only a local http://127.0.0.1:<port> backend is allowed.', 'bad');
                return;
              }
              void saveExt({ backendUrl: v.replace(/\/$/, '') }).then(() => check());
            }} />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" loading={busy} onClick={() => void testUrl()}>Test URL</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void pairNow()}><Link2 className="size-3" />Pair automatically</Button>
          </div>
          <p className="text-xs text-muted">Extension origin: <span className="font-mono">{location.origin}</span></p>
        </div>
      </Section>
      <Section title="API token">
        <p className="mb-2 text-xs text-muted">
          {config.token ? 'A token is stored on this device (chrome.storage.local, not readable by web pages or content scripts).' : 'No token stored.'}{' '}
          To pair manually, run <code>scripts\start.ps1</code> (or <code>python -m app.cli token</code>) and paste the token here.
        </p>
        <div className="flex gap-1.5">
          <Input type="password" autoComplete="off" placeholder="Paste API token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="API token" />
          <Button disabled={!token.trim()} onClick={() => void saveToken()}><KeyRound className="size-3.5" />Save</Button>
        </div>
        {config.token && <Button size="sm" variant="ghost" className="mt-2" onClick={() => void saveExt({ token: '' }).then(() => check())}>Forget token</Button>}
      </Section>
    </div>
  );
}

// --------------------------------------------------------------------- AI
function AiTab() {
  const s = useApp((st) => st.settings);
  const { saveBackend } = useSaver();
  return (
    <NeedsBackend>
      {s && (
        <div className="space-y-3">
          <Section title="Ollama">
            <div className="space-y-2">
              <TextField label="Ollama endpoint" mono value={s.ollama_url} hint="Default http://127.0.0.1:11434. Must be local while local-only mode is on." onCommit={(v) => void saveBackend({ ollama_url: v })} />
            </div>
          </Section>
          <ModelsSection save={saveBackend} />
          <Section title="Generation">
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Temperature" value={s.temperature} min={0} max={2} step={0.1} onCommit={(v) => void saveBackend({ temperature: v })} />
              <NumberField label="Context length (tokens)" value={s.context_length} min={1024} max={262144} step={1024} onCommit={(v) => void saveBackend({ context_length: v })} />
              <NumberField label="Generation timeout (s)" value={s.generation_timeout} min={10} max={3600} onCommit={(v) => void saveBackend({ generation_timeout: v })} />
              <NumberField label="Request timeout (s)" value={s.request_timeout} min={1} max={120} onCommit={(v) => void saveBackend({ request_timeout: v })} />
              <NumberField label="Max page context (chars)" value={s.max_page_context_chars} min={1000} max={200000} step={1000} onCommit={(v) => void saveBackend({ max_page_context_chars: v })} />
              <NumberField label="Recent messages sent" value={s.recent_messages} min={2} max={50} onCommit={(v) => void saveBackend({ recent_messages: v })} />
            </div>
            <Switch label="Streaming" description="Show the answer as it is generated." checked={s.streaming} onChange={(v) => void saveBackend({ streaming: v })} />
            <Switch label="Model thinking" description="Let reasoning models think first (slower; thinking is shown collapsed)." checked={s.think} onChange={(v) => void saveBackend({ think: v })} />
          </Section>
          <Section title="Knowledge retrieval (RAG)">
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Retrieved chunks (top-K)" value={s.rag_top_k} min={1} max={20} onCommit={(v) => void saveBackend({ rag_top_k: v })} />
              <NumberField label="Minimum relevance" value={s.min_relevance} min={0} max={1} step={0.05} onCommit={(v) => void saveBackend({ min_relevance: v })} />
              <NumberField label="Chunk size (tokens)" value={s.chunk_size_tokens} min={100} max={4000} step={50} onCommit={(v) => void saveBackend({ chunk_size_tokens: v })} />
              <NumberField label="Chunk overlap (tokens)" value={s.chunk_overlap_tokens} min={0} max={1000} step={10} onCommit={(v) => void saveBackend({ chunk_overlap_tokens: v })} />
            </div>
            <p className="mt-1 text-xs text-muted">Chunking changes apply to newly indexed documents. Re-index existing documents from the Knowledge page.</p>
          </Section>
        </div>
      )}
    </NeedsBackend>
  );
}

// ----------------------------------------------------------------- Memory
function MemoryTab() {
  const s = useApp((st) => st.settings);
  const { saveBackend } = useSaver();
  const [cats, setCats] = useState<MemoryCategory[]>([]);
  useEffect(() => {
    api.get<MemoryCategory[]>('/memory/categories').then(setCats, () => undefined);
  }, []);
  return (
    <NeedsBackend>
      {s && (
        <div className="space-y-3">
          <Section title="Automatic memory">
            <Field label="Policy">
              <Select value={s.auto_memory_mode} onChange={(e) => void saveBackend({ auto_memory_mode: e.target.value as AppSettings['auto_memory_mode'] })}>
                <option value="ask">Ask before saving</option>
                <option value="auto">Automatically save permitted categories</option>
                <option value="off">Disable automatic memory</option>
              </Select>
            </Field>
            <p className="mt-1 text-xs text-muted">Passwords, authentication, payment data and form entries are never saved automatically.</p>
            {s.auto_memory_mode !== 'off' && (
              <div className="mt-2">
                <p className="mb-1 text-xs font-medium text-muted">Enabled categories</p>
                <div className="flex flex-wrap gap-1.5">
                  {(cats.length ? cats.map((c) => c.name) : s.auto_memory_categories).map((name) => {
                    const on = s.auto_memory_categories.includes(name);
                    return (
                      <button key={name} aria-pressed={on} onClick={() => void saveBackend({ auto_memory_categories: on ? s.auto_memory_categories.filter((c) => c !== name) : [...s.auto_memory_categories, name] })}
                        className={cx('rounded-md border px-2 py-0.5 text-xs', on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted')}>
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Section>
          <Section title="Retrieval">
            <Switch label="Use personal memory in answers" checked={s.memory_retrieval} onChange={(v) => void saveBackend({ memory_retrieval: v })} />
            <Switch label="Retrieve from previous conversations" checked={s.cross_conversation_retrieval} onChange={(v) => void saveBackend({ cross_conversation_retrieval: v })} />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <NumberField label="Memories per answer" value={s.memory_top_k} min={1} max={20} onCommit={(v) => void saveBackend({ memory_top_k: v })} />
              <NumberField label="Summarize after (messages)" value={s.summarize_after_messages} min={6} max={200} onCommit={(v) => void saveBackend({ summarize_after_messages: v })} />
            </div>
          </Section>
          <Section title="Conversation retention">
            <NumberField label="Delete conversations older than (days)" hint="0 keeps conversations forever. Applied when the backend starts." value={s.conversation_retention_days} min={0} max={3650} onCommit={(v) => void saveBackend({ conversation_retention_days: v })} />
          </Section>
        </div>
      )}
    </NeedsBackend>
  );
}

// ---------------------------------------------------------------- Browser
const CONTEXT_LABELS: Record<keyof ContextToggles, string> = {
  page: 'Current page', selection: 'Selected text', tabs: 'Selected tabs', memory: 'Personal memory', knowledge: 'Knowledge base', history: 'Previous conversations', samples: 'Sample content',
};

function BrowserTab() {
  const config = useApp((s) => s.config);
  const { saveExt } = useSaver();
  return (
    <div className="space-y-3">
      <Section title="Floating assistant">
        <Switch label="Enable floating assistant" description="Shown only on websites you granted access to." checked={config.floating.enabled} onChange={(v) => void saveExt({ floating: { ...config.floating, enabled: v } })} />
        <Field label="Launcher position">
          <Select value={config.floating.position} onChange={(e) => void saveExt({ floating: { ...config.floating, position: e.target.value as ExtensionConfig['floating']['position'], offset: null } })}>
            <option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option>
            <option value="top-right">Top right</option><option value="top-left">Top left</option>
          </Select>
        </Field>
        <div className="mt-2">
          <SiteList label="Disabled on these sites" hint="One host per line. You can also disable it from the launcher menu." items={config.floating.disabledSites} onChange={(v) => void saveExt({ floating: { ...config.floating, disabledSites: v } })} />
        </div>
      </Section>
      <Section title="Default chat context">
        {(Object.keys(CONTEXT_LABELS) as (keyof ContextToggles)[]).map((k) => (
          <Switch key={k} label={CONTEXT_LABELS[k]} checked={config.contextDefaults[k]} onChange={(v) => void saveExt({ contextDefaults: { ...config.contextDefaults, [k]: v } })} />
        ))}
        <Field label="Custom instructions (sent with every request)">
          <Textarea rows={3} defaultValue={config.instructions} maxLength={4000} onBlur={(e) => e.target.value !== config.instructions && void saveExt({ instructions: e.target.value })} placeholder="e.g. Answer concisely. Use British English." />
        </Field>
      </Section>
      <Section title="Tabs & automation">
        <Switch label="Multi-tab context" description="Allow choosing other open tabs as context (requests the optional “tabs” permission)." checked={config.multiTab} onChange={(v) => void saveExt({ multiTab: v })} />
        <Switch label="Browser automation" description="Form filling and planned browser actions. Every action needs your approval." checked={config.automation} onChange={(v) => void saveExt({ automation: v })} />
        <Field label="Action approval">
          <Select value={config.approvalMode} onChange={(e) => void saveExt({ approvalMode: e.target.value as ExtensionConfig['approvalMode'] })}>
            <option value="each">Approve each action individually</option>
            <option value="plan">Approve the reviewed plan, then run it</option>
          </Select>
        </Field>
        <Switch label="Include a screenshot for vision models" description="Only when a vision model is selected and you ask about the page." checked={config.includeScreenshot} onChange={(v) => void saveExt({ includeScreenshot: v })} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- Privacy
interface Backup { name: string; size_bytes: number; created_at: string }

async function downloadAuthed(path: string, filename: string) {
  const cfg = await loadConfig();
  const resp = await fetch(`${cfg.backendUrl.replace(/\/$/, '')}/api/v1${path}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!resp.ok) throw new Error(`Download failed (HTTP ${resp.status}).`);
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function PrivacyTab() {
  const s = useApp((st) => st.settings);
  const config = useApp((st) => st.config);
  const init = useApp((st) => st.init);
  const { saveBackend, saveExt } = useSaver();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [phrase, setPhrase] = useState('');

  const loadBackups = () => api.get<Backup[]>('/backups').then(setBackups, () => undefined);
  useEffect(() => { void loadBackups(); }, []);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try { await fn(); } catch (e) { toast(describeError(e).message, 'bad'); } finally { setBusy(null); }
  };

  const exportMemory = () => run('export', async () => {
    const data = await api.get<unknown>('/memory/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lba-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });
  const importMemory = (file: File) => run('import', async () => {
    const json = JSON.parse(await file.text());
    const res = await api.post<{ imported: number }>('/memory/import', { memories: json.memories ?? json });
    toast(`Imported ${res.imported} memories (duplicates skipped).`, 'ok');
  });
  const backupNow = () => run('backup', async () => {
    const b = await api.post<Backup>('/backups');
    toast(`Backup created: ${b.name}`, 'ok');
    await loadBackups();
  });
  const deleteAll = () => run('delete', async () => {
    setDelOpen(false);
    const res = await api.post<{ safety_backup: string; note: string }>('/data/delete-all', { confirm: phrase });
    setPhrase('');
    toast(`All local data deleted. ${res.note}`, 'ok');
    await loadBackups();
    await init();
  });

  return (
    <div className="space-y-3">
      <Section title="Privacy">
        {s && <Switch label="Local-only mode" description="Refuse any non-local Ollama endpoint. No cloud services are ever used." checked={s.local_only} onChange={(v) => void saveBackend({ local_only: v })} />}
        <Switch label="Automatic page capture" description="Read the current page automatically when you ask a question. When off, use the capture button." checked={config.autoCapturePage} onChange={(v) => void saveExt({ autoCapturePage: v })} />
        <div className="mt-2">
          <SiteList label="Never read these sites" hint="Banking, payment, email and identity sites are excluded by default. One host per line; use * as a wildcard (e.g. *.example.com covers subdomains)." items={config.excludedSites} onChange={(v) => void saveExt({ excludedSites: v })} />
        </div>
      </Section>
      <PermissionsSection />
      <Section title="Memory export / import">
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" loading={busy === 'export'} onClick={() => void exportMemory()}><Download className="size-3" />Export memories</Button>
          <label className={cx('inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium hover:bg-subtle', busy === 'import' && 'opacity-50')}>
            <Upload className="size-3" />Import memories
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importMemory(f); e.target.value = ''; }} />
          </label>
        </div>
      </Section>
      <Section title="Backups" actions={<Button size="sm" loading={busy === 'backup'} onClick={() => void backupNow()}><Archive className="size-3" />Back up now</Button>}>
        <p className="mb-2 text-xs text-muted">A backup contains the database, vectors and uploaded documents. Restore with <code>scripts\backup.ps1 -Restore &lt;file&gt;</code> while the backend is stopped.</p>
        {!backups.length ? <p className="text-xs text-muted">No backups yet.</p> : (
          <ul className="space-y-1 text-xs">
            {backups.map((b) => (
              <li key={b.name} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono" title={b.name}>{b.name}</span>
                <span className="text-muted">{(b.size_bytes / 1e6).toFixed(1)} MB</span>
                <Button size="icon" variant="ghost" aria-label={`Download ${b.name}`} onClick={() => void run(b.name, () => downloadAuthed(`/backups/${encodeURIComponent(b.name)}`, b.name))}><Download className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Delete all local data">
        <p className="text-xs text-muted">Deletes conversations, memories, documents, vectors, prompts and logs of browser tasks. A safety backup is written first.</p>
        <Button size="sm" variant="danger" className="mt-2" loading={busy === 'delete'} onClick={() => setDelOpen(true)}><Trash2 className="size-3" />Delete all data…</Button>
      </Section>
      <ConfirmDialog open={delOpen} danger title="Delete all local data?" confirmLabel="Delete everything" onCancel={() => { setDelOpen(false); setPhrase(''); }}
        onConfirm={() => (phrase === DELETE_PHRASE ? void deleteAll() : toast(`Type “${DELETE_PHRASE}” to confirm.`, 'bad'))}>
        <p>This cannot be undone (except from the safety backup). Type <span className="font-mono text-fg">{DELETE_PHRASE}</span> to confirm.</p>
        <Input className="mt-2" value={phrase} onChange={(e) => setPhrase(e.target.value)} aria-label="Confirmation phrase" />
      </ConfirmDialog>
    </div>
  );
}

// ------------------------------------------------------------- Appearance
function AppearanceTab() {
  const config = useApp((s) => s.config);
  const { saveExt } = useSaver();
  return (
    <Section title="Appearance">
      <div className="space-y-2">
        <Field label="Theme">
          <Select value={config.theme} onChange={(e) => void saveExt({ theme: e.target.value as ExtensionConfig['theme'] })}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </Select>
        </Field>
        <Field label="Font size">
          <Select value={config.fontSize} onChange={(e) => void saveExt({ fontSize: e.target.value as ExtensionConfig['fontSize'] })}>
            <option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option>
          </Select>
        </Field>
        <Field label="Floating launcher position">
          <Select value={config.floating.position} onChange={(e) => void saveExt({ floating: { ...config.floating, position: e.target.value as ExtensionConfig['floating']['position'], offset: null } })}>
            <option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option>
            <option value="top-right">Top right</option><option value="top-left">Top left</option>
          </Select>
        </Field>
        <Field label="Periodic health check" hint="A lightweight connectivity check while the side panel is open. Never runs model inference.">
          <Select value={String(config.periodicHealthMinutes)} onChange={(e) => void saveExt({ periodicHealthMinutes: Number(e.target.value) })}>
            <option value="0">Off</option><option value="1">Every minute</option><option value="5">Every 5 minutes</option><option value="15">Every 15 minutes</option><option value="60">Every hour</option>
          </Select>
        </Field>
      </div>
    </Section>
  );
}

export function SettingsPage({ initialTab = 'connection' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div className="space-y-3 p-3">
      <div className="overflow-x-auto"><Tabs value={tab} onChange={setTab} items={TABS} /></div>
      {tab === 'connection' && <ConnectionTab />}
      {tab === 'ai' && <AiTab />}
      {tab === 'memory' && <MemoryTab />}
      {tab === 'browser' && <BrowserTab />}
      {tab === 'privacy' && <PrivacyTab />}
      {tab === 'appearance' && <AppearanceTab />}
    </div>
  );
}
