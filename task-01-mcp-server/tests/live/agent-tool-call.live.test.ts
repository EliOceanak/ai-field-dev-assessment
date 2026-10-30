/**
 * Live tool-calling loop against a real OpenAI-compatible server (opt-in).
 *
 *   RUN_LIVE_LLM=1 npm run test:live
 *
 * Defaults target llama.cpp on `http://127.0.0.1:8080/v1` with a tool-calling
 * model (`qwen3.8-turbo`). Override with `LIVE_OPENAI_BASE_URL`, `LIVE_OPENAI_MODEL`
 * (process environment or the repo-root `.env`).
 *
 * Rules followed here:
 *   - the whole suite is gated with `describe.skipIf(RUN_LIVE_LLM !== '1')`;
 *   - assertions are structural (tool names, JSON-RPC shapes, state deltas),
 *     never on model prose;
 *   - every request sends an explicit `max_tokens` (llama.cpp defaults to -1);
 *   - a stochastic check is retried once, and the test name says so.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/config.js';

loadDotEnv();

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
// Env names match the root `.env.example` (shared by all four tasks' live suites); empty means unset.
const BASE_URL = (process.env.LIVE_OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const MODEL = process.env.LIVE_OPENAI_MODEL || 'qwen3.8-turbo';
// Always explicit: llama.cpp defaults to -1 (unbounded), and a budget below ~512
// is eaten by the model's reasoning before it can emit a tool call (docs/LOCAL-LLM.md).
const MAX_TOKENS = Math.max(512, Number(process.env.LIVE_OPENAI_MAX_TOKENS ?? 1024) || 1024);

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface Completion {
  choices: Array<{
    finish_reason: string;
    message: { role: string; content: string | null; tool_calls?: ToolCall[] };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function chatCompletion(messages: ChatMessage[], tools: unknown[]): Promise<Completion> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: MAX_TOKENS,
      stream: false
    })
  });
  if (!response.ok) throw new Error(`live server returned ${response.status}`);
  return (await response.json()) as Completion;
}

/** MCP `inputSchema` → OpenAI function parameters (drop the JSON Schema dialect key). */
function toOpenAiTools(tools: Array<{ name: string; description?: string; inputSchema: unknown }>) {
  return tools.map((tool) => {
    const { $schema: _ignored, ...parameters } = tool.inputSchema as Record<string, unknown>;
    return {
      type: 'function' as const,
      function: { name: tool.name, description: tool.description ?? '', parameters }
    };
  });
}

const live = process.env.RUN_LIVE_LLM === '1';

describe.skipIf(!live)('live agent tool calling', () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve(PACKAGE_ROOT, 'src/server.ts')],
      cwd: PACKAGE_ROOT,
      stderr: 'ignore',
      env: { PATH: process.env.PATH ?? '', MCP_LOG_LEVEL: 'silent' }
    });
    client = new Client({ name: 'live-agent', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  it('advertises the two tools to the model as OpenAI function definitions', async () => {
    const { tools } = await client.listTools();
    const openAiTools = toOpenAiTools(tools);

    expect(openAiTools.map((tool) => tool.function.name)).toEqual(['get_customer_record', 'trigger_refund']);
    expect(openAiTools[1]?.function.parameters).toMatchObject({ type: 'object', additionalProperties: false });
  }, 60_000);

  it('asks for get_customer_record when the user asks about a customer (retried once: model choice is stochastic)', async () => {
    const { tools } = await client.listTools();
    const openAiTools = toOpenAiTools(tools);

    let observed: ToolCall[] = [];
    for (let attempt = 0; attempt < 2 && observed.length === 0; attempt += 1) {
      const completion = await chatCompletion(
        [
          { role: 'system', content: 'You are a customer operations agent. Always use the provided tools.' },
          { role: 'user', content: 'Look up the customer record for CUST-00001. Use the tool.' }
        ],
        openAiTools
      );
      observed = completion.choices[0]?.message.tool_calls ?? [];
    }

    expect(observed.length, 'the model returned no tool call in two attempts').toBeGreaterThan(0);
    const call = observed[0]!;
    expect(call.function.name).toBe('get_customer_record');
    expect(JSON.parse(call.function.arguments)).toMatchObject({ customer_id: 'CUST-00001' });
  }, 180_000);

  it('drives both tools and changes the balance the server reports', async () => {
    const { tools } = await client.listTools();
    const openAiTools = toOpenAiTools(tools);

    const before = await client.callTool({ name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } });
    const balanceBefore = (before.structuredContent as { balance_usd: number }).balance_usd;

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a customer operations agent. Always use the provided tools.' },
      {
        role: 'user',
        content:
          'Refund 5.00 USD to CUST-00001 with the reason "duplicate charge refund". Use the trigger_refund tool now.'
      }
    ];

    let refundCalled = false;
    for (let turn = 0; turn < 3 && !refundCalled; turn += 1) {
      const completion = await chatCompletion(messages, openAiTools);
      const message = completion.choices[0]?.message;
      const toolCalls = message?.tool_calls ?? [];
      if (toolCalls.length === 0) {
        messages.push({ role: 'user', content: 'Please call the trigger_refund tool for CUST-00001.' });
        continue;
      }

      messages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        const result = await client.callTool({
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments) as Record<string, unknown>
        });
        if (call.function.name === 'trigger_refund') refundCalled = true;
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.structuredContent ?? result.content)
        });
      }
    }

    expect(refundCalled, 'the model never called trigger_refund in three turns').toBe(true);

    const after = await client.callTool({ name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } });
    const record = after.structuredContent as { balance_usd: number; refunds: unknown[] };

    // Assert on state, not on prose: the refund is visible through the wire.
    expect(record.refunds.length).toBeGreaterThan(0);
    expect(record.balance_usd).toBeLessThan(balanceBefore);
  }, 180_000);
});
