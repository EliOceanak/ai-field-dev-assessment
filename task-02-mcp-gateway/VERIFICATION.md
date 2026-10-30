# VERIFICATION — Task 2 (MCP security gateway proxy)

Captured on Node v24.3.0 (npm 11.4.2,
Linux Mint 21.3) on 2026-10-29. Every command below was run from a clean working tree; nothing is
paraphrased and nothing is a projection. The four task files are aggregated in `docs/VERIFICATION.md`.

| Command | Result |
| --- | --- |
| `npm run hygiene` | exit 0 — `logging hygiene: OK (9 file(s) scanned in src)` |
| `npm run typecheck` | exit 0 — no diagnostics |
| `npm test` | exit 0 — **11 files, 183 tests passed** |
| `npm run test:live` | exit 0 — no live suites for this task (`passWithNoTests`) |
| `npm run demo` | exit 0 — 5 scenarios, 2 denials, 0 unauthorized upstream calls |
| `npm run verify` (repo root) | exit 0 — 676 tests across the four workspaces (180 + 183 + 154 + 159) |

---

## 1. `npm run hygiene && npm run typecheck && npm test`

```
> task-02-mcp-gateway@1.0.0 test
logging hygiene: OK (9 file(s) scanned in src)
 RUN  v5.0.5 /home/eli/Documents/quilr_test/ai-field-dev-assessment/task-02-mcp-gateway
 ✓ tests/unit/tool-policy.test.ts (30 tests) 7ms
 ✓ tests/unit/auth.test.ts (25 tests) 63ms
 ✓ tests/unit/jsonrpc-envelope.test.ts (38 tests) 12ms
 ✓ tests/unit/config.test.ts (6 tests) 8ms
 ✓ tests/integration/forwarding.test.ts (20 tests) 92ms
 ✓ tests/integration/authorization.test.ts (19 tests) 90ms
 ✓ tests/integration/batch.test.ts (14 tests) 89ms
 ✓ tests/interop/real-sdk-downstream.test.ts (5 tests) 86ms
 ✓ tests/integration/error-handling.test.ts (20 tests) 189ms
 ✓ tests/integration/server-lifecycle.test.ts (2 tests) 525ms
 ✓ tests/integration/sse-passthrough.test.ts (4 tests) 651ms
 Test Files  11 passed (11)
      Tests  183 passed (183)
   Duration  859ms (tests 67%, import 28%, transform 4%, worker 1%)
```

`npm run test:live` (opt-in suite, `RUN_LIVE_LLM=1`) exits 0 — this task has no live/model-dependent
behaviour by design (everything here is wire-level):

```console
$ npm run test:live
> task-02-mcp-gateway@1.0.0 test:live
> vitest run --config vitest.live.config.ts

 RUN  v5.0.5 /home/eli/Documents/quilr/task-02-mcp-gateway

No test files found, exiting with code 0

include: tests/live/**/*.live.test.ts
$ echo $?
0
```


---

## 2. `npm run demo` — the decisive scenarios

```console
$ npm run demo
> task-02-mcp-gateway@1.0.0 demo
> node scripts/demo.mjs

MCP security gateway — offline demo
===================================
downstream mock : http://127.0.0.1:37313/mcp
gateway         : http://127.0.0.1:44735/mcp
tokens          : minted with scripts/mint-token.mjs (viewer, admin; 1 h ttl)

1. viewer  → tools/list                 ← 200, 4 tools visible (transparent) ✔
                                          downstream calls: 1
2. viewer  → tools/call admin_reset_key ← 200 {"error":{"code":-32001,"message":"Unauthorized tool call"}}   downstream calls: 0 ✔
3. admin   → tools/call admin_reset_key ← 200 {"result":…}   downstream calls: 1 ✔
4. admin   → tools/call trigger_refund  ← 200 {"result":…}   downstream calls: 2 ✔
5. no auth → tools/list                 ← 401 WWW-Authenticate: Bearer realm="mcp-gateway", error="invalid_token" ✔

summary: 5 scenarios, 2 denials, 0 unauthorized upstream calls ✔
$ echo $?
0
```

`scripts/demo.mjs` starts the mock downstream and the **real gateway process** (`tsx src/server.ts`) on
ephemeral ports and drives them over HTTP, so the transcript is produced by the shipped code paths, not
by an in-process shortcut. The failure path was probed by temporarily changing one expectation
(`tools.length === 4` → `=== 5`) — the demo printed the failing check and exited 1:

```console
$ node scripts/demo.mjs   # with one expectation deliberately broken
...
summary: 5 scenarios, 2 denials, 0 unauthorized upstream calls ✔

  ✖ scenario 1: expected all 4 tools to be visible
$ echo $?
1
```

`scripts/demo.mjs` was restored byte-identically afterwards (`diff -q` reported no differences).

## 3. The decisive assertion, in test form

`tests/integration/authorization.test.ts` — the mock downstream exposes its call recorder, so the
denial is proven twice over: the response shape *and* the fact that the downstream never saw the request.

