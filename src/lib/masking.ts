// Capture-time PII masking engine — PRD §11.2.
//
// Masks happen *before* events land in storage so a compromised browser
// or extension upgrade never sees secrets in cleartext. Once masked, the
// original value is gone forever (PRD §4.1 "no information loss" applies
// to legitimate payload, not to sensitive data — which by promise §11.2
// is replaced at the door).
//
// The engine is intentionally pure and stateless: pass headers / body
// in, get masked headers / body + Redaction[] back. The service worker
// is the runner; settings are hydrated separately from
// chrome.storage.sync. Tests live in masking.test.ts.

import type { Redaction } from '@/types/events';

/** The opaque placeholder substituted for any masked value. */
export const MASKED = '***MASKED***' as const;

// ---------------------------------------------------------------------------
// Rule shapes
// ---------------------------------------------------------------------------

export type RuleScope = Redaction['scope'];

interface RuleBase {
  /** Stable identifier — used as Redaction.rule and as the dedup key when
   *  custom rules are merged with defaults. */
  id: string;
  /** Human-readable label shown in the Privacy settings chips. */
  label: string;
  /** Where this rule may fire. A rule only runs in scopes it lists. */
  scope: RuleScope[];
}

export interface HeaderMaskingRule extends RuleBase {
  kind: 'header';
  /** Header name to match case-insensitively. Stored lowercase. */
  headerName: string;
}

export interface BodyPatternRule extends RuleBase {
  kind: 'body-pattern';
  /** Regex applied to the body. Must carry the `g` flag — the engine
   *  iterates with `.replace()`. The pattern is responsible for word
   *  boundaries so it doesn't over-match. */
  pattern: RegExp;
  /** Optional secondary check (Luhn, TCKN checksum). Receives the matched
   *  string with whitespace/dashes stripped. Returning false means the
   *  match is left untouched — guards against false positives. */
  validate?: (digitsOnly: string) => boolean;
}

export interface FormFieldHeuristicRule extends RuleBase {
  kind: 'form-field';
  /** Inspect the field metadata captured from the DOM and decide if the
   *  field's value should be masked. */
  match: (field: FormFieldMeta) => boolean;
}

export interface FormFieldMeta {
  name?: string;
  id?: string;
  type?: string;
  autocomplete?: string;
}

export type MaskingRule = HeaderMaskingRule | BodyPatternRule | FormFieldHeuristicRule;

// ---------------------------------------------------------------------------
// Defaults — these ship with the extension; users add custom rules on top.
// ---------------------------------------------------------------------------

export const DEFAULT_HEADER_RULES: HeaderMaskingRule[] = [
  {
    id: 'header.authorization',
    label: 'Authorization',
    scope: ['request.headers', 'response.headers'],
    kind: 'header',
    headerName: 'authorization',
  },
  {
    id: 'header.cookie',
    label: 'Cookie',
    scope: ['request.headers'],
    kind: 'header',
    headerName: 'cookie',
  },
  {
    id: 'header.set-cookie',
    label: 'Set-Cookie',
    scope: ['response.headers'],
    kind: 'header',
    headerName: 'set-cookie',
  },
  {
    id: 'header.x-api-key',
    label: 'X-API-Key',
    scope: ['request.headers'],
    kind: 'header',
    headerName: 'x-api-key',
  },
  {
    id: 'header.x-auth-token',
    label: 'X-Auth-Token',
    scope: ['request.headers'],
    kind: 'header',
    headerName: 'x-auth-token',
  },
  {
    id: 'header.proxy-authorization',
    label: 'Proxy-Authorization',
    scope: ['request.headers'],
    kind: 'header',
    headerName: 'proxy-authorization',
  },
];

export const DEFAULT_BODY_RULES: BodyPatternRule[] = [
  {
    id: 'pattern.tckn',
    label: 'TCKN (Turkish national ID)',
    scope: ['request.body', 'response.body'],
    kind: 'body-pattern',
    pattern: /\b\d{11}\b/g,
    validate: (s) => isValidTckn(s),
  },
  {
    id: 'pattern.creditcard',
    label: 'Credit card',
    scope: ['request.body', 'response.body'],
    kind: 'body-pattern',
    // 13–19 digit run, optionally with single space or dash *between*
    // adjacent digits — never trailing. Anchor pattern so the final char
    // is always a digit; otherwise a greedy trailing separator (e.g. the
    // space before "end") would be swallowed into the match.
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: (s) => isValidLuhn(s),
  },
];

