/**
 * Express 5 pipeline + process lifecycle.
 *
 * The middleware order is deliberate and testable:
 *
 *   reqId → body(raw, 1 MiB) → auth(401) → JSON-RPC envelope(400) → policy
 *        → forward (fetch) → pipe the upstream response back unchanged
 *
 * Body-before-auth is a conscious trade: a rejected caller's body is still drained,
 * so the socket is never reset mid-request (which `fetch` surfaces as an opaque
 * "socket hang up" instead of a usable 401), and the cost is bounded by the 1 MiB
 * cap. Authentication is still the *first* decision made — nothing is parsed or
 * forwarded for an unauthenticated caller.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { createAuditLog } from './audit/auditLog.js';
import type { AuditLog } from './audit/auditLog.js';
import { getConfig } from './config.js';
import type { GatewayConfig } from './config.js';
import { JsonRpcErrorCode, jsonRpcError, sanitizeMessage } from './errors/gatewayErrors.js';
import type { JsonRpcErrorResponse, RequestId } from './errors/gatewayErrors.js';
import { createLogger } from './logging/logger.js';
import type { Logger } from './logging/logger.js';
import { WWW_AUTHENTICATE, authenticate } from './middleware/auth.js';
import type { Principal } from './middleware/auth.js';
import { isNotification, parseJsonRpcBody, requestIdOf, serializeMessages } from './middleware/jsonrpc.js';
import type { JsonRpcMessage, ParsedBody } from './middleware/jsonrpc.js';
import { decide, filterToolListMessage, loadPolicyFile, toolNameOf } from './policy/toolPolicy.js';
import type { PolicyDecision, PolicyOptions } from './policy/toolPolicy.js';
import { buildForwardHeaders, forward } from './proxy/forwarder.js';
import type { ForwardedResponse } from './proxy/forwarder.js';

export interface CreateAppOptions {
  config: GatewayConfig;
  logger?: Logger;
  audit?: AuditLog;
  /** Injected for deterministic tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Overrides/extends the policy (a file-driven policy wins for the keys it sets). */
  policy?: PolicyOptions;
}

interface RequestContext {
  config: GatewayConfig;
  logger: Logger;
  audit: AuditLog;
  policy: PolicyOptions;
  fetchImpl?: typeof fetch;
  now: () => Date;
}

function reqIdOf(res: Response): string {
  return String((res.locals as { reqId?: string }).reqId ?? 'unknown');
}

function sendJsonRpc(
  res: Response,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(status).end(JSON.stringify(body));
}

/**
 * Which shipped-by-default credentials are still in place.
 *
 * The defaults exist so that `npm test` and `npm run demo` work with no setup. They are also a real
 * credential, so a gateway that is running with them says so — loudly in the log, and on `/health`.
 */
export function insecureDefaultsIn(config: GatewayConfig): string[] {
  const found: string[] = [];
  if (config.tokenSecret === 'dev-secret-change-me') found.push('tokenSecret');
  const devTokens = config.devTokens ?? {};
  if (devTokens.admin === 'admin-dev-token') found.push('devTokens.admin');
  if (devTokens.viewer === 'viewer-dev-token') found.push('devTokens.viewer');
  return found;
}

/**
 * The reason a client is told about a failed authentication.
 *
 * Header-shape problems (`missing_header`, `malformed_header`) describe the request and are useful for
 * debugging. Everything about the *credential itself* collapses to one answer, so a caller cannot learn
 * whether a token was unparseable or merely forged, expired or unknown. The precise reason survives in
 * the audit log (`authFailure`).
 */
function clientVisibleAuthReason(reason: string): string {
  return reason === 'missing_header' || reason === 'malformed_header' ? reason : 'invalid_token';
}

/** Denial envelope: `-32001` with a machine-readable `data` payload, `id` echoed exactly. */
function denialBody(id: RequestId, decision: Extract<PolicyDecision, { kind: 'deny' }>): JsonRpcErrorResponse {
  const code = decision.code ?? JsonRpcErrorCode.UnauthorizedToolCall;
  return jsonRpcError({
    id,
    code,
    message: code === JsonRpcErrorCode.UnauthorizedToolCall ? 'Unauthorized tool call' : 'Invalid params',
    data: { tool: decision.tool, required_role: decision.requiredRole, reason: decision.reason }
  });
}

