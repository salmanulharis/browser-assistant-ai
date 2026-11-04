import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectForms, executeAction, extractPage, fingerprint, interactiveElements, refFor, setFieldValue } from '@/lib/page-agent-core';
import { localPolicy } from '@/services/browser-agent';
import { ContentMessageSchema } from '@/types/messages';
import { ExtensionConfigSchema } from '@/types/config';
import { isExcludedHost, DEFAULT_EXCLUDED_SITES, sensitiveFieldReason } from '@/utils/sensitive';
import { SseParser } from '@/utils/sse';

function page(html: string) {
  document.body.innerHTML = html;
}

describe('page extraction', () => {
  beforeEach(() => {
    document.title = 'Pricing – Example';
    page(`
      <nav><a href="/a">Home</a><a href="/b">Docs</a></nav>
      <main>
        <h1>Pricing</h1>
        <p>The Pro plan costs 12 dollars per month and includes unlimited projects for small teams.</p>
        <p>The Pro plan costs 12 dollars per month and includes unlimited projects for small teams.</p>
        <ul><li>Unlimited projects for every member</li><li>Priority support within one business day</li></ul>
        <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$12</td></tr></table>
        <pre><code class="language-js">const x = 1;</code></pre>
        <div style="display:none"><p>Hidden secret promo text that must not be extracted at all.</p></div>
        <script>window.evil = 1</script>
        <style>.x{color:red}</style>
      </main>`);
  });

  it('extracts structure and removes scripts, styles, hidden and duplicate content', () => {
    const p = extractPage(document, { useReadability: false });
    expect(p.title).toContain('Pricing');
    expect(p.headings.map((h) => h.text)).toContain('Pricing');
    expect(p.paragraphs.filter((x) => x.includes('Pro plan costs'))).toHaveLength(1);
    expect(JSON.stringify(p)).not.toContain('Hidden secret promo');
    expect(JSON.stringify(p)).not.toContain('window.evil');
    expect(JSON.stringify(p)).not.toContain('color:red');
    expect(p.lists.flat()).toContain("Priority support within one business day");
    expect(p.tables[0].rows.flat()).toContain('$12');
    expect(p.code_blocks[0].code).toContain('const x = 1');
    expect(p.content_hash).toBeTruthy();
  });

  it('includes the current selection', () => {
    const para = document.querySelector('main p')!;
    const range = document.createRange();
    range.selectNodeContents(para);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(extractPage(document, { useReadability: false }).selected_text).toContain('12 dollars');
  });
});

describe('form detection', () => {
  beforeEach(() =>
    page(`
      <form name="apply" aria-label="Job application">
        <p>Please answer all questions honestly.</p>
        <label for="n">Full name *</label><input id="n" name="full_name" required>
        <label>Years of experience <input name="years" type="number"></label>
        <label for="pw">Password</label><input id="pw" type="password" name="pw" value="hunter2">
        <label for="cc">Card number</label><input id="cc" name="card" autocomplete="cc-number">
        <label for="c">Country</label><select id="c" name="country"><option value="in">India</option><option value="de">Germany</option></select>
        <textarea name="cover" placeholder="Why do you want this job?"></textarea>
        <input type="hidden" name="csrf" value="abc">
        <button type="submit">Submit</button>
      </form>`),
  );

  it('detects labels, required, options and marks sensitive fields without leaking values', () => {
    const [form] = detectForms(document);
    expect(form.heading).toBe('Job application');
    expect(form.instructions).toContain('answer all questions');
    const by = Object.fromEntries(form.fields.map((f) => [f.name, f]));
    expect(by.full_name.label).toMatch(/Full name/);
    expect(by.full_name.required).toBe(true);
    expect(by.years.label).toMatch(/Years of experience/);
    expect(by.country.options.map((o) => o.label)).toEqual(['India', 'Germany']);
    expect(by.cover.placeholder).toContain('Why do you want');
    expect(by.pw.sensitive).toBeTruthy();
    expect(by.pw.has_value).toBe(false); // presence of a password value is not even reported
    expect(by.card.sensitive).toBeTruthy();
    expect(by.csrf).toBeUndefined();
    expect(JSON.stringify(form)).not.toContain('hunter2');
  });

  it('fills React-style controlled inputs through the native setter and events', () => {
    const input = document.querySelector<HTMLInputElement>('#n')!;
    const onInput = vi.fn();
    input.addEventListener('input', onInput);
    // Simulate React's value tracker overriding the instance property.
    let tracked = '';
    Object.defineProperty(input, 'value', { configurable: true, get: () => tracked, set: (v) => { tracked = v; } });
    setFieldValue(input, 'Asha Rao');
    expect(onInput).toHaveBeenCalled();
    setFieldValue(document.querySelector('#c')!, 'Germany');
    expect(document.querySelector<HTMLSelectElement>('#c')!.value).toBe('de');
  });

  it('executor refuses passwords, payment values, sensitive fields and submits', () => {
    const pw = refFor(document.querySelector('#pw')!);
    const cc = refFor(document.querySelector('#cc')!);
    const name = refFor(document.querySelector('#n')!);
    const submit = refFor(document.querySelector('button')!);
    expect(executeAction({ type: 'fill', target: { ref: pw }, value: 'x', reason: '', requires_confirmation: false }).status).toBe('blocked');
    expect(executeAction({ type: 'read', target: { ref: pw }, reason: '', requires_confirmation: false }).status).toBe('blocked');
    expect(executeAction({ type: 'fill', target: { ref: cc }, value: '4111111111111111', reason: '', requires_confirmation: false }).status).toBe('blocked');
    expect(executeAction({ type: 'fill', target: { ref: name }, value: '4111 1111 1111 1111', reason: '', requires_confirmation: false }).status).toBe('blocked');
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);
    expect(executeAction({ type: 'click', target: { ref: submit }, reason: '', requires_confirmation: false }).status).toBe('blocked');
    expect(onSubmit).not.toHaveBeenCalled();
    const ok = executeAction({ type: 'fill', target: { ref: name }, value: 'Asha Rao', reason: '', requires_confirmation: false });
    expect(ok.status).toBe('success');
    expect(document.querySelector<HTMLInputElement>('#n')!.value).toBe('Asha Rao');
  });

  it('detects target changes between approval and execution', () => {
    const el = document.querySelector('#n')!;
    const ref = refFor(el);
    const fp = fingerprint(el);
    el.setAttribute('name', 'something_else');
    expect(executeAction({ type: 'fill', target: { ref }, value: 'x', reason: '', requires_confirmation: false }, fp).status).toBe('target_changed');
    el.remove();
    expect(executeAction({ type: 'fill', target: { ref }, value: 'x', reason: '', requires_confirmation: false }, fp).status).toBe('target_changed');
  });

  it('lists interactive elements without values', () => {
    const els = interactiveElements(document);
    expect(els.some((e) => e.type === 'submit')).toBe(true);
    expect(JSON.stringify(els)).not.toContain('hunter2');
  });
});

