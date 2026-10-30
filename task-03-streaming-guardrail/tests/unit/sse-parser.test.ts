/**
 * SSE framing: every frame is split at **every byte boundary** (and fed one byte at a time) and
 * must parse to exactly the same events. CRLF / bare CR / comment lines / multi-line `data:` /
 * `event:` / `id:` / `retry:` / `[DONE]` / trailing data without a blank line are all covered,
 * plus multi-byte UTF-8 characters split across reads.
 */
import { describe, expect, it } from 'vitest';
import { createSseParser, serializeSseEvent, type SseEvent } from '../../src/sse/parser.js';

const FRAMES: readonly string[] = [
  'data: {"a":1}\n\n',
  'data: [DONE]\n\n',
  ': ping\n\n',
  ': keep-alive\ndata: {"a":1}\n\n',
  'event: message\nid: 42\nretry: 1000\ndata: line1\ndata: line2\n\n',
  'data: x\r\n\r\n',
  'data: y\r\r',
  'data: z\n\ndata: w\n\n',
  'data: tail-without-blank-line',
  'data: {"text":"héllo ✓ 日本語"}\n\n',
  'data:x\n\n',
  'data:  leading-space-kept\n\n',
  'event: only-a-name\n\ndata: after\n\n',
  'unknown: field\ndata: kept\n\n',
  'data:\n\n'
];

function parseWhole(frame: string): SseEvent[] {
  const parser = createSseParser();
  return [...parser.push(frame), ...parser.flush()];
}

function parseInPieces(frame: string, size: number): SseEvent[] {
  const bytes = Buffer.from(frame, 'utf8');
  const parser = createSseParser();
  const events: SseEvent[] = [];
  for (let index = 0; index < bytes.length; index += size) {
    events.push(...parser.push(bytes.subarray(index, index + size)));
  }
  events.push(...parser.flush());
  return events;
}

describe('SSE parser', () => {
  it('parses a single data frame', () => {
    expect(parseWhole('data: {"a":1}\n\n')).toEqual([{ data: '{"a":1}', raw: 'data: {"a":1}\n\n' }]);
  });

  it('parses the [DONE] sentinel', () => {
    const events = parseWhole('data: [DONE]\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('[DONE]');
    expect(events[0]?.raw).toBe('data: [DONE]\n\n');
  });

  it('ignores comment lines used as keep-alives', () => {
    expect(parseWhole(': ping\n\n')).toEqual([]);
    expect(parseWhole(': keep-alive\ndata: {"a":1}\n\n')[0]?.data).toBe('{"a":1}');
  });

  it('joins multi-line data with a newline and keeps event/id/retry', () => {
    const events = parseWhole('event: message\nid: 42\nretry: 1000\ndata: line1\ndata: line2\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'message', id: '42', retry: '1000', data: 'line1\nline2' });
  });

  it('accepts CRLF and bare CR terminators', () => {
    expect(parseWhole('data: x\r\n\r\n')[0]?.data).toBe('x');
    expect(parseWhole('data: y\r\r')[0]?.data).toBe('y');
  });

  it('parses several frames from one buffer', () => {
    expect(parseWhole('data: z\n\ndata: w\n\n').map((event) => event.data)).toEqual(['z', 'w']);
  });

  it('dispatches trailing data that never got its blank line', () => {
    const events = parseWhole('data: tail-without-blank-line');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ data: 'tail-without-blank-line', raw: 'data: tail-without-blank-line' });
  });

  it('does not emit an event for a name-only frame', () => {
    expect(parseWhole('event: only-a-name\n\ndata: after\n\n').map((event) => event.data)).toEqual(['after']);
  });

  it('ignores unknown fields', () => {
    expect(parseWhole('unknown: field\ndata: kept\n\n')[0]?.data).toBe('kept');
  });

  it('strips exactly one space after the colon and keeps the rest', () => {
    expect(parseWhole('data:x\n\n')[0]?.data).toBe('x');
    expect(parseWhole('data:  leading-space-kept\n\n')[0]?.data).toBe(' leading-space-kept');
  });

  it('emits an empty-data frame', () => {
    const events = parseWhole('data:\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('');
  });

  it('rejects an id containing a NUL character', () => {
    expect(parseWhole('id: a\u0000b\ndata: x\n\n')[0]?.id).toBeUndefined();
  });

  it('ignores a non-numeric retry value', () => {
    expect(parseWhole('retry: soon\ndata: x\n\n')[0]?.retry).toBeUndefined();
  });

  describe('split at every byte boundary', () => {
    for (const frame of FRAMES) {
      it(`produces identical events for ${JSON.stringify(frame.slice(0, 28))}`, () => {
        const expected = parseWhole(frame);
        const bytes = Buffer.from(frame, 'utf8');
        for (let split = 0; split <= bytes.length; split += 1) {
          const parser = createSseParser();
          const events = [
            ...parser.push(bytes.subarray(0, split)),
            ...parser.push(bytes.subarray(split)),
            ...parser.flush()
          ];
          expect(events, `split at ${split}`).toEqual(expected);
        }
      });
    }

    it('produces identical events when fed one byte at a time', () => {
      for (const frame of FRAMES) {
        expect(parseInPieces(frame, 1), frame).toEqual(parseWhole(frame));
      }
    });

    it('does not corrupt a multi-byte character split across reads', () => {
      const frame = 'data: {"text":"héllo ✓ 日本語"}\n\n';
      const events = parseInPieces(frame, 1);
      expect(events[0]?.data).toBe('{"text":"héllo ✓ 日本語"}');
      expect(events[0]?.raw).toBe(frame);
    });
  });
});

describe('SSE serializer', () => {
  it('round-trips every canonical frame through parse → serialize → parse', () => {
    for (const frame of FRAMES) {
      for (const event of parseWhole(frame)) {
        const reparsed = parseWhole(serializeSseEvent(event));
        expect(reparsed).toHaveLength(1);
        // `raw` is canonicalized (field order id/event/retry, LF terminators); the payload fields
        // are identical, which is what the proxy preserves for untouched frames.
        expect(reparsed[0]).toMatchObject({
          data: event.data,
          ...(event.event !== undefined ? { event: event.event } : {}),
          ...(event.id !== undefined ? { id: event.id } : {}),
          ...(event.retry !== undefined ? { retry: event.retry } : {})
        });
      }
    }
  });

  it('writes one data line per payload line', () => {
    expect(serializeSseEvent({ data: 'a\nb' })).toBe('data: a\ndata: b\n\n');
  });

  it('writes id, event and retry before data', () => {
    expect(serializeSseEvent({ id: '1', event: 'message', retry: '1000', data: 'x' })).toBe(
      'id: 1\nevent: message\nretry: 1000\ndata: x\n\n'
    );
  });
});