/** Wait for the socket to drain, but never hang if the client disconnects first. */
function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Pipe an upstream response back byte-for-byte.
 *
 * `for await` over the Web `ReadableStream` means the first SSE frame reaches the
 * client as soon as it arrives — the body is never materialised (the README's
 * incremental-SSE evidence depends on this).
 */
async function pipeUpstream(res: Response, upstream: ForwardedResponse, reqId: string): Promise<number> {
  res.status(upstream.status);
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (name.toLowerCase() === 'content-length') continue;
    res.setHeader(name, value);
  }
  res.setHeader('x-gateway-req-id', reqId);
  if (res.socket !== null && res.socket !== undefined) res.socket.setNoDelay(true);
  res.flushHeaders();

  if (upstream.body === null) {
    res.end();
    return 0;
  }

  let bytesOut = 0;
  try {
    for await (const chunk of upstream.body) {
      if (res.writableEnded || res.destroyed) break;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytesOut += buffer.byteLength;
      if (!res.write(buffer)) await waitForDrain(res);
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
  return bytesOut;
}

function auditDecision(
  ctx: RequestContext,
  reqId: string,
  principal: Principal,
  decision: PolicyDecision,
  message: JsonRpcMessage,
  batchIndex?: number
): void {
  const tool = toolNameOf(message);
  ctx.audit.policyDecision({
    reqId,
    role: principal.role,
    subject: principal.subject,
    tokenId: principal.tokenId,
    method: message.method,
    decision: decision.kind,
    reason: decision.reason,
    ...(tool === undefined ? {} : { tool }),
    ...(decision.kind === 'deny' ? { requiredRole: decision.requiredRole } : {}),
    ...(batchIndex === undefined ? {} : { batchIndex })
  });
}

async function readAllText(body: ForwardedResponse['body']): Promise<string> {
  if (body === null) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

function singleChunkStream(text: string): ReadableStream<Uint8Array> {
  const bytes = Buffer.from(text, 'utf8');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

/** Rewrite each SSE `data:` frame through the hardened filter, leaving framing untouched. */
function filterSseBody(text: string, options: PolicyOptions): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = text.split('\n').map((line) => {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return line;
    }
    const filtered = filterToolListMessage(value, options);
    if (filtered.removed.length === 0) return line;
    removed.push(...filtered.removed);
    return `data: ${JSON.stringify(filtered.value)}`;
  });
  return { text: lines.join('\n'), removed };
}

/**
 * Hardened `tools/list` filter (off by default).
 *
 * Applied to both plain JSON and SSE bodies, because the official SDK's
 * `StreamableHTTPServerTransport` answers POSTs with an SSE stream by default —
 * a JSON-only filter would be dead code against a real downstream server.
 */
async function applyToolListFilter(
  ctx: RequestContext,
  principal: Principal,
  message: JsonRpcMessage,
  upstream: ForwardedResponse
): Promise<ForwardedResponse> {
  if (ctx.policy.filterToolList !== true) return upstream;
  if (message.method !== 'tools/list') return upstream;
  if (principal.role === (ctx.policy.requiredRole ?? 'admin')) return upstream;
  if (upstream.status !== 200) return upstream;

  const original = await readAllText(upstream.body);
  const isSse = upstream.contentType.includes('text/event-stream');
  let rewritten: string;
  let removed: string[];

  if (isSse) {
    ({ text: rewritten, removed } = filterSseBody(original, ctx.policy));
  } else {
    let value: unknown;
    try {
      value = JSON.parse(original);
    } catch {
      return { ...upstream, body: singleChunkStream(original) };
    }
    const filtered = filterToolListMessage(value, ctx.policy);
    removed = filtered.removed;
    rewritten = filtered.removed.length === 0 ? original : JSON.stringify(filtered.value);
  }

  if (removed.length > 0) {
    ctx.logger.info('tool_list_filtered', { role: principal.role, removed, transport: isSse ? 'sse' : 'json' });
  }
  return { ...upstream, body: singleChunkStream(rewritten) };
}

async function forwardBody(
  ctx: RequestContext,
  req: Request,
  body: string
): ReturnType<typeof forward> {
  const headers = buildForwardHeaders(req.headers, {
    forwardClientAuth: ctx.config.forwardClientAuth,
    contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'application/json',
    ...(ctx.config.downstreamToken === undefined ? {} : { downstreamToken: ctx.config.downstreamToken })
  });
  return forward({
    downstreamUrl: ctx.config.downstreamUrl,
    timeoutMs: ctx.config.upstreamTimeoutMs,
    body,
    headers,
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl })
  });
}

