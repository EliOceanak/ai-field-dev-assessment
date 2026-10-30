/**
 * Streaming PII redactor — the graded core.
 *
 * The invariant (proved at every split point of the fixture set, plus a seeded fuzz test —
 * `tests/unit/streaming-redactor.test.ts`):
 *
 *   push(a) + push(b) + flush()  ===  redactText(a + b)
 *
 * for **every** split index of every fixture, and for one-character-at-a-time pushes.
 *
 * How: before emitting, the redactor withholds the longest suffix of the live buffer that is a
 * *prefix* of a potential match (`Pattern.partialAnchor`). A match can only straddle the emit
 * boundary if it *starts* inside that suffix, so everything before it is final and can be
 * redacted and released immediately. Retained state is therefore O(holdback) — bounded by
 * `maxHoldbackBytes` — and never O(response).
 *
 * The other half of "identical to whole-string redaction" is the *left context*: patterns that
 * begin with `\b` would otherwise treat the start of a buffer as a word boundary even when the
 * character before it was already emitted, and redact a run that merely continues an emitted word.
 * `push`/`flush` therefore match against `lastEmittedChar + buffer` and drop a match that begins
 * inside that context character. See `redactChunk`.
 */
import type { Pattern } from './patterns.js';
import { maxPatternLength, anchorWindow } from './patterns.js';

export interface RedactOptions {
  patterns: readonly Pattern[];
  /** Literal replacement text (`[REDACTED]`, per the brief). */
  replacement: string;
  /** Emit `[REDACTED:EMAIL]` instead of `[REDACTED]`. */
  typedPlaceholders: boolean;
}

export interface RedactionMatch {
  start: number;
  end: number;
  type: string;
}

export type RedactionCounts = Record<string, number>;

function placeholderFor(type: string, options: RedactOptions): string {
  return options.typedPlaceholders ? `[REDACTED:${type.toUpperCase()}]` : options.replacement;
}

/**
 * Complete candidates from every pattern, sorted by start (longest first on a tie), with overlapping
 * candidates merged into one span. Validators run here, so a Luhn-invalid card or a structurally
 * impossible SSN never reaches the output.
 *
 * Overlaps are merged, never dropped. Two overlapping candidates are both PII, and keeping only the
 * earlier one leaks whatever part of the later one lies past it: the phone pattern's optional `1`
 * country code lets `10.0.0.1 415-555-0132` match a phone starting on the address's last digit, and
 * dropping that candidate would emit `415-555-0132` in clear. The merged span keeps the type of the
 * candidate that starts first, so typed placeholders and per-type counts report one redaction for it.
 *
 * A candidate the validator *rejects* must not consume the text it matched. The greedy card pattern
 * happily swallows a neighbouring run of digits — `078-05-1120 4012-8888-8888-1881` matches as
 * `1120 4012-8888-8888` (Luhn-invalid) — and skipping to the end of that rejected candidate would hide
 * the valid `4012-8888-8888-1881` that starts inside it. Retrying from one character after the
 * rejected start finds it, and costs nothing when nothing is rejected.
 */
export function findMatches(text: string, patterns: readonly Pattern[]): RedactionMatch[] {
  const found: RedactionMatch[] = [];

  for (const pattern of patterns) {
    const regex = pattern.regex;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = match[0];
      if (value.length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      if (pattern.validate === undefined || pattern.validate(value)) {
        found.push({ start: match.index, end: match.index + value.length, type: pattern.name });
      } else {
        regex.lastIndex = match.index + 1;
      }
    }
    regex.lastIndex = 0;
  }

  found.sort((left, right) => left.start - right.start || right.end - left.end);

  const merged: RedactionMatch[] = [];
  for (const match of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && match.start < last.end) {
      if (match.end > last.end) last.end = match.end;
    } else {
      merged.push({ ...match });
    }
  }
  return merged;
}

/** Rebuilds `text` with the accepted matches replaced; counts per type. */
export function applyRedactions(
  text: string,
  matches: readonly RedactionMatch[],
  options: RedactOptions
): { text: string; byType: RedactionCounts } {
  const byType: RedactionCounts = {};
  if (matches.length === 0) return { text, byType };

  const chunks: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    chunks.push(text.slice(cursor, match.start), placeholderFor(match.type, options));
    byType[match.type] = (byType[match.type] ?? 0) + 1;
    cursor = match.end;
  }
  chunks.push(text.slice(cursor));
  return { text: chunks.join(''), byType };
}

/** Whole-string form of a pattern's global regex, for "is this partial already a full match?" */
function isCompleteMatch(pattern: Pattern, candidate: string): boolean {
  return new RegExp(`^(?:${pattern.regex.source})$`).test(candidate);
}

