/**
 * Router configuration — environment-first and Zod-validated at boot.
 *
 * Everything that makes the router testable is injectable from here: the two
 * providers (with their own timeouts), the failover triggers, the window
 * geometry, the SQLite path and the token estimator's coefficients.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}

/** Minimal `.env` reader (no dependency). Existing process variables win. */
export function loadDotEnv(paths: string[] = [resolve(HERE, '../../.env'), resolve(process.cwd(), '.env')]): void {
  for (const file of paths) {
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

/** `429,500,timeout,network` → `[429, 500, 'timeout', 'network']` */
export function parseFailoverTriggers(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => (/^\d+$/.test(entry) ? Number(entry) : entry));
}

/**
 * `z.coerce.boolean()` is `Boolean(value)`, so the string `"false"` — exactly what `.env.example`
 * ships — would coerce to `true`. This accepts `1/true/yes/on`, treats everything else as false, and
 * keeps the default when the variable is unset or empty.
 */
function envBoolean(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });
}

/** `a,b,c` → `['a','b','c']`; empty/absent → `[]`. */
function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

const DEFAULT_FAILOVER_TRIGGERS = [429, 500, 502, 503, 504, 'timeout', 'network'] as const;

const failoverTriggerSchema = z.union([
  z.coerce.number().int().min(400).max(599),
  z.enum(['timeout', 'network', 'any'])
]);

export type FailoverTrigger = z.infer<typeof failoverTriggerSchema>;

/** http(s)-only URL: `new URL()` alone would happily accept `localhost:8080`. */
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'must be an http(s) URL' });

const providerSchema = z.object({
  name: z.string().min(1),
  baseUrl: httpUrl,
  model: z.string().min(1),
  /** Provider credential. Never logged, never echoed to a client. */
  apiKey: z.string().optional(),
  /** Per-attempt timeout. The brief's primary default is 3000 ms. */
  timeoutMs: z.coerce.number().int().positive()
});

export type ProviderConfig = z.infer<typeof providerSchema>;

const routerConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(8791),
  /** On-disk SQLite database. Parent directory is created on boot if missing. */
  dbPath: z.string().min(1).default('./data/router.db'),
  sqliteDriver: z.enum(['better', 'node']).default('better'),
  /** Sliding window geometry: 50 000 tokens per 60 s per tenant key by default. */
  windowMs: z.coerce.number().int().positive().default(60_000),
  limitTokens: z.coerce.number().int().positive().default(50_000),
  providers: z.object({ primary: providerSchema, secondary: providerSchema }),
  /** 1 = primary only; 2 = primary then one failover attempt. */
  maxAttempts: z.coerce.number().int().min(1).max(5).default(2),
  failoverOn: z.array(failoverTriggerSchema).min(1).default([...DEFAULT_FAILOVER_TRIGGERS]),
  /** Cheap admission-time token estimate, reconciled against provider `usage`. */
  estimation: z
    .object({
      charsPerToken: z.coerce.number().positive().default(4),
      messageOverheadTokens: z.coerce.number().int().min(0).default(4),
      toolOverheadTokens: z.coerce.number().int().min(0).default(100)
    })
    .prefault({}),
  /**
   * Output budget a request must reserve at admission, on top of the input estimate. A reservation
   * that ignored the completion would let a tenant spend 50 000 prompt tokens and produce unbounded
   * output inside one window. `maxOutputReserveTokens` caps what a client may claim with
   * `max_tokens`, so a single request cannot reserve the whole window (it is rejected as
   * `oversized` instead). Set both to `0` to reserve the input estimate only.
   */
  outputReserveTokens: z.coerce.number().int().min(0).default(1_024),
  maxOutputReserveTokens: z.coerce.number().int().min(0).default(16_384),
  /**
   * Idle deadline for a response *body*: how long a provider may stay silent mid-response before the
   * attempt is killed. This is deliberately separate from `timeoutMs`, which is the deadline for the
   * provider to start responding at all (the failover deadline). A healthy stream may run for
   * minutes; it may not go quiet.
   */
  streamIdleTimeoutMs: z.coerce.number().int().min(0).default(30_000),
  /**
   * Deadline for a response *body* to begin after the headers arrived. A model provider sends headers
   * as soon as it accepts the request and then spends seconds on prompt processing before the first
   * token, so this is deliberately separate from `streamIdleTimeoutMs`, which only starts on the first
   * chunk. `0` disables it.
   */
  streamFirstByteTimeoutMs: z.coerce.number().int().min(0).default(120_000),
  /**
   * Ask the provider for `stream_options.include_usage` on streamed requests, so streamed
   * completions are reconciled against real usage instead of the estimate. The usage frame is hidden
   * again if the client did not ask for it, so the client-visible contract is unchanged.
   */
  injectStreamUsage: envBoolean(true),
  /**
   * Tenant allow-list. Empty (the default) auto-provisions a tenant for any bearer string; when set,
   * an unlisted key is rejected with 401 and creates no row.
   */
  tenantKeys: z.array(z.string().min(1)).default([]),
  logLevel: z.enum(LOG_LEVELS).default('info')
});

