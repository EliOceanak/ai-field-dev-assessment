# Live tests (opt-in)

Reserved for suites that need something outside this package: a real MCP server process, a real model
server, or the MCP Inspector. The graded behaviour of Task 2 is fully covered by the offline suites
(`tests/unit`, `tests/integration`, `tests/interop`), which run mock and real-SDK servers in-process.

```bash
RUN_LIVE_LLM=1 npm run test:live
```

Rules: file naming `*.live.test.ts`; gate with `describe.skipIf(process.env.RUN_LIVE_LLM !== '1')`;
assert on protocol shapes, not on model prose; keep the total runtime under ~2 minutes.
