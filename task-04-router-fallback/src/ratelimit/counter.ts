/**
 * Admission-time token estimator.
 *
 * The limiter has to decide *before* the provider answers, so it reserves an estimate and
 * reconciles against the provider's `usage` afterwards (see `tokenWindow.reconcile`). This module
 * is the estimate.
 *
 * The rule is deliberately arithmetic and boring, because the exact-admission test needs a body
 * whose estimate is a round number:
 *
 * ```
 *   tokens = Σ_messages ( messageOverheadTokens + ceil(chars(content) / charsPerToken) )
 *          + Σ_tools     ( toolOverheadTokens    + ceil(chars(JSON(tool)) / charsPerToken) )
 *          + ceil(chars(prompt|input|system) / charsPerToken)
 * ```
 *
 * `chars/4` is the standard English approximation and matches the configured default
 * (`ROUTER_CHARS_PER_TOKEN=4`). It is not a tokenizer: future work replaces this behind the same function
 * signature with a real one (`TokenCounter`), and the reservation/reconcile dance makes the switch
 * free — only the *reservation* size changes, never the accounting correctness.
 */
import type { RouterConfig } from '../config.js';

export interface EstimationConfig {
  charsPerToken: number;
  messageOverheadTokens: number;
  toolOverheadTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text of an OpenAI `content` field: a string, or an array of typed parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') text += part.text;
    // A part with neither text nor a known shape is counted through its JSON so that a large
    // `image_url` payload cannot slip through for free.
    else text += JSON.stringify(part);
  }
  return text;
}

/**
 * How much a request must reserve at admission: the input estimate **plus an output budget**.
 *
 * The brief's window is a budget for the whole exchange, so a reservation that only covered the prompt
 * would let one request spend the entire window on input and then stream unbounded output. The output
 * part is the client's own declaration (`max_tokens`) when it makes one, capped by
 * `maxOutputReserveTokens` so a client cannot reserve the whole window and starve itself; when the
 * client does not declare one (OpenAI clients omit it, llama.cpp sends `-1`), a configured default is
 * used. `outputReserveTokens: 0` restores input-only reservations.
 */
export function outputReserveTokens(body: unknown, config: Pick<RouterConfig, 'outputReserveTokens' | 'maxOutputReserveTokens'>): number {
  const max = Math.max(0, Math.floor(config.maxOutputReserveTokens));
  const fallback = Math.max(0, Math.floor(config.outputReserveTokens));
  if (!isRecord(body)) return Math.min(fallback, max);

  const declared = body.max_tokens ?? body.max_completion_tokens;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return Math.min(fallback, max);
  return Math.min(Math.floor(declared), max);
}

export function reservationTokens(
  body: unknown,
  config: Pick<RouterConfig, 'estimation' | 'outputReserveTokens' | 'maxOutputReserveTokens'>
): number {
  return estimateTokens(body, config) + outputReserveTokens(body, config);
}

export function estimateTokens(body: unknown, config: Pick<RouterConfig, 'estimation'>): number {
  const { charsPerToken, messageOverheadTokens, toolOverheadTokens } = config.estimation;
  if (!isRecord(body)) return 0;

  const chars = (value: unknown): number => {
    if (typeof value !== 'string' || value === '') return 0;
    return Math.ceil(value.length / charsPerToken);
  };

  let tokens = 0;

  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      tokens += messageOverheadTokens;
      tokens += chars(contentText(message.content));
      if (typeof message.name === 'string') tokens += chars(message.name);
      if (typeof message.role === 'string') tokens += chars(message.role);
    }
  }

  for (const key of ['prompt', 'input', 'system', 'instructions'] as const) {
    const value = body[key];
    if (typeof value === 'string') tokens += chars(value);
    else if (Array.isArray(value)) tokens += chars(contentText(value));
  }

  for (const key of ['tools', 'functions'] as const) {
    const definitions = body[key];
    if (!Array.isArray(definitions)) continue;
    for (const definition of definitions) {
      tokens += toolOverheadTokens;
      tokens += chars(JSON.stringify(definition));
    }
  }

  if (body.response_format !== undefined) tokens += chars(JSON.stringify(body.response_format));

  return tokens;
}

