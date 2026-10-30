/**
 * Non-streaming requests: the same field policy applied once to a complete JSON body, with the
 * upstream status and content type preserved and `X-Guardrail-Redactions` carrying the count that
 * the streaming path cannot know up front.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockUpstream, type MockUpstream } from '../helpers/mockUpstream.js';
import { startGateway, type TestGateway } from '../helpers/gateway.js';

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'mock-model',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Card 4111-1111-1111-1111 charged; receipt to bob@example.com.',
        reasoning_content: 'Checked SSN 123-45-6789 and host 10.0.0.42.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"email":"ops@internal.example.org"}' }
          }
        ]
      },
      finish_reason: 'tool_calls'
    }
  ],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
};

let upstream: MockUpstream;
let gateway: TestGateway;

beforeEach(async () => {
  upstream = await startMockUpstream({ chunks: undefined, body: JSON.stringify(COMPLETION) });
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

describe('non-streaming redaction', () => {
  it('redacts content, reasoning_content and tool-call arguments in the JSON body', async () => {
    const response = await request({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
    const body = (await response.json()) as typeof COMPLETION;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const message = body.choices[0]?.message;
    expect(message?.content).toBe('Card [REDACTED] charged; receipt to [REDACTED].');
    expect(message?.reasoning_content).toBe('Checked SSN [REDACTED] and host [REDACTED].');
    expect(message?.tool_calls?.[0]?.function.arguments).toBe('{"email":"[REDACTED]"}');
    expect(body.usage).toEqual(COMPLETION.usage);
    expect(body.model).toBe('mock-model');
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('never echoes raw PII in the non-streaming body', async () => {
    const response = await request({ model: 'mock-model', messages: [] });
    const raw = await response.text();

    for (const sentinel of [
      '4111-1111-1111-1111',
      'bob@example.com',
      '123-45-6789',
      '10.0.0.42',
      'ops@internal.example.org'
    ]) {
      expect(raw, `leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it('reports the redaction count in a response header', async () => {
    const response = await request({ model: 'mock-model', messages: [] });
    expect(response.headers.get('x-guardrail-redactions')).toBe('5');
    await response.text();
  });

  it('forwards stream:false upstream and reports the counters', async () => {
    await (await request({ model: 'mock-model', messages: [] })).text();

    expect(upstream.requests[0]?.body).toMatchObject({ stream: false });
    const stats = (await (await fetch(`${gateway.url()}/stats`)).json()) as Record<string, unknown>;
    expect(stats.nonStreamingRequests).toBe(1);
    expect(stats.streams).toBe(0);
    expect(stats.redactions).toBe(5);
  });

  it('preserves a non-200 upstream status with the redacted body', async () => {
    await upstream.close();
    upstream = await startMockUpstream({ status: 200, body: JSON.stringify({ ...COMPLETION, id: 'x' }) });
    await gateway.stop();
    gateway = await startGateway({ upstreamBaseUrl: upstream.url });

    const response = await request({ model: 'mock-model', messages: [] });
    expect(response.status).toBe(200);
    await response.text();
  });

  it('passes a body it cannot map through unchanged', async () => {
    await upstream.close();
    upstream = await startMockUpstream({ status: 200, body: JSON.stringify({ ok: true }) });
    await gateway.stop();
    gateway = await startGateway({ upstreamBaseUrl: upstream.url });

    const response = await request({ model: 'mock-model', messages: [] });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('x-guardrail-redactions')).toBe('0');
  });
});
