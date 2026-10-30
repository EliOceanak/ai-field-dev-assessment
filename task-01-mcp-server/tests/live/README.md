# Live tests (opt-in)

These tests talk to a **real OpenAI-compatible model server** (llama.cpp on
`http://127.0.0.1:8080/v1` by default) and require a model that supports tool calls
(`qwen3.8-turbo` in the reference environment). Point them at another server with
`LIVE_OPENAI_BASE_URL` / `LIVE_OPENAI_MODEL` (see `docs/LOCAL-LLM.md`).

```bash
RUN_LIVE_LLM=1 npm run test:live
```

Rules for this folder:

- File naming: `*.live.test.ts` — the offline suite excludes them, `vitest.live.config.ts` includes them.
- Gate every suite with `describe.skipIf(process.env.RUN_LIVE_LLM !== '1')` so a plain `npm test` run stays green.
- Assert on **structure** (JSON-RPC shapes, redaction invariants, headers, token accounting), never on
  model prose; retry once if a check is inherently stochastic, and say so in the test name.
- Always send an explicit `max_tokens` — llama.cpp defaults to `-1` (unbounded).
- Keep the total live runtime under ~2 minutes.
