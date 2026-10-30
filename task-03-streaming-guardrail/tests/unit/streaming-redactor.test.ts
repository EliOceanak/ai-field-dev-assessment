/**
 * The decisive test for this task: **no boundary leakage**.
 *
 * For every fixture and **every** possible split index, feeding the two halves to a fresh
 * redactor and flushing must produce exactly what redacting the whole string produces — and the
 * same must hold when the fixture arrives one character at a time. A synthetic multi-MB stream
 * then proves the retained tail stays bounded while it happens.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildPatterns } from '../../src/redact/patterns.js';
import {
  computeHoldback,
  createStreamingRedactor,
  redactText,
  type RedactOptions
} from '../../src/redact/streamingRedactor.js';
import { PII_FIXTURES } from '../helpers/fixtures.js';

const patterns = buildPatterns([]);
const options: RedactOptions = { patterns, replacement: '[REDACTED]', typedPlaceholders: false };

/** Feeds `text` to a fresh redactor in `size`-sized pieces; returns everything emitted. */
function streamIn(text: string, size: number): { out: string; maxBufferSeen: number } {
  const redactor = createStreamingRedactor({ ...options, maxHoldbackBytes: 512 });
  let out = '';
  for (let index = 0; index < text.length; index += size) {
    out += redactor.push(text.slice(index, index + size));
  }
  out += redactor.flush();
  return { out, maxBufferSeen: redactor.stats().maxBufferSeen };
}

