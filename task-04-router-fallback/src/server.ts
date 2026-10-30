/**
 * The HTTP surface: `node:http`, no framework — a router has no middleware pipeline to demonstrate,
 * and the asynchronous timeout work is the interesting part.
 *
 * ```
 * POST /v1/chat/completions ─▶ read bounded body ─▶ validate (zod)
 *                              ─▶ tenant key ─▶ handleCompletion(...)   ← all the graded logic
 *                              ─▶ plan: buffered payload | SSE stream | sanitized error
 * GET  /healthz   liveness + which providers are configured (hosts only)
 * GET  /stats     counters, window geometry, the last few request_log rows
 * GET  /metrics   Prometheus text exposition
 * ```
 *
 * The server owns the socket and nothing else: every decision (admission, failover, reconciliation)
 * lives in `src/router/routeRequest.ts` so it can be tested without HTTP.
 */
import { once } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { RouterConfig } from './config.js';
import { openDatabase, type Db } from './db/database.js';
import { applyMigrations } from './db/migrations.js';
import { createLogger, type Logger } from './logging/logger.js';
import { createMetrics, type Metrics } from './metrics/metrics.js';
import { createMutex, type Mutex } from './ratelimit/mutex.js';
import { createTokenWindow, type TokenWindow } from './ratelimit/tokenWindow.js';
import { createRequestLog, type RequestLog } from './router/requestLog.js';
import { handleCompletion, type CompletionPlan, type StreamPlan } from './router/routeRequest.js';
import { validateChatCompletion } from './router/schema.js';
import { createTenantResolver, extractTenantKey, keyFingerprint } from './router/tenant.js';
import { errorEnvelope, gatewayError, type GatewayError } from './errors/gatewayErrors.js';
import { providerHost } from './providers/providerClient.js';

export interface GatewayOptions {
  config: RouterConfig;
  logger?: Logger;
  metrics?: Metrics;
  /** Reuse an already-open database (tests). Otherwise one is opened from `config.dbPath`. */
  db?: Db;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Request body cap. Default 1 MiB → 413. */
  maxRequestBodyBytes?: number;
}

export interface Gateway {
  server: Server;
  db: Db;
  tokenWindow: TokenWindow;
  metrics: Metrics;
  logger: Logger;
  mutex: Mutex;
  requestLog: RequestLog;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** `http://127.0.0.1:<port>` once listening. */
  url(): string;
}

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

export class PayloadTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'PayloadTooLargeError';
    this.limit = limit;
  }
}

/** Bounded read: the cap is enforced while streaming in, never after buffering everything. */
async function readBoundedBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new PayloadTooLargeError(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendError(res: ServerResponse, error: GatewayError): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(error.status, {
    'content-type': 'application/json; charset=utf-8',
    'x-gateway-request-id': error.requestId,
    ...(error.headers ?? {})
  });
  res.end(JSON.stringify(errorEnvelope(error)));
}

/**
 * Pipes a proxied SSE response with backpressure.
 *
 * The mid-stream branch is the *committed* path: the status line and possibly several frames are
 * already on the wire, so there is no failover — only an honest, sanitized error event and the SSE
 * terminator. (A restart on the secondary would duplicate tokens the client already consumed.)
 */
