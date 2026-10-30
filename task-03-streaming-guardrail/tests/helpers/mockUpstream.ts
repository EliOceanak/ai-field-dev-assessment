/**
 * In-process mock provider: an OpenAI-compatible `POST /v1/chat/completions` endpoint that streams
 * scripted SSE frames with configurable delays, so streaming behaviour (TTFT, split boundaries,
 * malformed frames, hangs) is testable without a model or a network.
 *
 * It also records every request body, so tests can assert what the gateway forwarded upstream.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockChunk {
  /** Written verbatim (use this for `[DONE]`, comments or deliberately malformed frames). */
  raw?: string;
  /** Written as `data: <data>\n\n`. */
  data?: string;
  /** Delay before this chunk is written. */
  delayMs?: number;
}

export interface MockUpstreamOptions {
  /** Scripted stream. Defaults to the PII-splitting stream used by the integration suite. */
  chunks?: MockChunk[];
  /** Status for non-streaming/error responses. */
  status?: number;
  /** Body for non-streaming/error responses. */
  body?: string;
  contentType?: string;
  /** Never answer (used to prove the upstream timeout → 504). */
  hang?: boolean;
  /** Send the status/headers only after this delay. */
  headersDelayMs?: number;
}

export interface RecordedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  raw: string;
}

export interface MockUpstream {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** How many requests arrived. */
  callCount(): number;
  close(): Promise<void>;
  server: Server;
}

/** Deterministic "provider" stream: every PII value is split across two or three frames. */
export function scriptedPiiStream(): MockChunk[] {
  const chunk = (payload: unknown): MockChunk => ({ data: JSON.stringify(payload) });
  const delta = (value: Record<string, unknown>, finishReason: string | null = null): unknown => ({
    id: 'chatcmpl-mock-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'mock-model',
    choices: [{ index: 0, delta: value, finish_reason: finishReason }]
  });

  return [
    chunk(delta({ role: 'assistant', content: 'Hi ' })),
    chunk(delta({ content: 'Bob, your card 4111-' })),
    chunk(delta({ content: '1111-1111-1111 was charged. ' })),
    chunk(delta({ reasoning_content: 'Checking bob@ex' })),
    chunk(delta({ reasoning_content: 'ample.com and SSN 123-45-' })),
    chunk(delta({ reasoning_content: '6789 now. ' })),
    chunk(delta({ content: 'Receipt sent to ops@internal.example' })),
    chunk(delta({ content: '.org from 10.0.0.42.' })),
    chunk(
      delta({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"email":"bob@ex' } }
        ]
      })
    ),
    chunk(delta({ tool_calls: [{ index: 0, function: { arguments: 'ample.com"}' } }] })),
    chunk(delta({}, 'stop')),
    chunk({
      id: 'chatcmpl-mock-1',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'mock-model',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      timings: { predicted_per_second: 42.5 }
    }),
    { raw: 'data: [DONE]\n\n' }
  ];
}

export async function startMockUpstream(options: MockUpstreamOptions = {}): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const chunks = options.chunks ?? scriptedPiiStream();

  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push({ path: req.url ?? '/', headers: req.headers, body, raw });

      const respond = (): void => {
        if (options.hang === true) return; // never respond

        if (options.status !== undefined && options.status >= 400) {
          res.writeHead(options.status, { 'content-type': options.contentType ?? 'application/json' });
          res.end(options.body ?? JSON.stringify({ error: { message: 'mock provider failure' } }));
          return;
        }

        if (options.body !== undefined && options.chunks === undefined) {
          res.writeHead(options.status ?? 200, { 'content-type': options.contentType ?? 'application/json' });
          res.end(options.body);
          return;
        }

        res.writeHead(options.status ?? 200, {
          'content-type': options.contentType ?? 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });

        let cancelled = false;
        res.on('close', () => {
          cancelled = true;
        });

        const writeNext = (index: number): void => {
          if (cancelled || index >= chunks.length) {
            res.end();
            return;
          }
          const chunk = chunks[index] as MockChunk;
          const text = chunk.raw ?? `data: ${chunk.data ?? ''}\n\n`;
          setTimeout(() => {
            if (cancelled) return;
            res.write(text);
            writeNext(index + 1);
          }, chunk.delayMs ?? 0);
        };

        writeNext(0);
      };

      if (options.headersDelayMs !== undefined) setTimeout(respond, options.headersDelayMs);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    callCount: () => requests.length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
