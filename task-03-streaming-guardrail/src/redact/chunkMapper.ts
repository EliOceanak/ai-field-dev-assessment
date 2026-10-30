/**
 * Chunk mapper — decides *which* strings inside an OpenAI-compatible chunk are redacted.
 *
 * Measured on the reference server (see `docs/LOCAL-LLM.md`): llama.cpp
 * streams reasoning in a **separate** `delta.reasoning_content` field, and tool calls arrive as
 * `delta.tool_calls[].function.arguments` (a JSON *string*, streamed in pieces). A guardrail that
 * only rewrites `delta.content` leaks PII, so all three are redacted:
 *
 * | Field | Action |
 * | --- | --- |
 * | `choices[].delta.content` | redact |
 * | `choices[].delta.reasoning_content` / `.reasoning` | redact (the measured leak) |
 * | `choices[].delta.tool_calls[].function.arguments` | redact |
 * | `role`, `id`, `model`, `created`, `usage`, `timings`, `finish_reason`, `index` | untouched |
 * | unparseable `data:` payload | passed through untouched, counted as `unparsed_events` |
 *
 * Redactor state is keyed by `choices[].index` (and by tool-call index inside a choice), so a
 * multi-choice stream cannot mix buffers. Each choice's redactors are flushed when that choice
 * reports a `finish_reason`, and everything left is flushed on `[DONE]`.
 */
import type { Pattern } from './patterns.js';
import type { RedactionCounts, RedactOptions, Redactor } from './streamingRedactor.js';
import { createStreamingRedactor } from './streamingRedactor.js';

/** String fields inside `delta` (and `message`) that carry model output. */
export const TEXT_FIELDS = ['content', 'reasoning_content', 'reasoning'] as const;

export interface ChunkMapperOptions extends RedactOptions {
  maxHoldbackBytes?: number;
  onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

export interface MappedChunk {
  chunk: unknown;
  redactions: number;
  byType: RedactionCounts;
  /** `data:` payload was not a JSON object (or had no `choices`) — forwarded unchanged. */
  passthrough: boolean;
}

export interface ChunkMapperStats {
  maxBufferSeen: number;
  buffered: number;
  choices: number;
  redactionsByType: RedactionCounts;
}

export interface ChunkMapper {
  map(chunk: unknown): MappedChunk;
  /** Synthetic chunks carrying tails still held when `[DONE]` arrives (usually empty). */
  flushPending(): Array<Record<string, unknown>>;
  stats(): ChunkMapperStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ChoiceState {
  fields: Map<string, Redactor>;
  toolCalls: Map<number, Redactor>;
}

function appendToolCallTail(target: Record<string, unknown>, toolIndex: number, tail: string): void {
  if (!Array.isArray(target.tool_calls)) target.tool_calls = [];
  const toolCalls = target.tool_calls as unknown[];
  let entry: Record<string, unknown> | undefined;
  for (const candidate of toolCalls) {
    if (isRecord(candidate) && candidate.index === toolIndex) {
      entry = candidate;
      break;
    }
  }
  if (entry === undefined) {
    entry = { index: toolIndex, type: 'function', function: { arguments: '' } };
    toolCalls.push(entry);
  }
  const existing = entry.function;
  const fn: Record<string, unknown> = isRecord(existing) ? existing : {};
  if (!isRecord(existing)) entry.function = fn;
  fn.arguments = (typeof fn.arguments === 'string' ? fn.arguments : '') + tail;
}

export function createChunkMapper(options: ChunkMapperOptions): ChunkMapper {
  const states = new Map<number, ChoiceState>();
  const meta: Record<string, unknown> = {};
  const byType: RedactionCounts = {};
  let redactions = 0;

  const newRedactor = (): Redactor =>
    createStreamingRedactor({
      patterns: options.patterns,
      replacement: options.replacement,
      typedPlaceholders: options.typedPlaceholders,
      maxHoldbackBytes: options.maxHoldbackBytes ?? 512,
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {})
    });

