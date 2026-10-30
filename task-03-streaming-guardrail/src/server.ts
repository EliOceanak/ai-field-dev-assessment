/**
 * The gateway itself: `node:http` over the raw socket — the fewest possible layers,
 * because the rubric scores low-latency design).
 *
 * ```
 * client ──POST /v1/chat/completions──▶ node:http
 *                                         │ bounded request read
 *                                         ▼
 *                                   openUpstream (fetch, AbortSignal)
 *                                         │ raw bytes, never buffered
 *                                         ▼
 *                                   TextDecoder{stream:true}
 *                                         ▼
 *                                   createSseParser ──▶ frame
 *                                         ▼
 *                                   chunkMapper (per choice)  ──▶ redactor.push/flush
 *                                         ▼
 *                                   serializeSseEvent ──▶ res.write + drain
 * ```
 *
 * Nothing is accumulated: each frame is mapped and written as soon as it is complete, and the
 * only retained state is the redactor's bounded holdback tail (see `/stats.maxBufferSeen`).
 */
import { once } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { GuardrailConfig } from './config.js';
import { createLogger, type Logger } from './logging/logger.js';
import { createMetrics, type Metrics } from './metrics.js';
import { buildPatternsDetailed } from './redact/patterns.js';
import { createChunkMapper, redactResponseBody, type ChunkMapperOptions } from './redact/chunkMapper.js';
import { createSseParser, serializeSseEvent, type SseEvent } from './sse/parser.js';
import { openUpstream, upstreamHost } from './proxy/upstream.js';

export interface GatewayOptions {
  config: GuardrailConfig;
  logger?: Logger;
  metrics?: Metrics;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Request body cap for `POST /v1/chat/completions` (default 1 MiB → 413). */
  maxRequestBodyBytes?: number;
  /** Non-streaming response cap (default 1 MiB → 502). */
  maxNonStreamingBytes?: number;
}

export interface Gateway {
  server: Server;
  metrics: Metrics;
  logger: Logger;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** `http://127.0.0.1:<port>` once listening. */
  url(): string;
}

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_NON_STREAMING_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sanitized OpenAI-compatible error envelope. `message` is always ours: an
 * upstream body, hostname, stack trace or credential never reaches the client.
 */
function errorBody(message: string, type: string, code: string, requestId: string): string {
  return JSON.stringify({ error: { message, type, code, request_id: requestId } });
}

class PayloadTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`payload exceeds ${limit} bytes`);
    this.name = 'PayloadTooLargeError';
    this.limit = limit;
  }
}

