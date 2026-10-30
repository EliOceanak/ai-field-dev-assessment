#!/usr/bin/env node
/**
 * `npm run demo:live` — the same guardrail in front of the **real** local model server
 * (llama.cpp on 127.0.0.1:8080 by default). Requires a running OpenAI-compatible server: point it
 * elsewhere with `LIVE_OPENAI_BASE_URL` / `LIVE_OPENAI_MODEL` (or `GUARDRAIL_LIVE_BASE_URL` /
 * `GUARDRAIL_LIVE_MODEL` for this demo alone), from the process environment or the repo-root `.env`.
 *
 * It asks the model to echo a PII fixture, then prints the transcript the client sees plus a leak
 * scan. The model may reformat, spell out or refuse the values, so the script reports what it
 * observed rather than asserting prose.
 */
import { register } from 'tsx/esm/api';

register();
const { createGateway } = await import('../src/server.ts');
const { loadConfig, loadDotEnv } = await import('../src/config.ts');
const { createLogger } = await import('../src/logging/logger.ts');

loadDotEnv();
// `||`, not `??`: an empty value (a blank line in `.env`) means unset.
const UPSTREAM = process.env.GUARDRAIL_LIVE_BASE_URL || process.env.LIVE_OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1';
const MODEL = process.env.GUARDRAIL_LIVE_MODEL || process.env.LIVE_OPENAI_MODEL || 'qwen3.8-turbo';

const FIXTURES = ['bob.smith@example.com', '4111-1111-1111-1111', '123-45-6789', '10.0.0.42'];
const PROMPT =
  'Reply with exactly this line and nothing else, then stop: ' +
  `"customer ${FIXTURES[0]} card ${FIXTURES[1]} ssn ${FIXTURES[2]} host ${FIXTURES[3]}"`;

// `GET /models` is the one probe every OpenAI-compatible server answers (llama.cpp, Ollama, vLLM, LM
// Studio); `/health` is llama.cpp's own.
const models = await fetch(`${UPSTREAM}/models`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
if (models === undefined || !models.ok) {
  console.error(`No model server at ${UPSTREAM}. Start one (or set LIVE_OPENAI_BASE_URL) and retry.`);
  process.exit(2);
}

const gateway = createGateway({
  config: loadConfig({ GUARDRAIL_UPSTREAM_BASE_URL: UPSTREAM, GUARDRAIL_UPSTREAM_TIMEOUT_MS: '120000' }),
  logger: createLogger({ level: 'silent' })
});
const port = await gateway.listen(0);
const startedAt = performance.now();

const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    stream: true,
    max_tokens: 1024,
    reasoning_effort: 'none',
    stream_options: { include_usage: true }
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let raw = '';
let firstFrameMs = 0;
let frames = 0;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  if (firstFrameMs === 0) firstFrameMs = performance.now() - startedAt;
  raw += decoder.decode(value, { stream: true });
  frames += (raw.match(/\n\n/g) ?? []).length;
}

const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
const reassembled = { content: '', reasoning_content: '', toolArguments: '' };
for (const frame of raw.split('\n\n')) {
  if (!frame.startsWith('data: ') || frame === 'data: [DONE]') continue;
  try {
    const payload = JSON.parse(frame.slice(6));
    for (const choice of payload.choices ?? []) {
      reassembled.content += choice.delta?.content ?? '';
      reassembled.reasoning_content += choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? '';
      for (const call of choice.delta?.tool_calls ?? []) reassembled.toolArguments += call.function?.arguments ?? '';
    }
  } catch {
    /* counted by the gateway as unparsed_events */
  }
}

const leaks = FIXTURES.filter((value) => raw.includes(value) || JSON.stringify(reassembled).includes(value));

console.log(`Task 3 — live demo against ${UPSTREAM} (model ${MODEL})`);
console.log(`\nclient-visible content : ${reassembled.content.trim() || '(empty)'}`);
if (reassembled.reasoning_content.trim() !== '') {
  console.log(`reasoning_content      : ${reassembled.reasoning_content.trim().slice(0, 400)}`);
}
if (reassembled.toolArguments !== '') console.log(`tool arguments         : ${reassembled.toolArguments}`);

console.log('\nsummary');
console.log(`  first SSE frame      : ${firstFrameMs.toFixed(0)} ms after the request`);
console.log(`  frames               : ${frames}`);
console.log(`  redactions           : ${stats.redactions} (${JSON.stringify(stats.redactionsByType)})`);
console.log(`  leaks                : ${leaks.length}${leaks.length > 0 ? ` → ${leaks.join(', ')}` : ''}`);
console.log(`  max retained buffer  : ${stats.maxBufferSeen} bytes (cap ${stats.maxHoldbackBytes})`);
console.log(`  [DONE] preserved     : ${raw.trimEnd().endsWith('data: [DONE]')}`);
console.log(`  unparsed events      : ${stats.unparsedEvents}`);

await gateway.close();
process.exit(leaks.length === 0 ? 0 : 1);
