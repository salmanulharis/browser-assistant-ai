import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchOptionIndex, normalizeForInput, toBool } from '@/lib/field-values';
import { executeAction, executeActionAsync, interactiveElements, pageAgent, refFor, setFieldValue } from '@/lib/page-agent-core';

const countries = [['', 'Select a country / region…'], ...Array.from({ length: 150 }, (_, i) => [`X${i}`, `Filler ${i}`]),
  ['AX', 'Åland Islands'], ['IN', 'India'], ['GB', 'United Kingdom (UK)'], ['US', 'United States (US)']];

function page(html: string) {
  document.body.innerHTML = html;
}
const $ = <T extends Element = HTMLInputElement>(s: string) => document.querySelector(s) as unknown as T;
const act = (type: 'fill' | 'select' | 'click', ref: string, value?: string) => ({ type, target: { ref }, value, reason: '', requires_confirmation: false });

describe('value helpers (mirror of the backend)', () => {
  const opts = countries.map(([value, label]) => ({ value, label }));
  it.each([['IN', 'IN'], ['India', 'IN'], ['india', 'IN'], ['United Kingdom', 'GB'], ['Aland Islands', 'AX'], ['', '']])(
    'maps %j to option %j', (v, expected) => expect(opts[matchOptionIndex(v, opts)].value).toBe(expected));
  it('returns -1 for ambiguous/unknown answers', () => {
    expect(matchOptionIndex('United', opts)).toBe(-1);
    expect(matchOptionIndex('Atlantis', opts)).toBe(-1);
  });
  it('normalises booleans and input formats', () => {
    expect(toBool('Yes')).toBe(true);
    expect(toBool('unchecked')).toBe(false);
    expect(toBool('maybe')).toBeNull();
    expect(normalizeForInput('date', '15 March 1995')).toBe('1995-03-15');
    expect(normalizeForInput('date', 'March 15, 1995')).toBe('1995-03-15');
    expect(normalizeForInput('date', '15/03/1995')).toBe('1995-03-15');
    expect(normalizeForInput('time', '2:30 pm')).toBe('14:30');
    expect(normalizeForInput('month', 'March 2024')).toBe('2024-03');
    expect(normalizeForInput('number', '7 years')).toBe('7');
    expect(normalizeForInput('number', 'seven')).toBe('7');
    expect(normalizeForInput('color', 'FF8800')).toBe('#ff8800');
  });
});

