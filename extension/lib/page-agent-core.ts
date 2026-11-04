/**
 * DOM logic that runs inside web pages (isolated world): structured extraction,
 * form detection, element registry and SAFE execution of approved actions.
 *
 * Never reads password / sensitive field values. Never submits forms. No eval.
 */
import { Readability } from '@mozilla/readability';
import type {
  ElementInfo, ExecutionResult, FieldOption, Fingerprint, FormField, FormInfo, PageContext, PlannedAction,
} from '@/types/page';
import { CONSENT_PATTERN, matchOptionIndex, normalizeForInput, toBool } from '@/lib/field-values';
import { DANGEROUS_CLICK, sensitiveFieldReason, sensitiveValueReason } from '@/utils/sensitive';

const MAX_MAIN_TEXT = 200_000;
const AD_PATTERN = /(^|[\s_-])(ad|ads|advert|advertisement|sponsor(ed)?|promo|banner-ad|cookie-banner|newsletter-signup)([\s_-]|$)/i;

// ------------------------------------------------------------- registry
interface Registry { byRef: Map<string, WeakRef<Element>>; byEl: WeakMap<Element, string>; next: number }

function registry(): Registry {
  const w = globalThis as unknown as { __lbaRegistry?: Registry };
  if (!w.__lbaRegistry) w.__lbaRegistry = { byRef: new Map(), byEl: new WeakMap(), next: 1 };
  return w.__lbaRegistry;
}

export function refFor(el: Element): string {
  const r = registry();
  let ref = r.byEl.get(el);
  if (!ref) {
    ref = `e${r.next++}`;
    r.byEl.set(el, ref);
    r.byRef.set(ref, new WeakRef(el));
  }
  return ref;
}

export function elementForRef(ref: string): Element | null {
  const el = registry().byRef.get(ref)?.deref() ?? null;
  return el && el.isConnected ? el : null;
}

// ------------------------------------------------------------ utilities
const clean = (s: string | null | undefined, max = 500): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
};

export function isHidden(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if ((n as HTMLElement).hidden || n.getAttribute('aria-hidden') === 'true') return true;
    const view = n.ownerDocument?.defaultView;
    if (view) {
      const cs = view.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    }
    if (n.tagName === 'BODY') break;
  }
  return false;
}

function isAdLike(el: Element): boolean {
  const id = el.id || '';
  const cls = typeof el.className === 'string' ? el.className : '';
  return AD_PATTERN.test(id) || AD_PATTERN.test(cls) || el.getAttribute('aria-label')?.toLowerCase() === 'advertisement';
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function textOf(el: Element | null | undefined): string {
  if (!el) return '';
  return clean((el as HTMLElement).innerText ?? el.textContent ?? '', 2000);
}

function selectedText(doc: Document): string {
  const active = doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type === 'text'))) {
    if (sensitiveFieldReason(fieldDescriptor(active))) return '';
    const { selectionStart: s, selectionEnd: e } = active;
    if (s != null && e != null && e > s) return active.value.slice(s, e);
  }
  return doc.defaultView?.getSelection()?.toString() ?? '';
}

// --------------------------------------------------------------- labels
function labelFor(el: Element): string {
  const doc = el.ownerDocument;
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria, 300);
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = labelledby.split(/\s+/).map((id) => textOf(doc.getElementById(id))).join(' ');
    if (t.trim()) return clean(t, 300);
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) {
    const t = Array.from(labels).map((l) => textOf(l)).join(' ');
    if (t.trim()) return clean(t, 300);
  }
  const id = el.getAttribute('id');
  if (id) {
    const l = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (l) return clean(textOf(l), 300);
  }
  const wrap = el.closest('label');
  if (wrap) return clean(textOf(wrap), 300);
  const title = el.getAttribute('title');
  if (title) return clean(title, 300);
  // previous sibling text (common in div-based forms)
  let prev = el.previousElementSibling;
  for (let i = 0; prev && i < 2; i++, prev = prev.previousElementSibling) {
    const t = textOf(prev);
    if (t && t.length < 120) return t;
  }
  const parentPrev = el.parentElement?.previousElementSibling;
  const t = textOf(parentPrev);
  return t && t.length < 120 ? t : '';
}

