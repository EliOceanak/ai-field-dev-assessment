/**
 * Opt-in live suite: the guardrail in front of the **real** local model server.
 *
 *   RUN_LIVE_LLM=1 npm run test:live
 *
 * Measured provider facts drive the assertions: llama.cpp streams reasoning in a
 * separate `delta.reasoning_content` field (the measured leak), `max_tokens` defaults to `-1`, and
 * reasoning eats the budget — so every request sends an explicit budget of at least 512 tokens and
 * a `reasoning_effort` hint.
 *
 * The assertions are invariants (no raw PII in the client stream, framing intact, redaction counts
 * consistent), never model prose.
 *
 * The server comes from the shared `LIVE_OPENAI_BASE_URL` / `LIVE_OPENAI_MODEL` (process environment or
 * the repo-root `.env`), like every live suite; `GUARDRAIL_LIVE_BASE_URL` / `GUARDRAIL_LIVE_MODEL`
 * override them for this suite alone.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, loadDotEnv } from '../../src/config.js';
import { createLogger } from '../../src/logging/logger.js';
import { createGateway, type Gateway } from '../../src/server.js';

loadDotEnv();

const LIVE = process.env.RUN_LIVE_LLM === '1';
// `||`, not `??`: an empty value (a blank line in `.env`) means unset.
const UPSTREAM = process.env.GUARDRAIL_LIVE_BASE_URL || process.env.LIVE_OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1';
const MODEL = process.env.GUARDRAIL_LIVE_MODEL || process.env.LIVE_OPENAI_MODEL || 'qwen3.8-turbo';

/** Values the model is asked to echo; they must never appear in the client stream. */
const FIXTURE_EMAIL = 'bob.smith@example.com';
const FIXTURE_CARD = '4111-1111-1111-1111';
const FIXTURE_SSN = '123-45-6789';
const FIXTURE_IP = '10.0.0.42';

const PROMPT =
  'Reply with exactly this line and nothing else, then stop: ' +
  `"customer ${FIXTURE_EMAIL} card ${FIXTURE_CARD} ssn ${FIXTURE_SSN} host ${FIXTURE_IP}"`;

async function withGateway<T>(run: (gateway: Gateway, url: string) => Promise<T>): Promise<T> {
  const gateway = createGateway({
    config: loadConfig({ GUARDRAIL_UPSTREAM_BASE_URL: UPSTREAM, GUARDRAIL_UPSTREAM_TIMEOUT_MS: '120000' }),
    logger: createLogger({ level: 'silent' })
  });
  const port = await gateway.listen(0);
  try {
    return await run(gateway, `http://127.0.0.1:${port}`);
  } finally {
    gateway.server.closeAllConnections();
    await gateway.close();
  }
}

describe.skipIf(!LIVE)('live: real model stream through the guardrail', () => {
  it('never emits raw PII and keeps the SSE framing intact', async () => {
    await withGateway(async (gateway, url) => {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: PROMPT }],
          stream: true,
          max_tokens: 1024,
          reasoning_effort: 'none',
          stream_options: { include_usage: true }
        })
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const raw = await response.text();
      for (const value of [FIXTURE_EMAIL, FIXTURE_CARD, FIXTURE_SSN, FIXTURE_IP]) {
        expect(raw, `leaked ${value}`).not.toContain(value);
      }
      expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);

      const frames = raw.split('\n\n').filter((frame) => frame.trim() !== '');
      for (const frame of frames) {
        for (const line of frame.split('\n')) expect(line.startsWith('data: ')).toBe(true);
      }

      // Every frame must be valid JSON (or the sentinel) — the mapper never breaks the stream.
      for (const frame of frames) {
        const payload = frame.slice(6);
        if (payload === '[DONE]') continue;
        expect(() => JSON.parse(payload) as unknown).not.toThrow();
      }

      const stats = (await (await fetch(`${url}/stats`)).json()) as Record<string, number>;
      expect(stats.maxBufferSeen).toBeLessThanOrEqual(512);
      expect(stats.unparsedEvents).toBe(0);
    });
  }, 180_000);

  it('scrubs reasoning_content, which this server streams as a separate field', async () => {
    await withGateway(async (_gateway, url) => {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'user',
              content:
                'Think step by step about whether this record is valid, then answer yes or no: ' +
                `record with email ${FIXTURE_EMAIL} and card ${FIXTURE_CARD}`
            }
          ],
          stream: true,
          max_tokens: 1024
        })
      });

      const raw = await response.text();
      expect(raw).not.toContain(FIXTURE_EMAIL);
      expect(raw).not.toContain(FIXTURE_CARD);

      // If the provider used reasoning_content at all, it must have been mapped and scrubbed.
      const reasoning = raw
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: ') && frame !== 'data: [DONE]')
        .map((frame) => {
          try {
            return JSON.parse(frame.slice(6)) as {
              choices?: Array<{ delta?: { reasoning_content?: string } }>;
            };
          } catch {
            return {};
          }
        })
        .flatMap((payload) => payload.choices ?? [])
        .map((choice) => choice.delta?.reasoning_content ?? '')
        .join('');

      expect(reasoning).not.toContain(FIXTURE_EMAIL);
      expect(reasoning).not.toContain(FIXTURE_CARD);
      expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
    });
  }, 180_000);
});