describe('local policy (re-validation in the extension)', () => {
  const el = { ref: 'e1', tag: 'input', type: 'text', role: '', label: 'City', text: '', name: 'city', placeholder: '', autocomplete: '', href: '', options: [], disabled: false, sensitive: null, form_ref: null };
  const base = { reason: '', requires_confirmation: false };
  it('allows safe actions and rejects unsafe ones', () => {
    expect(localPolicy({ ...base, type: 'fill', target: { ref: 'e1' }, value: 'Chennai' }, el, 'https://a.com/')).toBeNull();
    expect(localPolicy({ ...base, type: 'fill', target: { ref: 'e1' }, value: 'x' }, undefined, 'https://a.com/')).toMatch(/not on the page/);
    expect(localPolicy({ ...base, type: 'fill', target: { ref: 'e1' }, value: 'x' }, { ...el, sensitive: 'password field' }, 'https://a.com/')).toMatch(/Sensitive/);
    expect(localPolicy({ ...base, type: 'click', target: { ref: 'e1' } }, { ...el, tag: 'button', type: 'submit' }, 'https://a.com/')).toMatch(/submission/);
    expect(localPolicy({ ...base, type: 'click', target: { ref: 'e1' } }, { ...el, tag: 'button', type: 'button', text: 'Place order' }, 'https://a.com/')).toMatch(/purchase|submit/);
    expect(localPolicy({ ...base, type: 'navigate', url: 'https://b.com/' }, undefined, 'https://a.com/')).toMatch(/confirmed/);
    expect(localPolicy({ ...base, type: 'navigate', url: 'https://b.com/', requires_confirmation: true }, undefined, 'https://a.com/')).toBeNull();
    expect(localPolicy({ ...base, type: 'navigate', url: 'javascript:alert(1)' }, undefined, 'https://a.com/')).toMatch(/http/);
    expect(localPolicy({ ...base, type: 'eval' as never }, el, 'https://a.com/')).toMatch(/schema/);
  });
});

describe('utilities', () => {
  it('parses SSE across chunk boundaries', () => {
    const p = new SseParser();
    expect(p.feed('event: delta\ndata: {"te')).toEqual([]);
    expect(p.feed('xt":"Hi"}\n\n: keepalive\n\nevent: done\r\ndata: {}\r\n\r\n')).toEqual([
      { event: 'delta', data: { text: 'Hi' } },
      { event: 'done', data: {} },
    ]);
  });

  it('flags sensitive fields and excluded hosts', () => {
    expect(sensitiveFieldReason({ type: 'password' })).toBeTruthy();
    expect(sensitiveFieldReason({ autocomplete: 'one-time-code' })).toBeTruthy();
    expect(sensitiveFieldReason({ label: 'CVV' })).toBeTruthy();
    expect(sensitiveFieldReason({ label: 'Company name' })).toBeNull();
    expect(isExcludedHost('www.paypal.com', DEFAULT_EXCLUDED_SITES)).toBe(true);
    expect(isExcludedHost('docs.python.org', DEFAULT_EXCLUDED_SITES)).toBe(false);
  });

  it('rejects unknown content-script messages', () => {
    expect(ContentMessageSchema.safeParse({ type: 'floating:config' }).success).toBe(true);
    expect(ContentMessageSchema.safeParse({ type: 'getToken' }).success).toBe(false);
    expect(ContentMessageSchema.safeParse({ type: 'floating:savePosition', offset: { x: Infinity, y: 1 } }).success).toBe(false);
  });

  it('config defaults are safe and invalid values are rejected', () => {
    const d = ExtensionConfigSchema.parse({});
    expect(d.backendUrl).toBe('http://127.0.0.1:8765');
    expect(d.token).toBe('');
    expect(d.excludedSites.length).toBeGreaterThan(3);
    expect(ExtensionConfigSchema.safeParse({ theme: 'neon' }).success).toBe(false);
  });
});
