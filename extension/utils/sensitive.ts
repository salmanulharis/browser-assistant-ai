/** Sensitive-field detection. Mirrors backend/app/security/sanitize.py. */

export const SENSITIVE_FIELD_PATTERN =
  /pass(word|wd|code|phrase)?|pwd|\bpin\b|otp|one[- ]time|2fa|mfa|verification code|security (code|question|answer)|cvv|cvc|csc|card ?(number|no)|credit ?card|debit ?card|cc-?(number|csc|exp)|expir|iban|routing|account number|bank account|sort code|swift|\bssn\b|social security|tax ?id|\bnin\b|passport|aadhaar|\bpan\b|secret|api[ _-]?key|token|username|user ?name|login/i;

const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp',
  'cc-exp-month', 'cc-exp-year', 'cc-name', 'cc-type', 'username', 'webauthn',
]);

export interface FieldDescriptor {
  type?: string;
  autocomplete?: string;
  label?: string;
  name?: string;
  placeholder?: string;
}

export function sensitiveFieldReason(f: FieldDescriptor): string | null {
  const type = (f.type ?? '').toLowerCase();
  if (type === 'password' || type === 'hidden' || type === 'file') return `${type} field`;
  for (const token of (f.autocomplete ?? '').toLowerCase().split(/\s+/)) {
    if (SENSITIVE_AUTOCOMPLETE.has(token)) return `autocomplete=${token}`;
  }
  const hay = [f.label, f.name, f.placeholder].filter(Boolean).join(' ');
  const m = hay.match(SENSITIVE_FIELD_PATTERN);
  return m ? `sensitive field (${m[0]})` : null;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Returns a reason when text looks like a credential / payment number / ID. */
export function sensitiveValueReason(text: string): string | null {
  if (!text) return null;
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'payment card number';
  }
  if (/(password|passwd|pwd|passcode|pin|otp|api[_ -]?key|secret|token|bearer)\s*[:=]?\s*\S+/i.test(text)) return 'credential or secret';
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return 'national identifier';
  return null;
}

export const DANGEROUS_CLICK =
  /\b(submit|send|buy|pay|purchase|checkout|check out|place order|order now|confirm|delete|remove|sign in|log ?in|sign up|register|subscribe|transfer|donate|book now|apply now|unsubscribe|publish|post|save changes|deactivate|close account)\b/i;

/** Default host patterns excluded from automatic capture / floating assistant. */
export const DEFAULT_EXCLUDED_SITES = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  '*.paypal.com',
  'paypal.com',
  '*.stripe.com',
  '*bank*',
  '*.gov',
  'mail.google.com',
  'outlook.live.com',
  '1password.com',
  '*.1password.com',
  'bitwarden.com',
  '*.bitwarden.com',
  'lastpass.com',
];

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(h);
}

export function isExcludedHost(host: string, patterns: string[]): boolean {
  return patterns.some((p) => hostMatches(host, p));
}