describe('streaming redactor — split boundaries', () => {
  it('redacts the whole string (reference implementation for the split assertions)', () => {
    for (const fixture of PII_FIXTURES) {
      expect(redactText(fixture.text, options).text, fixture.name).toBe(fixture.expected);
    }
  });

  it('still finds a valid card inside a longer, Luhn-rejected candidate', () => {
    // The greedy card pattern matches `1120 4012-8888-8888` first, and Luhn rejects it. Skipping to the
    // end of that rejected candidate would hide the valid 16-digit card that starts inside it, so the
    // whole-string path would emit the card in clear.
    expect(redactText('078-05-1120 4012-8888-8888-1881.', options).text).toBe('[REDACTED] [REDACTED].');
  });

  it.each([
    ['an address', 'server 10.0.0.1 415-555-0132 ok', 'server [REDACTED] ok'],
    ['a contiguous card', 'card 4111111111111111 415-555-0132 ok', 'card [REDACTED] ok'],
    ['a grouped card', 'card 4012-8888-8888-1881 (415) 555-0132 ok', 'card [REDACTED] ok']
  ])('merges a phone number that overlaps %s instead of dropping it', (_label, text, expected) => {
    // The phone's optional `1` country code starts on the previous value's last digit. Keeping only the
    // candidate that starts first would emit the phone number in clear.
    expect(redactText(text, options).text).toBe(expected);
    for (let split = 0; split <= text.length; split += 1) {
      const redactor = createStreamingRedactor(options);
      const out = redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.flush();
      expect(out, `split at ${split}`).toBe(expected);
    }
  });

  it('gives a merged span the type of the candidate that starts first', () => {
    const typed = { ...options, typedPlaceholders: true };
    const result = redactText('server 10.0.0.1 415-555-0132 ok', typed);
    expect(result.text).toBe('server [REDACTED:IPV4] ok');
    expect(result.byType).toEqual({ ipv4: 1 });
  });

  it.each([
    ['a year', '4111 1111 1111 1111 2025', '[REDACTED] 2025'],
    ['a date', 'paid with 4111 1111 1111 1111 2026-10-29 for $12.50', 'paid with [REDACTED] 2026-10-29 for $12.50'],
    ['a hyphenated group', 'card 4012-8888-8888-1881-0525 end', 'card [REDACTED]-0525 end']
  ])('does not let a following 4-digit group hide a grouped card (%s)', (_label, text, expected) => {
    // A fifth group makes 20 digits, which Luhn always rejects, so the grouped pattern stops at four.
    expect(redactText(text, options).text).toBe(expected);
    expect(streamIn(text, 1).out).toBe(expected);
  });

  it('does not invent a word boundary at an emit boundary', () => {
    // `word4111 1111 1111 1111.jane.doe@example.com` has no word boundary before the digits, so the
    // whole-string pass leaves the digit run alone (and redacts the email, whose local part starts
    // with the last group). Matching a chunk in isolation would see a boundary at position 0 and
    // redact a card that is not there — which is what the left-context character prevents.
    const text = 'word4111 1111 1111 1111.jane.doe@example.com';
    const expected = redactText(text, options).text;
    expect(expected).toBe('word4111 1111 1111 [REDACTED]');
    for (const size of [1, 3, 5, 9, 17]) {
      expect(streamIn(text, size).out, `chunk ${size}`).toBe(expected);
    }
  });

  it('matches whole-string redaction at EVERY split index', () => {
    for (const fixture of PII_FIXTURES) {
      const expected = redactText(fixture.text, options).text;
      for (let split = 0; split <= fixture.text.length; split += 1) {
        const redactor = createStreamingRedactor(options);
        const out =
          redactor.push(fixture.text.slice(0, split)) + redactor.push(fixture.text.slice(split)) + redactor.flush();
        expect(out, `${fixture.name} split at ${split}`).toBe(expected);
      }
    }
  });

  it('matches whole-string redaction when fed one character at a time', () => {
    for (const fixture of PII_FIXTURES) {
      const expected = redactText(fixture.text, options).text;
      const { out, maxBufferSeen } = streamIn(fixture.text, 1);
      expect(out, fixture.name).toBe(expected);
      expect(maxBufferSeen, fixture.name).toBeLessThanOrEqual(512);
    }
  });

  it('matches whole-string redaction for every fixed chunk size 1..17', () => {
    for (const fixture of PII_FIXTURES) {
      const expected = redactText(fixture.text, options).text;
      for (let size = 1; size <= 17; size += 1) {
        expect(streamIn(fixture.text, size).out, `${fixture.name} chunk ${size}`).toBe(expected);
      }
    }
  });

  it('matches whole-string redaction when values are spliced into random contexts at random splits', () => {
    const tokens = [
      '4111-1111-1111-1111',
      'bob@example.com',
      '123-45-6789',
      '+1 (555) 123-4567',
      '10.0.0.42',
      'sk-abcdefghijklmnopqrstuvwx',
      'Bearer zzzzzzzzzzzzzzzzzzzz',
      '4012888888881881',
      'ORD-10234',
      '2026-10-29'
    ];
    const fillers = ['hello ', 'the ', 'x', '-', '.', ' ', '\n', 'résumé ', '✓ ', '9'];
    let seed = 20_260_101;
    const random = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % bound;
    };

    for (let round = 0; round < 120; round += 1) {
      let text = '';
      for (let part = 0, count = 1 + random(4); part < count; part += 1) {
        const filler = random(2) === 1 ? (fillers[random(fillers.length)] as string) : '';
        text += filler + (tokens[random(tokens.length)] as string);
      }
      const expected = redactText(text, options).text;
      const split = random(text.length + 1);
      const redactor = createStreamingRedactor(options);
      const out = redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.flush();
      expect(out, `split ${split} of ${JSON.stringify(text)}`).toBe(expected);
      expect(streamIn(text, 1 + random(5)).out, `chunked ${JSON.stringify(text)}`).toBe(expected);
    }
  });

  it('matches whole-string redaction for seeded random PII fragments under seeded random chunking', () => {
    // The fuzz the invariant is proved with: PII values, partial values and filler are concatenated in
    // a seeded random order, then streamed in seeded random chunk sizes. Both bugs this file guards
    // against were found here — a run that merely continues an already-emitted word being redacted at
    // an emit boundary, and a Luhn-rejected candidate swallowing a valid card inside it.
    const pii = [
      'jane.doe@example.com',
      'a.b+c@mail.co.uk',
      '123-45-6789',
      '078-05-1120',
      '4111 1111 1111 1111',
      '4012-8888-8888-1881',
      '378282246310005',
      '(415) 555-0132',
      '+1 415-555-0132',
      '10.0.0.42',
      '192.168.1.1',
      `sk-${'x'.repeat(30)}`,
      `sk-proj-${'Ab9'.repeat(50)}`,
      `ghp_${'a1'.repeat(20)}`,
      'AKIAIOSFODNN7EXAMPLE',
      `Bearer ${'tok.'.repeat(60)}`
    ];
    const filler = [
      'v3.14.2',
      '2026-10-29',
      'ORD-10234',
      '1.2.3',
      '@',
      '-',
      '.',
      ' ',
      '\n',
      '12',
      '999',
      'word',
      'QUJD'.repeat(40),
      'e@x',
      'user@',
      '555-01'
    ];
    const fragments = [...pii, ...filler];
    const separators = ['', '.', ',', '\n', '; '];
    let seed = 12_345;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = (items: readonly string[]): string => items[Math.floor(rand() * items.length)] as string;

    for (let round = 0; round < 400; round += 1) {
      let text = '';
      const parts = 1 + Math.floor(rand() * 12);
      for (let index = 0; index < parts; index += 1) {
        text += pick(fragments) + (rand() < 0.5 ? ' ' : pick(separators));
      }
      const expected = redactText(text, options).text;

      for (let trial = 0; trial < 5; trial += 1) {
        const redactor = createStreamingRedactor({ ...options, maxHoldbackBytes: 512 });
        let out = '';
        let cursor = 0;
        while (cursor < text.length) {
          const size = 1 + Math.floor(rand() * 9);
          out += redactor.push(text.slice(cursor, cursor + size));
          cursor += size;
        }
        out += redactor.flush();
        expect(out, `round ${round} trial ${trial} of ${JSON.stringify(text)}`).toBe(expected);
      }
    }
  });

  it('never emits an inserted PII value when values sit next to each other in ordinary text', () => {
    // The fuzz above proves streaming equals whole-string redaction; this one proves the redaction is
    // there at all, which equality alone cannot (a value missed by both paths passes it). Values are
    // joined by real separators, so each one is complete and delimited, and neither the whole-string
    // pass nor a randomly chunked stream may contain any of them.
    const pii = [
      'jane.doe@example.com',
      'a.b+c@mail.co.uk',
      '123-45-6789',
      '078-05-1120',
      '4111 1111 1111 1111',
      '4012-8888-8888-1881',
      '4111111111111111',
      '378282246310005',
      '(415) 555-0132',
      '+1 415-555-0132',
      '10.0.0.42',
      '10.0.0.1',
      '192.168.1.1',
      `sk-${'x'.repeat(30)}`,
      `ghp_${'a1'.repeat(20)}`,
      'AKIAIOSFODNN7EXAMPLE'
    ];
    const filler = ['hello', 'the total is 12.50', 'v3.14.2', '2026-10-29', 'ORD-10234', 'and', 'id 42', '1234', '2025'];
    const separators = [' ', ', ', '. ', '\n', ' - ', '; ', ' and '];
    let seed = 987_654;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = (items: readonly string[]): string => items[Math.floor(rand() * items.length)] as string;

    for (let round = 0; round < 1_500; round += 1) {
      const inserted: string[] = [];
      let text = '';
      const parts = 1 + Math.floor(rand() * 8);
      for (let index = 0; index < parts; index += 1) {
        const value = rand() < 0.5 ? pick(pii) : pick(filler);
        if (pii.includes(value)) inserted.push(value);
        text += (index === 0 ? '' : pick(separators)) + value;
      }
      text += pick(['', '.', ' ok', '\n']);

      const redactor = createStreamingRedactor({ ...options, maxHoldbackBytes: 512 });
      let streamed = '';
      let cursor = 0;
      while (cursor < text.length) {
        const size = 1 + Math.floor(rand() * 9);
        streamed += redactor.push(text.slice(cursor, cursor + size));
        cursor += size;
      }
      streamed += redactor.flush();

      for (const out of [redactText(text, options).text, streamed]) {
        for (const value of inserted) {
          expect(out.includes(value), `${JSON.stringify(value)} survived in ${JSON.stringify(text)}`).toBe(false);
        }
      }
    }
  });
});

