/**
 * Scripted OpenAI-compatible provider (in-process, ephemeral port).
 *
 * Every graded upstream behaviour is a one-word script: `ok`, `ok-stream`, `429`, `500`, `hang`
 * (never answers), `slow-then-ok`, `stream-then-break` (dies after the first frame). The server also
 * records every call, so tests can assert *which* provider was tried and *how many* times — the
 * failover suite and the "no failover after the first byte" test both depend on that.
 *
 * Error bodies deliberately carry sentinel strings so the sanitization suite can prove they never
 * reach a client.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SECRET_PROVIDER_BODY_SENTINEL = 'SECRET_PROVIDER_BODY_SENTINEL';

export type Behaviour =
  | 'ok'
  | 'ok-stream'
  | '429'
  | '500'
  | 'hang'
  | 'slow-then-ok'
  | 'stream-then-break'
  /** Headers plus one frame, then silence — the socket stays open (a stalled stream). */
  | 'stream-then-hang';

export interface RecordedCall {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  raw: string;
}

export interface MockProviderOptions {
  /** Per-call behaviour, or a script indexed by call number. */
  behaviour?: Behaviour | Behaviour[];
  /** Milliseconds before the response starts (also used by `slow-then-ok`). */
  delayMs?: number;
  /** Usage reported in `ok` / `ok-stream` responses. */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Omit `usage` entirely (streaming without `include_usage`, or a terse provider). */
  omitUsage?: boolean;
  /** Frames written for `ok-stream` (raw SSE text, in order). */
  frames?: string[];
  /** Delay between frames, in ms. Lets a test build a slow but healthy stream. */
  frameDelayMs?: number;
  /**
   * Delay before the *first* frame of an `ok-stream` response, in ms. Headers are sent immediately and
   * the body then stays silent for this long — the prompt-processing gap before the first token.
   */
  firstFrameDelayMs?: number;
  /**
   * For `ok`: send the first half of the JSON body, wait this long, then the rest. A buffered
   * response that outlives the headers deadline but keeps producing bytes.
   */
  bodyDelayMs?: number;
  /**
   * `always` (default) appends the `usage` frame to every stream; `on-request` behaves like
   * llama.cpp and only reports usage when the request asked for `stream_options.include_usage`.
   */
  usageMode?: 'always' | 'on-request';
  /** Error body for `429` / `500` — carries sentinels on purpose. */
  errorBody?: string;
}

export interface MockProvider {
  url: string;
  port: number;
  server: Server;
  calls: RecordedCall[];
  callCount(): number;
  /** Behaviour of the next call (lets a demo script a scenario). */
  setBehaviour(behaviour: Behaviour | Behaviour[]): void;
  close(): Promise<void>;
}

export const SENTINEL_ERROR_BODY = JSON.stringify({
  error: {
    message: `${SECRET_PROVIDER_BODY_SENTINEL}: upstream quota exhausted for internal model shard`,
    type: 'insufficient_quota',
    detail: 'INTERNAL_STACK_TRACE_SENTINEL at /srv/provider/internal/limiter.ts:42'
  }
});

export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function chunkOf(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

/** A deterministic two-frame stream plus a `usage` frame and the `[DONE]` terminator. */
export function scriptedStream(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): string[] {
  return [
    sseFrame(chunkOf({ role: 'assistant', content: 'Hello ' })),
    sseFrame(chunkOf({ content: 'from the mock provider.' })),
    sseFrame(chunkOf({}, 'stop')),
    sseFrame({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [], usage }),
    'data: [DONE]\n\n'
  ];
}

export async function startMockProvider(options: MockProviderOptions = {}): Promise<MockProvider> {
  const calls: RecordedCall[] = [];
  let behaviour = options.behaviour ?? 'ok';
  const usage = options.usage ?? { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };

  const behaviourFor = (index: number): Behaviour =>
    Array.isArray(behaviour) ? (behaviour[Math.min(index, behaviour.length - 1)] ?? 'ok') : behaviour;

  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
      } catch {
        /* recorded as an empty body */
      }
      calls.push({ path: req.url ?? '/', headers: req.headers, body, raw });
      const current = behaviourFor(calls.length - 1);
      const respond = (): void => {
        switch (current) {
          case 'hang':
            return; // never answers: the gateway's own deadline must fire

          case '429':
          case '500': {
            res.writeHead(Number(current), { 'content-type': 'application/json' });
            res.end(options.errorBody ?? SENTINEL_ERROR_BODY);
            return;
          }

          case 'stream-then-hang': {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write(sseFrame(chunkOf({ role: 'assistant', content: 'first frame only' })));
            return; // …and then nothing, forever, with the socket still open
          }

          case 'stream-then-break': {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write(sseFrame(chunkOf({ role: 'assistant', content: 'first frame only' })));
            // Bytes are on the wire; killing the socket here is the "mid-stream failure" case.
            setTimeout(() => res.socket?.destroy(), 5);
            return;
          }

          case 'ok-stream': {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
            // Send the headers now, not with the first frame: a test can then tell "headers arrived"
            // apart from "the first body byte arrived" (`firstFrameDelayMs`). Node flushes them on the
            // first `write()` otherwise, which would make that gap unobservable.
            res.flushHeaders();
            const wantsUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
            const defaultFrames =
              options.usageMode === 'on-request' && !wantsUsage
                ? scriptedStream(usage).filter((frame) => !frame.includes('"usage"'))
                : scriptedStream(usage);
            const frames = options.frames ?? defaultFrames;
            let cancelled = false;
            res.on('close', () => {
              cancelled = true;
            });
            const writeNext = (index: number): void => {
              if (cancelled || index >= frames.length) {
                if (!cancelled) res.end();
                return;
              }
              res.write(frames[index] ?? '');
              const gap = options.frameDelayMs ?? 0;
              if (gap > 0) setTimeout(() => writeNext(index + 1), gap);
              else setImmediate(() => writeNext(index + 1));
            };
            const firstDelay = options.firstFrameDelayMs ?? 0;
            if (firstDelay > 0) {
              const firstTimer = setTimeout(() => writeNext(0), firstDelay);
              res.on('close', () => clearTimeout(firstTimer));
            } else {
              writeNext(0);
            }
            return;
          }

          case 'slow-then-ok':
          case 'ok': {
            const payload: Record<string, unknown> = {
              id: 'chatcmpl-mock',
              object: 'chat.completion',
              created: 1_700_000_000,
              model: 'mock-model',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
            };
            if (options.omitUsage !== true) payload.usage = usage;
            const text = JSON.stringify(payload);
            res.writeHead(200, { 'content-type': 'application/json' });
            if (options.bodyDelayMs !== undefined && options.bodyDelayMs > 0) {
              const half = Math.floor(text.length / 2);
              res.write(text.slice(0, half));
              setTimeout(() => res.end(text.slice(half)), options.bodyDelayMs);
              return;
            }
            res.end(text);
            return;
          }
        }
      };

      const delay = current === 'slow-then-ok' ? (options.delayMs ?? 50) : (options.delayMs ?? 0);
      if (delay > 0) setTimeout(respond, delay);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    callCount: () => calls.length,
    setBehaviour(next) {
      behaviour = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

/**
 * A provider URL that nothing is listening on: bind an ephemeral port, close it, and hand back the
 * URL. This is the honest way to test the `network` failure branch (connection refused).
 */
export async function closedProviderUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}
