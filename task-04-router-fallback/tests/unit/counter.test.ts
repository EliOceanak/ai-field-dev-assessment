/**
 * The admission-time estimator.
 *
 * The property that matters is not "is it accurate" (it cannot be, without the provider's
 * tokenizer) but "is it deterministic and monotone" — the limiter's decision must be reproducible,
 * and a bigger request must never look smaller.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { estimateTokens, outputReserveTokens, reservationTokens } from '../../src/ratelimit/counter.js';

const config = loadConfig({});

function estimate(body: unknown, overrides: Record<string, string> = {}): number {
  return estimateTokens(body, loadConfig(overrides));
}

describe('estimateTokens', () => {
  it('is zero for anything that is not a completion request', () => {
    expect(estimate(undefined)).toBe(0);
    expect(estimate(null)).toBe(0);
    expect(estimate(42)).toBe(0);
    expect(estimate('a prompt')).toBe(0);
    expect(estimate([])).toBe(0);
    expect(estimate({})).toBe(0);
    expect(estimate({ messages: [] })).toBe(0);
  });

  it('charges a per-message overhead plus characters/4', () => {
    // 4 (overhead) + 1 ("user" role) + ceil(40 / 4) = 15
    expect(estimate({ messages: [{ role: 'user', content: 'x'.repeat(40) }] })).toBe(15);
    expect(estimate({ messages: [{ role: 'user', content: 'x'.repeat(41) }] })).toBe(16); // ceil
  });

  it('scales with the number of messages', () => {
    const one = estimate({ messages: [{ role: 'user', content: 'hello' }] });
    const three = estimate({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'hello' }
      ]
    });
    expect(three).toBeGreaterThan(one * 2);
  });

  it('adds the tool overhead per definition', () => {
    const withoutTools = estimate({ messages: [{ role: 'user', content: 'hi' }] });
    const withTools = estimate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }]
    });
    expect(withTools - withoutTools).toBeGreaterThanOrEqual(config.estimation.toolOverheadTokens);
  });

  it('counts content parts, prompts, system prompts and response formats', () => {
    expect(estimate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(40) }] }] })).toBe(15);
    expect(estimate({ prompt: 'x'.repeat(40) })).toBe(10);
    expect(estimate({ input: 'x'.repeat(40) })).toBe(10);
    expect(estimate({ system: 'x'.repeat(40) })).toBe(10);
    expect(estimate({ messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } })).toBeGreaterThan(0);
  });

  it('honours the configured coefficients', () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(40) }] };
    expect(estimate(body, { ROUTER_CHARS_PER_TOKEN: '1' })).toBe(4 + 4 + 40); // overhead + "user" + content
    expect(estimate(body, { ROUTER_MESSAGE_OVERHEAD_TOKENS: '0' })).toBe(1 + 10);
    expect(estimate(body, { ROUTER_CHARS_PER_TOKEN: '8' })).toBe(4 + 1 + 5);
  });

  it('is deterministic: the same body always estimates the same way', () => {
    const body = { messages: [{ role: 'user', content: 'a'.repeat(1_000) }, { role: 'system', content: 'b'.repeat(37) }] };
    const first = estimate(body);
    expect(estimate(structuredClone(body))).toBe(first);
    expect(estimate(body)).toBe(first);
  });

  it('never shrinks when content is added', () => {
    const base = { messages: [{ role: 'user', content: 'a'.repeat(100) }] };
    const bigger = { messages: [{ role: 'user', content: 'a'.repeat(101) }] };
    expect(estimate(bigger)).toBeGreaterThanOrEqual(estimate(base));
  });

  it('ignores malformed messages instead of throwing', () => {
    expect(estimate({ messages: [null, 7, 'text'] })).toBe(0);
    expect(estimate({ messages: [{ role: 'user' }] })).toBe(5); // overhead + the role only
    expect(estimate({ messages: [{ role: 'user', content: 123 }] })).toBe(5);
  });
});

describe('reservationTokens', () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(40) }] };

  it('adds the configured output reserve when the client declares nothing', () => {
    const config = loadConfig({ ROUTER_OUTPUT_RESERVE_TOKENS: '500', ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '2000' });
    expect(estimateTokens(body, config)).toBe(15);
    expect(reservationTokens(body, config)).toBe(15 + 500);
  });

  it('reserves the declared max_tokens when it is smaller than the default', () => {
    const config = loadConfig({ ROUTER_OUTPUT_RESERVE_TOKENS: '500', ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '2000' });
    expect(reservationTokens({ ...body, max_tokens: 64 }, config)).toBe(15 + 64);
  });

  it('caps what a client may claim, so one request cannot reserve the whole window', () => {
    const config = loadConfig({ ROUTER_OUTPUT_RESERVE_TOKENS: '500', ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '2000' });
    expect(outputReserveTokens({ ...body, max_tokens: 1_000_000 }, config)).toBe(2_000);
  });

  it('treats llama.cpp\'s unbounded default (-1) as "not declared"', () => {
    const config = loadConfig({ ROUTER_OUTPUT_RESERVE_TOKENS: '500', ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '2000' });
    expect(outputReserveTokens({ ...body, max_tokens: -1 }, config)).toBe(500);
    expect(outputReserveTokens({ ...body, max_completion_tokens: 0 }, config)).toBe(500);
  });

  it('can be switched off entirely', () => {
    const config = loadConfig({ ROUTER_OUTPUT_RESERVE_TOKENS: '0', ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '0' });
    expect(reservationTokens({ ...body, max_tokens: 9_999 }, config)).toBe(15);
  });

  it('reserves nothing extra for a body that is not a request', () => {
    const config = loadConfig({ ROUTER_OUTPUT_RESERVE_TOKENS: '500' });
    expect(outputReserveTokens(null, config)).toBe(500);
    expect(outputReserveTokens(undefined, config)).toBe(500);
  });

  it('defaults to a 1 024-token output reserve capped at 16 384', () => {
    const config = loadConfig({});
    expect(config.outputReserveTokens).toBe(1_024);
    expect(config.maxOutputReserveTokens).toBe(16_384);
    expect(outputReserveTokens(body, config)).toBe(1_024);
    expect(outputReserveTokens({ ...body, max_tokens: 99_999 }, config)).toBe(16_384);
  });
});