function sendUpstreamFailure(
  res: Response,
  ctx: RequestContext,
  reqId: string,
  id: RequestId,
  outcome: { kind: 'unreachable' | 'timeout'; durationMs: number }
): void {
  const timedOut = outcome.kind === 'timeout';
  const status = timedOut ? 504 : 502;
  ctx.audit.gatewayError({ reqId, status, code: JsonRpcErrorCode.InternalError, reason: outcome.kind });
  ctx.logger.warn('upstream_failure', { reqId, kind: outcome.kind, durationMs: outcome.durationMs });
  sendJsonRpc(
    res,
    status,
    jsonRpcError({
      id,
      code: JsonRpcErrorCode.InternalError,
      message: timedOut ? 'Gateway timeout' : 'Bad gateway',
      data: { reqId }
    })
  );
}

/** Single message: decide, then either answer locally (deny) or forward verbatim. */
async function handleSingle(
  req: Request,
  res: Response,
  ctx: RequestContext,
  principal: Principal,
  parsed: Extract<ParsedBody, { kind: 'single' }>
): Promise<void> {
  const reqId = reqIdOf(res);
  const { message } = parsed;
  const decision = decide(principal, message, ctx.policy);
  auditDecision(ctx, reqId, principal, decision, message);

  const id: RequestId = requestIdOf(message) ?? null;

  if (decision.kind === 'deny') {
    // The decisive behaviour of this task: answer `-32001` and never touch the
    // downstream. A denied notification is dropped silently (nothing to answer).
    if (isNotification(message)) {
      res.status(202).end();
      return;
    }
    sendJsonRpc(res, 200, denialBody(id, decision));
    return;
  }

  const outcome = await forwardBody(ctx, req, parsed.text);
  if (!outcome.ok) {
    sendUpstreamFailure(res, ctx, reqId, id, outcome);
    return;
  }

  if (isNotification(message)) {
    await outcome.response.body?.cancel();
    res.setHeader('x-gateway-req-id', reqId);
    res.status(202).end();
    return;
  }

  const upstream = await applyToolListFilter(ctx, principal, message, outcome.response);
  const bytesOut = await pipeUpstream(res, upstream, reqId);
  ctx.audit.proxyRequest({
    reqId,
    upstreamStatus: upstream.status,
    durationMs: upstream.durationMs,
    bytesOut,
    streaming: upstream.contentType.includes('text/event-stream')
  });
}

function resolvePolicy(config: GatewayConfig, override?: PolicyOptions): PolicyOptions {
  const fromFile = config.policyFile === undefined ? undefined : loadPolicyFile(config.policyFile);
  return {
    privilegedPrefixes: override?.privilegedPrefixes ?? fromFile?.privilegedPrefixes ?? config.privilegedPrefixes,
    requiredRole: override?.requiredRole ?? fromFile?.requiredRole ?? 'admin',
    denyGlobs: override?.denyGlobs ?? fromFile?.denyGlobs ?? [],
    allowGlobs: override?.allowGlobs ?? fromFile?.allowGlobs ?? [],
    filterToolList: override?.filterToolList ?? config.filterToolList
  };
}