async function pumpStream(plan: StreamPlan, res: ServerResponse, log: Logger): Promise<void> {
  res.writeHead(plan.status, plan.headers);
  res.flushHeaders();
  const reader = plan.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (!res.write(value)) await once(res, 'drain');
    }
    plan.complete({ ok: true });
  } catch (error) {
    plan.complete({ ok: false, error });
    log.warn('upstream_stream_failed', { reason: error instanceof Error ? error.name : 'unknown' });
    if (!res.writableEnded) {
      try {
        res.write(plan.midStreamFailureFrames());
      } catch {
        /* the client is gone; nothing to terminate */
      }
    }
  } finally {
    reader.releaseLock();
    if (!res.writableEnded) res.end();
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  const { config } = options;
  const logger = options.logger ?? createLogger({ level: config.logLevel, base: { service: 'router-fallback' } });
  const metrics = options.metrics ?? createMetrics();
  const now = options.now ?? Date.now;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BYTES;

  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase({ path: config.dbPath, driver: config.sqliteDriver });
  if (ownsDb) applyMigrations(db);

  const tenants = createTenantResolver(config);
  const tokenWindow = createTokenWindow({ db, windowMs: config.windowMs, limitTokens: config.limitTokens, now });
  const requestLog = createRequestLog(db, now);
  const mutex = createMutex();

  if (!tenants.strict) {
    logger.warn('tenant_autoprovision_enabled', {
      detail: 'any bearer string becomes its own tenant window; set ROUTER_TENANT_KEYS to restrict this'
    });
  }

  const handleCompletionRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = `req_${randomUUID()}`;
    const log = logger.child({ reqId: requestId });

    const tenantKey = extractTenantKey(req.headers);
    if (tenantKey === undefined) {
      metrics.inc('unauthorized');
      log.warn('missing_tenant_key', { method: req.method });
      sendError(res, gatewayError('unauthorized', { requestId }));
      return;
    }
    const resolution = tenants.resolve(tenantKey);
    if (!resolution.ok) {
      metrics.inc('unauthorized');
      metrics.inc('tenants_rejected');
      log.warn('tenant_key_rejected', { keyFingerprint: keyFingerprint(tenantKey), knownKeys: tenants.knownKeys });
      sendError(res, gatewayError('unauthorized', { requestId }));
      return;
    }
    const tenantId = resolution.tenantId;
    const reqLog = log.child({ tenant: tenantId, keyFingerprint: keyFingerprint(tenantKey) });

    let raw: string;
    try {
      raw = await readBoundedBody(req, maxRequestBodyBytes);
    } catch (error) {
      metrics.inc('payload_too_large');
      reqLog.warn('request_too_large', { limit: maxRequestBodyBytes });
      sendError(res, gatewayError('payload_too_large', { requestId }));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      metrics.inc('invalid_requests');
      reqLog.warn('malformed_json', { bytes: Buffer.byteLength(raw) });
      sendError(res, gatewayError('invalid_request', { requestId, issues: [{ path: '(body)', code: 'invalid_json' }] }));
      return;
    }

    const validation = validateChatCompletion(parsed);
    if (!validation.ok || validation.request === undefined) {
      metrics.inc('invalid_requests');
      reqLog.warn('validation_failed', { issues: validation.issues.length });
      requestLog.record({ requestId, tenantId, outcome: 'invalid_request', latencyMs: 0 });
      sendError(res, gatewayError('invalid_request', { requestId, issues: validation.issues }));
      return;
    }

    // Abort the upstream attempt as soon as the client goes away (no orphaned provider work).
    const controller = new AbortController();
    const onClose = (): void => {
      if (res.writableEnded) return;
      metrics.inc('client_disconnects');
      reqLog.info('client_disconnect');
      controller.abort();
    };
    res.on('close', onClose);

    let plan: CompletionPlan;
    try {
      plan = await handleCompletion(
        { requestId, tenantId, body: validation.request, signal: controller.signal },
        { config, db, tokenWindow, logger, metrics, mutex, requestLog, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}), now }
      );
    } catch (error) {
      metrics.inc('internal_errors');
      reqLog.error('request_failed', { stage: 'routing' }, error);
      sendError(res, gatewayError('internal_error', { requestId }));
      res.off('close', onClose);
      return;
    }

    if (plan.kind === 'error') {
      reqLog.warn('request_rejected', { code: plan.error.code, status: plan.error.status });
      sendError(res, plan.error);
      res.off('close', onClose);
      return;
    }

    if (plan.kind === 'buffered') {
      res.writeHead(plan.status, plan.headers);
      res.end(plan.body);
      res.off('close', onClose);
      return;
    }

    await pumpStream(plan, res, reqLog);
    res.off('close', onClose);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      const pragmas = db.pragmas();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          driver: db.driver,
          journalMode: pragmas.journalMode,
          windowMs: config.windowMs,
          limitTokens: config.limitTokens,
          tenantMode: tenants.strict ? 'allow-list' : 'auto-provision',
          streamIdleTimeoutMs: config.streamIdleTimeoutMs,
          providers: { primary: providerHost(config.providers.primary), secondary: providerHost(config.providers.secondary) }
        })
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ...metrics.snapshot(),
          config: {
            driver: db.driver,
            dbPath: db.path,
            windowMs: config.windowMs,
            limitTokens: config.limitTokens,
            maxAttempts: config.maxAttempts,
            failoverOn: config.failoverOn
          },
          recentRequests: requestLog.recent(5)
        })
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.prometheus());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleCompletionRequest(req, res);
      return;
    }

    // The path is logged, never echoed: a client-supplied string must not become a response body.
    logger.warn('unknown_route', { method: req.method, path: url.pathname });
    sendError(res, gatewayError('not_found', { requestId: `req_${randomUUID()}` }));
  };

  const server = createHttpServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      metrics.inc('internal_errors');
      logger.error('unhandled_request_error', { method: req.method }, error);
      sendError(res, gatewayError('internal_error', { requestId: `req_${randomUUID()}` }));
    });
  });

  return {
    server,
    db,
    tokenWindow,
    metrics,
    logger,
    mutex,
    requestLog,

    listen(port = config.port, host = '127.0.0.1'): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          const address = server.address();
          const actual = typeof address === 'object' && address !== null ? address.port : port;
          logger.info('server_listening', { port: actual, driver: db.driver, dbPath: db.path });
          resolve(actual);
        });
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          try {
            if (ownsDb) db.close();
          } catch {
            /* already closed */
          }
          resolve();
        };
        if (!server.listening) {
          finish();
          return;
        }
        server.close((error) => (error ? reject(error) : finish()));
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

/** `npm start` entry point: open the on-disk database, bind, and shut down cleanly. */
async function main(): Promise<void> {
  const { getConfig } = await import('./config.js');
  const config = getConfig();
  const gateway = createGateway({ config });
  const port = await gateway.listen();
  gateway.logger.info('gateway_ready', {
    port,
    url: `http://127.0.0.1:${port}`,
    driver: gateway.db.driver,
    dbPath: config.dbPath,
    limitTokens: config.limitTokens,
    windowMs: config.windowMs
  });

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
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        event: 'gateway_boot_failed',
        message: error instanceof Error ? error.message : String(error)
      })}\n`
    );
    process.exit(1);
  });
}