/**
 * The *committed* partial tail: a suffix that is a prefix of a match **and** already carries an
 * unambiguous marker (an `@`, two SSN dashes, ≥13 card digits, a key prefix). Used only by
 * `flush()`, so a stream truncated mid-token does not silently emit half an email, while ordinary
 * prose ending in a word ("…brown fox") is left alone.
 */
function committedPartialTail(
  tail: string,
  patterns: readonly Pattern[]
): { start: number; length: number; type: string } | null {
  let best: { start: number; length: number; type: string } | null = null;

  for (const pattern of patterns) {
    if (pattern.flushAnchor === undefined) continue;
    const window = anchorWindow(pattern, tail);
    const match = pattern.partialAnchor.exec(window.text);
    if (match === null || match[0].length === 0) continue;
    // A match that fills a clamped window may continue further left; the committed partial is then
    // whatever the window holds, which is the most that can be verified.
    const partial = match[0];
    if (!pattern.flushAnchor.test(partial)) continue;
    // A validator already rejected this exact value as a *complete* match (e.g. a Luhn-invalid
    // card number at the very end of the stream) — do not redact it after the fact either.
    if (pattern.validate !== undefined && isCompleteMatch(pattern, partial) && !pattern.validate(partial)) continue;
    const start = window.offset + match.index;
    if (best === null || start < best.start || (start === best.start && partial.length > best.length)) {
      best = { start, length: partial.length, type: pattern.name };
    }
  }

  return best;
}

/**
 * Redaction of one piece of text whose real left neighbour is `context` — the last *original*
 * character already released (empty at the start of a stream, so whole-string redaction passes `''`).
 *
 * Several patterns start with `\b` (SSN, card, IPv4, secret). Matching a chunk in isolation makes its
 * first character look like the start of a word, so a run that merely *continues* an already-emitted
 * word (`word` + `4111 1111 1111 1111`) matches where the whole string does not, and the stream
 * redacts more than `redactText` would. Matching against `context + text` restores the real left
 * neighbour: a match that begins inside the context character started before this chunk and is
 * dropped, and every surviving index is shifted back by `context.length`.
 *
 * `context` is always a single character (or empty), and no `partialAnchor`/`flushAnchor` uses `\b`,
 * so the holdback arithmetic is unaffected by it.
 */
function redactChunk(
  text: string,
  context: string,
  options: RedactOptions
): { text: string; byType: RedactionCounts } {
  if (text.length === 0) return { text: '', byType: {} };

  const shift = context.length;
  const matches = findMatches(context + text, options.patterns)
    .filter((match) => match.start >= shift)
    .map((match) => ({ ...match, start: match.start - shift, end: match.end - shift }));
  const head = applyRedactions(text, matches, options);
  const lastEnd = matches.length > 0 ? (matches[matches.length - 1] as RedactionMatch).end : 0;
  const tail = text.slice(lastEnd);
  if (tail.length === 0) return head;

  const committed = committedPartialTail(tail, options.patterns);
  if (committed === null) return head;

  // Keep everything before the committed partial (it may start part-way through the tail: only
  // the partial itself is replaced, not the ordinary text in front of it).
  const prefix = head.text.slice(0, head.text.length - tail.length) + tail.slice(0, committed.start);
  const byType: RedactionCounts = { ...head.byType, [committed.type]: (head.byType[committed.type] ?? 0) + 1 };
  return { text: prefix + placeholderFor(committed.type, options), byType };
}

/** Redaction of a complete string: every complete match plus a committed partial tail. */
export function redactText(text: string, options: RedactOptions): { text: string; byType: RedactionCounts } {
  return redactChunk(text, '', options);
}

