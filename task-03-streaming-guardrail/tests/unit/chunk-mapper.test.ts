/**
 * Chunk mapper: `content`, `reasoning_content` (the field the reference llama.cpp server streams
 * reasoning in — ignoring it leaks), `reasoning` and `tool_calls[].function.arguments` are
 * redacted; `role`, `id`, `model`, `created`, `usage`, `timings`, `finish_reason` and `index` are
 * untouched; per-choice state is independent; an unparseable payload passes through.
 */
import { describe, expect, it } from 'vitest';
import { buildPatterns } from '../../src/redact/patterns.js';
import { createChunkMapper, redactResponseBody, type ChunkMapperOptions } from '../../src/redact/chunkMapper.js';

const options: ChunkMapperOptions = {
  patterns: buildPatterns([]),
  replacement: '[REDACTED]',
  typedPlaceholders: false,
  maxHoldbackBytes: 512
};

const deltaChunk = (
  delta: Record<string, unknown>,
  index = 0,
  finishReason: string | null = null
): Record<string, unknown> => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1_700_000_000,
  model: 'mock-model',
  choices: [{ index, delta, finish_reason: finishReason }]
});

/** Concatenates one string field across every mapped chunk — how a client sees the stream. */
function collect(
  mapper: ReturnType<typeof createChunkMapper>,
  chunks: unknown[],
  field = 'content',
  choiceIndex = 0
): string {
  let out = '';
  for (const chunk of chunks) {
    const mapped = mapper.map(chunk).chunk as {
      choices?: Array<{ index?: number; delta?: Record<string, unknown> }>;
    };
    for (const choice of mapped.choices ?? []) {
      if ((choice.index ?? 0) !== choiceIndex) continue;
      const value = choice.delta?.[field];
      if (typeof value === 'string') out += value;
    }
  }
  for (const pending of mapper.flushPending()) {
    for (const choice of (pending as { choices?: Array<{ index?: number; delta?: Record<string, unknown> }> }).choices ?? []) {
      if ((choice.index ?? 0) !== choiceIndex) continue;
      const value = choice.delta?.[field];
      if (typeof value === 'string') out += value;
    }
  }
  return out;
}