function fieldDescriptor(el: Element) {
  const input = el as HTMLInputElement;
  return {
    type: el.tagName === 'INPUT' ? input.type : el.tagName.toLowerCase(),
    autocomplete: el.getAttribute('autocomplete') ?? '',
    label: labelFor(el),
    name: el.getAttribute('name') ?? el.getAttribute('id') ?? '',
    placeholder: el.getAttribute('placeholder') ?? '',
  };
}

export function fingerprint(el: Element): Fingerprint {
  const d = fieldDescriptor(el);
  return { tag: el.tagName.toLowerCase(), type: d.type, name: d.name, label: d.label || textOf(el).slice(0, 80) };
}

function nearbyText(el: Element): string {
  const doc = el.ownerDocument;
  const describedby = el.getAttribute('aria-describedby');
  if (describedby) {
    const t = describedby.split(/\s+/).map((id) => textOf(doc.getElementById(id))).join(' ');
    if (t.trim()) return clean(t, 400);
  }
  const help = el.parentElement?.querySelector('small, .help, .hint, [class*="help"], [class*="hint"], [class*="description"]');
  return help && help !== el ? clean(textOf(help), 400) : '';
}

// ---------------------------------------------------------------- forms
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'file']);

function radioOptions(el: HTMLInputElement): FieldOption[] {
  const root = el.form ?? el.ownerDocument;
  return Array.from(root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)).map((r) => ({
    value: r.value,
    label: labelFor(r) || r.value,
  }));
}

export function describeField(el: Element): FormField | null {
  const tag = el.tagName.toLowerCase();
  const isCE = el.getAttribute('contenteditable') !== null && tag !== 'input' && tag !== 'textarea';
  const input = el as HTMLInputElement;
  const type = tag === 'input' ? (input.type || 'text').toLowerCase() : isCE ? 'contenteditable' : tag;
  if (tag === 'input' && SKIP_INPUT_TYPES.has(type)) return null;
  const d = fieldDescriptor(el);
  const sensitive = sensitiveFieldReason(d);
  let options: FieldOption[] = [];
  if (tag === 'select') {
    options = Array.from((el as HTMLSelectElement).options)
      .filter((o) => !o.disabled)
      .map((o) => ({ value: o.value, label: clean(o.label || o.text, 200) }));
  } else if (type === 'radio') {
    options = radioOptions(input);
  }
  const labelText = d.label;
  const value = isCE ? el.textContent ?? '' : (input.value ?? '');
  const maxLen = tag === 'input' || tag === 'textarea' ? (input.maxLength > 0 ? input.maxLength : null) : null;
  return {
    ref: refFor(el),
    tag: isCE ? 'contenteditable' : (tag as FormField['tag']),
    type,
    name: d.name,
    label: labelText,
    placeholder: d.placeholder,
    autocomplete: d.autocomplete,
    required: input.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(labelText),
    max_length: maxLen,
    options: options.slice(0, 1000),
    nearby_text: nearbyText(el),
    // Values are never transmitted; sensitive fields don't even report presence.
    has_value: sensitive ? false : type === 'checkbox' || type === 'radio' ? input.checked : value.trim().length > 0,
    sensitive,
  };
}