export const DEFAULT_FORM_RULES: FormFieldHeuristicRule[] = [
  {
    id: 'form.password-type',
    label: 'Password input',
    scope: ['form.value'],
    kind: 'form-field',
    match: (f) => (f.type ?? '').toLowerCase() === 'password',
  },
  {
    id: 'form.autocomplete-cc',
    label: 'Credit card autocomplete',
    scope: ['form.value'],
    kind: 'form-field',
    match: (f) => (f.autocomplete ?? '').toLowerCase().startsWith('cc-'),
  },
  {
    id: 'form.sensitive-name',
    label: 'Sensitive name (password/secret/token/ssn/pin)',
    scope: ['form.value'],
    kind: 'form-field',
    match: (f) => {
      const re = /password|secret|token|ssn|pin/i;
      return re.test(f.name ?? '') || re.test(f.id ?? '');
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MaskHeadersResult {
  headers: Record<string, string>;
  redactions: Redaction[];
}

export interface MaskBodyResult {
  body: string | null;
  redactions: Redaction[];
}

/**
 * Masks header values whose names match any rule scoped to `scope`.
 * Header lookup is case-insensitive. The output object preserves the
 * original casing of each header name.
 */
export function maskHeaders(
  headers: Record<string, string>,
  scope: 'request.headers' | 'response.headers',
  rules: HeaderMaskingRule[] = DEFAULT_HEADER_RULES
): MaskHeadersResult {
  const out: Record<string, string> = {};
  const redactions: Redaction[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const rule = rules.find((r) => r.scope.includes(scope) && r.headerName === lower);
    if (rule) {
      out[name] = MASKED;
      redactions.push({ scope, path: name, rule: rule.id });
    } else {
      out[name] = value;
    }
  }
  return { headers: out, redactions };
}

/**
 * Masks every regex match scoped to `scope`. If a rule provides a
 * `validate` function, only matches that pass validation are masked —
 * the rest pass through unchanged. This is how we keep TCKN and CC
 * patterns from chewing through random 11-digit numbers.
 *
 * Returns the masked body (`null` is preserved as `null`) and the list
 * of redactions, one per replaced match.
 */
export function maskBody(
  body: string | null,
  scope: 'request.body' | 'response.body',
  rules: BodyPatternRule[] = DEFAULT_BODY_RULES
): MaskBodyResult {
  if (body == null || body === '') return { body, redactions: [] };
  let out = body;
  const redactions: Redaction[] = [];
  for (const rule of rules) {
    if (!rule.scope.includes(scope)) continue;
    // Defensive clone to avoid sharing lastIndex across calls.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    out = out.replace(pattern, (match) => {
      const digitsOnly = match.replace(/[ -]/g, '');
      if (rule.validate && !rule.validate(digitsOnly)) return match;
      redactions.push({ scope, path: `body.${rule.id}`, rule: rule.id });
      return MASKED;
    });
  }
  return { body: out, redactions };
}

/**
 * Decides whether a single form field value should be masked. The
 * service worker doesn't see form fields today (action.input events
 * arrive in M2); the helper ships now so the Privacy settings UI and
 * future capture sites use one source of truth.
 */
export function shouldMaskFormField(
  field: FormFieldMeta,
  rules: FormFieldHeuristicRule[] = DEFAULT_FORM_RULES
): { masked: boolean; rule?: FormFieldHeuristicRule } {
  const rule = rules.find((r) => r.match(field));
  return rule ? { masked: true, rule } : { masked: false };
}

// ---------------------------------------------------------------------------
// Validators (exported so the Privacy settings sandbox can preview them)
// ---------------------------------------------------------------------------

/**
 * Turkish national ID number checksum. Spec:
 *   - 11 digits
 *   - first digit not zero
 *   - d10 = ((d1+d3+d5+d7+d9)*7 - (d2+d4+d6+d8)) mod 10
 *   - d11 = (d1 + d2 + ... + d10) mod 10
 * Reference: T.C. Nüfus ve Vatandaşlık İşleri Genel Müdürlüğü.
 */
export function isValidTckn(input: string): boolean {
  if (!/^\d{11}$/.test(input)) return false;
  const d = input.split('').map((c) => c.charCodeAt(0) - 48);
  if (d[0] === 0) return false;
  const odd = (d[0] ?? 0) + (d[2] ?? 0) + (d[4] ?? 0) + (d[6] ?? 0) + (d[8] ?? 0);
  const even = (d[1] ?? 0) + (d[3] ?? 0) + (d[5] ?? 0) + (d[7] ?? 0);
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  if (tenth !== d[9]) return false;
  const sumFirstTen = d.slice(0, 10).reduce((a, b) => a + b, 0);
  if (sumFirstTen % 10 !== d[10]) return false;
  return true;
}

/**
 * Luhn (mod-10) check for credit-card-shaped numbers. Accepts 13–19 digit
 * inputs after non-digit characters are stripped.
 */
export function isValidLuhn(input: string): boolean {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleNext = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i) - 48;
    let d = code;
    if (doubleNext) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleNext = !doubleNext;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Custom regex compilation (used by the Privacy settings sandbox)
// ---------------------------------------------------------------------------

/**
 * Attempts to compile a user-provided regex string into a global-flag
 * RegExp. Returns null if the source is empty or compilation throws.
 * The Privacy settings UI uses this to render a live match preview
 * without letting a malformed pattern crash the engine.
 */
export function tryCompilePattern(source: string): RegExp | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  try {
    return new RegExp(trimmed, 'g');
  } catch {
    return null;
  }
}