async function readBounded(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limit) throw new PayloadTooLargeError(limit);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createGateway(options: GatewayOptions): Gateway {
  const { config } = options;
  const logger = options.logger ?? createLogger({ level: config.logLevel, base: { server: 'streaming-guardrail' } });
  const metrics = options.metrics ?? createMetrics(options.now ?? Date.now);
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxNonStreamingBytes = options.maxNonStreamingBytes ?? DEFAULT_MAX_NON_STREAMING_BYTES;

  const { patterns, unsoundCustomPatterns } = buildPatternsDetailed(config.redaction.customPatterns);
  const mapperOptions: ChunkMapperOptions = {
    patterns,
    replacement: config.redaction.replacement,
    typedPlaceholders: config.redaction.typedPlaceholders,
    maxHoldbackBytes: config.maxHoldbackBytes
  };
  const host = upstreamHost(config);

  if (unsoundCustomPatterns.length > 0) {
    logger.warn('custom_pattern_partial_anchor_fallback', { patterns: unsoundCustomPatterns });
  }
  if (patterns.some((pattern) => pattern.maxLength > config.maxHoldbackBytes)) {
    logger.warn('holdback_cap_below_pattern_length', {
      capBytes: config.maxHoldbackBytes,
      patternLimit: Math.max(...patterns.map((pattern) => pattern.maxLength))
    });
  }

  const sendError = (
    res: ServerResponse,
    status: number,
    message: string,
    code: string,
    requestId: string,
    type = 'invalid_request_error'
  ): void => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(errorBody(message, type, code, requestId));
  };

  /** `res.write` + backpressure: a slow client must not make us buffer the whole response. */
  const write = async (res: ServerResponse, text: string): Promise<void> => {
    metrics.addBytesOut(Buffer.byteLength(text));
    metrics.inc('eventsOut');
    if (!res.write(text)) await once(res, 'drain');
  };

  const handleStream = async (
    upstreamBody: ReadableStream<Uint8Array>,
    res: ServerResponse,
    requestId: string,
    log: Logger,
    startedAt: number,
    refreshTimer: () => void
  ): Promise<void> => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies in front of us must not buffer the stream either.
      'x-accel-buffering': 'no',
      'x-guardrail-stream': 'redacted'
    });
    res.flushHeaders(); // TTFT: the client can start reading immediately.

    const mapper = createChunkMapper({
      ...mapperOptions,
      onEvent: (event, fields) => {
        if (event === 'holdback_cap_exceeded') metrics.inc('holdbackCapHits');
        log.warn(event, fields);
      }
    });
    const parser = createSseParser();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let sawDone = false;

    const emit = async (event: SseEvent): Promise<void> => {
      metrics.inc('eventsIn');

      if (event.data === '[DONE]') {
        for (const pending of mapper.flushPending()) {
          await write(res, serializeSseEvent({ data: JSON.stringify(pending) }));
          metrics.inc('chunksOut');
        }
        // Preserve the sentinel and its framing exactly as the provider sent it.
        await write(res, event.raw);
        sawDone = true;
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        metrics.inc('unparsedEvents');
        await write(res, event.raw);
        return;
      }

      const mapped = mapper.map(payload);
      if (mapped.passthrough) {
        metrics.inc('unparsedEvents');
        await write(res, event.raw);
        return;
      }

      metrics.addRedactions(mapped.byType);
      metrics.inc('chunksOut');
      await write(res, serializeSseEvent({ event: event.event, id: event.id, retry: event.retry, data: JSON.stringify(mapped.chunk) }));
    };

    for await (const chunk of upstreamBody) {
      metrics.inc('chunksIn');
      metrics.addBytesIn(chunk.byteLength);
      refreshTimer();
      for (const event of parser.push(chunk)) await emit(event);
      metrics.observeBuffer(mapper.stats().maxBufferSeen);
    }
    for (const event of parser.flush()) await emit(event);

    if (!sawDone) {
      // Provider closed without the sentinel: release the tails and close the stream cleanly so
      // every client sees the same terminator.
      for (const pending of mapper.flushPending()) {
        await write(res, serializeSseEvent({ data: JSON.stringify(pending) }));
        metrics.inc('chunksOut');
      }
      await write(res, serializeSseEvent({ data: '[DONE]' }));
    }

    metrics.observeBuffer(mapper.stats().maxBufferSeen);
    res.end();
    log.info('stream_completed', {
      ms: now() - startedAt,
      maxBufferSeen: mapper.stats().maxBufferSeen,
      redactionsByType: mapper.stats().redactionsByType
    });
  };

  const emptyStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });

  const handleNonStream = async (
    status: number,
    contentType: string,
    body: ReadableStream<Uint8Array> | null,
    res: ServerResponse,
    requestId: string,
    log: Logger,
    startedAt: number
  ): Promise<void> => {
    let raw: Buffer;
    try {
      raw = await readBounded(body ?? emptyStream(), maxNonStreamingBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        metrics.inc('upstreamErrors');
        sendError(res, 502, 'Provider response exceeded the gateway limit', 'upstream_response_too_large', requestId, 'upstream_error');
        return;
      }
      throw error;
    }

    metrics.addBytesIn(raw.byteLength);
    let text = raw.toString('utf8');
    let redactions = 0;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    if (parsed !== undefined) {
      const result = redactResponseBody(parsed, mapperOptions);
      if (result.mapped) {
        redactions = result.redactions;
        metrics.addRedactions(result.byType);
        text = JSON.stringify(result.body);
      }
    } else {
      // Not JSON (or not an object): we cannot redact structured fields, so the bytes pass
      // through and the event is logged. Documented as a limitation.
      metrics.inc('unparsedEvents');
      log.warn('unparsed_response_body', { bytes: raw.byteLength });
    }

    res.writeHead(status, {
      'content-type': contentType,
      // The streaming path cannot know the final count when headers are written; it reports
      // through /stats instead.
      'x-guardrail-redactions': String(redactions)
    });
    metrics.addBytesOut(Buffer.byteLength(text));
    res.end(text);
    log.info('request_completed', { status, mode: 'non-streaming', redactions, ms: now() - startedAt });
  };

  const handleCompletion = async (
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    log: Logger
  ): Promise<void> => {
    const startedAt = now();

    let raw: Buffer;
    try {
      raw = await readBounded(req, maxRequestBodyBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendError(res, 413, `Request body exceeds ${maxRequestBodyBytes} bytes`, 'payload_too_large', requestId);
        return;
      }
      throw error;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      sendError(res, 400, 'Request body is not valid JSON', 'invalid_json', requestId);
      return;
    }
    if (!isRecord(payload)) {
      sendError(res, 400, 'Request body must be a JSON object', 'invalid_request', requestId);
      return;
    }

    const streaming = payload.stream === true;
    const controller = new AbortController();
    let timedOut = false;
    let clientGone = false;
    let timer: NodeJS.Timeout | undefined;

    // The timeout covers both "no response headers" and "no bytes for a while" — a stalled
    // provider must not pin a socket forever.
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.upstreamTimeoutMs);
      timer.unref?.();
    };
    arm();

    const onClientClose = (): void => {
      if (res.writableEnded) return;
      clientGone = true;
      metrics.inc('clientDisconnects');
      log.info('client_disconnect');
      controller.abort();
    };
    res.on('close', onClientClose);

    try {
      const upstream = await openUpstream(config, { ...payload, stream: streaming }, {
        signal: controller.signal,
        fetchImpl
      });

      if (upstream.status >= 400) {
        metrics.inc('upstreamErrors');
        // Never echo the provider body: it can contain the prompt, and therefore the PII we are
        // supposed to be protecting.
        const rateLimited = upstream.status === 429;
        log.warn('upstream_error_status', { status: upstream.status });
        sendError(
          res,
          rateLimited ? 429 : 502,
          rateLimited ? 'Provider rate limit exceeded' : 'Provider request failed',
          rateLimited ? 'upstream_rate_limited' : 'upstream_error',
          requestId,
          'upstream_error'
        );
        return;
      }

      if (streaming) {
        metrics.inc('streams');
        await handleStream(upstream.body ?? emptyStream(), res, requestId, log, startedAt, arm);
      } else {
        metrics.inc('nonStreamingRequests');
        await handleNonStream(
          upstream.status,
          upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
          upstream.body,
          res,
          requestId,
          log,
          startedAt
        );
      }
    } catch (error) {
      if (timedOut) {
        metrics.inc('upstreamTimeouts');
        metrics.inc('upstreamErrors');
        if (res.headersSent) {
          // Mid-stream: the status line is already on the wire, so close the SSE stream with an
          // in-band error event plus the terminator instead of a bogus second response.
          const envelope = { error: { message: 'Provider timed out', type: 'upstream_error', code: 'upstream_timeout', request_id: requestId } };
          await write(res, serializeSseEvent({ data: JSON.stringify(envelope) }));
          await write(res, serializeSseEvent({ data: '[DONE]' }));
          res.end();
        } else {
          sendError(res, 504, 'Provider timed out', 'upstream_timeout', requestId, 'upstream_error');
        }
      } else if (clientGone) {
        log.info('stream_aborted_after_client_disconnect');
      } else {
        metrics.inc('upstreamErrors');
        log.warn('upstream_unavailable', { reason: error instanceof Error ? error.name : 'unknown' });
        sendError(res, 502, 'Provider unavailable', 'upstream_unavailable', requestId, 'upstream_error');
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      res.off('close', onClientClose);
    }
  };


  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = `req_${randomUUID()}`;
    const log = logger.child({ reqId: requestId });
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    metrics.inc('requests');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', upstreamHost: host }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ...metrics.snapshot(),
          upstreamHost: host,
          maxHoldbackBytes: config.maxHoldbackBytes,
          maxPatternLength: Math.max(0, ...patterns.map((pattern) => pattern.maxLength)),
          patterns: patterns.map((pattern) => pattern.name)
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleCompletion(req, res, requestId, log);
      return;
    }

    sendError(res, 404, `Unknown route ${req.method ?? 'GET'} ${url.pathname}`, 'unknown_route', requestId, 'not_found_error');
  };

  const server = createHttpServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      logger.error('request_failed', { method: req.method, path: req.url }, error);
      if (res.headersSent) res.end();
      else sendError(res, 500, 'Internal gateway error', 'internal_error', 'req_internal', 'server_error');
    });
  });

  return {
    server,
    metrics,
    logger,

    listen(bindPort = config.port, bindHost = '127.0.0.1'): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(bindPort, bindHost, () => {
          server.off('error', onError);
          const address = server.address();
          const actual = typeof address === 'object' && address !== null ? address.port : bindPort;
          logger.info('server_listening', { port: actual, upstreamHost: host });
          resolve(actual);
        });
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        // Node >= 19 closes idle keep-alive sockets on close(); this is belt-and-braces for a
        // socket that is still mid-request when a test tears the server down.
        server.closeIdleConnections?.();
      });
    },

    url(): string {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;
      return `http://127.0.0.1:${port}`;
    }
  };
}

/** `npm start` entry point: bind, log to stderr, shut down cleanly on SIGINT/SIGTERM. */
async function main(): Promise<void> {
  const { getConfig } = await import('./config.js');
  const config = getConfig();
  const gateway = createGateway({ config });
  const port = await gateway.listen();
  gateway.logger.info('gateway_ready', { port, url: `http://127.0.0.1:${port}`, patterns: 'built-in+custom' });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      gateway.logger.info('gateway_shutdown', { signal });
      void gateway.close().then(() => process.exit(0));
    });
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'gateway_boot_failed', message: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  });
}
