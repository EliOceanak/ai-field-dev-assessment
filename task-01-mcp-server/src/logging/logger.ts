/**
 * stderr-only structured logger.
 *
 * The stdio transport owns stdout: a single stray `console.log` corrupts the
 * JSON-RPC framing and the client drops the connection. Every diagnostic in this
 * package therefore goes through this logger, which writes one JSON object per
 * line to **stderr**. `scripts/check-stdout-hygiene.mjs` enforces the rule
 * statically and `tests/wire/stdout-isolation.test.ts` enforces it on the wire.
 */
import type { LogLevel } from '../config.js';

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY
};

export interface LoggerOptions {
  /** Minimum severity to emit. `silent` disables all output. */
  level?: LogLevel;
  /** Destination stream; defaults to stderr. Injectable for tests. */
  stream?: NodeJS.WritableStream;
  /** Fields merged into every line (e.g. `{ server: 'customer-ops-mcp' }`). */
  base?: Record<string, unknown>;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
}

export interface Logger {
  readonly level: LogLevel;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>, cause?: unknown): void;
  /** Derive a logger with extra bound fields (e.g. a per-request id). */
  child(bindings: Record<string, unknown>): Logger;
}

/** Errors are serialized explicitly — `JSON.stringify(new Error())` yields `{}`. */
function serializeCause(cause: unknown): Record<string, unknown> | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack };
  }
  return { value: String(cause) };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? (() => new Date());
  const threshold = SEVERITY[level];

  const emit = (severity: LogLevel, event: string, fields: Record<string, unknown> = {}, cause?: unknown): void => {
    if (SEVERITY[severity] < threshold) return;
    const line: Record<string, unknown> = {
      ts: now().toISOString(),
      level: severity,
      event,
      ...options.base,
      ...fields
    };
    const serialized = serializeCause(cause);
    if (serialized !== undefined) line.cause = serialized;
    stream.write(`${JSON.stringify(line)}\n`);
  };

  const logger: Logger = {
    level,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields, cause) => emit('error', event, fields, cause),
    child: (bindings) =>
      createLogger({ ...options, level, stream, now, base: { ...options.base, ...bindings } })
  };

  return logger;
}