describe('inserting values into every field type', () => {
  beforeEach(() =>
    page(`
      <form>
        <label for="country">Country / Region</label>
        <select id="country" name="billing_country">${countries.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <label for="skills">Skills</label>
        <select id="skills" multiple><option value="py">Python</option><option value="go">Go</option><option value="sql">SQL</option></select>
        <label for="plan">Plan</label>
        <select id="plan"><option value="free">Free</option><option value="pro" disabled>Pro</option></select>
        <fieldset><legend>Admin color</legend>
          <label><input type="radio" name="admin_color" value="fresh" checked> Default</label>
          <label><input type="radio" name="admin_color" value="modern"> Modern</label>
        </fieldset>
        <label><input type="checkbox" id="kbd" name="comment_shortcuts"> Enable keyboard shortcuts</label>
        <label><input type="checkbox" id="bar" name="admin_bar_front" checked> Show Toolbar</label>
        <label><input type="checkbox" id="terms" name="terms"> I agree to the Terms and Conditions</label>
        <div id="sw" role="switch" aria-checked="false" aria-label="Dark mode" tabindex="0"></div>
        <label for="dob">Date of birth</label><input id="dob" type="date">
        <label for="yrs">Years</label><input id="yrs" type="number">
        <label for="t">Start time</label><input id="t" type="time">
        <label for="c">Brand colour</label><input id="c" type="color">
        <label for="code">Code</label><input id="code" maxlength="4">
        <div id="bio" contenteditable="true" aria-label="Bio"></div>
      </form>`),
  );

  it('selects by label, case-insensitive, beyond the first hundred options', () => {
    setFieldValue($('#country'), 'india');
    expect($<HTMLSelectElement>('#country').value).toBe('IN');
    setFieldValue($('#country'), 'United Kingdom');
    expect($<HTMLSelectElement>('#country').value).toBe('GB');
    expect(() => setFieldValue($('#country'), 'Atlantis')).toThrow(/not an option/);
  });

  it('fires change events that frameworks listen to', () => {
    const onChange = vi.fn();
    $('#country').addEventListener('change', onChange);
    setFieldValue($('#country'), 'IN');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('handles multiple selects and skips disabled options', () => {
    setFieldValue($('#skills'), 'Python, SQL');
    expect(Array.from($<HTMLSelectElement>('#skills').selectedOptions).map((o) => o.value)).toEqual(['py', 'sql']);
    expect(() => setFieldValue($('#plan'), 'Pro')).toThrow(/not an option/);
  });

  it('selects radios by value or label', () => {
    setFieldValue($('input[value="fresh"]'), 'Modern');
    expect($('input[value="modern"]').checked).toBe(true);
    setFieldValue($('input[value="modern"]'), 'fresh');
    expect($('input[value="fresh"]').checked).toBe(true);
    expect(() => setFieldValue($('input[value="fresh"]'), 'Neon')).toThrow(/radio group/);
  });

  it('sets checkboxes and ARIA switches to an explicit state (idempotent)', () => {
    setFieldValue($('#kbd'), 'true');
    setFieldValue($('#kbd'), 'yes');
    expect($('#kbd').checked).toBe(true);
    setFieldValue($('#bar'), 'false');
    expect($('#bar').checked).toBe(false);
    const sw = $<HTMLElement>('#sw');
    sw.addEventListener('click', () => sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));
    setFieldValue(sw, 'on');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(() => setFieldValue($('#kbd'), 'perhaps')).toThrow(/checked\/unchecked/);
  });

  it('normalises dates, numbers, times and colours, respects maxlength, and reports rejects', () => {
    setFieldValue($('#dob'), '15 March 1995');
    expect($('#dob').value).toBe('1995-03-15');
    setFieldValue($('#yrs'), 'seven years');
    expect($('#yrs').value).toBe('7');
    setFieldValue($('#t'), '2:30 pm');
    expect($('#t').value).toBe('14:30');
    setFieldValue($('#c'), 'FF8800');
    expect($('#c').value).toBe('#ff8800');
    setFieldValue($('#code'), 'ABCDEFG');
    expect($('#code').value).toBe('ABCD');
    expect(() => setFieldValue($('#dob'), 'sometime soon')).toThrow(/not a valid date value/);
  });

  it('writes contenteditable editors', () => {
    setFieldValue($('#bio'), 'Data engineer in Chennai');
    expect($<HTMLElement>('#bio').textContent).toBe('Data engineer in Chennai');
  });

  it('never ticks consent boxes but allows unticking them', () => {
    const terms = refFor($('#terms'));
    expect(executeAction(act('fill', terms, 'true')).status).toBe('blocked');
    expect($('#terms').checked).toBe(false);
    $('#terms').checked = true;
    expect(executeAction(act('fill', terms, 'false')).status).toBe('success');
    expect($('#terms').checked).toBe(false);
  });

  it('snapshot keeps all options and reports checked state', () => {
    const els = interactiveElements(document);
    const country = els.find((e) => e.name === 'billing_country')!;
    expect(country.options.length).toBe(countries.length);
    expect(country.options.some((o) => o.value === 'IN')).toBe(true);
    expect(els.find((e) => e.name === 'admin_bar_front')!.checked).toBe(true);
    expect(els.find((e) => e.name === 'comment_shortcuts')!.checked).toBe(false);
    expect(els.find((e) => e.role === 'switch')!.checked).toBe(false);
    expect(els.find((e) => e.name === 'billing_country')!.checked).toBeNull();
  });

  it('form-fill "fill" on a select/radio is treated as a selection', async () => {
    expect((await pageAgent.fill(refFor($('#country')), 'India')).status).toBe('success');
    expect($<HTMLSelectElement>('#country').value).toBe('IN');
    expect((await pageAgent.fill(refFor($('input[value="fresh"]')), 'Modern')).status).toBe('success');
    expect($('input[value="modern"]').checked).toBe(true);
  });
});

describe('script-driven (custom) dropdowns', () => {
  beforeEach(() => {
    page(`
      <label id="lbl">Country</label>
      <div id="combo" role="combobox" aria-labelledby="lbl" aria-controls="list" aria-expanded="false" tabindex="0">
        <input id="search" aria-label="Search countries">
        <span id="shown">Choose…</span>
      </div>
      <ul id="list" role="listbox"></ul>`);
    // Options render only after opening, like react-select/select2.
    const combo = $<HTMLElement>('#combo');
    combo.addEventListener('click', () => {
      setTimeout(() => {
        $('#list').innerHTML = ['India', 'Indonesia', 'Ireland'].map((c) => `<li role="option" data-value="${c.slice(0, 2).toUpperCase()}">${c}</li>`).join('');
        for (const li of Array.from(document.querySelectorAll('[role="option"]'))) {
          li.addEventListener('click', () => { $('#shown').textContent = li.textContent; combo.dataset.value = (li as HTMLElement).dataset.value; });
        }
      }, 50);
    });
  });

  it('opens the dropdown, waits for options and clicks the match', async () => {
    const res = await executeActionAsync(act('select', refFor($('#combo')), 'india'));
    expect(res.status).toBe('success');
    expect($('#shown').textContent).toBe('India');
  });

  it('reports a clear error when no option matches', async () => {
    const res = await executeActionAsync(act('select', refFor($('#combo')), 'Atlantis'));
    expect(res.status).toBe('failed');
    expect(res.message).toMatch(/not one of the dropdown's options/);
  });

  it('pageAgent.execute uses the async path', async () => {
    const res = await pageAgent.execute(act('select', refFor($('#combo')), 'Ireland'));
    expect(res.status).toBe('success');
    expect($('#shown').textContent).toBe('Ireland');
  });
});