describe('chunk mapper — streaming deltas', () => {
  it('redacts content split across chunks', () => {
    const mapper = createChunkMapper(options);
    const text = collect(mapper, [
      deltaChunk({ role: 'assistant', content: 'your card 4111-' }),
      deltaChunk({ content: '1111-1111-1111 is charged' }),
      deltaChunk({}, 0, 'stop')
    ]);
    expect(text).toBe('your card [REDACTED] is charged');
  });

  it('redacts reasoning_content as well as content', () => {
    const mapper = createChunkMapper(options);
    const reasoning = collect(
      mapper,
      [
        deltaChunk({ reasoning_content: 'checking bob@ex' }),
        deltaChunk({ reasoning_content: 'ample.com now' }),
        deltaChunk({}, 0, 'stop')
      ],
      'reasoning_content'
    );
    expect(reasoning).toBe('checking [REDACTED] now');
  });

  it('redacts the reasoning alias some providers use', () => {
    const mapper = createChunkMapper(options);
    const reasoning = collect(mapper, [deltaChunk({ reasoning: 'ssn 123-45-6789 on file' })], 'reasoning');
    expect(reasoning).toBe('ssn [REDACTED] on file');
  });

  it('redacts streamed tool-call arguments', () => {
    const mapper = createChunkMapper(options);
    const mapped = [
      mapper.map(
        deltaChunk({
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"email":"bob@ex' } }]
        })
      ),
      mapper.map(deltaChunk({ tool_calls: [{ index: 0, function: { arguments: 'ample.com"}' } }] })),
      mapper.map(deltaChunk({}, 0, 'tool_calls'))
    ];

    const streamed = mapped.map((result) => JSON.stringify(result.chunk)).join('');
    const arguments_ = mapped
      .flatMap((result) =>
        ((result.chunk as { choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> })
          .choices ?? []).flatMap((choice) => choice.delta?.tool_calls ?? [])
      )
      .map((toolCall) => toolCall.function?.arguments ?? '')
      .join('');

    expect(arguments_).toBe('{"email":"[REDACTED]"}');
    expect(streamed).not.toContain('bob@example.com');
    expect(streamed).toContain('lookup');
  });

  it('leaves role, id, model, created, usage, timings and finish_reason untouched', () => {
    const mapper = createChunkMapper(options);
    const role = mapper.map(deltaChunk({ role: 'assistant', content: 'hi' }));
    expect(role.chunk).toMatchObject({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'mock-model'
    });
    expect((role.chunk as { choices: Array<{ delta: { role: string } }> }).choices[0]?.delta.role).toBe('assistant');

    const finish = mapper.map(deltaChunk({}, 0, 'stop'));
    expect((finish.chunk as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason).toBe('stop');

    const usage = mapper.map({
      id: 'chatcmpl-1',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      timings: { predicted_per_second: 42.5 }
    });
    expect(usage.chunk).toMatchObject({
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      timings: { predicted_per_second: 42.5 }
    });
    expect(usage.redactions).toBe(0);
  });

  it('keeps per-choice state independent', () => {
    const mapper = createChunkMapper(options);
    const text0 = collect(mapper, [
      { choices: [{ index: 0, delta: { content: 'card 4012' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '888888881881 ' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]);
    const text1 = collect(
      mapper,
      [
        { choices: [{ index: 1, delta: { content: 'mail bob@ex' }, finish_reason: null }] },
        { choices: [{ index: 1, delta: { content: 'ample.com ' }, finish_reason: null }] },
        { choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] }
      ],
      'content',
      1
    );

    expect(text0).toBe('card [REDACTED] ');
    expect(text1).toBe('mail [REDACTED] ');
    expect(mapper.stats().choices).toBe(2);
  });

  it('passes an unparseable payload through and reports it', () => {
    const mapper = createChunkMapper(options);
    const result = mapper.map('not-a-chunk' as unknown);
    expect(result.passthrough).toBe(true);
    expect(result.redactions).toBe(0);
    expect(result.chunk).toBe('not-a-chunk');
  });

  it('passes a JSON object without choices through untouched', () => {
    const mapper = createChunkMapper(options);
    const result = mapper.map({ id: 'x', object: 'chat.completion.chunk' });
    expect(result.passthrough).toBe(true);
  });

  it('releases withheld text when a finish_reason arrives', () => {
    const mapper = createChunkMapper(options);
    mapper.map(deltaChunk({ content: 'the tail is bob@exa' }));
    const finish = mapper.map(deltaChunk({}, 0, 'stop')) as { chunk: { choices: Array<{ delta: { content?: string } }> } };
    expect(finish.chunk.choices[0]?.delta.content).toBe('[REDACTED]');
  });

  it('flushes a leftover tail on [DONE] via flushPending', () => {
    const mapper = createChunkMapper(options);
    mapper.map(deltaChunk({ content: 'tail bob@exa' }));
    const pending = mapper.flushPending();
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending[0])).toContain('[REDACTED]');
    expect(JSON.stringify(pending[0])).not.toContain('bob@exa');
    expect(mapper.flushPending()).toEqual([]);
  });

  it('reports the largest retained buffer across its redactors', () => {
    const mapper = createChunkMapper(options);
    mapper.map(deltaChunk({ content: 'card 4111-1111-1111-1111' }));
    expect(mapper.stats().maxBufferSeen).toBeGreaterThan(0);
    expect(mapper.stats().maxBufferSeen).toBeLessThanOrEqual(512);
  });
});

describe('chunk mapper — non-streaming bodies', () => {
  it('redacts message content and tool-call arguments', () => {
    const result = redactResponseBody(
      {
        id: 'chatcmpl-1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'card 4111-1111-1111-1111 and bob@example.com',
              reasoning_content: 'ssn 123-45-6789',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"e":"ops@x.co"}' } }]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { total_tokens: 12 }
      },
      options
    );

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('4111-1111-1111-1111');
    expect(serialized).not.toContain('bob@example.com');
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('ops@x.co');
    expect(serialized).toContain('[REDACTED]');
    expect(result.redactions).toBe(4);
    expect(result.byType).toEqual({ credit_card: 1, email: 2, ssn: 1 });
  });

  it('does not mutate the caller body', () => {
    const body = { choices: [{ index: 0, message: { content: 'bob@example.com' } }] };
    redactResponseBody(body, options);
    expect(body.choices[0]?.message.content).toBe('bob@example.com');
  });

  it('reports an unmappable body instead of guessing', () => {
    const result = redactResponseBody({ ok: true }, options);
    expect(result.mapped).toBe(false);
    expect(result.redactions).toBe(0);
  });
});