  const stateFor = (index: number): ChoiceState => {
    let state = states.get(index);
    if (state === undefined) {
      state = { fields: new Map(), toolCalls: new Map() };
      states.set(index, state);
    }
    return state;
  };

  const fieldRedactor = (state: ChoiceState, field: string): Redactor => {
    let redactor = state.fields.get(field);
    if (redactor === undefined) {
      redactor = newRedactor();
      state.fields.set(field, redactor);
    }
    return redactor;
  };

  const toolCallRedactor = (state: ChoiceState, toolIndex: number): Redactor => {
    let redactor = state.toolCalls.get(toolIndex);
    if (redactor === undefined) {
      redactor = newRedactor();
      state.toolCalls.set(toolIndex, redactor);
    }
    return redactor;
  };

  /**
   * A redactor reports *cumulative* counts, so every call is diffed against the previous snapshot
   * to produce a per-call delta. That delta is what the caller accumulates for `/stats` — without
   * it the gateway would multiply-count every redaction on each subsequent chunk.
   */
  const seenByRedactor = new Map<Redactor, RedactionCounts>();

  const diff = (redactor: Redactor): void => {
    const previous = seenByRedactor.get(redactor) ?? {};
    const current = redactor.stats().redactionsByType;
    for (const [type, count] of Object.entries(current)) {
      const increase = count - (previous[type] ?? 0);
      if (increase > 0) {
        byType[type] = (byType[type] ?? 0) + increase;
        redactions += increase;
      }
    }
    seenByRedactor.set(redactor, { ...current });
  };

  const redactToolCalls = (
    container: Record<string, unknown>,
    state: ChoiceState,
    mode: 'stream' | 'complete'
  ): void => {
    const toolCalls = container.tool_calls;
    if (!Array.isArray(toolCalls)) return;
    for (const [position, toolCall] of (toolCalls as unknown[]).entries()) {
      if (!isRecord(toolCall)) continue;
      const fn = toolCall.function;
      if (!isRecord(fn) || typeof fn.arguments !== 'string') continue;
      const toolIndex = typeof toolCall.index === 'number' ? toolCall.index : position;
      const redactor = toolCallRedactor(state, toolIndex);
      const out = redactor.push(fn.arguments);
      diff(redactor);
      fn.arguments = mode === 'complete' ? out + redactor.flush() : out;
      if (mode === 'complete') diff(redactor);
    }
  };

  const redactTextFields = (
    container: Record<string, unknown>,
    state: ChoiceState,
    mode: 'stream' | 'complete'
  ): void => {
    for (const field of TEXT_FIELDS) {
      if (typeof container[field] !== 'string') continue;
      const redactor = fieldRedactor(state, field);
      const out = redactor.push(container[field] as string);
      diff(redactor);
      container[field] = mode === 'complete' ? out + redactor.flush() : out;
      if (mode === 'complete') diff(redactor);
    }
  };

  const flushInto = (target: Record<string, unknown>, state: ChoiceState): void => {
    for (const [field, redactor] of state.fields) {
      const tail = redactor.flush();
      diff(redactor);
      if (tail === '') continue;
      target[field] = (typeof target[field] === 'string' ? target[field] : '') + tail;
    }
    for (const [toolIndex, redactor] of state.toolCalls) {
      const tail = redactor.flush();
      diff(redactor);
      if (tail === '') continue;
      appendToolCallTail(target, toolIndex, tail);
    }
  };


