/**
 * Scripted OpenAI-compatible provider for the demo/bench scripts (plain JS: `scripts/` is not
 * type-checked, and the demo must run without tsx loading the test helpers).
 *
 * Behaviours mirror `tests/helpers/mockProvider.ts`: ok | ok-stream | 429 | 500 | hang |
 * stream-then-break. Error bodies carry sentinel strings on purpose — the demo asserts they never
 * reach a client.
 */
import { createServer } from 'node:http';

export const SECRET_PROVIDER_BODY_SENTINEL = 'SECRET_PROVIDER_BODY_SENTINEL';

export const SENTINEL_ERROR_BODY = JSON.stringify({
  error: {
    message: `${SECRET_PROVIDER_BODY_SENTINEL}: upstream quota exhausted for internal model shard`,
    type: 'insufficient_quota',
    detail: 'INTERNAL_STACK_TRACE_SENTINEL at /srv/provider/internal/limiter.ts:42'
  }
});

export function chunkOf(delta, finishReason = null) {
  return {
    id: 'chatcmpl-demo',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'demo-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

export function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function demoStream(usage = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }) {
  return [
    sseFrame(chunkOf({ role: 'assistant', content: 'Hello ' })),
    sseFrame(chunkOf({ content: 'from the demo provider.' })),
    sseFrame(chunkOf({}, 'stop')),
    sseFrame({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', choices: [], usage }),
    'data: [DONE]\n\n'
  ];
}

/** A port that nothing is listening on (bind, note the port, close) — the `network` failure case. */
export async function deadProviderUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
}

export async function startScriptedProvider({ name, behaviour = 'ok', delayMs = 0, usage } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (part) => parts.push(part));
    req.on('end', () => {
      calls.push({ path: req.url, body: Buffer.concat(parts).toString('utf8') });
      const respond = () => {
        if (behaviour === 'hang') return; // never answers
        if (behaviour === '429' || behaviour === '500') {
          res.writeHead(Number(behaviour), { 'content-type': 'application/json' });
          res.end(SENTINEL_ERROR_BODY);
          return;
        }
        if (behaviour === 'stream-then-break') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write(sseFrame(chunkOf({ role: 'assistant', content: 'first frame only' })));
          setTimeout(() => res.socket?.destroy(), 5);
          return;
        }
        if (behaviour === 'ok-stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          for (const frame of demoStream(usage)) res.write(frame);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-demo',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: 'demo-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: usage ?? { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }
          })
        );
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    name,
    port,
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    callCount: () => calls.length,
    setBehaviour(next) {
      behaviour = next;
    },
    setDelay(next) {
      delayMs = next;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
