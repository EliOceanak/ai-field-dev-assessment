/**
 * Gateway configuration — environment-first and Zod-validated at boot.
 *
 * `loadConfig()` is pure (it takes an environment object) so unit tests can
 * assert every default and every failure mode without touching the real env.
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

/** `admin:admin-dev-token,viewer:viewer-dev-token` → `{ admin: 'admin-dev-token', … }` */
function parseDevTokens(raw: string | undefined): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [role, token] = pair.split(':');
    if (role !== undefined && token !== undefined && role.trim() !== '' && token.trim() !== '') {
      tokens[role.trim()] = token.trim();
    }
  }
  return tokens;
}

/**
 * Env boolean that actually understands `"false"`.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, so the string `"false"` — exactly what `.env.example`
 * ships — coerces to **true**: `GATEWAY_FILTER_TOOL_LIST=false` would silently enable hardened mode.
 * This accepts `1/true/yes/on` (case-insensitive), everything else as false, and keeps the default
 * for an unset/empty value. (Same helper as Task 3.)
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

/** http(s)-only URL: `new URL()` alone would happily accept `localhost:8080`. */
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'must be an http(s) URL' });

const gatewayConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(8787),
  downstreamUrl: httpUrl.default('http://127.0.0.1:8788/mcp'),
  /** HMAC secret for signed bearer tokens (see scripts/mint-token.mjs). */
  tokenSecret: z.string().min(8).default('dev-secret-change-me'),
  /** Static dev tokens by role, accepted in addition to signed tokens. */
  devTokens: z.record(z.string(), z.string()).default({ admin: 'admin-dev-token', viewer: 'viewer-dev-token' }),
  upstreamTimeoutMs: z.coerce.number().int().positive().default(10_000),
  /** Hardened mode: strip `admin_*` from tools/list for non-admin roles. */
  filterToolList: envBoolean(false),
  /** Forward the caller's Authorization header downstream (default: strip). */
  forwardClientAuth: envBoolean(false),
  /** Optional credential injected when calling the downstream server. */
  downstreamToken: z.string().min(1).optional(),
  /** Tool-name prefixes that require the admin role. */
  privilegedPrefixes: z.array(z.string().min(1)).default(['admin_']),
  /** Upper bound on an accepted JSON-RPC request body; anything larger is rejected with 413. */
  maxBodyBytes: z.coerce.number().int().positive().default(1_048_576),
  /** Optional file-driven policy rules (allow/deny globs, privileged prefixes). */
  policyFile: z.string().min(1).optional(),
  logLevel: z.enum(LOG_LEVELS).default('info')
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = gatewayConfigSchema.safeParse({
    port: env.GATEWAY_PORT,
    downstreamUrl: env.GATEWAY_DOWNSTREAM_URL,
    tokenSecret: env.GATEWAY_TOKEN_SECRET,
    devTokens: env.GATEWAY_DEV_TOKENS === undefined ? undefined : parseDevTokens(env.GATEWAY_DEV_TOKENS),
    upstreamTimeoutMs: env.GATEWAY_UPSTREAM_TIMEOUT_MS,
    filterToolList: env.GATEWAY_FILTER_TOOL_LIST,
    forwardClientAuth: env.GATEWAY_FORWARD_CLIENT_AUTH,
    downstreamToken: env.GATEWAY_DOWNSTREAM_TOKEN,
    maxBodyBytes: env.GATEWAY_MAX_BODY_BYTES,
    policyFile: env.GATEWAY_POLICY_FILE,
    logLevel: env.GATEWAY_LOG_LEVEL
  });

  if (!parsed.success) {
    throw new Error(`Invalid MCP gateway configuration:\n${formatIssues(parsed.error)}`);
  }

  return parsed.data;
}

let cached: GatewayConfig | undefined;

export function getConfig(): GatewayConfig {
  if (cached === undefined) {
    loadDotEnv();
    cached = loadConfig();
  }
  return cached;
}