```console
$ npx vitest run tests/integration/authorization.test.ts --reporter=verbose
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > intercepts a viewer admin_reset_key call with -32001 and never touches the downstream 21ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > intercepts a viewer admin_list_tenants call (no arguments) with zero downstream calls 4ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > echoes a string id exactly as received on a denial 2ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > echoes id 0 on a denial (no falsy-id confusion) 2ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > forwards an admin admin_reset_key call and executes it downstream 5ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > treats an unknown role as least privilege (non-admin, but still a valid credential) 4ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > denies an admin_-prefixed tool the downstream does not even have 2ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > normalises surrounding whitespace before the prefix check 2ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > drops a denied notification silently (202, no body, no downstream call) 3ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > allows a viewer to call a non-privileged tool 2ms
 ✓ tests/integration/authorization.test.ts > method-level authorization (admin_* requires the admin role) > logs the decision without ever logging the credential 2ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

The assertion itself (`tests/integration/authorization.test.ts`):

```ts
// The decisive assertion for this task: the downstream server saw nothing at all.
expect(mock.calls.length).toBe(0);
```

`tests/interop/real-sdk-downstream.test.ts` repeats the proof against a **real** MCP server: the
downstream's own tool handlers record their invocations, and `downstream.invocations` is still empty
after a blocked viewer call.

## 4. Raw evidence: responses and audit lines

Captured by driving the real gateway (in-process, real mock downstream) with `fetch`:

```
A: 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Unauthorized tool call",
        "data":{"tool":"admin_reset_key","required_role":"admin","reason":"insufficient_role"}}}
B: 401 {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request",
        "data":{"reason":"missing_header"}}}
C: 200 {"jsonrpc":"2.0","id":3,"result":{"tools":[ get_customer_record, trigger_refund,
        admin_reset_key, admin_list_tenants ]}}      ← transparent, all four tools visible
```

The gateway's stderr for those three requests (one JSON object per line, verbatim):

```json
{"ts":"2026-10-29T18:53:36.126Z","level":"info","event":"http_request","service":"mcp-gateway","reqId":"dee8a4b0-8799-4afe-8719-3f4c59dbfecb","method":"POST","path":"/mcp","bytesIn":123}
{"ts":"2026-10-29T18:53:36.126Z","level":"info","event":"policy_decision","service":"mcp-gateway","reqId":"dee8a4b0-8799-4afe-8719-3f4c59dbfecb","role":"viewer","subject":"viewer-user","tokenId":"ebe630ca2e7d","method":"tools/call","decision":"deny","reason":"insufficient_role","tool":"admin_reset_key","requiredRole":"admin"}
{"ts":"2026-10-29T18:53:36.131Z","level":"warn","event":"auth_failure","service":"mcp-gateway","reqId":"46a1d38f-2260-4378-96a8-89300a38a759","reason":"missing_header","path":"/mcp"}
{"ts":"2026-10-29T18:53:36.132Z","level":"info","event":"http_request","service":"mcp-gateway","reqId":"0b811d80-fad8-4320-afcc-a0f37db2c3b4","method":"POST","path":"/mcp","bytesIn":46}
{"ts":"2026-10-29T18:53:36.132Z","level":"info","event":"policy_decision","service":"mcp-gateway","reqId":"0b811d80-fad8-4320-afcc-a0f37db2c3b4","role":"viewer","subject":"viewer-user","tokenId":"ebe630ca2e7d","method":"tools/list","decision":"allow","reason":"transparent_method"}
{"ts":"2026-10-29T18:53:36.135Z","level":"info","event":"proxy_request","service":"mcp-gateway","reqId":"0b811d80-fad8-4320-afcc-a0f37db2c3b4","upstreamStatus":200,"durationMs":1,"bytesOut":1174,"streaming":false}
```

Three things to read out of this:

1. The **denied** request (`dee8a4b0…`) has a `policy_decision` line and **no `proxy_request` line** —
   there was no upstream call to report.
2. The credential appears only as `tokenId: "ebe630ca2e7d"` (a truncated SHA-256) and `subject`.
   The raw bearer token appears nowhere in the logs (also asserted by a test that greps the whole
   captured stderr buffer for the token).
3. The missing-credential request produced `auth_failure` + a 401, and **no `http_request` line** —
   authentication is decided before the body is inspected.


## 5. `npm run verify` from the repository root

```console
$ npm run verify > /tmp/verify-final.log 2>&1        # from the repository root
$ echo $?
0
$ grep -E 'Test Files|Tests ' /tmp/verify-final.log
 Test Files  10 passed (10)
      Tests  180 passed (180)      # task-01
 Test Files  11 passed (11)
      Tests  183 passed (183)      # task-02  ← this deliverable
 Test Files  9 passed (9)
      Tests  154 passed (154)      # task-03
 Test Files  17 passed (17)
      Tests  159 passed (159)      # task-04
$ grep -c 'hygiene: OK' /tmp/verify-final.log
8
```

`npm run verify` = `hygiene && doc paths && typecheck && test` across all four workspaces: 676 tests, 0 failures,
both hygiene guards (stdout for task-01, logging for tasks 2-4) green.

## 6. What was deliberately *not* verified

- **Live/model behaviour.** Nothing in this task talks to a model; the opt-in live suite is empty on
  purpose (`vitest.live.config.ts` → `passWithNoTests`).
- **A real OAuth 2.1 authorization server.** Tokens are self-issued HMAC tokens; the OAuth resource-server
  flow is listed as future work in the README.
- **Long-lived SSE (minutes) and back-pressure under a slow consumer.** The SSE test covers incremental
  delivery over ~120 ms and asserts the chunks arrive separately; sustained streaming back-pressure is
  covered by the `waitForDrain` path but not by a dedicated test.
- **`Mcp-Session-Id` stateful downstream sessions.** The header is forwarded (asserted), but no test
  drives a stateful session end-to-end.

