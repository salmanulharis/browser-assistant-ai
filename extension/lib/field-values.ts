/**
 * Field-value helpers used when inserting values into a page. Mirrors
 * backend/app/services/field_values.py so planning and execution agree.
 */

export interface OptionLike { value: string; label: string }

const norm = (s: string): string =>
  (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // "Åland" -> "Aland"
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Returns the option (by index) that `value` refers to, or -1 when unknown/ambiguous.
 * Order: exact value → exact label → normalised value/label → unique prefix → unique substring.
 */
export function matchOptionIndex(value: string | null | undefined, options: OptionLike[]): number {
  if (value == null || !options.length) return -1;
  const raw = String(value).trim();
  let i = options.findIndex((o) => o.value === raw);
  if (i >= 0) return i;
  i = options.findIndex((o) => o.label.trim() === raw);
  if (i >= 0) return i;
  const n = norm(raw);
  if (!n) return options.findIndex((o) => o.value === '');
  i = options.findIndex((o) => norm(o.value) === n || norm(o.label) === n);
  if (i >= 0) return i;
  const unique = (pred: (o: OptionLike) => boolean): number => {
    const hits = options.map((o, idx) => (pred(o) ? idx : -1)).filter((x) => x >= 0);
    return hits.length === 1 ? hits[0] : -1;
  };
  i = unique((o) => norm(o.label).startsWith(n) || (n.length >= 3 && !!norm(o.label) && n.startsWith(norm(o.label))));
  if (i >= 0) return i;
  return unique((o) => norm(o.label).includes(n) || (norm(o.label).length >= 3 && n.includes(norm(o.label))));
}

const TRUE = new Set(['true', 'yes', 'y', 'on', '1', 'checked', 'check', 'tick', 'ticked', 'enable', 'enabled', 'select', 'selected', 'agree']);
const FALSE = new Set(['false', 'no', 'n', 'off', '0', 'unchecked', 'uncheck', 'untick', 'unticked', 'disable', 'disabled', 'deselect', 'unselected', 'clear', '']);

/** Normalise a checkbox answer; null when unclear. */
export function toBool(value: string | null | undefined): boolean | null {
  const v = norm(String(value ?? ''));
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return null;
}

/** Agreeing to terms/consent or subscribing is a decision the user must make themselves. */
export const CONSENT_PATTERN =
  /\b(agree|accept|consent|terms|conditions|privacy|policy|gdpr|newsletter|subscribe|marketing|opt[ -]?in|i have read|i confirm|i certify|authori[sz]e)\b/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const WORD_NUMBERS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');

function parseDate(v: string): { y: number; m: number; d: number } | null {
  const s = v.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); // day-first (as in the backend)
  if (m) return +m[2] > 12 ? { y: +m[3], m: +m[1], d: +m[2] } : { y: +m[3], m: +m[2], d: +m[1] };
  m = s.match(/^(\d{1,2}) ([a-z]+) (\d{4})$/i);
  if (m && MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) >= 0) return { y: +m[3], m: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, d: +m[1] };
  m = s.match(/^([a-z]+) (\d{1,2}) (\d{4})$/i);
  if (m && MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) >= 0) return { y: +m[3], m: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, d: +m[2] };
  return null;
}

/** Convert a value into the format a native input of `type` accepts (unchanged when n/a). */
export function normalizeForInput(type: string, value: string): string {
  const t = (type || '').toLowerCase();
  const v = (value ?? '').trim();
  if (!v) return v;
  switch (t) {
    case 'date': {
      const d = parseDate(v);
      return d ? `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}` : v;
    }
    case 'month': {
      const d = parseDate(v) ?? parseDate(`1 ${v}`);
      if (d) return `${pad(d.y, 4)}-${pad(d.m)}`;
      const m = v.match(/^(\d{4})[-/](\d{1,2})$/);
      return m ? `${m[1]}-${pad(+m[2])}` : v;
    }
    case 'datetime-local': {
      const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);
      return m ? `${m[1]}T${pad(+m[2])}:${m[3]}` : v;
    }
    case 'time': {
      const m = v.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
      if (!m) return v;
      let h = +m[1];
      const mi = +(m[2] ?? 0);
      const ap = (m[3] ?? '').toLowerCase();
      if (ap.startsWith('p') && h < 12) h += 12;
      if (ap.startsWith('a') && h === 12) h = 0;
      return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : v;
    }
    case 'number':
    case 'range': {
      const m = v.match(/-?\d+(?:[.,]\d+)?/);
      if (m) return m[0].replace(',', '.');
      const w = WORD_NUMBERS.indexOf(norm(v).split(' ')[0]);
      return w >= 0 ? String(w) : v;
    }
    case 'email':
      return v.replace(/\s+/g, '');
    case 'color': {
      const m = v.match(/^#?([0-9a-f]{6})$/i);
      return m ? `#${m[1].toLowerCase()}` : v;
    }
    default:
      return v;
  }
}
