/**
 * Error handling: the sanitized envelope, status mapping, timeouts and robustness.
 *
 * The important assertion is the *negative* one: an upstream error body — which can contain the
 * prompt, and therefore the very PII this gateway exists to protect — must never be echoed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startMockUpstream, type MockUpstream } from '../helpers/mockUpstream.js';
import { startGateway, type TestGateway } from '../helpers/gateway.js';

/** Sentinel strings a hostile/broken provider might return. */
const UPSTREAM_SECRET = 'sk-live-DO-NOT-LEAK-abcdefghijklmnop';
const UPSTREAM_PROMPT = 'bob@example.com 4111-1111-1111-1111 123-45-6789';

let upstream: MockUpstream | undefined;
let gateway: TestGateway | undefined;

afterEach(async () => {
  await gateway?.stop();
  await upstream?.close();
  upstream = undefined;
  gateway = undefined;
});

const start = async (options: Parameters<typeof startMockUpstream>[0], timeoutMs = 5_000): Promise<void> => {
  upstream = await startMockUpstream(options);
  gateway = await startGateway({ upstreamBaseUrl: upstream.url, upstreamTimeoutMs: timeoutMs });
};

const request = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${gateway?.url() ?? ''}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

describe('upstream failures', () => {
  it('maps an upstream 500 to 502 without echoing the provider body', async () => {
    await start({
      status: 500,
      body: JSON.stringify({ error: { message: `internal: ${UPSTREAM_SECRET} ${UPSTREAM_PROMPT}` } })
    });

    const response = await request({ model: 'mock-model', messages: [], stream: true });
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(raw)).toMatchObject({ error: { type: 'upstream_error', code: 'upstream_error' } });
    expect(raw).not.toContain(UPSTREAM_SECRET);
    expect(raw).not.toContain('bob@example.com');
    expect(raw).not.toContain('internal:');
    expect((JSON.parse(raw) as { error: { request_id: string } }).error.request_id).toMatch(/^req_/);
  });

  it('preserves a 429 as a rate-limit signal, sanitized', async () => {
    await start({ status: 429, body: JSON.stringify({ error: { message: UPSTREAM_SECRET } }) });

    const response = await request({ model: 'mock-model', messages: [], stream: true });
    const raw = await response.text();

    expect(response.status).toBe(429);
    expect(JSON.parse(raw)).toMatchObject({ error: { code: 'upstream_rate_limited' } });
    expect(raw).not.toContain(UPSTREAM_SECRET);
  });

  it('answers 502 when the provider is unreachable', async () => {
    upstream = await startMockUpstream();
    const deadUrl = upstream.url;
    await upstream.close();
    upstream = undefined;
    gateway = await startGateway({ upstreamBaseUrl: deadUrl, upstreamTimeoutMs: 5_000 });

    const response = await request({ model: 'mock-model', messages: [], stream: true });
    const body = (await response.json()) as { error: { code: string; type: string } };

    expect(response.status).toBe(502);
    expect(body.error).toMatchObject({ code: 'upstream_unavailable', type: 'upstream_error' });
    expect(JSON.stringify(body)).not.toContain(deadUrl);
  });

  it('answers 504 when the provider never sends headers', async () => {
    await start({ hang: true }, 250);

    const response = await request({ model: 'mock-model', messages: [], stream: true });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(504);
    expect(body.error.code).toBe('upstream_timeout');
  });

  it('closes a stalled mid-stream response with an in-band error and [DONE]', async () => {
    await start(
      {
        chunks: [
          { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial ' }, finish_reason: null }] }) },
          { raw: '\n', delayMs: 5_000 }
        ]
      },
      250
    );

    const response = await request({ model: 'mock-model', messages: [], stream: true });
    const raw = await response.text();

    expect(raw).toContain('partial');
    expect(raw).toContain('upstream_timeout');
    expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('request validation', () => {
  it('rejects a body that is not JSON with 400', async () => {
    await start({ hang: true });

    const response = await fetch(`${gateway?.url() ?? ''}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json'
    });
    const body = (await response.json()) as { error: { code: string; request_id: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_json');
    expect(body.error.request_id).toMatch(/^req_/);
  });

  it('rejects a JSON body that is not an object', async () => {
    await start({ hang: true });
    const response = await request(['not', 'an', 'object'] as unknown as Record<string, unknown>);
    expect(response.status).toBe(400);
    await response.text();
  });

  it('rejects an oversized request body with 413', async () => {
    upstream = await startMockUpstream();
    gateway = await startGateway({ upstreamBaseUrl: upstream.url, maxRequestBodyBytes: 64 });

    const response = await request({ model: 'mock-model', messages: [{ role: 'user', content: 'x'.repeat(200) }] });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(413);
    expect(body.error.code).toBe('payload_too_large');
  });

  it('answers 404 for an unknown route with a sanitized envelope', async () => {
    await start({ hang: true });
    const response = await fetch(`${gateway?.url() ?? ''}/v1/embeddings`, { method: 'POST' });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('unknown_route');
  });

  it('answers 502 when the upstream body exceeds the non-streaming cap', async () => {
    upstream = await startMockUpstream({ status: 200, body: JSON.stringify({ choices: [], filler: 'x'.repeat(4_096) }) });
    gateway = await startGateway({ upstreamBaseUrl: upstream.url, maxNonStreamingBytes: 128 });

    const response = await request({ model: 'mock-model', messages: [] });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe('upstream_response_too_large');
  });
});
