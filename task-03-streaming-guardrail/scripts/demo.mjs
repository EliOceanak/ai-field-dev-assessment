#!/usr/bin/env node
/**
 * `npm run demo` — offline end-to-end transcript. No model server required.
 *
 * A scripted provider streams PII in the awkward places: a card split across three frames, an
 * email split at the `@`, an SSN split mid-group, a `reasoning_content` delta carrying PII, a
 * tool-call argument carrying an email — plus benign order ids, dates and versions that must
 * survive untouched. The raw upstream frames are printed beside the client-visible stream.
 *
 * `src/` is TypeScript, so the script registers tsx's ESM loader and imports it directly.
 */
import { register } from 'tsx/esm/api';
import { chunkOf, sseFrame, startMockUpstream } from './lib/mock-upstream.mjs';

register();
const { createGateway } = await import('../src/server.ts');
const { loadConfig } = await import('../src/config.ts');
const { createLogger } = await import('../src/logging/logger.ts');

const BENIGN = ['ORD-10234', '2026-10-29', '5.9.3'];
const RAW_PII = ['4012 8888 8888 1881', '4012888888881881', 'alice@example.com', '078-05-1120', '10.0.0.42', 'bob@example.com'];

const frames = [
  sseFrame(chunkOf({ role: 'assistant', content: 'Hi, your card 4012' })),
  sseFrame(chunkOf({ content: '8888 8888' })),
  sseFrame(chunkOf({ content: ' 1881 was charged 12.50. ' })),
  sseFrame(chunkOf({ content: 'Receipt to alice@' })),
  sseFrame(chunkOf({ content: 'example.com, SSN 078-' })),
  sseFrame(chunkOf({ content: '05-1120, order ORD-10234 dated 2026-10-29 (v5.9.3). ' })),
  sseFrame(chunkOf({ reasoning_content: 'Checking alice@exam' })),
  sseFrame(chunkOf({ reasoning_content: 'ple.com against host 10.0.0.42. ' })),
  sseFrame(
    chunkOf({
      tool_calls: [
        { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"email":"bob@ex' } }
      ]
    })
  ),
  sseFrame(chunkOf({ tool_calls: [{ index: 0, function: { arguments: 'ample.com"}' } }] })),
  sseFrame(chunkOf({}, 'stop')),
  'data: [DONE]\n\n'
];

const upstream = await startMockUpstream({ frames: frames.map((text) => ({ text })) });
const config = loadConfig({ GUARDRAIL_UPSTREAM_BASE_URL: upstream.url });
const gateway = createGateway({ config, logger: createLogger({ level: 'silent' }) });
const port = await gateway.listen(0);

const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'scripted-provider',
    messages: [{ role: 'user', content: 'Where is my order?' }],
    stream: true
  })
});
const clientBytes = await response.text();
const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();

const line = (label) => `\n${label}\n${'-'.repeat(label.length)}`;

console.log('Task 3 — streaming PII guardrail: offline demo (scripted provider, no model server)');
console.log(`upstream ${upstream.url}  →  gateway http://127.0.0.1:${port}`);

console.log(line('1. What the provider sent (raw SSE frames)'));
for (const frame of frames) console.log(`  ${frame.trimEnd().replace(/\n/g, '\n  ')}`);

console.log(line('2. What the client received (guarded SSE frames)'));
for (const frame of clientBytes.split('\n\n').filter((part) => part.trim() !== '')) {
  console.log(`  ${frame.replace(/\n/g, '\n  ')}`);
}

/** Rebuilds the visible message from the guarded stream. */
function visible(field) {
  let out = '';
  for (const frame of clientBytes.split('\n\n')) {
    if (!frame.startsWith('data: ') || frame === 'data: [DONE]') continue;
    const payload = JSON.parse(frame.slice(6));
    for (const choice of payload.choices ?? []) {
      const value = choice.delta?.[field];
      if (typeof value === 'string') out += value;
    }
  }
  return out;
}

function visibleToolArguments() {
  let out = '';
  for (const frame of clientBytes.split('\n\n')) {
    if (!frame.startsWith('data: ') || frame === 'data: [DONE]') continue;
    const payload = JSON.parse(frame.slice(6));
    for (const choice of payload.choices ?? []) {
      for (const call of choice.delta?.tool_calls ?? []) out += call.function?.arguments ?? '';
    }
  }
  return out;
}

console.log(line('3. Reassembled client view'));
console.log(`  content            : ${visible('content')}`);
console.log(`  reasoning_content  : ${visible('reasoning_content')}`);
console.log(`  tool arguments     : ${visibleToolArguments()}`);

const reassembled = `${visible('content')}\n${visible('reasoning_content')}\n${visibleToolArguments()}`;
const leaks = RAW_PII.filter((value) => clientBytes.includes(value) || reassembled.includes(value));
const survivors = BENIGN.filter((value) => reassembled.includes(value));
const byType = Object.entries(stats.redactionsByType)
  .map(([type, count]) => `${count} ${type}`)
  .join(', ');

console.log(line('4. Summary'));
console.log(`  redactions         : ${stats.redactions} (${byType})`);
console.log(`  leaks              : ${leaks.length}${leaks.length > 0 ? ` → ${leaks.join(', ')}` : ''}`);
console.log(`  benign values kept : ${survivors.length}/${BENIGN.length} (${survivors.join(', ')})`);
console.log(`  max buffer seen    : ${stats.maxBufferSeen} bytes (cap ${stats.maxHoldbackBytes})`);
console.log(`  bytes              : ${stats.bytesIn} in → ${stats.bytesOut} out, ${stats.chunksIn} frames in / ${stats.chunksOut} out`);
console.log(`  framing            : ${clientBytes.trimEnd().endsWith('data: [DONE]') ? '[DONE] preserved' : 'MISSING [DONE]'}`);
console.log('  note               : an empty "content" delta means the redactor withheld the tail of a');
console.log('                       value that could still be completed by the next frame.');

await gateway.close();
await upstream.close();

const ok = leaks.length === 0 && survivors.length === BENIGN.length;
console.log(`\n${ok ? 'PASS' : 'FAIL'} — ${ok ? 'no raw PII reached the client' : 'see the summary above'}`);
process.exit(ok ? 0 : 1);
