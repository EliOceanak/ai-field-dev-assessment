/**
 * Configuration for the MCP server.
 *
 * Environment-first, Zod-validated, and loaded lazily so unit tests can call
 * `loadConfig()` with an explicit environment object. `getConfig()` also loads a
 * repo-root `.env` (see `loadDotEnv`) without adding a dependency.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Render Zod issues as a readable, indented block (stable across Zod majors). */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Minimal `.env` reader: `KEY=value` lines, `#` comments, optional surrounding
 * quotes. Existing process variables always win, so `FOO=bar npm test` works.
 */
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

const serverConfigSchema = z.object({
  /** `serverInfo.name` reported during `initialize`. */
  serverName: z.string().min(1).default('customer-ops-mcp'),
  /** `serverInfo.version` reported during `initialize`. */
  serverVersion: z.string().min(1).default('1.0.0'),
  /** Verbosity of the stderr logger. `silent` disables logging entirely. */
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /** Optional JSON file that replaces the built-in customer seed data. */
  seedDataPath: z.string().min(1).optional()
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = serverConfigSchema.safeParse({
    serverName: env.MCP_SERVER_NAME,
    serverVersion: env.MCP_SERVER_VERSION,
    logLevel: env.MCP_LOG_LEVEL,
    seedDataPath: env.MCP_SEED_DATA_PATH
  });

  if (!parsed.success) {
    throw new Error(`Invalid MCP server configuration:\n${formatIssues(parsed.error)}`);
  }

  return parsed.data;
}

let cached: ServerConfig | undefined;

/** Process-wide configuration; loads `.env` once on first use. */
export function getConfig(): ServerConfig {
  if (cached === undefined) {
    loadDotEnv();
    cached = loadConfig();
  }
  return cached;
}
