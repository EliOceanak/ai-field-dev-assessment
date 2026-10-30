/**
 * Boots the real gateway (real `node:http`, real SQLite file, real `fetch`) on an ephemeral port
 * with two scripted providers. Tests then talk to it over HTTP exactly as a client would.
 *
 * Configuration goes through `loadConfig(env)`, so every test exercises the same code path the
 * process uses at boot — including the 3000 ms primary-timeout default, which tests that need speed
 * override explicitly.
 */
import { loadConfig, type LogLevel } from '../../src/config.js';
import { createLogger, captureLogLines, type Logger } from '../../src/logging/logger.js';
import { createGateway, type Gateway } from '../../src/server.js';
import { openDatabase, type Db, type SqliteDriver } from '../../src/db/database.js';
import { applyMigrations } from '../../src/db/migrations.js';
import { createMetrics, type Metrics } from '../../src/metrics/metrics.js';

export interface HarnessOptions {
  primaryUrl: string;
  secondaryUrl?: string;
  /** On-disk database path (from `createTestDb()`); required unless `db` is given. */
  dbPath?: string;
  db?: Db;
  driver?: SqliteDriver;
  /** Extra `ROUTER_*` overrides, applied last. */
  env?: Record<string, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logLevel?: LogLevel;
  /** Capture the stderr log lines so a test can assert on them. */
  captureLogs?: boolean;
  metrics?: Metrics;
  maxRequestBodyBytes?: number;
}

export interface Harness {
  gateway: Gateway;
  url: string;
  db: Db;
  metrics: Metrics;
  logger: Logger;
  /** Present when `captureLogs` is set. */
  logLines(): Record<string, unknown>[];
  close(): Promise<void>;
}

export const TEST_TENANT_KEY = 'tenant-key-alpha';
export const OTHER_TENANT_KEY = 'tenant-key-beta';

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const env: Record<string, string> = {
    ROUTER_LOG_LEVEL: options.logLevel ?? 'silent',
    // The output reserve is off by default in tests so a crafted body estimates to exactly the number
    // of tokens a test names. The reserve has its own dedicated tests, which set it explicitly.
    ROUTER_OUTPUT_RESERVE_TOKENS: '0',
    ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '0',
    ROUTER_PRIMARY_BASE_URL: options.primaryUrl,
    ROUTER_SECONDARY_BASE_URL: options.secondaryUrl ?? options.primaryUrl,
    ROUTER_DB_PATH: options.dbPath ?? './data/harness.db',
    ...(options.driver !== undefined ? { ROUTER_SQLITE_DRIVER: options.driver } : {}),
    ...options.env
  };
  const config = loadConfig(env);

  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase({ path: config.dbPath, driver: config.sqliteDriver });
  if (ownsDb) applyMigrations(db);

  const capture = options.captureLogs === true ? captureLogLines() : undefined;
  // A capturing harness must actually log; an uncaptured one stays silent so the suite is quiet.
  const level = options.logLevel ?? (capture !== undefined ? 'debug' : 'silent');
  const logger = createLogger({
    level,
    ...(capture !== undefined ? { stream: capture.stream } : {}),
    base: { service: 'router-fallback' }
  });
  const metrics = options.metrics ?? createMetrics();

  const gateway = createGateway({
    config,
    db,
    logger,
    metrics,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: options.maxRequestBodyBytes } : {})
  });

  const port = await gateway.listen(0);
  const url = `http://127.0.0.1:${port}`;

  return {
    gateway,
    url,
    db,
    metrics,
    logger,
    logLines: () =>
      (capture?.lines() ?? []).map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { raw: line };
        }
      }),
    async close() {
      await gateway.close();
      if (ownsDb) db.close();
    }
  };
}

export interface PostOptions {
  /** Tenant key. Absent → the default test key; explicitly `undefined` → no auth header at all. */
  key?: string | undefined;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function postCompletion(baseUrl: string, body: unknown, options: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
  const key = 'key' in options ? options.key : TEST_TENANT_KEY;
  if (key !== undefined) headers.authorization = `Bearer ${key}`;
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  });
}

/** A request body whose estimate is exactly `tokens` (charsPerToken 4, one message, overhead 4). */
export function bodyWithEstimatedTokens(tokens: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // estimate = 4 (message overhead) + 1 ("user" is 4 chars → ceil(4/4)) + ceil(chars/4)
  const contentChars = (tokens - 5) * 4;
  return { model: 'client-requested-model', messages: [{ role: 'user', content: 'a'.repeat(contentChars) }], ...extra };
}

export function simpleBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'client-requested-model', messages: [{ role: 'user', content: 'hello there' }], ...extra };
}
