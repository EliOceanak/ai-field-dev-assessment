#!/usr/bin/env node
/**
 * `npm run demo:live` — a real tool-calling model driving the MCP server.
 *
 * Requires the local OpenAI-compatible server from docs/LOCAL-LLM.md
 * (`llama.cpp` on http://127.0.0.1:8080/v1 by default) and a tool-calling model.
 * This is the only script in the package that needs a model; `npm run demo` does
 * not.
 *
 *   LIVE_OPENAI_BASE_URL=http://127.0.0.1:8080/v1 LIVE_OPENAI_MODEL=qwen3.8-turbo \
 *     npm run demo:live
 *
 * Both variables can also come from the repo-root `.env`.
 */
import { register } from 'tsx/esm/api';
import { runAgentLoop, toOpenAiTools } from './lib/agent-loop.mjs';
import { auditStdout, spawnMcpServer } from './lib/mcp-child.mjs';

register();
const { loadDotEnv } = await import('../src/config.ts');
loadDotEnv();

// Empty means unset, so a blank line in `.env` falls back to the default.
const BASE_URL = process.env.LIVE_OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1';
const MODEL = process.env.LIVE_OPENAI_MODEL || 'qwen3.8-turbo';
// Always explicit: llama.cpp defaults to -1 (unbounded), and a budget below ~512
// is eaten by the model's reasoning before it can emit a tool call (docs/LOCAL-LLM.md).
const MAX_TOKENS = Math.max(512, Number(process.env.LIVE_OPENAI_MAX_TOKENS ?? 1024) || 1024);

const money = (value) => `$${Number(value).toFixed(2)}`;

const server = spawnMcpServer({ env: { MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? 'info' } });
await server.initialize();

const { result } = await server.request('tools/list');
const tools = toOpenAiTools(result.tools);
console.log(`MCP tools advertised to ${MODEL} @ ${BASE_URL}`);
console.log(`  ${tools.map((tool) => tool.function.name).join(', ')}\n`);

const messages = [
  {
    role: 'system',
    content:
      'You are a customer operations agent. You must use the provided tools for every fact you state. ' +
      'Refund ids and balances must come from tool output, never from your own knowledge.'
  },
  {
    role: 'user',
    content:
      'Customer CUST-00001 reports a duplicate charge. Look up their record, then refund 12.50 USD with the ' +
      'reason "duplicate charge refund". Finally summarise their remaining balance.'
  }
];

let toolCalls = 0;
const transcript = await runAgentLoop({
  mcp: server,
  baseUrl: BASE_URL,
  model: MODEL,
  messages,
  tools,
  maxTurns: 5,
  maxTokens: MAX_TOKENS,
  onToolCall({ name, args, payload }) {
    toolCalls += 1;
    if (payload.error !== undefined) {
      console.log(`  [tool] ${name}(${JSON.stringify(args)}) → error ${payload.error.code}`);
      return;
    }
    const structured = payload.structuredContent ?? {};
    if (structured.refund_id !== undefined) {
      console.log(
        `  [tool] ${name}(${JSON.stringify(args)}) → ${structured.refund_id} ${money(structured.amount_usd)}, balance ${money(structured.new_balance_usd)}`
      );
    } else if (structured.customer_id !== undefined) {
      console.log(
        `  [tool] ${name}(${JSON.stringify(args)}) → ${structured.name}, balance ${money(structured.balance_usd)}, ${structured.refunds.length} refund(s)`
      );
    } else {
      console.log(`  [tool] ${name}(${JSON.stringify(args)}) → ${JSON.stringify(structured)}`);
    }
  }
});

for (const entry of transcript) {
  const names = entry.toolCalls.map((call) => call.function.name).join(', ');
  console.log(`turn ${entry.turn}: finish_reason=${entry.finishReason}${names === '' ? '' : `  tool_calls=[${names}]`}`);
}

const finalMessage = [...messages].reverse().find((message) => message.role === 'assistant' && message.content);
console.log(`\nassistant: ${String(finalMessage?.content ?? '').trim().slice(0, 600)}`);

const record = await server.request('tools/call', {
  name: 'get_customer_record',
  arguments: { customer_id: 'CUST-00001' }
});
const structured = record.result?.structuredContent ?? {};
console.log(
  `\nfinal state (read over the wire): balance ${money(structured.balance_usd)}, ${structured.refunds?.length ?? 0} refund(s)`
);

const exitCode = await server.close();
const audit = auditStdout(server.stdoutLines);
console.log(`stdout: ${audit.total} lines, all JSON-RPC ${audit.invalid.length === 0 ? '✔' : '✖'}`);
console.log(`stderr: ${server.stderrLines.length} log lines`);

const failures = [];
if (toolCalls === 0) failures.push('the model never called a tool');
if ((structured.refunds?.length ?? 0) === 0) failures.push('no refund was applied');
if (audit.invalid.length > 0) failures.push('stdout carried a non-JSON-RPC line');
if (exitCode !== 0) failures.push(`the server exited ${exitCode}`);

if (failures.length > 0) {
  console.error(`\n✖ ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\n✔ the model drove the MCP server end to end');