export function detectForms(doc: Document = document): FormInfo[] {
  const groups = new Map<Element | null, Element[]>();
  const seenRadio = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll(FIELD_SELECTOR))) {
    if (isHidden(el) || (el as HTMLInputElement).disabled || el.closest('[data-lba-ui]')) continue;
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'radio') {
      const key = `${(el as HTMLInputElement).form ? refFor((el as HTMLInputElement).form!) : ''}:${(el as HTMLInputElement).name}`;
      if (seenRadio.has(key)) continue;
      seenRadio.add(key);
    }
    const form = el.closest('form');
    if (!groups.has(form)) groups.set(form, []);
    groups.get(form)!.push(el);
  }
  const forms: FormInfo[] = [];
  for (const [form, els] of groups) {
    const fields = els.map(describeField).filter((f): f is FormField => !!f);
    if (!fields.length) continue;
    const heading = form
      ? clean(form.getAttribute('aria-label') || textOf(form.querySelector('legend, h1, h2, h3, h4')) || '', 300)
      : clean(textOf(doc.querySelector('h1')), 300);
    const instructions = form
      ? clean(Array.from(form.querySelectorAll('p')).slice(0, 3).map((p) => textOf(p)).join(' '), 1500)
      : '';
    forms.push({
      ref: form ? refFor(form) : 'page',
      name: form?.getAttribute('name') ?? form?.getAttribute('id') ?? (form ? '' : 'Fields outside a form'),
      heading,
      instructions,
      fields: fields.slice(0, 200),
    });
  }
  return forms.slice(0, 30);
}

// ------------------------------------------------------- interactive els
const INTERACTIVE = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"], [role="combobox"], [role="menuitem"], [contenteditable="true"]';

export function interactiveElements(doc: Document = document, limit = 300): ElementInfo[] {
  const out: ElementInfo[] = [];
  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE))) {
    if (out.length >= limit) break;
    if (isHidden(el) || el.closest('[data-lba-ui]')) continue;
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    if (tag === 'input' && input.type === 'hidden') continue;
    const d = fieldDescriptor(el);
    const isField = ['input', 'textarea', 'select'].includes(tag);
    let options: FieldOption[] = [];
    if (tag === 'select') options = Array.from((el as HTMLSelectElement).options).map((o) => ({ value: o.value, label: clean(o.label || o.text, 200) }));
    else if (tag === 'input' && input.type === 'radio') options = radioOptions(input);
    const href = tag === 'a' ? (el as HTMLAnchorElement).href : '';
    out.push({
      ref: refFor(el),
      tag,
      // button.type defaults to "submit" inside forms – exactly what the policy needs.
      type: tag === 'button' ? (el as HTMLButtonElement).type : tag === 'input' ? input.type : '',
      role: el.getAttribute('role') ?? '',
      label: d.label,
      text: isField ? '' : clean(textOf(el), 200),
      name: d.name,
      placeholder: d.placeholder,
      autocomplete: d.autocomplete,
      href: href.startsWith('http') ? href.split('#')[0].slice(0, 2048) : href.startsWith('javascript:') ? 'javascript:' : '',
      options: options.slice(0, 1000),
      disabled: !!(el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true',
      checked: tag === 'input' && (input.type === 'checkbox' || input.type === 'radio') ? input.checked
        : isAriaToggle(el) || el.getAttribute('role') === 'radio' ? el.getAttribute('aria-checked') === 'true' : null,
      sensitive: isField ? sensitiveFieldReason(d) : null,
      form_ref: (el as HTMLInputElement).form ? refFor((el as HTMLInputElement).form!) : null,
    });
  }
  return out;
}

// ------------------------------------------------------------ extraction
export interface ExtractOptions { includeForms?: boolean; includeLinks?: boolean; useReadability?: boolean }

