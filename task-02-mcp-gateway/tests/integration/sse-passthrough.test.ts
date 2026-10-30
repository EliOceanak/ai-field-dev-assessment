import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockDownstream } from '../helpers/mockDownstream.js';
import type { MockDownstream } from '../helpers/mockDownstream.js';
import { startTestGateway } from '../helpers/startGateway.js';
import type { TestGateway } from '../helpers/startGateway.js';
import { TEST_SECRET, mintToken } from '../helpers/tokens.js';

const viewerToken = mintToken('viewer');

const STREAM_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 'stream-1',
  method: 'mock/stream',
  params: { frames: 3, delayMs: 40 }
});

interface Arrival {
  at: number;
  text: string;
}

/** Read a response body incrementally, recording every chunk as it lands. */
async function readIncrementally(response: Response): Promise<{ arrivals: Arrival[]; text: string }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { arrivals: [], text: '' };
  const decoder = new TextDecoder();
  const arrivals: Arrival[] = [];
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    arrivals.push({ at: Date.now(), text: chunk });
  }
  return { arrivals, text };
}

async function postStream(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${viewerToken}` },
    body: STREAM_REQUEST
  });
}

describe('SSE passthrough', () => {
  let mock: MockDownstream;
  let gateway: TestGateway;

  beforeEach(async () => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} }
    });
  });

  afterEach(async () => {
    await gateway.close();
    await mock.close();
  });

  it('keeps the downstream content type and streams frames as they arrive', async () => {
    const startedAt = Date.now();
    const response = await postStream(gateway.url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    // A streamed body must not be framed by a length the gateway cannot know.
    expect(response.headers.get('content-length')).toBeNull();

    const { arrivals, text } = await readIncrementally(response);

    // Buffering would collapse this into a single chunk.
    expect(arrivals.length).toBeGreaterThanOrEqual(4);
    // The first frame is delivered while the stream is still open...
    expect(arrivals[0]?.text).toContain('"index":0');
    expect(arrivals[0]?.text).not.toContain('event: done');
    // ...and the last frame lands ~120 ms later, i.e. the frames were relayed one by one.
    const first = arrivals[0]?.at ?? 0;
    const last = arrivals[arrivals.length - 1]?.at ?? 0;
    expect(last - first).toBeGreaterThanOrEqual(60);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);

    expect(text).toContain('event: done');
    expect(text).toContain('"frames":3');
  });

  it('relays the frames byte-identically', async () => {
    const direct = await readIncrementally(await postStream(mock.url));
    const through = await readIncrementally(await postStream(gateway.url));

    expect(through.text).toBe(direct.text);
  });

  it('logs the streaming response as streaming, with the byte count', async () => {
    const response = await postStream(gateway.url);
    const { text } = await readIncrementally(response);
    const [line] = gateway.logsFor('proxy_request');

    expect(line).toMatchObject({ upstreamStatus: 200, streaming: true });
    expect(line?.bytesOut).toBe(Buffer.byteLength(text));
  });

  it('forwards the stream request exactly once', async () => {
    await readIncrementally(await postStream(gateway.url));

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe('mock/stream');
    expect(mock.calls[0]?.rawBody).toBe(STREAM_REQUEST);
  });
});
