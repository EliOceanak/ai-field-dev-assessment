/**
 * PII pattern set: the *complete* match regex, the *partial* anchor used by the streaming
 * holdback, and the validators that keep false positives down.
 *
 * Two regexes per pattern, with different jobs:
 *
 * - `regex` (global) finds complete candidates in a finished piece of text.
 * - `partialAnchor` (end-anchored, `$`, **no** `^`) matches a suffix of the live buffer that is
 *   a *prefix* of a potential match. Applied to the whole buffer, the **leftmost** match marks
 *   where the holdback must start. That is exactly equivalent to an ascending
 *   k-loop over suffixes (`partialAnchor.test(buffer.slice(-k))` with `^…$`), in a single pass —
 *   `tests/unit/streaming-redactor.test.ts` proves the equivalence on random buffers.
 *
 * A pattern is only sound if every prefix of a match is matched by `partialAnchor`; each
 * built-in documents its prefix language next to the regex.
 */
import type { CustomPattern } from '../config.js';

export interface Pattern {
  /** Label used by typed placeholders and the per-type counters. */
  name: string;
  /** Global regex used to find complete candidates. */
  regex: RegExp;
  /**
   * End-anchored regex whose language is "every prefix of a possible match". The leftmost match
   * in the buffer gives the holdback start.
   */
  partialAnchor: RegExp;
  /** Upper bound on the length of a match (used for stats and the holdback-cap warning). */
  maxLength: number;
  /** Rejects a syntactically-matching candidate (`4111-…-1112` fails Luhn). */
  validate?: (match: string) => boolean;
  /**
   * Whole-string (`^…$`) matcher for a *committed* partial match: on `flush()` a truncated tail
   * that already carries an unambiguous PII marker (`@`, two SSN dashes, ≥13 card digits) is
   * redacted instead of leaked. A bare word is deliberately *not* committed — otherwise ordinary
   * prose would be redacted at end-of-stream.
   */
  flushAnchor?: RegExp;
}

/**
 * The slice a `partialAnchor` is applied to: at most `pattern.maxLength` characters from the end.
 *
 * No prefix longer than a pattern's maximum match can be part of a match, so a longer window can
 * never change the answer — but it does change the cost. Applied to the whole buffer, an anchor like
 * the email one (`[local]+(?:@[label]*)?$`) is O(n²) on a long delimiter-free run: every start
 * position is retried, so a 40 KB base64 blob with no `@` costs seconds of event-loop time. Clamping
 * makes the work O(maxLength²) worst case and O(run) in practice.
 *
 * `clamped` reports that the window is a suffix of a longer buffer, which matters for one case: a
 * match that fills the entire window may continue further left, so the caller withholds from the
 * start of the buffer instead (the holdback cap governs it, exactly as before).
 */
export function anchorWindow(
  pattern: Pattern,
  buffer: string
): { text: string; offset: number; clamped: boolean } {
  if (buffer.length <= pattern.maxLength) return { text: buffer, offset: 0, clamped: false };
  return { text: buffer.slice(buffer.length - pattern.maxLength), offset: buffer.length - pattern.maxLength, clamped: true };
}

/** Luhn (mod 10) checksum over a card-like string; separators are ignored. */
export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const value = digits.charCodeAt(index) - 48;
    let digit = value;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * SSN structural rules (SSA): area 000/666/900-999, group 00 and serial 0000 are never issued.
 * `text` may be `123-45-6789` (the only shape this gateway matches); separators are tolerated so
 * the validator stays usable from tests.
 */