export function extractPage(doc: Document = document, opts: ExtractOptions = {}): PageContext {
  const { includeForms = true, includeLinks = true, useReadability = true } = opts;
  const meta = (sel: string) => doc.querySelector<HTMLMetaElement>(sel)?.content ?? '';
  const loc = doc.defaultView?.location;
  const url = loc ? `${loc.origin}${loc.pathname}${loc.search}` : doc.URL;

  let mainText = '';
  if (useReadability) {
    try {
      const clone = doc.cloneNode(true) as Document;
      clone.querySelectorAll('[data-lba-ui], script, style, noscript, template').forEach((n) => n.remove());
      const parsed = new Readability(clone, { charThreshold: 300 }).parse();
      mainText = parsed?.textContent ?? '';
    } catch {
      mainText = '';
    }
  }
  const root = doc.querySelector('main, article, [role="main"]') ?? doc.body;
  const visible = (sel: string) => Array.from(root?.querySelectorAll(sel) ?? []).filter((e) => !isHidden(e) && !isAdLike(e) && !e.closest('[data-lba-ui], nav, footer, aside'));

  const seen = new Set<string>();
  const uniq = (t: string) => {
    if (!t || seen.has(t)) return false;
    seen.add(t);
    return true;
  };
  const paragraphs = visible('p').map((p) => textOf(p)).filter((t) => t.length > 20 && uniq(t)).slice(0, 1500);
  if (!mainText.trim()) mainText = paragraphs.join('\n\n') || textOf(root).slice(0, MAX_MAIN_TEXT);
  mainText = mainText.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

  const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .filter((h) => !isHidden(h) && !h.closest('[data-lba-ui]'))
    .map((h) => ({ level: Number(h.tagName[1]), text: clean(textOf(h), 300) }))
    .filter((h) => h.text)
    .slice(0, 200);
  const lists = visible('ul, ol')
    .filter((l) => !l.parentElement?.closest('ul, ol'))
    .map((l) => Array.from(l.querySelectorAll(':scope > li')).map((li) => clean(textOf(li), 300)).filter(Boolean))
    .filter((items) => items.length > 1 && items.join('').length > 40)
    .slice(0, 100);
  const tables = visible('table').slice(0, 30).map((t) => ({
    caption: clean(textOf(t.querySelector('caption')), 200),
    rows: Array.from(t.querySelectorAll('tr')).slice(0, 100).map((tr) =>
      Array.from(tr.querySelectorAll('th, td')).slice(0, 15).map((c) => clean(textOf(c), 200))),
  })).filter((t) => t.rows.length);
  const codeBlocks = visible('pre').slice(0, 50).map((pre) => {
    const code = pre.querySelector('code');
    const cls = (code?.className || pre.className || '').match(/(?:language|lang)-([\w+#-]+)/);
    return { language: cls?.[1] ?? '', code: (pre.textContent ?? '').slice(0, 15000) };
  }).filter((c) => c.code.trim());
  const links = includeLinks
    ? visible('a[href]').map((a) => ({ text: clean(textOf(a), 150), href: (a as HTMLAnchorElement).href.split('#')[0] }))
        .filter((l) => l.text && /^https?:/.test(l.href) && uniq(`L:${l.href}`)).slice(0, 150)
    : [];

  const truncated = mainText.length > MAX_MAIN_TEXT;
  return {
    url,
    title: clean(doc.title, 400),
    description: clean(meta('meta[name="description"]') || meta('meta[property="og:description"]'), 1000),
    lang: doc.documentElement.lang || '',
    site_name: clean(meta('meta[property="og:site_name"]'), 100),
    headings,
    main_text: mainText.slice(0, MAX_MAIN_TEXT),
    paragraphs,
    lists,
    tables,
    code_blocks: codeBlocks,
    links,
    selected_text: selectedText(doc).slice(0, 40_000),
    forms: includeForms ? detectForms(doc) : [],
    content_hash: hash(mainText),
    truncated,
  };
}

// ------------------------------------------------------- value setting
/** Set a value in a way React/Vue/Angular controlled inputs observe. */
type NativeView = Window & typeof globalThis;

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, view: NativeView): void {
  // Use the prototype setter so React/Vue-controlled inputs notice the change.
  const proto = el instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype
    : el instanceof view.HTMLSelectElement ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fireChange(el: Element, view: NativeView): void {
  el.dispatchEvent(new view.Event('input', { bubbles: true }));
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
  el.dispatchEvent(new view.FocusEvent('blur', { bubbles: false }));
}

const optionList = (sel: HTMLSelectElement) =>
  Array.from(sel.options).map((o) => ({ value: o.value, label: clean(o.label || o.text, 300), disabled: o.disabled }));

/** ARIA checkbox/switch (div/button with role + aria-checked). */
function isAriaToggle(el: Element): boolean {
  const role = el.getAttribute('role');
  return (role === 'checkbox' || role === 'switch') && el.tagName !== 'INPUT';
}

/** True when the element is a checkbox (native or ARIA). */
export function isCheckboxLike(el: Element): boolean {
  return (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') || isAriaToggle(el);
}

/**
 * Insert `value` into a field the way a user would, for every native field type:
 * text-like inputs (with format normalisation for date/time/number/…), textarea, single and
 * multiple <select>, radio groups, checkboxes, ARIA checkboxes/switches and contenteditable.
 * Throws a descriptive Error when the value cannot be applied (it is never silently dropped).
 */
export function setFieldValue(el: Element, value: string): void {
  const view = el.ownerDocument.defaultView as NativeView | null;
  if (!view) throw new Error('No window');

  if (el instanceof view.HTMLSelectElement) {
    const enabled = optionList(el).filter((o) => !o.disabled);
    if (el.multiple) {
      const wanted = value.split(/\s*[,;\n]\s*/).filter(Boolean);
      const idx = wanted.map((w) => matchOptionIndex(w, enabled));
      const bad = wanted.filter((_, k) => idx[k] < 0);
      if (bad.length) throw new Error(`"${bad.join('", "')}" ${bad.length > 1 ? 'are' : 'is'} not an option of this list`);
      const chosen = new Set(idx.map((k) => enabled[k].value));
      for (const o of Array.from(el.options)) o.selected = chosen.has(o.value);
    } else {
      const k = matchOptionIndex(value, enabled);
      if (k < 0) throw new Error(`"${value}" is not an option of this field`);
      setNativeValue(el, enabled[k].value, view);
    }
    el.focus();
    fireChange(el, view);
    return;
  }

  if (el instanceof view.HTMLInputElement && el.type === 'radio') {
    const group = el.name
      ? Array.from((el.form ?? el.ownerDocument).querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
      : [el];
    const k = matchOptionIndex(value, group.map((r) => ({ value: r.value, label: labelFor(r) || r.value })));
    // A bare "true"/"yes" aimed at one radio means "select this one".
    const target = k >= 0 ? group[k] : toBool(value) === true ? el : null;
    if (!target) throw new Error(`"${value}" is not an option of this radio group`);
    if (target.disabled) throw new Error('That option is disabled');
    if (!target.checked) target.click();
    if (!target.checked) throw new Error('The page did not accept the selection');
    return;
  }

  if (isCheckboxLike(el)) {
    const want = toBool(value);
    if (want === null) throw new Error(`"${value}" is not a checked/unchecked value`);
    const isChecked = () => (el instanceof view.HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true');
    if (isChecked() !== want) (el as HTMLElement).click();
    if (isChecked() !== want) throw new Error('The page did not accept the change');
    return;
  }

  if (el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement) {
    const type = el instanceof view.HTMLInputElement ? el.type.toLowerCase() : 'textarea';
    let v = el instanceof view.HTMLInputElement ? normalizeForInput(type, value) : value;
    if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
    el.focus();
    setNativeValue(el, v, view);
    fireChange(el, view);
    // Browsers silently reject malformed values for typed inputs (date, number, color, …).
    if (v && el.value === '' && !['text', 'search', 'textarea', 'password', 'email', 'url', 'tel'].includes(type)) {
      throw new Error(`"${value}" is not a valid ${type} value for this field`);
    }
    return;
  }

  if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') !== null) {
    const h = el as HTMLElement;
    const doc = el.ownerDocument;
    h.focus();
    // Rich editors (ProseMirror, Draft, Lexical, Gutenberg) track edits through input events;
    // execCommand keeps their internal model in sync. Fall back to textContent otherwise.
    let done = false;
    const sel = doc.getSelection();
    if (sel && typeof doc.execCommand === 'function') {
      const range = doc.createRange();
      range.selectNodeContents(h);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        done = doc.execCommand('insertText', false, value);
      } catch {
        done = false;
      }
    }
    if (!done || clean(h.textContent ?? '', 100000) !== clean(value, 100000)) {
      h.textContent = value;
      h.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
    h.dispatchEvent(new view.FocusEvent('blur', { bubbles: false }));
    return;
  }

  throw new Error('Element is not an editable field');
}

// --------------------------------------------------- custom dropdowns
/** Script-driven dropdown (ARIA combobox/listbox, select2, react-select…) – not a native <select>. */
export function isCustomCombobox(el: Element): boolean {
  if (el.tagName === 'SELECT') return false;
  const role = el.getAttribute('role');
  return role === 'combobox' || role === 'listbox' || el.getAttribute('aria-haspopup') === 'listbox';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function visibleOptions(doc: Document, el: Element): HTMLElement[] {
  const owned = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  const scope: ParentNode = (owned && doc.getElementById(owned.split(/\s+/)[0])) || doc;
  return Array.from(scope.querySelectorAll<HTMLElement>('[role="option"]'))
    .filter((o) => !isHidden(o) && o.getAttribute('aria-disabled') !== 'true');
}

const asOptions = (els: HTMLElement[]) => els.map((o) => ({ value: o.getAttribute('data-value') ?? '', label: textOf(o) }));

/**
 * Pick `value` in a custom dropdown the way a user does: open it, type to filter, click the
 * matching option. Waits up to ~2.5 s for options to render; throws when nothing matches.
 */
export async function chooseInCustomCombobox(el: Element, value: string): Promise<void> {
  const view = el.ownerDocument.defaultView as NativeView | null;
  if (!view) throw new Error('No window');
  const doc = el.ownerDocument;
  const h = el as HTMLElement;
  h.focus();
  h.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true }));
  h.click();
  // Type into the combobox (or its inner search input) to filter long lists.
  const input = el instanceof view.HTMLInputElement ? el
    : (el.querySelector('input') ?? (doc.activeElement instanceof view.HTMLInputElement ? doc.activeElement : null));
  if (input && !sensitiveFieldReason(fieldDescriptor(input))) {
    setNativeValue(input, value, view);
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
  }
  let options: HTMLElement[] = [];
  let k = -1;
  for (let i = 0; i < 25 && k < 0; i++) {
    await sleep(100);
    options = visibleOptions(doc, el);
    k = matchOptionIndex(value, asOptions(options));
  }
  if (k < 0) {
    h.dispatchEvent(new view.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    throw new Error(options.length ? `"${value}" is not one of the dropdown's options` : 'The dropdown did not show any options');
  }
  const opt = options[k];
  opt.scrollIntoView?.({ block: 'nearest' });
  opt.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true }));
  opt.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true }));
  opt.click();
  await sleep(150);
}

