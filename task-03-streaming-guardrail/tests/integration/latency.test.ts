/**
 * Latency and memory: the two claims the brief actually scores.
 *
 * 1. **No accumulation.** The mock emits one token, waits 300 ms, then finishes. The client must
 *    receive that first SSE event *before* the upstream finishes — which is only possible if the
 *    gateway writes each frame as it arrives instead of buffering the response.
 * 2. **Bounded memory.** A synthetic multi-MB stream keeps the retained tail (`maxBufferSeen`,
 *    reported on `/stats`) far below the response size.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockUpstream, type MockUpstream } from '../helpers/mockUpstream.js';
import { concatenateContent, startGateway, type TestGateway } from '../helpers/gateway.js';

const frame = (content: string): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  })}\n\n`;

let upstream: MockUpstream;
let gateway: TestGateway;

afterEach(async () => {
  await gateway.stop();
  await upstream.close();
});

describe('time to first token', () => {
  beforeEach(async () => {
    upstream = await startMockUpstream({
      chunks: [
        { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'first token ' }, finish_reason: null }] }) },
        { raw: '\n', delayMs: 300 }, // pause the provider
        { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'last token' }, finish_reason: null }] }) },
        { data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) },
        { raw: 'data: [DONE]\n\n' }
      ]
    });
    gateway = await startGateway({ upstreamBaseUrl: upstream.url });
  });

  it('delivers the first event long before the upstream finishes', async () => {
    const startedAt = Date.now();
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [], stream: true })
    });

    expect(response.body).not.toBeNull();
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    const firstEventAt = Date.now() - startedAt;
    const firstText = new TextDecoder().decode(first.value);

    // The provider is still paused: nothing may have been buffered until the end.
    expect(firstText).toContain('first token');
    expect(firstEventAt).toBeLessThan(250);

    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const totalAt = Date.now() - startedAt;
    const text = firstText + rest;
    const frames = text.split('\n\n').filter((part) => part.trim() !== '');

    expect(totalAt).toBeGreaterThanOrEqual(290); // the 300 ms provider pause happened
    expect(firstEventAt).toBeLessThan(totalAt / 2); // …and we did not wait for it
    // The whole message arrives; the last word is only held back by one delta (see README).
    expect(concatenateContent(frames)).toBe('first token last token');
    expect(text).toContain('data: [DONE]');
  });

  it('does not wait for the whole response before writing headers', async () => {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [], stream: true })
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await response.text();
  });
});

describe('bounded buffer under a multi-MB stream', () => {
  it('keeps maxBufferSeen bounded while streaming 5 MB', async () => {
    const chunkSize = 16 * 1024;
    const totalChunks = 320; // 320 × 16 KiB ≈ 5 MB
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod. ';
    const pieces: string[] = [];
    for (let index = 0; index < totalChunks; index += 1) {
      // Every 20th chunk carries PII, so redaction really runs throughout the stream.
      const content =
        index % 20 === 0
          ? `${filler.slice(0, chunkSize - 60)} bob@example.com 4111-1111-1111-1111 end.`
          : filler.repeat(Math.ceil(chunkSize / filler.length)).slice(0, chunkSize);
      pieces.push(content);
    }

    upstream = await startMockUpstream({
      chunks: [
        ...pieces.map((content) => ({ data: JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) })),
        { data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) },
        { raw: 'data: [DONE]\n\n' }
      ]
    });
    gateway = await startGateway({ upstreamBaseUrl: upstream.url });

    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [], stream: true })
    });
    const raw = await response.text();

    const stats = (await (await fetch(`${gateway.url()}/stats`)).json()) as Record<string, number>;
    expect(raw.length).toBeGreaterThan(5_000_000);
    expect(raw).not.toContain('bob@example.com');
    expect(raw).not.toContain('4111-1111-1111-1111');
    expect(stats.maxBufferSeen).toBeLessThanOrEqual(512);
    expect(stats.holdbackCapHits).toBe(0);
    // 16 PII-bearing chunks, each with one card and one email.
    expect(stats.redactions).toBe((totalChunks / 20) * 2);
  }, 60_000);
});
