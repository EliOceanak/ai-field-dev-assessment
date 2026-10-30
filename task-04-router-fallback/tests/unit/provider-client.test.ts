/**
 * The three deadlines, and the difference between them.
 *
 * `timeoutMs` is **time to first response headers** — the failover deadline. It is not a total request
 * budget: a healthy completion may take longer than three seconds, and killing it would truncate a
 * good answer and regenerate it on the secondary. Silence is the thing that must be fatal, and it is
 * measured twice: `firstByteTimeoutMs` for the gap between the headers and the first body byte (prompt
 * processing happens there), and `idleTimeoutMs` for the gap between chunks after that.
 *
 * These tests pin the boundary: a stream that outlives the headers deadline completes, a late first
 * token is not a stall, a provider that never sends headers still fails over, and a body that goes
 * quiet is still killed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { callProvider, type ProviderResult } from '../../src/providers/providerClient.js';
import { chunkOf, sseFrame, startMockProvider, type MockProvider } from '../helpers/mockProvider.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function provider(options: Parameters<typeof startMockProvider>[0] = {}): Promise<MockProvider> {
  const mock = await startMockProvider(options);
  cleanups.push(() => void mock.close());
  return mock;
}

function configFor(mock: MockProvider) {
  return { name: 'primary', baseUrl: mock.url, model: 'mock-model', timeoutMs: 3_000 };
}

async function readAll(result: ProviderResult): Promise<string> {
  if (result.kind !== 'ok' || result.stream === null) throw new Error(`expected a stream, got ${result.kind}`);
  let text = '';
  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

const slowHealthyFrames = [
  ...Array.from({ length: 6 }, (_unused, index) => sseFrame(chunkOf({ content: `frame-${index} ` }))),
  'data: [DONE]\n\n'
];

describe('callProvider deadlines', () => {
  it('does not kill a healthy stream that outlives the headers deadline', async () => {
    const mock = await provider({ behaviour: 'ok-stream', frames: slowHealthyFrames, frameDelayMs: 50 });

    // 6 frames × 50 ms ≈ 300 ms of healthy streaming, with a 60 ms headers deadline.
    const result = await callProvider(configFor(mock), { stream: true }, { timeoutMs: 60, idleTimeoutMs: 5_000 });

    expect(result.kind).toBe('ok');
    const text = await readAll(result);
    expect(text).toContain('frame-0');
    expect(text).toContain('frame-5');
    expect(text).toContain('[DONE]');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.timedOut()).toBe(false);
    expect(result.stalled()).toBe(false);
    result.release();
  });

  it('lets a buffered response that outlives the headers deadline finish', async () => {
    const mock = await provider({ behaviour: 'ok-stream', frames: slowHealthyFrames, frameDelayMs: 50 });

    // Same 300 ms of body, read as a single buffered payload, still a 60 ms headers deadline.
    const result = await callProvider(configFor(mock), {}, { timeoutMs: 60, idleTimeoutMs: 5_000, mode: 'buffer' });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.text).toContain('frame-5');
    expect(result.timedOut()).toBe(false);
    expect(result.stalled()).toBe(false);
  });

  it('still reports a timeout when the provider never sends headers', async () => {
    const mock = await provider({ behaviour: 'hang' });

    const result = await callProvider(configFor(mock), {}, { timeoutMs: 120, idleTimeoutMs: 5_000 });

    expect(result).toMatchObject({ kind: 'timeout', phase: 'headers' });
    if (result.kind === 'ok') result.release();
  });

  it('kills a body that goes silent for longer than the idle deadline', async () => {
    const mock = await provider({ behaviour: 'stream-then-hang' });

    const result = await callProvider(configFor(mock), { stream: true }, { timeoutMs: 5_000, idleTimeoutMs: 120 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');

    // The first frame arrives; then silence. The watchdog must abort the body.
    await expect(readAll(result)).rejects.toThrow();
    expect(result.stalled()).toBe(true);
    expect(result.timedOut()).toBe(false);
    result.release();
  });

  it('reports a stall in a buffered body as a body-phase timeout', async () => {
    const mock = await provider({ behaviour: 'stream-then-hang' });

    const result = await callProvider(configFor(mock), {}, { timeoutMs: 5_000, idleTimeoutMs: 120, mode: 'buffer' });

    expect(result).toMatchObject({ kind: 'timeout', phase: 'body' });
  });

  it('can disable the idle watchdog entirely', async () => {
    const mock = await provider({ behaviour: 'ok-stream', frames: slowHealthyFrames, frameDelayMs: 30 });

    const result = await callProvider(configFor(mock), { stream: true }, { timeoutMs: 60, idleTimeoutMs: 0 });

    expect(result.kind).toBe('ok');
    expect(await readAll(result)).toContain('frame-5');
    if (result.kind === 'ok') result.release();
  });

  it('does not treat prompt processing as a stall: a late first byte completes', async () => {
    const mock = await provider({
      behaviour: 'ok-stream',
      frames: slowHealthyFrames,
      firstFrameDelayMs: 200,
      frameDelayMs: 10
    });

    // Headers arrive immediately, the first byte only after 200 ms — four times the 50 ms stall
    // watchdog, and comfortably inside the first-byte deadline. The watchdog starts on the first chunk,
    // so nothing fires and the stream finishes.
    const result = await callProvider(configFor(mock), { stream: true }, {
      timeoutMs: 5_000,
      firstByteTimeoutMs: 5_000,
      idleTimeoutMs: 50
    });

    expect(result.kind).toBe('ok');
    const text = await readAll(result);
    expect(text).toContain('frame-0');
    expect(text).toContain('frame-5');
    expect(text).toContain('[DONE]');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.timedOut()).toBe(false);
    expect(result.stalled()).toBe(false);
    result.release();
  });

  it('kills a provider that sends headers but never starts the body', async () => {
    const mock = await provider({ behaviour: 'ok-stream', frames: slowHealthyFrames, firstFrameDelayMs: 1_000 });

    // Only the first-byte deadline can catch this: the stall watchdog has not started yet. A stream is
    // already `ok` once headers arrive (the gateway commits the client's response then), so the abort
    // surfaces as a failed body read with `stalled()` true, which the gateway turns into an in-band
    // `gateway_stream_failed`. The buffered case below is the one that can still fail over.
    const result = await callProvider(configFor(mock), { stream: true }, {
      timeoutMs: 5_000,
      firstByteTimeoutMs: 120,
      idleTimeoutMs: 5_000
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    await expect(readAll(result)).rejects.toThrow();
    expect(result.stalled()).toBe(true);
    expect(result.timedOut()).toBe(false);
    result.release();
  });

  it('reports a buffered body that never starts as a body-phase timeout', async () => {
    const mock = await provider({ behaviour: 'ok-stream', frames: slowHealthyFrames, firstFrameDelayMs: 1_000 });

    const result = await callProvider(configFor(mock), {}, {
      timeoutMs: 5_000,
      firstByteTimeoutMs: 120,
      idleTimeoutMs: 5_000,
      mode: 'buffer'
    });

    expect(result).toMatchObject({ kind: 'timeout', phase: 'body' });
  });

  it('maps a 429 to an http result and drains the body', async () => {
    const mock = await provider({ behaviour: '429' });

    const result = await callProvider(configFor(mock), {}, { timeoutMs: 500, idleTimeoutMs: 500 });

    expect(result).toMatchObject({ kind: 'http', status: 429 });
  });
});
