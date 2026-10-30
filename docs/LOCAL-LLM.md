# Local model server (OpenAI-compatible) & live tests

Tasks 3 and 4 are gateways in front of an **OpenAI-compatible chat-completions API**. The default
target in this repo is a local **llama.cpp** server; the code is provider-agnostic.

> Everything in `npm run verify` is hermetic. This document only matters for the *opt-in* live
> suites (`RUN_LIVE_LLM=1 npm run test:live`) and for the manual demos.

## Reference environment (verified)

| Property | Value |
| --- | --- |
| Server | `llama-server` (llama.cpp, build `b10868-304665fe7`) |
| Base URL | `http://127.0.0.1:8080/v1` |
| Model id | `qwen3.8-turbo` (27.3B params, `Q4_K - Medium`, ~18.5 GB GGUF, `n_ctx` 165,120, 248k vocab) |
| Extras | `GET /health` → `{"status":"ok"}`; `GET /props` → chat template + generation defaults; `GET /metrics` → Prometheus |
| Alternate (also verified) | Ollama 0.11.4 on `http://127.0.0.1:11434/v1` |

```bash
export LIVE_OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export LIVE_OPENAI_MODEL=qwen3.8-turbo
curl -s "$LIVE_OPENAI_BASE_URL/models" | head -c 200
```

## Behaviour the implementation relies on (measured, not assumed)

1. **Tool calling works.** A `tools` request returns
   `finish_reason: "tool_calls"` with `message.tool_calls[].function.{name,arguments}` — `arguments`
   is a **JSON string** that must be parsed. The message also carries a `reasoning_content` field.
   ```
   finish: tool_calls
   tool_calls: [{"type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"},
                 "id":"Hl1u1B2DJjPbZCrjlQs64qJTWn5v4BLx"}}]
   ```
2. **Reasoning is a separate stream field.** Streaming deltas look like
   `{"delta":{"reasoning_content":"\n\n"}}` and later `{"delta":{"content":"..."}}`. A guardrail that
   only redacts `delta.content` leaks PII emitted as reasoning — Task 3 therefore redacts
   `content`, `reasoning_content` **and** `tool_calls[].function.arguments`.
3. **`stream_options.include_usage` is supported.** The final chunk arrives with `choices: []` plus
   `usage` (and llama.cpp-specific `timings`), immediately before `data: [DONE]`. Task 3 passes it
   through untouched; Task 4 uses it to reconcile reserved tokens with actual usage.
   ```
   data: {"choices":[], ..., "usage":{"prompt_tokens":210,"completion_tokens":64,"total_tokens":274}}
   data: [DONE]
   ```
4. **`max_tokens` defaults to `-1` (unbounded)** in `/props`. Always send an explicit `max_tokens`
   in live tests, or a chatty reasoning model will generate until the context limit.
5. **Reasoning models need budget.** With a small budget the model can spend the entire allowance
   inside `reasoning_content` and return `finish_reason: "length"` with no `content` and no tool
   call. Task 1's tool-calling loop sends `LIVE_OPENAI_MAX_TOKENS` (default 1024, never below 512), the
   other live suites send at least 512, and all of them assert on structure, not exact prose.
6. **Timings/slot notes.** llama.cpp reports per-request `timings` and the server exposes slot
   counts via `/props` (`total_slots`); with few slots, concurrent live requests queue rather than
   fail — which is why Task 4's concurrency assertions run against in-process mock providers.

## Running the live suites

```bash
cp .env.example .env            # defaults already point at 127.0.0.1:8080/v1
RUN_LIVE_LLM=1 npm run test:live                 # all tasks
cd task-03-streaming-guardrail && RUN_LIVE_LLM=1 npm run test:live   # one task
```

Every live suite and every `npm run demo:live` reads the same two settings, `LIVE_OPENAI_BASE_URL` and
`LIVE_OPENAI_MODEL`, from the process environment or the repo-root `.env` (the process environment wins).
Tasks 3 and 4 also accept `GUARDRAIL_LIVE_BASE_URL` / `GUARDRAIL_LIVE_MODEL` and `ROUTER_LIVE_BASE_URL` /
`ROUTER_LIVE_MODEL` to point their own suite somewhere else. The live demos look for a server with
`GET <base>/models`, which every OpenAI-compatible server answers.

Live tests are written to be **structure-first**: they assert on JSON-RPC shapes, redaction
invariants, token accounting and header behaviour — never on model prose. If a live assertion is
inherently stochastic it is documented as such in the task README and retried once.

## Using a different provider

```bash
# Live suites and live demos: one server for all of them (Ollama shown)
LIVE_OPENAI_BASE_URL=http://127.0.0.1:11434/v1
LIVE_OPENAI_MODEL=qwen3:8b

# The services themselves (`npm start`) read their own prefix
GUARDRAIL_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1   # Task 3 upstream (Ollama)
ROUTER_PRIMARY_BASE_URL=https://api.openai.com/v1       # Task 4 primary: any hosted provider
ROUTER_PRIMARY_MODEL=gpt-4o-mini
ROUTER_PRIMARY_API_KEY=sk-...                           # never commit this
```

Mock providers used by the offline tests (`tests/**/helpers/mockUpstream.ts`) implement the same
contract, so switching between a mock and a real server never changes the gateway code paths.
