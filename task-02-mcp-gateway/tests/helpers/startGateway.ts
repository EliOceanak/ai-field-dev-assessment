/**
 * Test helper: boot the real gateway app on an ephemeral port with an injected
 * config, logger and (optionally) an injected `fetch`/clock.
 *
 * Nothing is stubbed out: the suite drives the production Express pipeline over
 * real HTTP, and asserts against the mock downstream's call recorder.
 */
import { Writable } from 'node:stream';
import { loadConfig } from '../../src/config.js';
import type { GatewayConfig } from '../../src/config.js';
import { createLogger } from '../../src/logging/logger.js';
import { startGateway } from '../../src/server.js';
import type { RunningGateway } from '../../src/server.js';
import { FIXED_NOW } from './tokens.js';

export interface StartGatewayOptions {
  /** Extra config on top of `loadConfig({})`. */
  config?: Partial<GatewayConfig>;
  fetchImpl?: typeof fetch;
  /**
   * Injected clock. Defaults to `FIXED_NOW` so that tokens minted by
   * `tests/helpers/tokens.ts` are valid regardless of the wall clock — an
   * expiry assertion must not depend on when the suite is run.
   */
  now?: () => Date;
}

export interface TestGateway extends RunningGateway {
  config: GatewayConfig;
  /** Raw stderr lines written by the gateway's logger. */
  logLines: string[];
  /** Parsed stderr log objects. */
  logs(): Record<string, unknown>[];
  /** Log objects for one event name. */
  logsFor(event: string): Record<string, unknown>[];
  resetLogs(): void;
}

export async function startTestGateway(options: StartGatewayOptions = {}): Promise<TestGateway> {
  const config: GatewayConfig = { ...loadConfig({}), ...options.config };
  const logLines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      logLines.push(String(chunk));
      callback();
    }
  });
  const logger = createLogger({ level: 'debug', stream, base: { service: 'mcp-gateway' } });

  const gateway = await startGateway({
    config,
    logger,
    now: options.now ?? (() => FIXED_NOW),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

  const parse = (): Record<string, unknown>[] =>
    logLines
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    ...gateway,
    config,
    logLines,
    logs: parse,
    logsFor: (event) => parse().filter((line) => line.event === event),
    resetLogs: () => {
      logLines.length = 0;
    }
  };
}

export interface McpResponse {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export interface PostOptions {
  /** Raw `Authorization` header value (use to exercise malformed headers). */
  authorization?: string;
  /** Convenience: sends `Bearer <token>`. */
  token?: string;
  headers?: Record<string, string>;
  /** Override the target URL (e.g. `/health`). */
  url?: string;
}

/** POST a body to the gateway and return the raw response. */
export async function postMcp(
  gateway: RunningGateway,
  body: string,
  options: PostOptions = {}
): Promise<McpResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.authorization !== undefined) headers.authorization = options.authorization;

  const response = await fetch(options.url ?? gateway.url, { method: 'POST', headers, body });
  const text = await response.text();
  let json: unknown;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}
