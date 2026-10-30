/**
 * Guardrail configuration — environment-first and Zod-validated at boot.
 *
 * The redaction settings live here (not in code) so a deployment can add a
 * tenant-specific pattern such as an employee-id format without a rebuild:
 *
 *   GUARDRAIL_CUSTOM_PATTERNS='[{"name":"employee_id","pattern":"EMP-\\d{6}"}]'
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

const customPatternSchema = z.object({
  /** Label used by typed placeholders (`[REDACTED:EMAIL]`) and by the stats counters. */
  name: z.string().min(1),
  /** JavaScript regular expression source. Compiled and validated below. */
  pattern: z.string().min(1),
  /** Optional flags; defaults to `g`. */
  flags: z.string().optional()
});

export type CustomPattern = z.infer<typeof customPatternSchema>;

/** Accepts either a JSON string or an already-parsed array (tests). */
function parseCustomPatterns(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return raw;
  return JSON.parse(raw) as unknown;
}

/** http(s)-only URL: `new URL()` alone would happily accept `localhost:8080`. */
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'must be an http(s) URL' });

/**
 * Env boolean that actually understands `"false"`.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, so the string `"false"` (exactly what `.env.example`
 * ships) coerces to **true** — a deployment that writes `GUARDRAIL_TYPED_PLACEHOLDERS=false` would
 * silently get `[REDACTED:EMAIL]` placeholders. This accepts `1/true/yes/on` (case-insensitive),
 * everything else as false, and keeps the default for an unset/empty value.
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

const guardrailConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(8790),
  /** Any OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1 (llama.cpp). */
  upstreamBaseUrl: httpUrl.default('http://127.0.0.1:8080/v1'),
  upstreamApiKey: z.string().optional(),
  upstreamTimeoutMs: z.coerce.number().int().positive().default(120_000),
  redaction: z
    .object({
      /** Literal replacement text. The brief specifies `[REDACTED]`. */
      replacement: z.string().min(1).default('[REDACTED]'),
      /** `[REDACTED:EMAIL]` instead of `[REDACTED]`. */
      typedPlaceholders: envBoolean(false),
      /** Extra patterns (tenant-specific ids, internal hostnames, …). */
      customPatterns: z
        .array(customPatternSchema)
        .default([])
        .superRefine((patterns, ctx) => {
          patterns.forEach((custom, index) => {
            try {
              void new RegExp(custom.pattern, custom.flags ?? 'g');
            } catch (error) {
              ctx.addIssue({
                code: 'custom',
                path: [index, 'pattern'],
                message: `not a valid regular expression: ${(error as Error).message}`
              });
            }
          });
        })
    })
    .prefault({}),
  /** Upper bound for the retained tail buffer; guards against pathological deltas. */
  maxHoldbackBytes: z.coerce.number().int().positive().default(512),
  logLevel: z.enum(LOG_LEVELS).default('info')
});

export type GuardrailConfig = z.infer<typeof guardrailConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GuardrailConfig {
  const parsed = guardrailConfigSchema.safeParse({
    port: env.GUARDRAIL_PORT,
    upstreamBaseUrl: env.GUARDRAIL_UPSTREAM_BASE_URL,
    upstreamApiKey: env.GUARDRAIL_UPSTREAM_API_KEY,
    upstreamTimeoutMs: env.GUARDRAIL_UPSTREAM_TIMEOUT_MS,
    redaction: {
      replacement: env.GUARDRAIL_REDACTION_REPLACEMENT,
      typedPlaceholders: env.GUARDRAIL_TYPED_PLACEHOLDERS,
      customPatterns: parseCustomPatterns(env.GUARDRAIL_CUSTOM_PATTERNS)
    },
    maxHoldbackBytes: env.GUARDRAIL_MAX_HOLDBACK_BYTES,
    logLevel: env.GUARDRAIL_LOG_LEVEL
  });

  if (!parsed.success) {
    throw new Error(`Invalid guardrail configuration:\n${formatIssues(parsed.error)}`);
  }

  return parsed.data;
}

let cached: GuardrailConfig | undefined;

export function getConfig(): GuardrailConfig {
  if (cached === undefined) {
    loadDotEnv();
    cached = loadConfig();
  }
  return cached;
}
