# Live tests (opt-in)

Suites that hit a **real** model server. The graded behaviour (window arithmetic, atomicity,
failover, sanitization) is covered offline with scripted mock providers; the live suite exists to
prove the same code path against llama.cpp (`http://127.0.0.1:8080/v1`, model `qwen3.8-turbo`) — or any other
OpenAI-compatible server named by `LIVE_OPENAI_BASE_URL` / `LIVE_OPENAI_MODEL` (see `docs/LOCAL-LLM.md`).

```bash
RUN_LIVE_LLM=1 npm run test:live
```

Rules: file naming `*.live.test.ts`; gate with `describe.skipIf(process.env.RUN_LIVE_LLM !== '1')`;
always send an explicit `max_tokens` (llama.cpp defaults to `-1`); assert on accounting/headers/shapes,
not on model prose. Note that a single-slot llama.cpp server serialises concurrent requests — keep
live concurrency low and leave the atomicity assertions to the offline suite.