// ---------------------------------------------------------- highlighting
const HL_ATTR = 'data-lba-highlight';

export function highlight(el: Element, ms = 2500): void {
  const h = el as HTMLElement;
  const prev = h.style.outline;
  const prevOffset = h.style.outlineOffset;
  h.setAttribute(HL_ATTR, '1');
  h.style.outline = '3px solid #6366f1';
  h.style.outlineOffset = '2px';
  h.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  setTimeout(() => {
    h.style.outline = prev;
    h.style.outlineOffset = prevOffset;
    h.removeAttribute(HL_ATTR);
  }, ms);
}

// ------------------------------------------------------------- executor
function resolveTarget(action: PlannedAction, expected?: Fingerprint): { el: Element | null; changed: boolean } {
  const ref = action.target?.ref;
  if (!ref) return { el: null, changed: false };
  const el = elementForRef(ref);
  if (!el) return { el: null, changed: true };
  if (expected) {
    const now = fingerprint(el);
    const changed = now.tag !== expected.tag || now.type !== expected.type || now.name !== expected.name || now.label !== expected.label;
    return { el, changed };
  }
  return { el, changed: false };
}

/** Safety checks shared by every write (fill/type/select); returns a refusal or null. */
function writeRefusal(el: Element, value: string, sensitive: string | null): ExecutionResult | null {
  if (sensitive) return { status: 'blocked', message: `Refused: ${sensitive}. Fill it yourself.` };
  const bad = sensitiveValueReason(value);
  if (bad) return { status: 'blocked', message: `Refused: value looks like a ${bad}.` };
  if (isCheckboxLike(el) && toBool(value) === true) {
    const label = [labelFor(el), textOf(el), el.getAttribute('name') ?? ''].join(' ');
    const isChecked = el.tagName === 'INPUT' ? (el as HTMLInputElement).checked : el.getAttribute('aria-checked') === 'true';
    if (!isChecked && CONSENT_PATTERN.test(label)) {
      return { status: 'blocked', message: 'Refused: agreeing to terms, consent or subscriptions is your decision – tick it yourself.' };
    }
  }
  return null;
}