export type RouterConfig = z.infer<typeof routerConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const parsed = routerConfigSchema.safeParse({
    port: env.ROUTER_PORT,
    dbPath: env.ROUTER_DB_PATH,
    sqliteDriver: env.ROUTER_SQLITE_DRIVER,
    windowMs: env.ROUTER_WINDOW_MS,
    limitTokens: env.ROUTER_LIMIT_TOKENS,
    providers: {
      primary: {
        name: env.ROUTER_PRIMARY_NAME ?? 'primary',
        baseUrl: env.ROUTER_PRIMARY_BASE_URL ?? 'http://127.0.0.1:8080/v1',
        model: env.ROUTER_PRIMARY_MODEL ?? 'qwen3.8-turbo',
        apiKey: env.ROUTER_PRIMARY_API_KEY,
        timeoutMs: env.ROUTER_PRIMARY_TIMEOUT_MS ?? 3_000
      },
      secondary: {
        name: env.ROUTER_SECONDARY_NAME ?? 'secondary',
        baseUrl: env.ROUTER_SECONDARY_BASE_URL ?? 'http://127.0.0.1:8080/v1',
        model: env.ROUTER_SECONDARY_MODEL ?? 'qwen3.8-turbo',
        apiKey: env.ROUTER_SECONDARY_API_KEY,
        timeoutMs: env.ROUTER_SECONDARY_TIMEOUT_MS ?? 10_000
      }
    },
    maxAttempts: env.ROUTER_MAX_ATTEMPTS,
    failoverOn: parseFailoverTriggers(env.ROUTER_FAILOVER_ON),
    estimation: {
      charsPerToken: env.ROUTER_CHARS_PER_TOKEN,
      messageOverheadTokens: env.ROUTER_MESSAGE_OVERHEAD_TOKENS,
      toolOverheadTokens: env.ROUTER_TOOL_OVERHEAD_TOKENS
    },
    outputReserveTokens: env.ROUTER_OUTPUT_RESERVE_TOKENS,
    maxOutputReserveTokens: env.ROUTER_MAX_OUTPUT_RESERVE_TOKENS,
    streamIdleTimeoutMs: env.ROUTER_STREAM_IDLE_TIMEOUT_MS,
    streamFirstByteTimeoutMs: env.ROUTER_STREAM_FIRST_BYTE_TIMEOUT_MS,
    injectStreamUsage: env.ROUTER_INJECT_STREAM_USAGE,
    tenantKeys: parseList(env.ROUTER_TENANT_KEYS),
    logLevel: env.ROUTER_LOG_LEVEL
  });

  if (!parsed.success) {
    throw new Error(`Invalid router configuration:\n${formatIssues(parsed.error)}`);
  }

  return parsed.data;
}

let cached: RouterConfig | undefined;

export function getConfig(): RouterConfig {
  if (cached === undefined) {
    loadDotEnv();
    cached = loadConfig();
  }
  return cached;
}
