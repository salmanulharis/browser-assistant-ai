/**
 * Plan → review → execute. The backend plans; this module validates plans with
 * Zod + local policy, executes ONLY user-approved actions, revalidates targets
 * and reports results back.
 */
import { api } from '@/services/api';
import { callAgent } from '@/services/page-reader';
import { BrowserTaskSchema, type BrowserTask, type FormGenerateResponse } from '@/types/api';
import { PlannedActionSchema, type ElementInfo, type ExecutionResult, type Fingerprint, type FormInfo, type PlannedAction } from '@/types/page';
import { DANGEROUS_CLICK, sensitiveValueReason } from '@/utils/sensitive';

export interface ReviewedAction {
  index: number;
  action: PlannedAction;
  element?: ElementInfo;
  fingerprint?: Fingerprint | null;
  localBlock?: string;
}

/** Local policy – independent of the backend's, so a compromised plan is still contained. */
export function localPolicy(action: PlannedAction, el: ElementInfo | undefined, pageUrl: string): string | null {
  const parsed = PlannedActionSchema.safeParse(action);
  if (!parsed.success) return 'Action does not match the allowed schema.';
  const needsTarget = ['click', 'type', 'fill', 'select', 'find', 'read', 'highlight'].includes(action.type);
  if (needsTarget && !el) return 'Target element is not on the page.';
  if (['type', 'fill', 'select', 'read'].includes(action.type) && el?.sensitive) return `Sensitive field (${el.sensitive}).`;
  if (['type', 'fill'].includes(action.type)) {
    const bad = sensitiveValueReason(action.value ?? '');
    if (bad) return `Value looks like a ${bad}.`;
  }
  if (action.type === 'click' && el) {
    if (['submit', 'image', 'reset'].includes(el.type.toLowerCase())) return 'Form submission is never automated.';
    if (DANGEROUS_CLICK.test(`${el.label} ${el.text} ${el.name}`)) return 'Button may submit, purchase or change an account.';
    if (el.href.startsWith('javascript:')) return 'Script links are not allowed.';
  }
  if (action.type === 'navigate') {
    try {
      const u = new URL(action.url ?? '');
      if (!/^https?:$/.test(u.protocol)) return 'Only http(s) navigation is allowed.';
      if (new URL(pageUrl).origin !== u.origin && !action.requires_confirmation) return 'Cross-site navigation must be explicitly confirmed.';
    } catch {
      return 'Invalid navigation URL.';
    }
  }
  return null;
}

export async function snapshotElements(tabId: number, url?: string): Promise<ElementInfo[]> {
  return callAgent<ElementInfo[]>(tabId, 'elements', [300], url);
}

export async function detectForms(tabId: number, url?: string): Promise<FormInfo[]> {
  return callAgent<FormInfo[]>(tabId, 'forms', [], url);
}

export async function planTask(input: {
  tabId: number; url: string; title: string; task: string; pageSummary?: string; useMemory?: boolean; useKnowledge?: boolean;
  /** Abort planning (e.g. the user pressed Cancel). */
  signal?: AbortSignal;
  /** Client-side limit; callers derive it from the backend generation timeout. */
  timeoutMs?: number;
}): Promise<{ task: BrowserTask; reviewed: ReviewedAction[]; elements: ElementInfo[] }> {
  const elements = await snapshotElements(input.tabId, input.url);
  const raw = await api.post<unknown>('/agent/plan', {
    task: input.task,
    url: input.url,
    title: input.title,
    page_summary: (input.pageSummary ?? '').slice(0, 8000),
    elements,
    use_memory: input.useMemory ?? true,
    use_knowledge: input.useKnowledge ?? true,
  }, { timeoutMs: input.timeoutMs ?? 300_000, signal: input.signal });
  const task = BrowserTaskSchema.parse(raw); // throws on any unexpected shape
  const byRef = new Map(elements.map((e) => [e.ref, e]));
  const refs = task.plan.actions.map((a) => a.target?.ref).filter((r): r is string => !!r);
  const fps = refs.length ? await callAgent<Record<string, Fingerprint | null>>(input.tabId, 'fingerprints', [refs], input.url) : {};
  const reviewed = task.plan.actions.map((action, index) => {
    const el = action.target?.ref ? byRef.get(action.target.ref) : undefined;
    return { index, action, element: el, fingerprint: action.target?.ref ? fps[action.target.ref] : undefined, localBlock: localPolicy(action, el, input.url) ?? undefined };
  });
  return { task, reviewed, elements };
}

/** Execute one approved action in the tab (or navigate via chrome.tabs). */
export async function executeApproved(tabId: number, url: string, item: ReviewedAction, signal?: AbortSignal): Promise<ExecutionResult> {
  if (signal?.aborted) return { status: 'cancelled', message: 'Cancelled before execution.' };
  if (item.localBlock) return { status: 'blocked', message: item.localBlock };
  const { action } = item;
  if (action.type === 'navigate') {
    const target = action.url ?? '';
    await chrome.tabs.update(tabId, { url: target });
    return { status: 'success', message: `Navigated to ${new URL(target).origin}.` };
  }
  return callAgent<ExecutionResult>(tabId, 'execute', [action, item.fingerprint ?? undefined], url);
}

export async function reportResults(taskId: string, status: string, results: { index: number; status: string; message: string }[]): Promise<BrowserTask> {
  const mapped = results.map((r) => ({ ...r, status: r.status === 'target_changed' ? 'failed' : r.status }));
  return BrowserTaskSchema.parse(await api.post(`/agent/tasks/${taskId}/result`, { status, results: mapped }));
}

export async function generateFieldValues(input: {
  url: string; title: string; form: FormInfo; refs?: string[]; instructions?: string; pageSummary?: string;
}): Promise<FormGenerateResponse> {
  return api.post<FormGenerateResponse>('/forms/generate', {
    url: input.url,
    title: input.title,
    page_summary: (input.pageSummary ?? '').slice(0, 8000),
    form_heading: input.form.heading,
    form_instructions: input.form.instructions,
    fields: input.form.fields,
    target_refs: input.refs ?? [],
    instructions: input.instructions ?? '',
  }, { timeoutMs: 300_000 });
}

export async function fillField(tabId: number, url: string, ref: string, value: string, expected?: Fingerprint | null): Promise<ExecutionResult> {
  return callAgent<ExecutionResult>(tabId, 'fill', [ref, value, expected ?? undefined], url);
}

export async function highlightRef(tabId: number, url: string, ref: string): Promise<boolean> {
  return callAgent<boolean>(tabId, 'highlight', [ref], url);
}

export async function fingerprintsOf(tabId: number, url: string, refs: string[]): Promise<Record<string, Fingerprint | null>> {
  return callAgent(tabId, 'fingerprints', [refs], url);
}
