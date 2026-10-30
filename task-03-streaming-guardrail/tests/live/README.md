# Live tests (opt-in)

Suites that stream from a **real** model server. The offline suite already covers the hard parts
(split boundaries, SSE framing, latency, memory bound) with a scripted mock upstream, so these tests
exist to prove the guardrail behaves against a real provider stream — including `delta.reasoning_content`,
which the reference llama.cpp server emits as a separate field. Point them at another server with
`LIVE_OPENAI_BASE_URL` / `LIVE_OPENAI_MODEL` (see `docs/LOCAL-LLM.md`).

```bash
RUN_LIVE_LLM=1 npm run test:live
```

Rules: file naming `*.live.test.ts`; gate with `describe.skipIf(process.env.RUN_LIVE_LLM !== '1')`;
always send an explicit `max_tokens` (llama.cpp defaults to `-1`); assert on redaction invariants and
JSON shapes, not on model prose.
