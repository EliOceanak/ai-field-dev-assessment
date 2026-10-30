/**
 * PII fixtures shared by the unit and integration suites.
 *
 * Every fixture is a *complete* string plus its expected redaction, so the split-index test can
 * assert `push(prefix) + push(suffix) + flush() === redactText(whole)` for **every** index.
 *
 * The values are synthetic (RFC 2606 example domains, the published Visa test number, an SSA
 * range that is never issued) — no real PII lives in this repository.
 */
import type { RedactionCounts } from '../../src/redact/streamingRedactor.js';

export interface PiiFixture {
  name: string;
  text: string;
  /** What `redactText(text)` must produce. */
  expected: string;
  redactions: RedactionCounts;
}

export const PII_FIXTURES: readonly PiiFixture[] = [
  {
    name: 'email in prose',
    text: 'Contact bob.smith+alerts@example.co.uk for details.',
    expected: 'Contact [REDACTED] for details.',
    redactions: { email: 1 }
  },
  {
    name: 'email at the very end of the stream',
    text: 'the address is ops@internal.example.org',
    expected: 'the address is [REDACTED]',
    redactions: { email: 1 }
  },
  {
    name: 'email with no separator before it',
    text: 'reachmeatbob@example.com',
    expected: '[REDACTED]',
    redactions: { email: 1 }
  },
  {
    name: 'luhn-valid card, hyphenated',
    text: 'Card 4111-1111-1111-1111 was charged 12.50 today.',
    expected: 'Card [REDACTED] was charged 12.50 today.',
    redactions: { credit_card: 1 }
  },
  {
    name: 'luhn-valid card, contiguous',
    text: 'reference 4111111111111111 on file',
    expected: 'reference [REDACTED] on file',
    redactions: { credit_card: 1 }
  },
  {
    name: 'luhn-valid card at end of stream',
    text: 'the number is 5500005555555559',
    expected: 'the number is [REDACTED]',
    redactions: { credit_card: 1 }
  },
  {
    name: 'luhn-invalid card is not redacted',
    text: 'Number 4111-1111-1111-1112 is not a card.',
    expected: 'Number 4111-1111-1111-1112 is not a card.',
    redactions: {}
  },
  {
    name: 'ssn mid-sentence',
    text: 'SSN 123-45-6789 is on file.',
    expected: 'SSN [REDACTED] is on file.',
    redactions: { ssn: 1 }
  },
  {
    name: 'structurally impossible ssn is not redacted',
    text: 'records 000-12-3456 and 666-12-3456 and 900-12-3456',
    expected: 'records 000-12-3456 and 666-12-3456 and 900-12-3456',
    redactions: {}
  },
  {
    name: 'phone with country code',
    text: 'Call +1 (555) 123-4567 today.',
    expected: 'Call [REDACTED] today.',
    redactions: { phone: 1 }
  },
  {
    name: 'ipv4 address',
    text: 'Server 10.0.0.42 responded from 192.168.1.1.',
    expected: 'Server [REDACTED] responded from [REDACTED].',
    redactions: { ipv4: 2 }
  },
  {
    name: 'invalid octets are not redacted',
    text: 'Version 999.1.1.1 is not an address.',
    expected: 'Version 999.1.1.1 is not an address.',
    redactions: {}
  },
  {
    name: 'api key',
    text: 'key sk-abcdefghijklmnopqrstuvwx must rotate',
    expected: 'key [REDACTED] must rotate',
    redactions: { secret: 1 }
  },
  {
    name: 'bearer token',
    text: 'Authorization: Bearer abcdefghijklmnopqrstuvwx0123 done',
    expected: 'Authorization: [REDACTED] done',
    redactions: { secret: 1 }
  },
  {
    name: 'benign numbers, dates, versions and order ids survive',
    text: 'Order ORD-10234 shipped on 2026-10-29, version 5.9.3, build 20260101, qty 42.',
    expected: 'Order ORD-10234 shipped on 2026-10-29, version 5.9.3, build 20260101, qty 42.',
    redactions: {}
  },
  {
    name: 'every built-in in one line',
    text: 'mail a.b@example.org, card 4012888888881881, ssn 078-05-1120, ip 203.0.113.7.',
    expected: 'mail [REDACTED], card [REDACTED], ssn [REDACTED], ip [REDACTED].',
    redactions: { email: 1, credit_card: 1, ssn: 1, ipv4: 1 }
  },
  {
    name: 'ordinary prose with no PII',
    text: 'The quick brown fox jumps over the lazy dog.',
    expected: 'The quick brown fox jumps over the lazy dog.',
    redactions: {}
  },
  {
    name: 'empty string',
    text: '',
    expected: '',
    redactions: {}
  },
  {
    name: 'multi-byte characters around PII',
    text: 'résumé — контакт bob@example.com ✓ 日本語',
    expected: 'résumé — контакт [REDACTED] ✓ 日本語',
    redactions: { email: 1 }
  },
  {
    name: 'truncated email at end of stream is committed',
    text: 'my email is bob@exa',
    expected: 'my email is [REDACTED]',
    redactions: { email: 1 }
  },
  {
    name: 'truncated card at end of stream is committed',
    text: 'card number 4111-1111-1111-11',
    expected: 'card number [REDACTED]',
    redactions: { credit_card: 1 }
  },
  {
    name: 'prose ending in a bare word is not over-redacted',
    text: 'the answer is 42 and the word is fox',
    expected: 'the answer is 42 and the word is fox',
    redactions: {}
  }
];

/** The fixture used by the end-to-end streaming test (deliberately mixes every pattern). */
export const MIXED_PII_TEXT =
  'Hi Bob, your card 4111-1111-1111-1111 was charged. ' +
  'Receipt sent to bob@example.com, SSN 123-45-6789, server 10.0.0.42. ' +
  'Order ORD-10234 shipped on 2026-10-29.';

export const MIXED_PII_EXPECTED =
  'Hi Bob, your card [REDACTED] was charged. ' +
  'Receipt sent to [REDACTED], SSN [REDACTED], server [REDACTED]. ' +
  'Order ORD-10234 shipped on 2026-10-29.';

/** Raw strings that must never appear in a client-visible byte stream. */
export const RAW_PII_SENTINELS: readonly string[] = [
  '4111-1111-1111-1111',
  '4111111111111111',
  'bob@example.com',
  'bob.smith+alerts@example.co.uk',
  'ops@internal.example.org',
  '123-45-6789',
  '078-05-1120',
  '555) 123-4567',
  '10.0.0.42',
  '192.168.1.1',
  'sk-abcdefghijklmnopqrstuvwx',
  'Bearer abcdefghijklmnopqrstuvwx0123'
];
