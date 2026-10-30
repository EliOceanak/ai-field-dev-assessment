/**
 * End-to-end: a scripted provider streams PII (split across frames, in `content`,
 * `reasoning_content` **and** tool-call arguments) → the gateway → the client.
 *
 * The decisive assertion is a scan of the **whole response byte stream** for the raw values:
 * nothing may leak, while `[DONE]` and the SSE framing survive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockUpstream, type MockUpstream } from '../helpers/mockUpstream.js';
import {
  concatenateContent,
  concatenateField,
  concatenateToolArguments,
  readSseFrames,
  startGateway,
  type TestGateway
} from '../helpers/gateway.js';
import { RAW_PII_SENTINELS } from '../helpers/fixtures.js';

const EXPECTED_CONTENT = 'Hi Bob, your card [REDACTED] was charged. Receipt sent to [REDACTED] from [REDACTED].';
const EXPECTED_REASONING = 'Checking [REDACTED] and SSN [REDACTED] now. ';
const EXPECTED_ARGUMENTS = '{"email":"[REDACTED]"}';

let upstream: MockUpstream;
let gateway: TestGateway;

beforeEach(async () => {
  upstream = await startMockUpstream();
  gateway = await startGateway({ upstreamBaseUrl: upstream.url });
});

afterEach(async () => {
  await gateway.stop();
  await upstream.close();
});

const request = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${gateway.url()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

describe('streaming redaction through the proxy', () => {
  it('redacts content, reasoning_content and tool-call arguments', async () => {
    const response = await request({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const { frames, raw } = await readSseFrames(response);

    expect(concatenateContent(frames)).toBe(EXPECTED_CONTENT);
    expect(concatenateField(frames, 'reasoning_content')).toBe(EXPECTED_REASONING);
    expect(concatenateToolArguments(frames)).toBe(EXPECTED_ARGUMENTS);
    expect(raw).not.toContain('undefined');
  });

  it('never lets a raw PII value appear anywhere in the response bytes', async () => {
    const response = await request({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const { raw } = await readSseFrames(response);

    for (const sentinel of RAW_PII_SENTINELS) {
      expect(raw, `leaked ${sentinel}`).not.toContain(sentinel);
    }
    expect(raw).toContain('[REDACTED]');
  });

  it('preserves the [DONE] sentinel and the SSE framing', async () => {
    const response = await request({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const raw = await response.text();

    expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(raw.split('\n\n').filter((frame) => frame.trim() !== '')).toHaveLength(13);

    for (const frame of raw.split('\n\n')) {
      if (frame.trim() === '') continue;
      for (const line of frame.split('\n')) expect(line.startsWith('data: ')).toBe(true);
      const payload = frame.slice(6);
      if (payload === '[DONE]') continue;
      expect(() => JSON.parse(payload) as unknown).not.toThrow();
    }
  });

  it('keeps role, model, usage and timings intact in the client stream', async () => {
    const response = await request({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const raw = await response.text();

    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"model":"mock-model"');
    expect(raw).toContain('"total_tokens":30');
    expect(raw).toContain('"predicted_per_second":42.5');
    expect(raw).toContain('"finish_reason":"stop"');
  });

  it('forwards the request upstream unchanged apart from the explicit stream flag', async () => {
    await request({ model: 'mock-model', messages: [{ role: 'user', content: 'hello' }], stream: true });

    expect(upstream.callCount()).toBe(1);
    expect(upstream.requests[0]?.body).toEqual({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    });
  });

  it('exposes counters on /stats (the streaming path cannot know the count when headers are written)', async () => {
    const response = await request({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true });
    await response.text();

    const stats = (await (await fetch(`${gateway.url()}/stats`)).json()) as Record<string, unknown>;
    expect(stats.streams).toBe(1);
    expect(stats.chunksIn).toBeGreaterThan(10);
    // card 1 + email 3 (content, reasoning, tool arguments) + ssn 1 + ipv4 1
    expect(stats.redactions).toBe(6);
    expect(stats.redactionsByType).toEqual({ credit_card: 1, email: 3, ipv4: 1, ssn: 1 });
    expect(stats.maxBufferSeen).toBeLessThanOrEqual(512);
    expect(stats.unparsedEvents).toBe(0);
  });

  it('reports a PII-free health response with the upstream host only', async () => {
    const health = (await (await fetch(`${gateway.url()}/healthz`)).json()) as Record<string, unknown>;
    expect(health.status).toBe('ok');
    expect(health.upstreamHost).toBe(`127.0.0.1:${upstream.port}`);
    expect(JSON.stringify(health)).not.toContain('/v1');
  });

  it('passes an unparseable upstream frame through without breaking the stream', async () => {
    await gateway.stop();
    await upstream.close();
    upstream = await startMockUpstream({
      chunks: [
        { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok ' }, finish_reason: null }] }) },
        { raw: 'data: {not-json\n\n' },
        { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'bob@example.com' }, finish_reason: null }] }) },
        { raw: 'data: [DONE]\n\n' }
      ]
    });
    gateway = await startGateway({ upstreamBaseUrl: upstream.url });

    const response = await request({ model: 'mock-model', messages: [], stream: true });
    const { frames, raw } = await readSseFrames(response);

    expect(raw).toContain('data: {not-json');
    expect(concatenateContent(frames)).toBe('ok [REDACTED]');
    expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('honours typed placeholders when configured', async () => {
    await gateway.stop();
    gateway = await startGateway({ upstreamBaseUrl: upstream.url, typedPlaceholders: true });

    const response = await request({ model: 'mock-model', messages: [], stream: true });
    const raw = await response.text();

    expect(raw).toContain('[REDACTED:EMAIL]');
    expect(raw).toContain('[REDACTED:CREDIT_CARD]');
    expect(raw).not.toContain('bob@example.com');
  });

  it('adds the sentinel when a provider ends the stream without [DONE]', async () => {
    await gateway.stop();
    await upstream.close();
    upstream = await startMockUpstream({
      chunks: [
        { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'tail bob@exa' }, finish_reason: null }] }) }
      ]
    });
    gateway = await startGateway({ upstreamBaseUrl: upstream.url });

    const response = await request({ model: 'mock-model', messages: [], stream: true });
    const raw = await response.text();

    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('bob@exa');
    expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});
