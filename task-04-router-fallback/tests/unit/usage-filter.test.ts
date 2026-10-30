/**
 * The frame-aware pass-through.
 *
 * It has two jobs and must not confuse them: learn the provider's real `usage`, and hide that frame
 * from a client that never asked for it. Everything else — content frames, comments, `[DONE]`, CRLF
 * framing — must come out byte-identical, whatever the chunk boundaries look like.
 */
import { describe, expect, it } from 'vitest';
import { createSseUsageFilter, type SseUsageFilterOptions } from '../../src/router/usageScanner.js';

const USAGE_FRAME = `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 } })}\n\n`;
const CONTENT_FRAME = `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

async function run(chunks: string[], options: SseUsageFilterOptions = {}) {
  const filter = createSseUsageFilter(options);
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  const out = await new Response(source.pipeThrough(filter.stream)).text();
  return {
    out,
    usage: filter.usage(),
    stripped: filter.strippedFrames(),
    forwarded: filter.forwardedFrames(),
    overflowed: filter.overflowed(),
    maxRetained: filter.maxRetainedBytes()
  };
}

describe('createSseUsageFilter', () => {
  it('removes the usage frame and reports the usage it saw', async () => {
    const result = await run([CONTENT_FRAME, USAGE_FRAME, DONE], { stripUsage: true });

    expect(result.out).toBe(CONTENT_FRAME + DONE);
    expect(result.out).not.toContain('usage');
    expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 });
    expect(result.stripped).toBe(1);
    expect(result.forwarded).toBe(2);
  });

  it('forwards the usage frame byte-identically when the client asked for it', async () => {
    const result = await run([CONTENT_FRAME, USAGE_FRAME, DONE], { stripUsage: false });

    expect(result.out).toBe(CONTENT_FRAME + USAGE_FRAME + DONE);
    expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 });
    expect(result.stripped).toBe(0);
    expect(result.forwarded).toBe(3);
  });

  it('produces the same output however the stream is chunked', async () => {
    const whole = await run([CONTENT_FRAME, USAGE_FRAME, DONE], { stripUsage: true });

    const bytes = new TextEncoder().encode(CONTENT_FRAME + USAGE_FRAME + DONE);
    const perByte = await run(
      Array.from(bytes, (byte) => String.fromCharCode(byte)),
      { stripUsage: true }
    );

    expect(perByte.out).toBe(whole.out);
    expect(perByte.usage).toEqual(whole.usage);
    expect(perByte.stripped).toBe(1);
  });

  it('handles CRLF framing and comments without touching them', async () => {
    const crlfContent = CONTENT_FRAME.replace(/\n\n$/, '\r\n\r\n');
    const crlfUsage = USAGE_FRAME.replace(/\n\n$/, '\r\n\r\n');
    const comment = ': keep-alive\n\n';

    const result = await run([comment, crlfContent, crlfUsage, DONE], { stripUsage: true });

    expect(result.out).toBe(comment + crlfContent + DONE);
    expect(result.usage?.total_tokens).toBe(16);
  });

  it('leaves frames that merely mention usage alone', async () => {
    const textFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'the usage of this tool' } }] })}\n\n`;
    const result = await run([textFrame], { stripUsage: true });

    expect(result.out).toBe(textFrame);
    expect(result.stripped).toBe(0);
  });

  it('forwards a trailing partial frame when the stream ends without a terminator', async () => {
    const result = await run(['data: {"choices":[]}'], { stripUsage: true });
    expect(result.out).toBe('data: {"choices":[]}');
  });

  it('passes a complete oversized frame straight through without flagging an overflow', async () => {
    const huge = `data: ${'x'.repeat(4_000)}\n\n`;
    const result = await run([huge], { stripUsage: true, maxBytes: 512 });

    expect(result.out).toBe(huge);
    expect(result.overflowed).toBe(false); // nothing had to be carried across chunks
    expect(result.forwarded).toBe(1);
  });

  it('flushes an unterminated oversized tail instead of growing without limit', async () => {
    const half = `data: ${'x'.repeat(2_000)}`;
    const rest = 'y'.repeat(2_000);
    const result = await run([half, rest], { stripUsage: true, maxBytes: 512 });

    expect(result.overflowed).toBe(true);
    expect(result.out).toBe(half + rest); // no data loss
    expect(result.maxRetained).toBeLessThan(half.length + rest.length); // it let go instead of accumulating
  });

  it('keeps the retained tail bounded across a long stream', async () => {
    const frames = Array.from({ length: 200 }, (_unused, index) => CONTENT_FRAME.replace('hi', `chunk-${index}`));
    const result = await run([...frames, USAGE_FRAME, DONE], { stripUsage: true });

    expect(result.forwarded).toBe(201);
    expect(result.usage?.total_tokens).toBe(16);
    expect(result.maxRetained).toBeLessThanOrEqual(CONTENT_FRAME.length);
  });

  it('ignores a usage-looking frame it cannot parse', async () => {
    const malformed = 'data: {"usage": not json}\n\n';
    const result = await run([malformed], { stripUsage: true });

    expect(result.out).toBe(malformed);
    expect(result.usage).toBeUndefined();
  });
});