describe('streaming redactor — buffer state', () => {
  it('keeps the retained tail within maxHoldbackBytes on a synthetic multi-MB stream', () => {
    const redactor = createStreamingRedactor({ ...options, maxHoldbackBytes: 512 });
    const piece = 'Lorem ipsum dolor sit amet bob@example.com consectetur 4111-1111-1111-1111 adipiscing. ';
    let out = '';
    for (let index = 0; index < 3_000; index += 1) out += redactor.push(piece);
    out += redactor.flush();

    expect(out).not.toContain('bob@example.com');
    expect(out).not.toContain('4111-1111-1111-1111');
    expect(out.split('[REDACTED]').length - 1).toBe(6_000);
    expect(redactor.stats().maxBufferSeen).toBeLessThanOrEqual(512);
  });

  it('reports the tail it is currently withholding', () => {
    const redactor = createStreamingRedactor(options);
    expect(redactor.push('email bob@exa')).toBe('email ');
    const stats = redactor.stats();
    expect(stats.buffered).toBe(7);
    expect(redactor.flush()).toBe('[REDACTED]');
    expect(redactor.stats().buffered).toBe(0);
  });

  it('ignores empty deltas', () => {
    const redactor = createStreamingRedactor(options);
    expect(redactor.push('')).toBe('');
    expect(redactor.push('card 4111-1111-1111-1111')).toBe('card ');
    expect(redactor.push('')).toBe('');
    expect(redactor.flush()).toBe('[REDACTED]');
  });

  it('flushes on demand so the tail of a message is never lost', () => {
    const redactor = createStreamingRedactor(options);
    expect(redactor.push('total 42')).toBe('total');
    expect(redactor.flush()).toBe(' 42');
    expect(redactor.flush()).toBe('');
  });

  it('commits a truncated SSN at end of stream rather than leaking it', () => {
    const redactor = createStreamingRedactor(options);
    expect(redactor.push('ssn 123-45')).toBe('ssn');
    expect(redactor.flush()).toBe(' [REDACTED]');
  });

  it('counts redactions per type across pushes and flushes', () => {
    const redactor = createStreamingRedactor(options);
    redactor.push('a@b.co ');
    redactor.push('4111-1111-1111-1111 ');
    redactor.push('123-45-6789');
    redactor.flush();
    expect(redactor.stats().redactionsByType).toEqual({ email: 1, credit_card: 1, ssn: 1 });
  });

  it('fires the safety valve instead of growing without bound', () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const redactor = createStreamingRedactor({
      ...options,
      // Below the longest prefix a built-in anchor can ask for (64 for the local part of an email),
      // so the valve is the only thing standing between a pathological delta and unbounded state.
      maxHoldbackBytes: 32,
      onEvent: (event, fields) => events.push({ event, fields })
    });
    // A single 4 KiB token with no delimiter: the holdback would otherwise retain all of it.
    const huge = 'a'.repeat(4_096);
    const out = redactor.push(huge) + redactor.flush();

    expect(out).toBe(huge);
    expect(redactor.stats().maxBufferSeen).toBeLessThanOrEqual(64);
    expect(redactor.stats().holdbackCapHits).toBeGreaterThan(0);
    expect(events.map((entry) => entry.event)).toContain('holdback_cap_exceeded');
  });

  it("holds back only the pattern's own bound, so a long run never needs the valve", () => {
    const events: string[] = [];
    const redactor = createStreamingRedactor({ ...options, onEvent: (event) => events.push(event) });
    const huge = 'a'.repeat(40_000); // base64-ish, no delimiter, no `@`

    const out = redactor.push(huge) + redactor.flush();

    expect(out).toBe(huge);
    expect(redactor.stats().holdbackCapHits).toBe(0);
    expect(redactor.stats().maxBufferSeen).toBeLessThanOrEqual(64);
    expect(events).not.toContain('holdback_cap_exceeded');
  });

  it('warns when the configured cap is below the longest pattern', () => {
    const events: string[] = [];
    const redactor = createStreamingRedactor({
      ...options,
      maxHoldbackBytes: 32,
      onEvent: (event) => events.push(event)
    });
    redactor.push('x');
    expect(events).toContain('holdback_cap_below_pattern_length');
  });
});

