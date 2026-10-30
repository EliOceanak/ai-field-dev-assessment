/**
 * Pattern correctness: what is detected, what is deliberately *not* detected, and the validators
 * that keep false positives out (Luhn, SSA area/group/serial rules, IPv4 octets).
 */
import { describe, expect, it } from 'vitest';
import {
  buildPatterns,
  buildPatternsDetailed,
  ipv4Valid,
  luhnValid,
  maxPatternLength,
  ssnValid
} from '../../src/redact/patterns.js';
import { redactText } from '../../src/redact/streamingRedactor.js';
import { PII_FIXTURES } from '../helpers/fixtures.js';

const options = { patterns: buildPatterns([]), replacement: '[REDACTED]', typedPlaceholders: false };

const redact = (text: string): string => redactText(text, options).text;
const typesOf = (text: string): string[] =>
  Object.entries(redactText(text, options).byType)
    .filter(([, count]) => count > 0)
    .map(([type]) => type)
    .sort();

describe('luhnValid', () => {
  it.each([
    ['4111111111111111', true],
    ['4111-1111-1111-1111', true],
    ['4012888888881881', true],
    ['5500005555555559', true],
    ['4111-1111-1111-1112', false],
    ['4111111111111112', false],
    ['1234567890123456', false],
    ['411111111111', false]
  ])('scores %s as %s', (candidate, expected) => {
    expect(luhnValid(candidate)).toBe(expected);
  });

  it('ignores separators but rejects lengths outside 13-19 digits', () => {
    expect(luhnValid('4111 1111 1111 1111')).toBe(true);
    expect(luhnValid('4111111111111')).toBe(false);
    expect(luhnValid('41111111111111111111')).toBe(false);
  });
});

describe('ssnValid', () => {
  it.each([
    ['123-45-6789', true],
    ['078-05-1120', true],
    ['000-12-3456', false],
    ['666-12-3456', false],
    ['900-12-3456', false],
    ['999-99-9999', false],
    ['123-00-6789', false],
    ['123-45-0000', false],
    ['12-45-6789', false]
  ])('scores %s as %s', (candidate, expected) => {
    expect(ssnValid(candidate)).toBe(expected);
  });
});

describe('built-in patterns', () => {
  it('detects each built-in type', () => {
    expect(typesOf('mail a.b@example.org')).toEqual(['email']);
    expect(typesOf('ssn 123-45-6789')).toEqual(['ssn']);
    expect(typesOf('card 4111-1111-1111-1111')).toEqual(['credit_card']);
    expect(typesOf('call 555-123-4567')).toEqual(['phone']);
    expect(typesOf('host 10.0.0.42')).toEqual(['ipv4']);
    expect(typesOf('key sk-abcdefghijklmnopqrstuvwx')).toEqual(['secret']);
    expect(typesOf('token Bearer abcdefghijklmnopqrstuvwx0123')).toEqual(['secret']);
    expect(typesOf('aws AKIAIOSFODNN7EXAMPLE')).toEqual(['secret']);
    expect(typesOf('pat ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toEqual(['secret']);
  });

  it('rejects a Luhn-invalid card number', () => {
    expect(redact('Number 4111-1111-1111-1112 is not a card.')).toBe('Number 4111-1111-1111-1112 is not a card.');
  });

  it('rejects structurally impossible SSNs', () => {
    const text = 'records 000-00-0000, 666-12-3456 and 900-12-3456';
    expect(redact(text)).toBe(text);
  });

  it('rejects IPv4 candidates with an octet above 255', () => {
    expect(redact('Version 999.1.1.1 is not an address.')).toBe('Version 999.1.1.1 is not an address.');
  });

  it('does not redact dates, order ids, versions, builds or quantities', () => {
    const text = 'Order ORD-10234 shipped on 2026-10-29, version 5.9.3, build 20260101, qty 42.';
    expect(redact(text)).toBe(text);
    expect(redactText(text, options).byType).toEqual({});
  });

  it('does not redact ordinary prose', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    expect(redact(text)).toBe(text);
  });

  it('does not redact a bare 9-digit run as an SSN', () => {
    expect(redact('invoice 123456789')).toBe('invoice 123456789');
  });

  it('redacts a card that is immediately followed by another number', () => {
    // Regression: a loose `(?:\d[ -]?){13,19}` match would swallow " 12.50", fail Luhn and leak.
    expect(redact('Card 4111-1111-1111-1111 was charged 12.50 today.')).toBe(
      'Card [REDACTED] was charged 12.50 today.'
    );
  });

  it('handles a value that is adjacent to punctuation', () => {
    expect(redact('mailto:bob@example.com,and')).toBe('mailto:[REDACTED],and');
  });

  it('satisfies every fixture expectation', () => {
    for (const fixture of PII_FIXTURES) {
      expect(redactText(fixture.text, options).text, fixture.name).toBe(fixture.expected);
      expect(redactText(fixture.text, options).byType, fixture.name).toEqual(fixture.redactions);
    }
  });

  it('never re-matches its own placeholder', () => {
    const once = redact('card 4111-1111-1111-1111');
    expect(once).toBe('card [REDACTED]');
    expect(redact(once)).toBe('card [REDACTED]');
  });
});

describe('typed placeholders', () => {
  it('emits [REDACTED:TYPE] when enabled', () => {
    const typed = { ...options, typedPlaceholders: true };
    expect(redactText('mail a@b.co and card 4111111111111111', typed).text).toBe(
      'mail [REDACTED:EMAIL] and card [REDACTED:CREDIT_CARD]'
    );
  });
});

describe('custom patterns', () => {
  it('appends a configured pattern to the built-ins', () => {
    const custom = buildPatterns([{ name: 'employee_id', pattern: 'EMP-\\d{6}' }]);
    const result = redactText('badge EMP-123456 issued', {
      patterns: custom,
      replacement: '[REDACTED]',
      typedPlaceholders: false
    });
    expect(result.text).toBe('badge [REDACTED] issued');
    expect(result.byType).toEqual({ employee_id: 1 });
  });

  it('derives a sound partial anchor for a literal-prefixed custom pattern', () => {
    const { patterns, unsoundCustomPatterns } = buildPatternsDetailed([{ name: 'employee_id', pattern: 'EMP-\\d{6}' }]);
    expect(unsoundCustomPatterns).toEqual([]);
    const employee = patterns.find((pattern) => pattern.name === 'employee_id');
    expect(employee?.partialAnchor.test('EMP-12')).toBe(true);
    expect(employee?.partialAnchor.test('EMP-')).toBe(true);
    expect(employee?.partialAnchor.test('EM')).toBe(true);
    expect(employee?.partialAnchor.test('nope')).toBe(false);
  });

  it('reports a custom pattern whose partial anchor had to fall back to a fixed window', () => {
    const { unsoundCustomPatterns } = buildPatternsDetailed([{ name: 'digits', pattern: '\\d{4}-\\d{4}' }]);
    expect(unsoundCustomPatterns).toEqual(['digits']);
  });

  it('adds the global flag to a custom pattern that asks for another one', () => {
    const patterns = buildPatterns([{ name: 'employee_id', pattern: 'EMP-\\d{6}', flags: 'i' }]);
    const employee = patterns.find((pattern) => pattern.name === 'employee_id');
    expect(employee?.regex.flags).toContain('g');
  });
});

describe('maxPatternLength', () => {
  it('bounds the holdback by the longest built-in', () => {
    expect(maxPatternLength(buildPatterns([]))).toBe(254);
  });
});