export function ssnValid(text: string): boolean {
  const match = /^(\d{3})-?(\d{2})-?(\d{4})$/.exec(text);
  if (match === null) return false;
  const area = match[1] ?? '';
  const group = match[2] ?? '';
  const serial = match[3] ?? '';
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

/** Every octet must be 0-255; `999.1.1.1` is not an address. */
export function ipv4Valid(text: string): boolean {
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Built-ins. Order matters only for reporting: overlapping candidates are merged into one redaction
 * that carries the type of the candidate starting first (the longest one on a tie), so whether
 * `credit_card` or `ssn` names a merged span is decided by the matches themselves, not by this order.
 */
export const BUILT_IN_PATTERNS: readonly Pattern[] = [
  {
    name: 'email',
    // local@label.tld — prefix language: any run of local-part characters, optionally followed by
    // `@` and any run of label characters (the TLD is only required for a *complete* match).
    //
    // Every repetition is bounded by the protocol limits (64-octet local part, 255-octet domain,
    // 63-octet label) for one reason: an *unbounded* greedy run followed by a required `@` is
    // quadratic when the `@` never arrives. On a 40 KB base64 blob the unbounded form retries the
    // run from every start position and blocks the event loop for seconds; bounded, the same input
    // is linear. The bounds are the RFC limits, so nothing legitimate stops matching.
    regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,63}/g,
    partialAnchor: /[A-Za-z0-9._%+-]{1,64}(?:@[A-Za-z0-9.-]{0,255})?$/,
    flushAnchor: /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{0,255}$/,
    maxLength: 254
  },
  {
    name: 'ssn',
    // ddd-dd-dddd with the SSA structural rules; a bare 9-digit run is deliberately not matched.
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: ssnValid,
    partialAnchor: /\d{1,3}(?:-\d{0,2}(?:-\d{0,4})?)?$/,
    flushAnchor: /^\d{3}-\d{2}(?:-\d{0,4})?$/,
    maxLength: 11
  },
  {
    name: 'credit_card',
    // 13-19 contiguous digits, 4-digit groups, or the 4-6-5 Amex shape. Deliberately *not* a
    // loose `(?:\d[ -]?){13,19}`: a trailing space would let the match swallow the next number
    // ("…1111 12.50"), which then fails Luhn and leaks the card. The grouped form stops at four
    // groups for the same reason: a fifth group makes 20 digits, which can never pass Luhn, so a
    // greedy fifth group ("4111 1111 1111 1111 2025") would reject the run and leak the card in it.
    regex: /\b\d{13,19}\b|\b\d{4}(?:[ -]?\d{4}){2,3}\b|\b\d{4}[ -]\d{6}[ -]\d{5}\b/g,
    validate: luhnValid,
    // Prefix language: digit runs with separators, including one that ends *on* a separator
    // ("4111-" is a prefix of "4111-1111-…"), hence the trailing `[ -]?`. The `{0,36}` bound is
    // deliberately larger than the 19 digits a card can have: a longer hyphenated run can still
    // contain a card-shaped sub-match, and the holdback must reach back past its first group.
    partialAnchor: /\d(?:[ -]?\d){0,36}[ -]?$/,
    // ≥13 digits already seen: the value is unambiguous even if the stream stops here.
    flushAnchor: /^(?:\d[ -]?){12,19}$/,
    maxLength: 37
  },
  {
    name: 'phone',
    // NANP-style only (3-3-4 with separators, optional +1 / parentheses) so dates and order ids
    // (`2026-10-29`, `ORD-10234`) survive.
    regex: /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g,
    // Prefix language: "+1 (", "(555", "555) 123-4", … — every partial form, including one that
    // stops just after the country code or an opening parenthesis, must be withheld.
    partialAnchor: /(?:\+?1[ .-]?\(?|\()?\d{0,3}\)?(?:[ .-]\d{0,3}(?:[ .-]\d{0,4})?)?$/,
    flushAnchor: /^\(?\d{3}\)?[ .-]\d{3}[ .-]\d{0,4}$/,
    maxLength: 20
  },
  {
    name: 'ipv4',
    // Four octets; `1.2.3` (a version) is not an address.
    regex: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
    validate: ipv4Valid,
    partialAnchor: /\d{1,3}(?:\.\d{0,3}){0,3}$/,
    // Committed only when the address *looks complete* (four groups, last one non-empty). Committing
    // a three-group prefix as well would redact ordinary dotted versions — "version 3.14.2." is a
    // sentence ending, not a truncated address. Trade-off: a stream truncated inside an address can
    // emit up to three octets; mid-stream they are still withheld by `partialAnchor`.
    flushAnchor: /^(?:\d{1,3}\.){3}\d{1,3}$/,
    maxLength: 15
  },
  {
    name: 'secret',
    // Prefixed API keys and bearer tokens. Deliberately shape-based: no entropy heuristics, so
    // there are no surprises for ordinary prose.
    regex:
      /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bBearer[ \t]+[A-Za-z0-9._~+/=-]{16,}/g,
    partialAnchor:
      /(?:sk|pk|rk)[-_]?[A-Za-z0-9_-]*$|gh[pousr]?[_]?[A-Za-z0-9]*$|AKIA[0-9A-Z]*$|Bearer[ \t]*[A-Za-z0-9._~+/=-]*$/,
    flushAnchor:
      /^(?:sk|pk|rk)-[A-Za-z0-9_-]{4,}$|^gh[pousr]_[A-Za-z0-9]{4,}$|^AKIA[0-9A-Z]{4,}$|^Bearer[ \t]+[A-Za-z0-9._~+/=-]{4,}$/,
    maxLength: 80
  }
];
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest literal run a pattern source starts with (`EMP-\d{6}` → `EMP-`). */
function leadingLiteral(source: string): string {
  let literal = '';
  for (const char of source) {
    if ('\\^$.*+?()[]{}|'.includes(char)) break;
    literal += char;
  }
  return literal;
}

/**
 * Rough upper bound on a match length, from the literal parts and the numeric quantifiers.
 * `*`/`+` are treated as "at most 32 more", which is why the derived anchor below is only a
 * fallback: it is a *conservative* window, not a proof.
 */
function estimateMaxLength(source: string): number {
  const parts = source.match(/\{[0-9]+(?:,[0-9]*)?\}|\*|\+|\[[^\]]*\]|\\[a-zA-Z]|\.|[^\\^$.*+?()[\]{}|]/g) ?? [];
  let total = 0;
  for (const part of parts) {
    if (part.startsWith('{')) {
      const [min, max] = part.slice(1, -1).split(',');
      total += Number(max ?? min ?? '1') || 1;
    } else if (part === '*' || part === '+') {
      total += 32;
    } else if (part.startsWith('[')) {
      total += 8;
    } else if (part === '.') {
      total += 4;
    } else if (part.startsWith('\\')) {
      total += 2;
    } else {
      total += part.length;
    }
  }
  return Math.max(8, Math.min(total, 256));
}

/**
 * Custom patterns arrive from `GUARDRAIL_CUSTOM_PATTERNS` as bare regex sources, so the partial
 * anchor has to be derived:
 *
 * - if the source starts with a literal (`EMP-\d{6}`), every prefix of that literal is a safe
 *   anchor start → `/(?:EMP-|EMP|EM|E)[\s\S]*$/`;
 * - otherwise no sound anchor is derivable, so we fall back to the *conservative fixed holdback*
 *   (hold the last `maxLength - 1` characters) and report it, so the README and a `warn` log line
 *   can state the trade-off honestly.
 */
function derivePartialAnchor(source: string, maxLength: number): { partialAnchor: RegExp; sound: boolean } {
  const literal = leadingLiteral(source);
  if (literal.length >= 2) {
    const prefixes: string[] = [];
    for (let length = literal.length; length >= 1; length -= 1) {
      prefixes.push(escapeRegExp(literal.slice(0, length)));
    }
    return { partialAnchor: new RegExp(`(?:${prefixes.join('|')})[\\s\\S]*$`), sound: true };
  }
  const window = Math.max(1, maxLength - 1);
  return { partialAnchor: new RegExp(`[\\s\\S]{0,${window}}$`), sound: false };
}

export interface BuildPatternsResult {
  patterns: Pattern[];
  /** Custom patterns whose partial anchor had to fall back to a fixed window. */
  unsoundCustomPatterns: string[];
}

/** Built-ins plus the configured custom patterns (custom patterns append; they never replace). */
export function buildPatternsDetailed(customPatterns: readonly CustomPattern[] = []): BuildPatternsResult {
  const patterns: Pattern[] = [...BUILT_IN_PATTERNS];
  const unsoundCustomPatterns: string[] = [];

  for (const custom of customPatterns) {
    const rawFlags = custom.flags ?? 'g';
    const flags = rawFlags.includes('g') ? rawFlags : `${rawFlags}g`;
    const maxLength = estimateMaxLength(custom.pattern);
    const { partialAnchor, sound } = derivePartialAnchor(custom.pattern, maxLength);
    if (!sound) unsoundCustomPatterns.push(custom.name);
    patterns.push({
      name: custom.name,
      regex: new RegExp(custom.pattern, flags),
      partialAnchor,
      maxLength
    });
  }

  return { patterns, unsoundCustomPatterns };
}

/** Convenience wrapper used by the redactor factory and the tests. */
export function buildPatterns(customPatterns: readonly CustomPattern[] = []): Pattern[] {
  return buildPatternsDetailed(customPatterns).patterns;
}

/** Longest match any pattern can produce — the bound the holdback is compared against. */
export function maxPatternLength(patterns: readonly Pattern[]): number {
  return patterns.reduce((longest, pattern) => Math.max(longest, pattern.maxLength), 0);
}

