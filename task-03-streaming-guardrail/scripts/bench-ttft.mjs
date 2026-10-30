#!/usr/bin/env node
/**
 * `npm run bench` — the TTFT / throughput evidence, direct vs guarded, no model server required.
 *
 * Method: a scripted provider emits a fixed cadence of tokens (default 20 ms/token, 200 tokens,
 * like a local ~50 tok/s model). Two paths are measured:
 *
 *   direct   client ─────────────────────────────▶ scripted provider
 *   guarded  client ──▶ gateway (redaction) ──────▶ scripted provider
 *
 * TTFT is the time from just before the request to the first non-empty SSE chunk the client can
 * read. Two first-delta shapes are reported, because the holdback's cost depends on them:
 *
 *   "bare word"   the first delta is a single word that could still become an email/SSN/card
 *                 prefix, so it is withheld until the next delta → about one token of TTFT.
 *   "prose"       the first delta already contains a space, so everything before the trailing
 *                 word is released immediately → essentially no TTFT penalty.
 *
 * Tune with BENCH_RUNS / BENCH_TOKENS / BENCH_TOKEN_MS / BENCH_THROUGHPUT_RUNS.
 */
import { register } from 'tsx/esm/api';
import { chunkOf, sseFrame, startMockUpstream } from './lib/mock-upstream.mjs';

register();
const { createGateway } = await import('../src/server.ts');
const { loadConfig } = await import('../src/config.ts');
const { createLogger } = await import('../src/logging/logger.ts');

const RUNS = Number(process.env.BENCH_RUNS ?? 20);
const TOKENS = Number(process.env.BENCH_TOKENS ?? 200);
const TOKEN_MS = Number(process.env.BENCH_TOKEN_MS ?? 20);
const THROUGHPUT_RUNS = Number(process.env.BENCH_THROUGHPUT_RUNS ?? 3);

const WORDS = 'the quarterly report shows revenue up 12 percent year over year and margin steady'.split(' ');
const BODY = {
  model: 'scripted-provider',
  messages: [{ role: 'user', content: 'Summarise the report.' }],
  stream: true
};

/** Builds a token stream; `firstDelta` controls what the client sees first. */
function buildFrames(firstDelta) {
  const frames = [{ text: sseFrame(chunkOf({ role: 'assistant', content: firstDelta })) }];
  for (let index = 1; index < TOKENS; index += 1) {
    frames.push({ text: sseFrame(chunkOf({ content: ` ${WORDS[index % WORDS.length]}` })) });
  }
  frames.push({ text: sseFrame(chunkOf({}, 'stop')) });
  frames.push({ text: 'data: [DONE]\n\n' });
  return frames;
}

/** One measurement: TTFT (ms), time to first *non-empty content* (ms) and total duration (ms). */
async function measure(url, body, { abortAfterContent = false } = {}) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  });

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let ttft = 0;
  let firstContent = 0;
  let bytes = 0;
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (ttft === 0) ttft = performance.now() - startedAt;
      if (firstContent === 0) {
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split('\n\n');
        pending = parts.pop() ?? '';
        for (const part of parts) {
          if (!part.startsWith('data: ') || part === 'data: [DONE]') continue;
          const payload = JSON.parse(part.slice(6));
          const content = (payload.choices ?? []).map((choice) => choice.delta?.content ?? '').join('');
          if (content.trim() !== '') {
            firstContent = performance.now() - startedAt;
            break;
          }
        }
      }
      if (abortAfterContent && firstContent !== 0) {
        controller.abort();
        break;
      }
    }
  } catch {
    /* aborted once the measurement is complete — expected */
  }
  return { ttft, firstContent, total: performance.now() - startedAt, bytes };
}

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
};
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const ms = (value) => `${value.toFixed(1)} ms`;

async function series(url, body, runs, options) {
  const ttft = [];
  const firstContent = [];
  const total = [];
  for (let run = 0; run < runs; run += 1) {
    const result = await measure(url, body, options);
    ttft.push(result.ttft);
    firstContent.push(result.firstContent);
    total.push(result.total);
  }
  return {
    ttftMean: mean(ttft),
    ttftP95: percentile(ttft, 0.95),
    contentMean: mean(firstContent),
    totalMean: mean(total)
  };
}

