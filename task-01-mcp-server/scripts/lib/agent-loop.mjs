/**
 * Tool-calling loop shared by `scripts/agent-demo.mjs`.
 *
 * Speaks OpenAI chat-completions to a local llama.cpp server, turns the MCP
 * `tools/list` result into OpenAI function definitions, executes whatever the
 * model asks for against the real MCP server, and feeds the results back.
 * Model-agnostic and dependency-free (global `fetch`).
 */

/** MCP `inputSchema` → OpenAI function parameters (drop the JSON Schema dialect key). */
export function toOpenAiTools(tools) {
  return tools.map((tool) => {
    const { $schema: _ignored, ...parameters } = tool.inputSchema ?? {};
    return {
      type: 'function',
      function: { name: tool.name, description: tool.description ?? '', parameters }
    };
  });
}

export async function chatCompletion({ baseUrl, model, messages, tools, maxTokens = 1024, signal }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: maxTokens,
      stream: false
    }),
    ...(signal === undefined ? {} : { signal })
  });
  if (!response.ok) {
    throw new Error(`live server responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

/**
 * Run the loop until the model stops asking for tools or `maxTurns` is reached.
 * `onToolCall` receives `{ name, arguments, result }` so the caller can print.
 */
export async function runAgentLoop({ mcp, baseUrl, model, messages, tools, maxTurns = 4, maxTokens = 1024, onToolCall }) {
  const transcript = [];

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const completion = await chatCompletion({ baseUrl, model, messages, tools, maxTokens });
    const message = completion.choices?.[0]?.message ?? {};
    const toolCalls = message.tool_calls ?? [];
    transcript.push({ turn, finishReason: completion.choices?.[0]?.finish_reason, content: message.content, toolCalls });

    if (toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: message.content ?? '' });
      break;
    }

    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const args = JSON.parse(call.function.arguments || '{}');
      const result = await mcp.request('tools/call', { name: call.function.name, arguments: args });
      const payload = result.error ?? result.result;
      if (onToolCall !== undefined) onToolCall({ name: call.function.name, args, payload });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(payload)
      });
    }
  }

  return transcript;
}
