/**
 * Frame-aware pass-through that (a) learns the provider's real token usage and (b) hides the frame it
 * used to learn it, when the client never asked for it.
 *
 * Two problems, one component:
 *
 *  1. A streamed completion can only be reconciled against real tokens if the provider reports them,
 *     so the router asks for `stream_options.include_usage` upstream. The final chunk then carries a
 *     `usage` object.
 *  2. A client that did not ask for usage must not suddenly start receiving it, so the frame is
 *     removed before it reaches the client. The gateway's visible contract stays byte-identical to
 *     what the client asked for.
 *
 * Memory is bounded by construction: only the bytes since the last `\n\n` frame boundary are held, and
 * if that ever exceeds `maxBytes` the held bytes are flushed verbatim (never lose data, never grow
 * without limit). Well-formed SSE keeps this at zero between frames — a few hundred bytes at most.
 */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Reads `usage` off a complete payload (a frame's `data:` JSON, or a buffered response body). */
export function readUsagePayload(payload: unknown): TokenUsage | undefined {
  if (!isRecord(payload)) return undefined;
  const usage = payload.usage;
  if (!isRecord(usage)) return undefined;
  const out: TokenUsage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `data:` payload of one SSE frame, or `undefined` for comments/other fields. */
function frameData(frame: Buffer): string | undefined {
  const text = frame.toString('utf8');
  if (!text.includes('data:')) return undefined;
  const parts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    parts.push(line.slice(5).trim());
  }
  const data = parts.join('');
  return data === '' ? undefined : data;
}

export interface SseUsageFilterOptions {
  /** Drop the frame that carries `usage` (the client did not ask for it). Default true. */
  stripUsage?: boolean;
  /** Cap on the bytes held while waiting for a frame boundary. Default 64 KiB. */
  maxBytes?: number;
}

export interface SseUsageFilter {
  /** Attach with `upstream.pipeThrough(filter.stream)`. */
  stream: TransformStream<Uint8Array, Uint8Array>;
  /** The last `usage` the provider reported, or `undefined` when it never did. */
  usage(): TokenUsage | undefined;
  /** Frames removed because they carried `usage`. */
  strippedFrames(): number;
  /** Frames forwarded unchanged. */
  forwardedFrames(): number;
  /** Held bytes flushed early because a single frame exceeded the cap. */
  overflowed(): boolean;
  /**
   * Largest tail carried **across a chunk boundary** — i.e. the memory this filter accumulates. A
   * single chunk is never split, so a transient hold of one chunk is inherent to any stream; what is
   * bounded here is what survives from one chunk to the next.
   */
  maxRetainedBytes(): number;
}

export function createSseUsageFilter(options: SseUsageFilterOptions = {}): SseUsageFilter {
  const stripUsage = options.stripUsage ?? true;
  const maxBytes = options.maxBytes ?? 64 * 1024;

  let pending: Buffer = Buffer.alloc(0);
  let found: TokenUsage | undefined;
  let stripped = 0;
  let forwarded = 0;
  let overflowed = false;
  let maxRetained = 0;

  /** Splits complete frames out of `pending` and returns the bytes to forward. */
  const takeFrames = (): Buffer[] => {
    const out: Buffer[] = [];
    for (;;) {
      const lf = pending.indexOf('\n\n');
      const crlf = pending.indexOf('\r\n\r\n');
      const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
      const boundary = useCrlf ? crlf : lf;
      if (boundary === -1) break;

      const end = boundary + (useCrlf ? 4 : 2);
      const frame = pending.subarray(0, end);
      pending = pending.subarray(end);

      const data = frameData(frame);
      let usage: TokenUsage | undefined;
      if (data !== undefined && data !== '[DONE]' && data.includes('"usage"')) {
        try {
          usage = readUsagePayload(JSON.parse(data) as unknown);
        } catch {
          usage = undefined;
        }
      }

      if (usage !== undefined) {
        found = usage;
        if (stripUsage) {
          stripped += 1;
          continue; // the client never asked for this frame
        }
      }
      forwarded += 1;
      out.push(frame);
    }
    return out;
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      for (const frame of takeFrames()) controller.enqueue(frame);

      if (pending.length > maxBytes) {
        // A frame bigger than the cap that has not terminated yet: stop holding it back rather than
        // grow without limit. Data is never dropped, only forwarded early.
        overflowed = true;
        controller.enqueue(pending);
        pending = Buffer.alloc(0);
      }
      maxRetained = Math.max(maxRetained, pending.length);
    },

    flush(controller) {
      // A stream that ended without a trailing blank line: forward what is left, verbatim.
      if (pending.length > 0) {
        controller.enqueue(pending);
        pending = Buffer.alloc(0);
      }
    }
  });

  return {
    stream,
    usage: () => found,
    strippedFrames: () => stripped,
    forwardedFrames: () => forwarded,
    overflowed: () => overflowed,
    maxRetainedBytes: () => maxRetained
  };
}