describe('computeHoldback', () => {
  it('agrees with a naive ascending suffix loop over every possible holdback', () => {
    const naive = (buffer: string): number => {
      let holdback = 0;
      const limit = Math.min(300, buffer.length);
      for (let k = 1; k <= limit; k += 1) {
        const suffix = buffer.slice(buffer.length - k);
        for (const pattern of patterns) {
          if (new RegExp(`^(?:${pattern.partialAnchor.source})`).test(suffix)) holdback = k;
        }
      }
      return holdback;
    };

    const samples = [
      '',
      'hello',
      'hello ',
      'bob@exa',
      '4111-',
      '123-45-6789',
      '123-45-6789 ',
      '+1 (',
      'Call +1 (555) 123-4567',
      'the quick brown fox',
      '10.0.0',
      'sk-abcdef'
    ];
    for (const sample of samples) {
      expect(computeHoldback(sample, patterns), JSON.stringify(sample)).toBe(naive(sample));
    }
  });

  it('withholds the shortest suffix that could still complete a match', () => {
    expect(computeHoldback('say bob@exa', patterns)).toBe(7);
    expect(computeHoldback('4111-1111-1111-111', patterns)).toBe(18);
    // A trailing space or dot is withheld by one or two characters: "+1 " / "( " are valid
    // prefixes of a phone number, and the cost of being wrong there is a leak.
    expect(computeHoldback('say bob@exa ', patterns)).toBe(1);
    expect(computeHoldback('say bob@exa. ', patterns)).toBe(2);
  });
});