export interface RedactorOptions extends RedactOptions {
  /** Hard cap on the retained tail; the safety valve fires above it. */
  maxHoldbackBytes?: number;
  /** Structured, PII-free diagnostics sink (the server binds the stderr logger here). */
  onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

export interface RedactorStats {
  redactionsByType: RedactionCounts;
  /** Largest retained tail observed — the memory claim, measured. */
  maxBufferSeen: number;
  /** Bytes currently withheld. */
  buffered: number;
  holdbackCapHits: number;
  maxPatternLength: number;
}

export interface Redactor {
  /** Feed one decoded delta; returns the text that is now safe to emit (may be empty). */
  push(delta: string): string;
  /** End of stream: redact and release whatever is still withheld. */
  flush(): string;
  stats(): RedactorStats;
}

/**
 * Longest suffix of `buffer` that is a prefix of a potential match, via the leftmost match of
 * each end-anchored `partialAnchor`. Equivalent to an ascending k-loop over suffixes
 * (`for k = 1..limit: if partialAnchor.test(buffer.slice(-k)) holdback = k`, last match wins) —
 * the leftmost match start is exactly `buffer.length - max(k)` — but it is a single regex pass
 * instead of up to `maxPatternLength` slices. Equivalence is asserted in the unit suite.
 */
export function computeHoldback(buffer: string, patterns: readonly Pattern[]): number {
  if (buffer.length === 0) return 0;
  let start = buffer.length;

  for (const pattern of patterns) {
    const window = anchorWindow(pattern, buffer);
    const match = pattern.partialAnchor.exec(window.text);
    if (match === null || match[0].length === 0) continue;
    // A full match inside a clamped window means the run may continue past the window: withhold from
    // the start of the buffer (the holdback cap governs that case, as it always did).
    const candidate = window.clamped && match.index === 0 ? 0 : window.offset + match.index;
    if (candidate < start) start = candidate;
  }

  return buffer.length - start;
}

export function createStreamingRedactor(options: RedactorOptions): Redactor {
  const maxHoldbackBytes = options.maxHoldbackBytes ?? 512;
  const patternLimit = maxPatternLength(options.patterns);
  const onEvent = options.onEvent;
  const counts: RedactionCounts = {};
  let buffer = '';
  /**
   * The last *original* character already released — the real left neighbour of `buffer`, empty
   * before the first byte. This is what keeps a leading `\b` honest across an emit boundary.
   */
  let context = '';
  let maxBufferSeen = 0;
  let holdbackCapHits = 0;
  let warnedAboutCap = false;

  const merge = (byType: RedactionCounts): void => {
    for (const [type, count] of Object.entries(byType)) {
      counts[type] = (counts[type] ?? 0) + count;
    }
  };

  return {
    push(delta: string): string {
      if (delta.length === 0) return '';
      buffer += delta;

      const shift = context.length;
      const matches = findMatches(context + buffer, options.patterns)
        .filter((match) => match.start >= shift)
        .map((match) => ({ ...match, start: match.start - shift, end: match.end - shift }));
      const holdback = computeHoldback(buffer, options.patterns);
      let emitEnd = buffer.length - holdback;

      // The holdback only guarantees that no *future* delta can extend a match into the emitted
      // prefix. It does not by itself stop the boundary from cutting a match we can already see
      // (e.g. buffer "123-45-6789 " where a shorter pattern anchors the trailing "789 "): never
      // cut a known match — move the boundary to its start instead.
      for (const match of matches) {
        if (match.start < emitEnd && match.end > emitEnd) emitEnd = match.start;
      }

      let out = '';
      if (emitEnd > 0) {
        // Everything before the boundary is final: no future delta can extend a match into it.
        const emitted = buffer.slice(0, emitEnd);
        const applicable = matches.filter((match) => match.end <= emitEnd);
        const result = applyRedactions(emitted, applicable, options);
        merge(result.byType);
        out = result.text;
        // The next pass's left context is the last *original* character released, redacted or not.
        context = emitted.charAt(emitted.length - 1);
      }
      buffer = buffer.slice(emitEnd);

      if (buffer.length > maxHoldbackBytes) {
        // Safety valve: a pathological delta (a megabyte with no delimiter) must not grow retained
        // state without bound. Release it, redact what we can, and report the event.
        const result = redactChunk(buffer, context, options);
        merge(result.byType);
        out += result.text;
        context = buffer.charAt(buffer.length - 1);
        buffer = '';
        holdbackCapHits += 1;
        onEvent?.('holdback_cap_exceeded', { capBytes: maxHoldbackBytes, patternLimit });
      }

      if (!warnedAboutCap && patternLimit > maxHoldbackBytes) {
        warnedAboutCap = true;
        onEvent?.('holdback_cap_below_pattern_length', { capBytes: maxHoldbackBytes, patternLimit });
      }

      if (buffer.length > maxBufferSeen) maxBufferSeen = buffer.length;
      return out;
    },

    flush(): string {
      const result = redactChunk(buffer, context, options);
      merge(result.byType);
      // A mid-stream flush releases the buffer as well, so the context follows it. At end of stream
      // this is simply the last character of the response, which nothing reads again.
      if (buffer.length > 0) context = buffer.charAt(buffer.length - 1);
      buffer = '';
      return result.text;
    },

    stats(): RedactorStats {
      return {
        redactionsByType: { ...counts },
        maxBufferSeen,
        buffered: buffer.length,
        holdbackCapHits,
        maxPatternLength: patternLimit
      };
    }
  };
}