/** Batch: per-element decisions, one upstream request for the survivors, ordered merge. */
async function handleBatch(
  req: Request,
  res: Response,
  ctx: RequestContext,
  principal: Principal,
  parsed: Extract<ParsedBody, { kind: 'batch' }>
): Promise<void> {
  const reqId = reqIdOf(res);
  const slots = new Map<number, unknown>();
  for (const element of parsed.invalid) slots.set(element.index, element.error);

  const allowed: JsonRpcMessage[] = [];
  const allowedIndexes: number[] = [];

  for (const entry of parsed.entries) {
    const decision = decide(principal, entry.message, ctx.policy);
    auditDecision(ctx, reqId, principal, decision, entry.message, entry.index);
    if (decision.kind === 'deny') {
      if (isNotification(entry.message)) continue;
      slots.set(entry.index, denialBody(requestIdOf(entry.message) ?? null, decision));
      continue;
    }
    allowed.push(entry.message);
    allowedIndexes.push(entry.index);
  }

  const ordered = (): unknown[] => {
    const out: unknown[] = [];
    for (let index = 0; index < parsed.total; index += 1) {
      const value = slots.get(index);
      if (value !== undefined) out.push(value);
    }
    return out;
  };

  if (allowed.length === 0) {
    const responses = ordered();
    if (responses.length === 0) {
      res.status(202).end();
      return;
    }
    sendJsonRpc(res, 200, responses);
    return;
  }

  // Byte-identical forwarding is only safe when the batch was forwarded *whole*: the raw text still
  // contains the elements that failed envelope validation, and those were never policy-checked. So
  // "untouched" means no invalid elements AND every valid message allowed — anything else is
  // re-serialized from the allowed set alone. A security gateway must not depend on the downstream
  // rejecting what it forwards.
  const untouched = parsed.invalid.length === 0 && allowed.length === parsed.messages.length;
  const body = untouched ? parsed.text : serializeMessages(allowed);
  const outcome = await forwardBody(ctx, req, body);
  if (!outcome.ok) {
    sendUpstreamFailure(res, ctx, reqId, null, outcome);
    return;
  }

  const upstreamText = await readAllText(outcome.response.body);
  ctx.audit.proxyRequest({
    reqId,
    upstreamStatus: outcome.response.status,
    durationMs: outcome.response.durationMs,
    bytesOut: Buffer.byteLength(upstreamText),
    streaming: false
  });

  if (upstreamText.trim() !== '') {
    let payload: unknown;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      payload = undefined;
    }
    const items = payload === undefined ? [] : Array.isArray(payload) ? payload : [payload];

    // JSON-RPC allows a batch response array in any order, so results are matched
    // back to their slot by `id`; position is only the fallback for a response whose
    // id could not be determined.
    const indexById = new Map<string, number>();
    for (const entry of parsed.entries) {
      const entryId = requestIdOf(entry.message);
      if (entryId !== undefined) indexById.set(String(entryId), entry.index);
    }

    items.forEach((item, position) => {
      const itemId = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).id : undefined;
      const byId = itemId === undefined || itemId === null ? undefined : indexById.get(String(itemId));
      const target = byId ?? allowedIndexes[position];
      if (target !== undefined) slots.set(target, item);
    });
  }

  const responses = ordered();
  if (responses.length === 0) {
    res.status(202).end();
    return;
  }
  sendJsonRpc(res, 200, responses);
}

async function handleMcp(req: Request, res: Response, ctx: RequestContext): Promise<void> {
  const reqId = reqIdOf(res);

  const auth = authenticate(req, {
    tokenSecret: ctx.config.tokenSecret,
    devTokens: ctx.config.devTokens,
    now: ctx.now
  });
  if (!auth.ok) {
    ctx.audit.authFailure({ reqId, reason: auth.reason, path: req.path });
    sendJsonRpc(
      res,
      401,
      jsonRpcError({
        id: null,
        code: JsonRpcErrorCode.InvalidRequest,
        message: 'Invalid request',
        // One reason for every credential failure: a client-visible distinction between "malformed"
        // and "bad signature" is a small oracle, and the precise reason is in the audit log instead.
        // Header-shape problems are still named, because they describe the request, not the secret.
        data: { reason: clientVisibleAuthReason(auth.reason) }
      }),
      { 'www-authenticate': WWW_AUTHENTICATE }
    );
    return;
  }

  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  ctx.audit.request({ reqId, method: req.method, path: req.path, bytesIn: Buffer.byteLength(raw) });

  const parsed = parseJsonRpcBody(raw);
  if (parsed.kind === 'error') {
    ctx.audit.gatewayError({
      reqId,
      status: parsed.status,
      code: parsed.error.error.code,
      reason: 'invalid_envelope'
    });
    sendJsonRpc(res, parsed.status, parsed.error);
    return;
  }

  if (parsed.kind === 'single') {
    await handleSingle(req, res, ctx, auth.principal, parsed);
    return;
  }
  await handleBatch(req, res, ctx, auth.principal, parsed);
}