/**
 * Like executeAction, but also handles script-driven dropdowns (ARIA combobox/listbox,
 * select2, react-select…) that must be opened and clicked asynchronously.
 */
export async function executeActionAsync(action: PlannedAction, expected?: Fingerprint): Promise<ExecutionResult> {
  const ref = action.target?.ref;
  const el = ref ? elementForRef(ref) : null;
  if (action.type !== 'select' || !el || !isCustomCombobox(el)) return executeAction(action, expected);
  const { changed } = resolveTarget(action, expected);
  if (changed) return { status: 'target_changed', message: 'The element changed since the plan was made. Please review and confirm again.' };
  if (isHidden(el)) return { status: 'failed', message: 'The element is not visible.' };
  const refused = writeRefusal(el, action.value ?? '', null);
  if (refused) return refused;
  try {
    await chooseInCustomCombobox(el, action.value ?? '');
    highlight(el, 1200);
    return { status: 'success', message: 'Option selected (not submitted).' };
  } catch (e) {
    return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Execute ONE already-approved action. Re-validates the target and safety rules at
 * execution time; navigation is handled by the extension (not here).
 */
export function executeAction(action: PlannedAction, expected?: Fingerprint): ExecutionResult {
  if (action.type === 'navigate') return { status: 'skipped', message: 'Navigation is performed by the extension.' };
  if (action.type === 'scroll' && !action.target?.ref) {
    const view = document.defaultView!;
    const dir = action.direction ?? 'down';
    if (dir === 'top') view.scrollTo({ top: 0, behavior: 'smooth' });
    else if (dir === 'bottom') view.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    else view.scrollBy({ top: (dir === 'up' ? -1 : 1) * view.innerHeight * 0.8, behavior: 'smooth' });
    return { status: 'success', message: `Scrolled ${dir}.` };
  }
  const { el, changed } = resolveTarget(action, expected);
  if (!el) return { status: changed ? 'target_changed' : 'failed', message: changed ? 'The element no longer exists – the page changed. Re-plan the task.' : 'No target element.' };
  if (changed) return { status: 'target_changed', message: 'The element changed since the plan was made. Please review and confirm again.' };
  if (isHidden(el)) return { status: 'failed', message: 'The element is not visible.' };

  const d = fieldDescriptor(el);
  const sensitive = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? sensitiveFieldReason(d) : null;
  try {
    switch (action.type) {
      case 'highlight':
      case 'find':
        highlight(el);
        return { status: 'success', message: 'Element highlighted.' };
      case 'scroll':
        (el as HTMLElement).scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        return { status: 'success', message: 'Scrolled to element.' };
      case 'read': {
        if (sensitive) return { status: 'blocked', message: `Refused: ${sensitive}.` };
        const v = 'value' in el && typeof (el as HTMLInputElement).value === 'string' && el.tagName !== 'BUTTON'
          ? (el as HTMLInputElement).value : textOf(el);
        return { status: 'success', message: 'Read element.', data: clean(v, 4000) };
      }
      case 'type':
      case 'fill':
      case 'select': {
        const refused = writeRefusal(el, action.value ?? '', sensitive);
        if (refused) return refused;
        if (action.type === 'select' && isCustomCombobox(el)) {
          return { status: 'failed', message: 'This dropdown is script-driven; use the asynchronous executor.' };
        }
        setFieldValue(el, action.value ?? '');
        highlight(el, 1200);
        return { status: 'success', message: isCheckboxLike(el) ? 'Checkbox set (not submitted).' : 'Value inserted (not submitted).' };
      }
      case 'click': {
        const tag = el.tagName.toLowerCase();
        const type = ((el as HTMLButtonElement).type || '').toLowerCase();
        if ((tag === 'button' || tag === 'input') && ['submit', 'image', 'reset'].includes(type)) {
          return { status: 'blocked', message: 'Refused: this would submit or reset a form.' };
        }
        const label = [d.label, textOf(el), d.name].join(' ');
        if (DANGEROUS_CLICK.test(label)) return { status: 'blocked', message: `Refused: "${clean(label, 60)}" may submit, pay or change an account.` };
        if (tag === 'a' && /^\s*javascript:/i.test(el.getAttribute('href') ?? '')) return { status: 'blocked', message: 'Refused: script link.' };
        highlight(el, 800);
        (el as HTMLElement).click();
        return { status: 'success', message: 'Clicked.' };
      }
      default:
        return { status: 'blocked', message: `Unsupported action type.` };
    }
  } catch (e) {
    return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

export function fingerprintsFor(refs: string[]): Record<string, Fingerprint | null> {
  const out: Record<string, Fingerprint | null> = {};
  for (const r of refs) {
    const el = elementForRef(r);
    out[r] = el ? fingerprint(el) : null;
  }
  return out;
}

/** Lightweight change signal without rescanning the full DOM. */
export function pageSignature(doc: Document = document): string {
  const body = doc.body;
  const len = body ? (body.textContent ?? '').length : 0;
  return `${doc.title}|${doc.defaultView?.location.href ?? ''}|${Math.round(len / 200)}|${doc.forms.length}`;
}

export const pageAgent = {
  version: 1,
  extract: (opts?: ExtractOptions) => extractPage(document, opts),
  forms: () => detectForms(document),
  elements: (limit?: number) => interactiveElements(document, limit),
  execute: (action: PlannedAction, expected?: Fingerprint) => executeActionAsync(action, expected),
  fingerprints: (refs: string[]) => fingerprintsFor(refs),
  highlight: (ref: string) => {
    const el = elementForRef(ref);
    if (el) highlight(el);
    return !!el;
  },
  fill: (ref: string, value: string, expected?: Fingerprint) => {
    // Form-fill panel: values for dropdowns/radios are selections (custom dropdowns need the async path).
    const el = elementForRef(ref);
    const type = el && (el.tagName === 'SELECT' || isCustomCombobox(el) || (el as HTMLInputElement).type === 'radio') ? 'select' : 'fill';
    return executeActionAsync({ type, target: { ref }, value, reason: '', requires_confirmation: false }, expected);
  },
  signature: () => pageSignature(document),
  selection: () => selectedText(document),
};

export type PageAgent = typeof pageAgent;