function table(rows) {
  const header = ['scenario', 'path', 'TTFT mean', 'TTFT p95', 'first content', 'total mean'];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => String(row[index]).length)));
  const render = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  console.log(render(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(render(row));
}

/** Runs one direct/guarded pair and returns the table rows plus the deltas. */
async function compare(scenario, directUrl, guardedUrl, runs, options) {
  const direct = await series(directUrl, BODY, runs, options);
  const guarded = await series(guardedUrl, BODY, runs, options);
  const delta = guarded.ttftMean - direct.ttftMean;
  const contentDelta = guarded.contentMean - direct.contentMean;
  const totalDelta = guarded.totalMean - direct.totalMean;
  const sign = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} ms`;

  return {
    rows: [
      [scenario, 'direct', ms(direct.ttftMean), ms(direct.ttftP95), ms(direct.contentMean), options.abortAfterContent ? '—' : ms(direct.totalMean)],
      [scenario, 'guarded', ms(guarded.ttftMean), ms(guarded.ttftP95), ms(guarded.contentMean), options.abortAfterContent ? '—' : ms(guarded.totalMean)],
      [scenario, 'delta', sign(delta), '—', sign(contentDelta), options.abortAfterContent ? '—' : sign(totalDelta)]
    ],
    delta,
    contentDelta,
    totalDelta
  };
}

const upstream = await startMockUpstream({ frames: buildFrames('Hello'), tokenDelayMs: TOKEN_MS });
const gateway = createGateway({
  config: loadConfig({ GUARDRAIL_UPSTREAM_BASE_URL: upstream.url }),
  logger: createLogger({ level: 'silent' })
});
const port = await gateway.listen(0);

const proseUpstream = await startMockUpstream({ frames: buildFrames('Hello, here is the summary'), tokenDelayMs: TOKEN_MS });
const proseGateway = createGateway({
  config: loadConfig({ GUARDRAIL_UPSTREAM_BASE_URL: proseUpstream.url }),
  logger: createLogger({ level: 'silent' })
});
const prosePort = await proseGateway.listen(0);

console.log(`Task 3 — TTFT bench: ${RUNS} runs, ${TOKENS} tokens at ${TOKEN_MS} ms/token (scripted provider, no model)`);

const bare = await compare('first delta "Hello" (bare word)', `${upstream.url}/chat/completions`, `http://127.0.0.1:${port}/v1/chat/completions`, RUNS, {
  abortAfterContent: true
});
const prose = await compare(
  'first delta "Hello, here is…"',
  `${proseUpstream.url}/chat/completions`,
  `http://127.0.0.1:${prosePort}/v1/chat/completions`,
  RUNS,
  { abortAfterContent: true }
);

console.log('\nTTFT — time to the first client-visible SSE chunk, and to the first non-empty content');
table([...bare.rows, ...prose.rows]);

console.log(`\nTotal stream duration (${THROUGHPUT_RUNS} full runs of ${TOKENS} tokens)`);
const throughput = await compare('full stream', `${upstream.url}/chat/completions`, `http://127.0.0.1:${port}/v1/chat/completions`, THROUGHPUT_RUNS, {});
table(throughput.rows);

const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
console.log('\nGuardrail state after the bench');
console.log(`  streams             : ${stats.streams}`);
console.log(`  redactions          : ${stats.redactions}`);
console.log(`  max retained buffer : ${stats.maxBufferSeen} bytes (cap ${stats.maxHoldbackBytes})`);
console.log(`  holdback cap hits   : ${stats.holdbackCapHits}`);
console.log(`  bytes proxied       : ${stats.bytesIn} in / ${stats.bytesOut} out`);

console.log(
  `\nTTFT cost of guarding : +${bare.delta.toFixed(1)} ms to the first SSE frame; ` +
    `+${bare.contentDelta.toFixed(1)} ms to the first non-empty content (≤ one ${TOKEN_MS} ms token); ` +
    `+${prose.delta.toFixed(1)} ms when the first delta is prose`
);
const totalSign = throughput.totalDelta >= 0 ? '+' : '';
console.log(
  `Throughput cost       : ${totalSign}${throughput.totalDelta.toFixed(1)} ms over a ${TOKENS}-token stream ` +
    `(${totalSign}${(throughput.totalDelta / TOKENS).toFixed(2)} ms/token of added latency)`
);

await gateway.close();
await proseGateway.close();
await upstream.close();
await proseUpstream.close();