export interface RunningGateway {
  server: Server;
  /** The `/mcp` endpoint URL. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Build the Express app.
 *
 * `express.json()` is deliberately absent: the raw body is read once and kept as
 * text, which is what makes byte-identical forwarding and `-32700`-vs-`-32600`
 * discrimination possible.
 */
export function createApp(options: CreateAppOptions): Express {
  const { config } = options;
  const logger = options.logger ?? createLogger({ level: config.logLevel, base: { service: 'mcp-gateway' } });
  const audit = options.audit ?? createAuditLog(logger);
  const ctx: RequestContext = {
    config,
    logger,
    audit,
    policy: resolvePolicy(config, options.policy),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    now: options.now ?? (() => new Date())
  };

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const header = req.headers['x-request-id'];
    const reqId = typeof header === 'string' && header.trim() !== '' ? header.trim().slice(0, 64) : randomUUID();
    (res.locals as { reqId?: string }).reqId = reqId;
    res.setHeader('x-gateway-req-id', reqId);
    next();
  });

  // Bounded body read, before any decision: see the module doc for why.
  app.use(express.raw({ type: '*/*', limit: config.maxBodyBytes }));

  const insecureDefaults = insecureDefaultsIn(config);
  if (insecureDefaults.length > 0) {
    logger.warn('insecure_defaults_active', {
      defaults: insecureDefaults,
      detail: 'fine for a local demo, not for anything reachable: set GATEWAY_TOKEN_SECRET and GATEWAY_DEV_TOKENS'
    });
  }

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'mcp-gateway',
      // Visible, not just logged: a scanner should be able to see that a default credential is live.
      insecureDefaults: insecureDefaults.length > 0
    });
  });

  app.post('/mcp', (req, res, next) => {
    handleMcp(req, res, ctx).catch(next);
  });

  app.all('/mcp', (_req, res) => {
    res.setHeader('allow', 'POST');
    sendJsonRpc(res, 405, jsonRpcError({
      id: null,
      code: JsonRpcErrorCode.InvalidRequest,
      message: 'Invalid request',
      data: { reason: 'method_not_allowed', allow: 'POST' }
    }));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Express needs arity 4 to treat this as an error handler.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    void next;
    const reqId = reqIdOf(res);
    if (res.headersSent) {
      res.end();
      return;
    }
    const type = typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined;
    if (type === 'entity.too.large') {
      audit.gatewayError({ reqId, status: 413, code: JsonRpcErrorCode.InvalidRequest, reason: 'body_too_large' });
      sendJsonRpc(res, 413, jsonRpcError({
        id: null,
        code: JsonRpcErrorCode.InvalidRequest,
        message: 'Invalid request',
        data: { reason: 'body_too_large', limit: config.maxBodyBytes }
      }));
      return;
    }
    // Sanitized: no stack, no paths, no upstream detail ever reaches a client.
    logger.error('unhandled_error', { reqId, detail: sanitizeMessage(error) });
    audit.gatewayError({ reqId, status: 500, code: JsonRpcErrorCode.InternalError, reason: 'unhandled' });
    sendJsonRpc(res, 500, jsonRpcError({
      id: null,
      code: JsonRpcErrorCode.InternalError,
      message: 'Internal error',
      data: { reqId }
    }));
  });

  return app;
}

/** Boot the app on an ephemeral (or explicit) port — used by the tests and by `main()`. */
export async function startGateway(options: CreateAppOptions & { port?: number; host?: string }): Promise<RunningGateway> {
  const app = createApp(options);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

export async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger({ level: config.logLevel, base: { service: 'mcp-gateway' } });
  // `port: config.port` matters: without it the gateway would bind an ephemeral port
  // and silently ignore `GATEWAY_PORT`.
  const gateway = await startGateway({ config, logger, port: config.port });
  const downstream = new URL(config.downstreamUrl);
  // Host + path only: the gateway never puts an upstream URL on a client-visible surface.
  logger.info('server_listening', {
    url: gateway.url,
    port: gateway.port,
    downstreamHost: downstream.host,
    downstreamPath: downstream.pathname
  });

  const shutdown = (signal: string): void => {
    logger.info('shutdown', { signal });
    void gateway.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    // Boot diagnostics go to stderr: configuration failures must stay readable
    // (they are operator-facing, never client-facing).
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

