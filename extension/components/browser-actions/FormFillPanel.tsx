import { CheckCircle2, Copy, Crosshair, RefreshCw, ShieldOff, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Select, Spinner, Textarea, cx } from '@/components/common/ui';
import { toast } from '@/components/common/toast';
import { api, describeError } from '@/services/api';
import { detectForms, fillField, fingerprintsOf, generateFieldValues, highlightRef, reportResults } from '@/services/browser-agent';
import { readTabCached } from '@/services/context-manager';
import type { TabSummary } from '@/services/tabs';
import { BrowserTaskSchema } from '@/types/api';
import type { ExecutionResult, Fingerprint, FormInfo } from '@/types/page';

interface Proposal { value: string; confidence: 'high' | 'medium' | 'low'; note: string; approved: boolean }

export function FormFillPanel({ tab, onClose }: { tab: TabSummary; onClose: () => void }) {
  const [forms, setForms] = useState<FormInfo[] | null>(null);
  const [formIdx, setFormIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState('');
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [skipped, setSkipped] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, ExecutionResult>>({});
  const [fps, setFps] = useState<Record<string, Fingerprint | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string | null } | null>(null);

  const load = async () => {
    setError(null);
    try {
      const f = await detectForms(tab.id, tab.url);
      setForms(f);
      if (f.length) choose(f, 0);
    } catch (e) {
      setError(describeError(e));
      setForms([]);
    }
  };

  const choose = (all: FormInfo[], i: number) => {
    setFormIdx(i);
    setProposals({});
    setSkipped({});
    setResults({});
    // Checkboxes are opt-in (ticking boxes is a decision); every other non-sensitive empty field is preselected.
    setSelected(new Set(all[i].fields.filter((f) => !f.sensitive && f.type !== 'checkbox' && !f.has_value).map((f) => f.ref)));
  };

  useEffect(() => { void load(); }, [tab.id]);

  const form = forms?.[formIdx];

  const generate = async (refs?: string[]) => {
    if (!form) return;
    const targets = refs ?? [...selected];
    if (!targets.length) return;
    setBusy(refs?.length === 1 ? refs[0] : 'all');
    setError(null);
    try {
      let summary = '';
      try { summary = (await readTabCached(tab)).main_text.slice(0, 4000); } catch { /* optional */ }
      const res = await generateFieldValues({ url: tab.url, title: tab.title, form, refs: targets, instructions, pageSummary: summary });
      const next = { ...proposals };
      for (const s of res.suggestions) next[s.ref] = { value: s.value, confidence: s.confidence, note: s.note, approved: false };
      setProposals(next);
      const sk = { ...skipped };
      for (const s of res.skipped) sk[s.ref] = s.reason;
      for (const s of res.suggestions) delete sk[s.ref];
      setSkipped(sk);
      setFps({ ...fps, ...(await fingerprintsOf(tab.id, tab.url, targets)) });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const insertApproved = async () => {
    if (!form) return;
    const refs = Object.entries(proposals).filter(([, p]) => p.approved && p.value).map(([r]) => r);
    if (!refs.length) return;
    setBusy('insert');
    const out: Record<string, ExecutionResult> = {};
    for (const ref of refs) {
      try {
        out[ref] = await fillField(tab.id, tab.url, ref, proposals[ref].value, fps[ref]);
      } catch (e) {
        out[ref] = { status: 'failed', message: describeError(e).message };
      }
    }
    setResults({ ...results, ...out });
    // Log the insertions as an approved browser task (no LLM call).
    try {
      const fieldByRef = new Map(form.fields.map((f) => [f.ref, f]));
      const task = BrowserTaskSchema.parse(await api.post('/agent/tasks', {
        task: `Fill form "${form.heading || form.name || 'form'}"`,
        url: tab.url,
        actions: refs.map((r) => ({ type: 'fill', target: { ref: r, label: fieldByRef.get(r)?.label ?? '' }, value: proposals[r].value, reason: 'Approved in form preview' })),
        elements: refs.map((r) => {
          const f = fieldByRef.get(r)!;
          return { ref: r, tag: f.tag, type: f.type, label: f.label, name: f.name, placeholder: f.placeholder, autocomplete: f.autocomplete, options: f.options, sensitive: f.sensitive };
        }),
      }));
      const ok = Object.values(out).filter((r) => r.status === 'success').length;
      await reportResults(task.id, ok === refs.length ? 'completed' : ok ? 'partial' : 'failed', refs.map((r, i) => ({ index: i, status: out[r].status, message: out[r].message })));
    } catch { /* logging is best effort */ }
    const failed = Object.values(out).filter((r) => r.status !== 'success').length;
    toast(failed ? `${failed} field(s) could not be filled.` : 'Inserted. Review the form and submit it yourself.', failed ? 'bad' : 'ok');
    setBusy(null);
  };

  if (forms === null) return <div className="p-4"><Spinner /></div>;
  if (!forms.length) {
    return (
      <div className="p-3">
        <ErrorNote error={error} />
        <Empty title="No fillable form fields found on this page">
          <Button size="sm" className="mt-2" onClick={() => void load()}>Scan again</Button>
        </Empty>
      </div>
    );
  }
  const approvedCount = Object.values(proposals).filter((p) => p.approved).length;

  return (
    <div className="space-y-2 p-3">
      {forms.length > 1 && (
        <Select value={formIdx} onChange={(e) => choose(forms, Number(e.target.value))} aria-label="Form">
          {forms.map((f, i) => <option key={f.ref} value={i}>{f.heading || f.name || `Form ${i + 1}`} ({f.fields.length} fields)</option>)}
        </Select>
      )}
      <Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Optional instructions (tone, which project to mention…)" aria-label="Instructions" />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => void generate()} disabled={!selected.size || !!busy} loading={busy === 'all'}>Generate {selected.size} value(s)</Button>
        <Button size="sm" variant="primary" onClick={() => void insertApproved()} disabled={!approvedCount || !!busy} loading={busy === 'insert'}>Insert {approvedCount} approved</Button>
        <Button size="sm" onClick={onClose}>Close</Button>
      </div>
      <ErrorNote error={error} />
      <ul className="space-y-1.5">
        {form!.fields.map((f) => {
          const p = proposals[f.ref];
          const r = results[f.ref];
          const disabled = !!f.sensitive;
          return (
            <li key={f.ref} className={cx('rounded-md border p-2 text-xs', disabled ? 'border-border opacity-70' : 'border-border')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" aria-label={`Include ${f.label || f.name}`} disabled={disabled} checked={selected.has(f.ref)}
                  onChange={(e) => { const n = new Set(selected); e.target.checked ? n.add(f.ref) : n.delete(f.ref); setSelected(n); }} />
                <span className="min-w-0 flex-1 truncate font-medium">{f.label || f.name || f.placeholder || f.type}{f.required && <span className="text-bad"> *</span>}</span>
                <Badge>{f.tag === 'select' ? 'select' : f.type}</Badge>
                {f.has_value && <Badge tone="warn">has value</Badge>}
                <button className="text-muted hover:text-fg" title="Show on page" aria-label="Highlight field" onClick={() => void highlightRef(tab.id, tab.url, f.ref)}><Crosshair className="size-3.5" /></button>
              </div>
              {f.sensitive && <p className="mt-1 flex items-center gap-1 text-muted"><ShieldOff className="size-3" /> Never filled automatically ({f.sensitive}).</p>}
              {skipped[f.ref] && !p && <p className="mt-1 text-muted">{skipped[f.ref]}</p>}
              {p && (
                <div className="mt-1 space-y-1">
                  {f.type === 'checkbox' ? (
                    <Select value={p.value === 'true' ? 'true' : 'false'} onChange={(e) => setProposals({ ...proposals, [f.ref]: { ...p, value: e.target.value } })} aria-label="Proposed state">
                      <option value="true">Checked</option>
                      <option value="false">Unchecked</option>
                    </Select>
                  ) : f.options.length ? (
                    <Select value={p.value} onChange={(e) => setProposals({ ...proposals, [f.ref]: { ...p, value: e.target.value } })} aria-label="Proposed option">
                      {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                  ) : (
                    <Textarea rows={Math.min(5, Math.max(1, Math.ceil(p.value.length / 60)))} value={p.value} onChange={(e) => setProposals({ ...proposals, [f.ref]: { ...p, value: e.target.value } })} aria-label="Proposed value" />
                  )}
                  <div className="flex items-center gap-1.5">
                    <label className="flex items-center gap-1"><input type="checkbox" checked={p.approved} onChange={(e) => setProposals({ ...proposals, [f.ref]: { ...p, approved: e.target.checked } })} /> Approve</label>
                    <Badge tone={p.confidence === 'high' ? 'ok' : p.confidence === 'low' ? 'warn' : 'neutral'}>{p.confidence}</Badge>
                    <span className="flex-1" />
                    <button className="text-muted hover:text-fg" title="Copy" aria-label="Copy value" onClick={() => navigator.clipboard.writeText(p.value)}><Copy className="size-3.5" /></button>
                    <button className="text-muted hover:text-fg" title="Regenerate" aria-label="Regenerate value" disabled={!!busy} onClick={() => void generate([f.ref])}>
                      <RefreshCw className={cx('size-3.5', busy === f.ref && 'animate-spin')} />
                    </button>
                    {r && (r.status === 'success' ? <CheckCircle2 className="size-3.5 text-ok" aria-label="Inserted" /> : <XCircle className="size-3.5 text-bad" aria-label="Failed" />)}
                  </div>
                  {p.note && <p className="text-muted">{p.note}</p>}
                  {r && r.status !== 'success' && <p className="text-bad">{r.message}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[0.7rem] text-muted">Forms are never submitted automatically. Password, payment and login fields are never read or filled.</p>
    </div>
  );
}