  return {
    map(chunk: unknown): MappedChunk {
      if (!isRecord(chunk) || !Array.isArray(chunk.choices)) {
        return { chunk, redactions: 0, byType: {}, passthrough: true };
      }

      for (const key of ['id', 'model', 'created', 'object', 'system_fingerprint'] as const) {
        if (chunk[key] !== undefined && meta[key] === undefined) meta[key] = chunk[key];
      }

      const beforeRedactions = redactions;
      const beforeByType: RedactionCounts = { ...byType };

      for (const choice of chunk.choices as unknown[]) {
        if (!isRecord(choice)) continue;
        const index = typeof choice.index === 'number' ? choice.index : 0;
        const state = stateFor(index);
        const delta = isRecord(choice.delta) ? choice.delta : undefined;
        const message = isRecord(choice.message) ? choice.message : undefined;

        if (delta !== undefined) {
          redactTextFields(delta, state, 'stream');
          redactToolCalls(delta, state, 'stream');
        }
        if (message !== undefined) {
          redactTextFields(message, state, 'complete');
          redactToolCalls(message, state, 'complete');
        }

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          // The choice is done: release whatever is still withheld so the tail of the message is
          // not lost (the classic "forgot to flush on finish_reason" bug).
          const target = delta ?? message;
          if (target !== undefined) flushInto(target, state);
        }
      }

      const deltaByType: RedactionCounts = {};
      for (const [type, count] of Object.entries(byType)) {
        const increase = count - (beforeByType[type] ?? 0);
        if (increase > 0) deltaByType[type] = increase;
      }

      return { chunk, redactions: redactions - beforeRedactions, byType: deltaByType, passthrough: false };
    },

    flushPending(): Array<Record<string, unknown>> {
      const pending: Array<Record<string, unknown>> = [];

      for (const [index, state] of states) {
        const delta: Record<string, unknown> = {};
        flushInto(delta, state);
        if (Object.keys(delta).length === 0) continue;
        pending.push({
          ...meta,
          object: 'chat.completion.chunk',
          choices: [{ index, delta, finish_reason: null }]
        });
      }

      return pending;
    },

    stats(): ChunkMapperStats {
      let maxBufferSeen = 0;
      let buffered = 0;
      const merged: RedactionCounts = { ...byType };

      for (const state of states.values()) {
        for (const redactor of [...state.fields.values(), ...state.toolCalls.values()]) {
          const stats = redactor.stats();
          maxBufferSeen = Math.max(maxBufferSeen, stats.maxBufferSeen);
          buffered += stats.buffered;
          for (const [type, count] of Object.entries(stats.redactionsByType)) {
            merged[type] = (merged[type] ?? 0) + count;
          }
        }
      }

      return { maxBufferSeen, buffered, choices: states.size, redactionsByType: merged };
    }
  };
}

/**
 * Non-streaming response body: the same field policy, applied once to a complete JSON object.
 * The body is cloned, so the caller's parsed object is never mutated.
 */
export function redactResponseBody(
  body: unknown,
  options: ChunkMapperOptions
): { body: unknown; redactions: number; byType: RedactionCounts; mapped: boolean } {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return { body, redactions: 0, byType: {}, mapped: false };
  }

  const clone = structuredClone(body) as Record<string, unknown>;
  const byType: RedactionCounts = {};
  let redactions = 0;

  const redactWhole = (value: string): string => {
    const redactor = createStreamingRedactor({
      patterns: options.patterns,
      replacement: options.replacement,
      typedPlaceholders: options.typedPlaceholders,
      maxHoldbackBytes: options.maxHoldbackBytes ?? 512
    });
    const out = redactor.push(value) + redactor.flush();
    for (const [type, count] of Object.entries(redactor.stats().redactionsByType)) {
      byType[type] = (byType[type] ?? 0) + count;
      redactions += count;
    }
    return out;
  };

  for (const choice of clone.choices as unknown[]) {
    if (!isRecord(choice)) continue;
    const message = isRecord(choice.message) ? choice.message : undefined;
    if (message === undefined) continue;
    for (const field of TEXT_FIELDS) {
      if (typeof message[field] === 'string') message[field] = redactWhole(message[field] as string);
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls as unknown[]) {
        if (!isRecord(toolCall)) continue;
        const fn = toolCall.function;
        if (isRecord(fn) && typeof fn.arguments === 'string') fn.arguments = redactWhole(fn.arguments);
      }
    }
  }

  return { body: clone, redactions, byType, mapped: true };
}

export type { Pattern };

