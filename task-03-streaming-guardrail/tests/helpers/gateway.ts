/** Test harness: a gateway bound to an ephemeral port with a silent logger. */
import { loadConfig, type GuardrailConfig } from '../../src/config.js';
import { createLogger } from '../../src/logging/logger.js';
import { createGateway, type Gateway } from '../../src/server.js';

export interface TestGatewayOptions {
  upstreamBaseUrl: string;
  upstreamTimeoutMs?: number;
  maxHoldbackBytes?: number;
  typedPlaceholders?: boolean;
  customPatterns?: GuardrailConfig['redaction']['customPatterns'];
  maxRequestBodyBytes?: number;
  maxNonStreamingBytes?: number;
}

export interface TestGateway extends Gateway {
  config: GuardrailConfig;
  stop(): Promise<void>;
}

export async function startGateway(options: TestGatewayOptions): Promise<TestGateway> {
  const config = loadConfig({
    GUARDRAIL_UPSTREAM_BASE_URL: options.upstreamBaseUrl,
    GUARDRAIL_UPSTREAM_TIMEOUT_MS: String(options.upstreamTimeoutMs ?? 5_000),
    GUARDRAIL_MAX_HOLDBACK_BYTES: String(options.maxHoldbackBytes ?? 512),
    GUARDRAIL_TYPED_PLACEHOLDERS: options.typedPlaceholders === true ? 'true' : 'false',
    ...(options.customPatterns !== undefined
      ? { GUARDRAIL_CUSTOM_PATTERNS: JSON.stringify(options.customPatterns) }
      : {})
  });

  const gateway = createGateway({
    config,
    logger: createLogger({ level: 'silent' }),
    ...(options.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: options.maxRequestBodyBytes } : {}),
    ...(options.maxNonStreamingBytes !== undefined ? { maxNonStreamingBytes: options.maxNonStreamingBytes } : {})
  });
  await gateway.listen(0);

  return {
    ...gateway,
    config,
    stop: async () => {
      // Undici keeps connections alive for 4 s; drop them so teardown is immediate.
      gateway.server.closeAllConnections();
      await gateway.close();
    }
  };
}

/** Reads a whole SSE response into the frames the client actually saw. */
export async function readSseFrames(response: Response): Promise<{ frames: string[]; raw: string }> {
  const raw = await response.text();
  const frames = raw.split('\n\n').filter((frame) => frame.trim() !== '');
  return { frames, raw };
}

/** Concatenates the `content` deltas of a chunked SSE transcript. */
export function concatenateContent(frames: readonly string[]): string {
  let out = '';
  for (const frame of frames) {
    const payload = frame.split('\n').find((line) => line.startsWith('data: '));
    if (payload === undefined) continue;
    const data = payload.slice(6);
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      for (const choice of parsed.choices ?? []) out += choice.delta?.content ?? '';
    } catch {
      /* ignore malformed frames — asserted separately */
    }
  }
  return out;
}

/** Concatenates a named string field (e.g. `reasoning_content`) of a chunked SSE transcript. */
export function concatenateField(frames: readonly string[], field: string): string {
  let out = '';
  for (const frame of frames) {
    const payload = frame.split('\n').find((line) => line.startsWith('data: '));
    if (payload === undefined) continue;
    const data = payload.slice(6);
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: Record<string, unknown> }> };
      for (const choice of parsed.choices ?? []) {
        const value = choice.delta?.[field];
        if (typeof value === 'string') out += value;
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Concatenates streamed tool-call arguments of a chunked SSE transcript. */
export function concatenateToolArguments(frames: readonly string[]): string {
  let out = '';
  for (const frame of frames) {
    const payload = frame.split('\n').find((line) => line.startsWith('data: '));
    if (payload === undefined) continue;
    const data = payload.slice(6);
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
      };
      for (const choice of parsed.choices ?? []) {
        for (const toolCall of choice.delta?.tool_calls ?? []) out += toolCall.function?.arguments ?? '';
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}