describe('pathological input stays linear', () => {
  it('scans a 40 KB delimiter-free run in milliseconds, not seconds', () => {
    // The regression: an unbounded `[class]+@…` retries the run from every start position, so this
    // input took ~2.3 s (80 KB: ~9 s) and blocked the event loop for every concurrent stream. With
    // every repetition bounded by the protocol limits it is ~13 ms — hence the deliberately loose
    // bound: the assertion is "linear", not "fast on this machine".
    const blob = 'A'.repeat(40_000);
    const startedAt = performance.now();
    const redactor = createStreamingRedactor(options);
    const out = redactor.push(blob) + redactor.flush();
    const elapsedMs = performance.now() - startedAt;

    expect(out).toBe(blob);
    expect(elapsedMs).toBeLessThan(250);
  });

  it('still redacts inside such a run when there is something to redact', () => {
    const blob = `${'A'.repeat(20_000)} alice@example.com ${'B'.repeat(20_000)}`;
    const redactor = createStreamingRedactor(options);
    const out = redactor.push(blob) + redactor.flush();

    expect(out).toBe(`${'A'.repeat(20_000)} [REDACTED] ${'B'.repeat(20_000)}`);
  });

  it('keeps matching the longest allowed local part', () => {
    const local = 'a'.repeat(64);
    expect(redactText(`${local}@example.com`, options).text).toBe('[REDACTED]');
  });
});

describe('flush semantics at end of stream', () => {
  it('redacts a truncated but committed email instead of leaking it', () => {
    const redactor = createStreamingRedactor(options);
    const out = redactor.push('my email is bob@exa') + redactor.flush();
    expect(out).toBe('my email is [REDACTED]');
  });

  it('does not mistake a dotted version number for a truncated address', () => {
    // "version 3.14.2." is a sentence, not an IPv4 prefix: committing a three-group partial would
    // redact ordinary prose at end of stream.
    const redactor = createStreamingRedactor(options);
    const out = redactor.push('the version is 3.14.2.') + redactor.flush();
    expect(out).toBe('the version is 3.14.2.');
  });

  it('still commits an address-shaped tail at end of stream', () => {
    const redactor = createStreamingRedactor(options);
    const out = redactor.push('the host is 10.0.0.42') + redactor.flush();
    expect(out).toBe('the host is [REDACTED]');
  });

  it('does not redact prose that merely ends in a bare word', () => {
    const redactor = createStreamingRedactor(options);
    const out = redactor.push('the word is fox') + redactor.flush();
    expect(out).toBe('the word is fox');
  });

  it('does not resurrect a value a validator already rejected', () => {
    const redactor = createStreamingRedactor(options);
    const out = redactor.push('number 4111-1111-1111-1112') + redactor.flush();
    expect(out).toBe('number 4111-1111-1111-1112');
  });

  it('logs the holdback cap breach with fields but never the buffered text', () => {
    const onEvent = vi.fn();
    const redactor = createStreamingRedactor({ ...options, maxHoldbackBytes: 8, onEvent });
    redactor.push('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(onEvent).toHaveBeenCalledWith('holdback_cap_exceeded', { capBytes: 8, patternLimit: 254 });
    for (const call of onEvent.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('aaaaaaaa');
    }
  });
});
