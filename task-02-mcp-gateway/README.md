# Task 2 — MCP security gateway proxy (tool filtering & auth)

> **Problem statement (from [`ASSESSMENT.md`](../ASSESSMENT.md))**
>
> Build a lightweight HTTP/JSON-RPC reverse proxy (Node.js or Python) that acts as an MCP Gateway
> between an AI agent client and a downstream mock MCP server.
>
> **Requirements**
> - Read an incoming `Bearer <token>` HTTP header and extract the user's role (e.g. `admin`, `viewer`).
> - Inspect the incoming MCP JSON-RPC payload:
>   - `tools/list` → forward transparently to the downstream server.
>   - `tools/call` → inspect `params.name`. If it starts with `admin_` (e.g. `admin_reset_key`),
>     require the `admin` role; otherwise intercept and return JSON-RPC error **`-32001`
>     Unauthorized Tool Call** *without calling the downstream server*.
>
> **Scored on** — JSON-RPC wire-format parsing · proxy middleware construction and forwarding ·
> fine-grained, method-level authorization and clean error handling.

**Status:** implemented — bearer auth, `admin_*` authorization, batch handling, hardened `tools/list` filter, real-SDK interop test, file-driven policy.

An Express 5 HTTP/JSON-RPC reverse proxy in front of a downstream MCP server. It authenticates a
`Bearer` token, resolves the caller's role, forwards `tools/list` **transparently**, and intercepts
`tools/call` for `admin_*` tools when the role is not `admin` — answering JSON-RPC `-32001`
**without the downstream server ever seeing the request**. The decisive test asserts the denial *and*
that the mock downstream's call counter is still zero.

## What this demonstrates

- **JSON-RPC wire-format parsing** — `src/middleware/jsonrpc.ts` parses the body *once*, keeps the raw
  text, and validates the envelope: single requests, batches, notifications, `id` as number/string/`0`/`null`,
  absent `params`, empty batches. `-32700` (not JSON) and `-32600` (not an envelope) are distinguished
  because the raw text survives, and a body that repeats a key is refused before any decision.
  → `tests/unit/jsonrpc-envelope.test.ts` (38 cases)
- **Proxy middleware construction & HTTP forwarding** — `src/server.ts` is an explicit six-stage Express
  pipeline; `src/proxy/forwarder.ts` owns header hygiene, a bounded time-to-headers and an unbuffered
  body. Allowed requests are forwarded **byte-identically** (the raw body text is reused) and the
  response — including `text/event-stream` — is piped back untouched. → `tests/integration/forwarding.test.ts`,
  `tests/integration/sse-passthrough.test.ts`
- **Fine-grained, method-level authorization** — `src/policy/toolPolicy.ts` is a pure decision function
  (prefix rule → `requiredRole`), with per-element evaluation for batches. → `tests/unit/tool-policy.test.ts`,
  `tests/integration/authorization.test.ts`, `tests/integration/batch.test.ts`
- **Clean error handling** — every status in the contract table below is produced by
  `src/errors/gatewayErrors.ts` and asserted, including sanitized 502/504 with no upstream URL, port,
  body or stack trace. → `tests/integration/error-handling.test.ts` (18 cases)
- **Real MCP server behind the gateway** — `mock/sdkDownstream.ts` is a genuine `McpServer` +
  `StreamableHTTPServerTransport`; the real SDK client drives it *through* the gateway and the server's
  own tool handlers prove a blocked `admin_*` call never arrived. → `tests/interop/real-sdk-downstream.test.ts`

## Architecture

```
 client (agent / SDK / curl)
   │  POST /mcp   Authorization: Bearer <token>   Content-Type: application/json
   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ src/server.ts — Express 5 pipeline (one decision per stage, one audit line per decision)  │
│                                                                                          │
│  1. requestId        x-request-id (or a UUID) → res.locals.reqId, echoed as x-gateway-req-id
│  2. body             express.raw, 1 MiB cap  → the body is read ONCE and kept as TEXT     │
│  3. authenticate     src/middleware/auth.ts   → Principal { role, subject, tokenId }      │
│        missing / malformed / tampered / expired ─────────────────► 401 + WWW-Authenticate │
│  4. envelope         src/middleware/jsonrpc.ts → single | batch | error                   │
│        not JSON ─► 400 -32700 · not an envelope ─► 400 -32600                            │
│  5. policy           src/policy/toolPolicy.ts  → allow | deny (per element)               │
│        deny (request) ─────────────────────────► 200 + JSON-RPC -32001   ← NO UPSTREAM    │
│        deny (notification) ────────────────────► 202, no body            ← NO UPSTREAM    │
│  6. forward          src/proxy/forwarder.ts    → fetch(downstream, raw body, safe headers)│
│        unreachable ─► 502 · timeout ─► 504 (sanitized -32603)                             │
│  7. pipe back        status + headers + body bytes, streamed (SSE never buffered)         │
└──────────────────────────────────────────────────────────────────────────────────────────┘
   │  POST /mcp   (raw body, Accept/Content-Type mirrored, caller Authorization stripped)
   ▼
 downstream MCP server  (mock/downstream.ts · mock/sdkDownstream.ts · any MCP server)
```

**Decision state machine** (`src/policy/toolPolicy.ts`, first match wins):

```
message.method ──┬── tools/list ─────────────────────────────────────► ALLOW (always, every role)
                 │
                 ├── tools/call ──┬── params.name starts with a privileged prefix ("admin_")
                 │                │        ├── role === requiredRole ("admin") ──► ALLOW → forward
                 │                │        └── otherwise ─────────────────────► DENY  → -32001, no upstream
                 │                └── otherwise ──────────────────────────────► ALLOW → forward
                 │
                 └── anything else (unknown methods included) ───────────────► ALLOW → forward
                                                                                (downstream answers -32601)
```

With a policy file (`GATEWAY_POLICY_FILE`), `deny` globs are evaluated first and cannot be overridden;
`allow` globs are evaluated last and can never escalate past the prefix rule.


## Grader quickstart

```bash
npm ci                     # repo root
cd task-02-mcp-gateway
npm test                   # offline: auth, policy, forwarding, batch, SSE, real-SDK interop
npm run demo               # viewer denied admin_reset_key, admin allowed, tools/list transparent
```

## HTTP status contract

This table is authoritative: every row is asserted in `tests/integration/error-handling.test.ts`,
`tests/integration/authorization.test.ts` or `tests/integration/batch.test.ts`.

| Situation | HTTP | Body | Why |
| --- | --- | --- | --- |
| missing / malformed / tampered / expired bearer | **401** + `WWW-Authenticate: Bearer realm="mcp-gateway", error="invalid_token"` | JSON-RPC `-32600` `Invalid request`, `id: null`, `data: { reason }` (`missing_header` · `malformed_header` · `invalid_token`; the precise cause is in the audit log) | transport-level authentication. The credential is part of the HTTP envelope, not of the JSON-RPC request, so `-32600` is the honest code; `-32001` is reserved for the tool-authorization case the brief names |
| authenticated caller, `tools/call` on `admin_*` without the `admin` role | **200** | JSON-RPC `-32001` `Unauthorized tool call`, `id` echoed exactly, `data: { tool, required_role: "admin", reason: "insufficient_role" }` | the request was understood and *answered*; the caller is simply not allowed. 403 would make MCP clients treat it as a transport failure and never surface the error to the model. **No upstream request is made.** |
| authenticated caller, `tools/call` on `admin_*` as a **notification** | **202** | empty | a denied notification is dropped silently: there is nothing to answer, and it must not reach the downstream |
| malformed JSON body | **400** | JSON-RPC `-32700` `Parse error`, `id: null` | the body is not JSON |
| valid JSON, not a JSON-RPC 2.0 envelope (or an empty batch) | **400** | JSON-RPC `-32600` `Invalid request`, `id: null` (echoed when the `id` itself was well-formed) | the body is not a JSON-RPC request |
| valid JSON whose objects repeat a key (any depth, single or batch) | **400** | JSON-RPC `-32600` `Invalid request`, `id: null`, `data: { reason: "duplicate_key", key }` | parsers disagree on which duplicate wins, and the downstream parses the original text — see the design notes |
| batch with mixed valid/invalid elements | **200** | array, one entry per original position: per-element `-32600` for invalid elements, merged results for the rest | JSON-RPC 2.0 §6 requires per-element errors and forbids an empty response array |
| body larger than `GATEWAY_MAX_BODY_BYTES` | **413** | JSON-RPC `-32600`, `data: { reason: "body_too_large", limit }` | bounded read, rejected before any decision |
| notification only (no `id`) | **202** | empty | MCP Streamable HTTP: notifications are acknowledged with 202 and no body |
| downstream unreachable | **502** | sanitized JSON-RPC `-32603` `Bad gateway`, `data: { reqId }` | no upstream URL, port, error text or stack trace is ever included |
| downstream slower than `GATEWAY_UPSTREAM_TIMEOUT_MS` (time to **headers**) | **504** | sanitized JSON-RPC `-32603` `Gateway timeout`, `data: { reqId }` | same sanitization; the timeout does not apply once the body is streaming |
| allowed request | downstream status | **byte-identical** downstream body, same `Content-Type` | transparency: status, headers and bytes pass through; `text/event-stream` is piped frame by frame |
| `GET /mcp` | **405** + `Allow: POST` | JSON-RPC `-32600`, `data: { reason: "method_not_allowed" }` | the standalone GET SSE stream is not proxied (see limitations) |
| `GET /health` | **200** | `{ "status": "ok", "service": "mcp-gateway" }` | liveness probe |
| any other path | **404** | `{ "error": "not_found" }` | not a JSON-RPC endpoint |
| unexpected gateway failure | **500** | sanitized JSON-RPC `-32603` `Internal error`, `data: { reqId }` | last-resort handler; never a stack trace |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_PORT` | `8787` | listen port |
| `GATEWAY_DOWNSTREAM_URL` | `http://127.0.0.1:8788/mcp` | downstream MCP endpoint |
| `GATEWAY_TOKEN_SECRET` | `dev-secret-change-me` | HMAC secret for signed bearer tokens |
| `GATEWAY_DEV_TOKENS` | `admin:admin-dev-token,viewer:viewer-dev-token` | static dev tokens |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | `10000` | bound on **time to downstream response headers** (not the whole exchange, so long SSE streams survive) |
| `GATEWAY_FILTER_TOOL_LIST` | `false` | hardened mode: strip `admin_*` from `tools/list` for non-admin roles (defence in depth; off because the brief demands transparency) |
| `GATEWAY_FORWARD_CLIENT_AUTH` | `false` | forward the caller's Authorization downstream (default: strip it) |
| `GATEWAY_DOWNSTREAM_TOKEN` | _(unset)_ | service credential injected downstream as `Authorization: Bearer <token>` |
| `GATEWAY_MAX_BODY_BYTES` | `1048576` | request body cap; larger bodies get 413 |
| `GATEWAY_POLICY_FILE` | _(unset)_ | path to a JSON policy file (see `config/policy.example.json`) |
| `GATEWAY_LOG_LEVEL` | `info` | stderr logger threshold (`debug`\|`info`\|`warn`\|`error`\|`silent`) |

Signed tokens are minted with `npm run mint-token -- --role admin --ttl 3600`
(`node scripts/mint-token.mjs`); the static dev tokens above exist so a reviewer can `curl` the gateway
without minting anything. Both credential kinds are accepted; signed tokens are checked first.

## Test matrix

| Criterion | Test file | What it proves |
| --- | --- | --- |
| JSON-RPC envelope parsing (single, batch, notification, `id` types) | `tests/unit/jsonrpc-envelope.test.ts` | 38 cases: single/batch/notification, `id` as number/`0`/string/empty/`null`, missing or wrong `jsonrpc`, non-string `method`, object `id`, primitive `params`, empty batch, all-invalid batch, `-32700` vs `-32600`, duplicate keys (escaped, nested, in a batch; braces and quotes inside strings), `httpStatusFor` table, `sanitizeMessage` leak patterns |
| bearer → principal (valid, tampered, expired, wrong secret, unknown role) | `tests/unit/auth.test.ts` | 25 cases: signed-token verification order (structure → HMAC → `exp`), tampered payload, wrong secret, expiry boundary, unknown role, malformed header, missing header, dev tokens, `Bearer` casing/whitespace, repeated header, the exact `WWW-Authenticate` string, and a spawned `scripts/mint-token.mjs` whose output the verifier accepts (no CLI/middleware drift) |
| policy table (prefix rule, per-role allow/deny, unknown tool passthrough) | `tests/unit/tool-policy.test.ts` | the full role × method × tool decision table, custom prefixes and `requiredRole`, deny-glob precedence, allow-glob non-escalation, whitespace normalisation, hardened `tools/list` filter, `config/policy.example.json` |
| `tools/list` transparent for every role | `tests/integration/forwarding.test.ts` | viewer *and* admin get a **byte-identical** body (compared against a direct fetch of the downstream), same `Content-Type`, all four tools visible; the forwarded request body is byte-identical too |
| viewer + `admin_*` → `-32001` AND zero downstream calls | `tests/integration/authorization.test.ts` | **`mock.calls.length === 0`**, `id` echoed for number/`0`/string ids, `data:{tool,required_role,reason}`, HTTP 200 with no challenge header, prefix check on a tool the downstream does not even have, whitespace normalisation, denied notifications dropped, and the credential never appears in the logs |
| admin + `admin_*` → forwarded, byte-identical | `tests/integration/authorization.test.ts` | the tool executes downstream (`rotated: true`) and the call counter moves to 1 |
| batch: mixed allow/deny, per-item errors merged | `tests/integration/batch.test.ts` | ordered merge by original position, upstream reordering handled by `id`-matching, per-element `-32600` for invalid elements, fully denied batch makes **no** upstream request, untouched batch forwarded byte-identically, notification batches → 202, empty batch → 400 |
| notifications forwarded, no response | `tests/integration/forwarding.test.ts` | 202 with an empty body, and the downstream recorded the notification |
| SSE/streaming passthrough without buffering | `tests/integration/sse-passthrough.test.ts` | the body arrives in ≥ 4 separate chunks (buffering would collapse it into one), the first frame lands while the stream is still open, frames are byte-identical to the downstream's, no `Content-Length`, and the audit line is marked `streaming: true` |
| error handling (401 vs 200+JSON-RPC, malformed, downstream down) | `tests/integration/error-handling.test.ts` | 18 cases: the 401 table with the exact challenge, auth-before-parse ordering, `-32700`, `-32600`, 413, 502/504 sanitization (no URL/port/`ECONNREFUSED`), `reqId` correlation, 405 + `Allow`, 404, `/health` |
| header hygiene (pure) | `tests/integration/forwarding.test.ts` | the deny-list drops hop-by-hop, `Host`, `Content-Length`, `Content-Encoding`, `Cookie`, `Authorization` and forces `Accept-Encoding: identity`; response framing headers are dropped; a gzip request reaches the downstream decoded and without `Content-Encoding` |
| a malformed sibling cannot smuggle an unchecked call into a batch | `tests/integration/batch.test.ts` | three bypass payloads (missing `jsonrpc`, `jsonrpc: "1.0"`, object `id`) each leave the downstream with no mention of `admin_reset_key`, and an untouched batch is still byte-identical |
| duplicate keys cannot split the decision from the execution | `tests/integration/authorization.test.ts` | a duplicate `method`, a duplicate tool `name` and a duplicate inside one batch element are each refused with `400` / `-32600` (`duplicate_key`) and the downstream records **zero** calls |
| an unnameable `tools/call` fails closed | `tests/unit/tool-policy.test.ts`, `tests/integration/authorization.test.ts` | a missing / numeric / object / null `name` gets `-32602` with `data.reason: unnameable_tool` and **zero** downstream calls, for a viewer and for an admin |
| one reason per credential failure | `tests/integration/error-handling.test.ts` | seven authentication failures map to three client-visible reasons, while the audit log keeps the precise one |
| default credentials are announced | `tests/integration/error-handling.test.ts` | `insecure_defaults_active` at boot + `insecureDefaults: true` on `/health`, and silence once both are configured |
| real SDK Streamable HTTP server behind the gateway | `tests/interop/real-sdk-downstream.test.ts` | a genuine `McpServer` + `StreamableHTTPServerTransport` driven by the real SDK client *through* the gateway: handshake, identical `tools/list` for both roles, `-32001` for a viewer with the server's own handler recorder still empty, admin succeeds, anonymous client rejected with 401 |
| process lifecycle (`GATEWAY_PORT`, fail-fast config, SIGTERM) | `tests/integration/server-lifecycle.test.ts` | the spawned entry point binds the configured port, logs host + path (never the full downstream URL), serves `/health`, exits 0 on SIGTERM, and rejects an invalid configuration with a readable multi-line message on stderr |
| offline demo (`npm run demo`) | `scripts/demo.mjs` | the 5-scenario transcript, exit code 1 if any expectation fails |


## Design notes & trade-offs

**Why `-32001`, and why it is a legacy code.** The `2026-07-28` MCP revision marks the whole
`-32000 … -32019` sub-range as legacy and forbids allocating *new* codes there
(`docs/SDK-AND-PROTOCOL-NOTES.md`). This gateway still returns `-32001`, because the brief mandates
that exact code and existing MCP clients already read it as "unauthorized tool call". The gateway
allocates no codes of its own, and it never uses `-32001` for anything except the tool-authorization
decision — so a client that treats `-32001` as "you are not allowed to call this tool" is exactly
right. The trade-off is documented rather than hidden.

**Byte-identical forwarding, but only for an untouched batch.** `tools/list` and any request the policy
leaves alone are forwarded as the *original text*, so the downstream sees exactly what the client sent.
A batch is only "untouched" when **no element failed envelope validation and every valid element was
allowed** — otherwise the body is re-serialized from the allowed set alone. Checking only the *valid*
elements is not enough: a batch like
`[tools/list, {"id":2,"method":"tools/call","params":{"name":"admin_reset_key"}}]` (no `jsonrpc` field)
would be forwarded verbatim — including the element that was never policy-checked — and a viewer would
reach `admin_reset_key` on a lenient downstream. A security gateway must not depend on the downstream
being strict; `tests/integration/batch.test.ts` sends three such payloads and asserts the downstream
received no mention of the admin tool.

**Original text is only forwarded when it is unambiguous.** RFC 8259 leaves duplicate object keys
undefined: `JSON.parse` keeps the last one, other parsers keep the first or reject the object. So
`{"method":"tools/call","method":"tools/list","params":{"name":"admin_reset_key"}}` would be authorized
here as `tools/list` while a first-key-wins downstream ran `admin_reset_key` from the same bytes. The
envelope parser therefore refuses any body whose objects repeat a key (compared after unescaping, at any
depth, batch or not) with `400` / `-32600` and `data.reason: "duplicate_key"`, before a policy decision is
made. Legitimate JSON encoders never emit duplicates, so the cost is one linear scan of the body.

**Fail closed on an unnameable tool call.** A `tools/call` whose `params.name` is missing or not a string
cannot be matched against the policy, so it is refused with `-32602` (`reason: unnameable_tool`) rather
than forwarded: forwarding it would let a caller reach a privileged tool by hiding the name in a type.
A non-`tools/call` method without a name is still transparent.

**One client-visible reason per credential failure.** `missing_header` and `malformed_header` describe the
*request* and stay specific; everything about the *credential* (`malformed_token`, `invalid_signature`,
`expired`) collapses to `invalid_token` in the response, so the body cannot be used to tell "unparseable"
from "forged" or "expired". The precise reason is in the audit log (`auth_failure`).

**Shipped-by-default credentials are loud, not silent.** The dev secret and the two dev tokens exist so
`npm test` and `npm run demo` work with no setup; a gateway running with them logs
`insecure_defaults_active` at boot and reports `insecureDefaults: true` on `/health`, so a scanner can
see it too.

**The 200-vs-401 split.** Two failure planes are deliberately kept apart:

| Plane | Status | Meaning |
| --- | --- | --- |
| transport authentication | **401** | "I do not know who you are." The credential is missing, malformed, tampered with or expired. The gateway cannot even attribute the call, so it answers with a `WWW-Authenticate` challenge. |
| application policy denial | **200** + `-32001` | "I know who you are, and you may not call this tool." The HTTP exchange succeeded and the JSON-RPC request was *answered*. |

A 403 for the second case would be a tempting shortcut and a real bug: MCP clients (and the MCP SDK)
treat any non-2xx as a transport failure and never surface the JSON-RPC error to the model, so the
agent would see "connection problem" instead of "you lack the `admin` role". Keeping the two planes
distinct also lets monitoring page on 401 spikes (credential problems) without paging on policy denials
(normal operation).

**Authentication is decided before the body is parsed.** The order is `body → auth → envelope`, not
`auth → body`: a rejected caller's body is still drained, so `fetch` receives a usable 401 instead of an
opaque "socket hang up", and the cost is bounded by the 1 MiB cap. Authentication is still the *first
decision*: nothing is parsed, logged as a request, or forwarded for an unauthenticated caller
(asserted: a malformed body without credentials gets 401, and no `http_request` audit line is written).

**Why the caller's `Authorization` is stripped by default.** Relaying the end-user credential
downstream turns every downstream server into a credential store, widens the blast radius of a
compromised downstream, and destroys the point of a single choke point. `GATEWAY_FORWARD_CLIENT_AUTH=true`
re-enables pass-through for a downstream that genuinely needs the end-user identity, and
`GATEWAY_DOWNSTREAM_TOKEN` injects a service credential instead. The credential is also never logged:
audit lines carry `tokenId` (a truncated SHA-256) and `subject`.

**What "transparent" means precisely.** For an allowed request the gateway reuses the *raw body text*
it read, so `method`, `id` (including `0`, `""` and `null`), `jsonrpc`, `params` and key order are
byte-identical — there is no re-serialisation round trip. `Accept` and `Content-Type` are mirrored;
`Host` and `Content-Length` are recomputed by `fetch`; hop-by-hop headers are dropped; a compressed
request body is decoded by the body parser, so its `Content-Encoding` is dropped with it. The response
keeps the downstream status, `Content-Type` and body bytes, and the body is piped as it arrives.
`Accept-Encoding` is forced to `identity` — the one place transparency is deliberately *not*
byte-for-byte: proxying a compressed stream would either break the body framing or require
re-compression, and identity keeps the response headers consistent with the bytes sent.

**Header handling uses a deny-list, not an allow-list.** MCP carries behaviour in headers
(`Mcp-Session-Id`, `MCP-Protocol-Version`, `Last-Event-ID`) and the protocol is still evolving; an
allow-list would silently drop future ones and break "transparent" for a protocol this young. The
deny-list is explicit and unit-tested.

**`GATEWAY_UPSTREAM_TIMEOUT_MS` bounds time to *headers*, not the whole exchange.** A proxy that
aborts an SSE stream after N seconds would break the very use case MCP streaming exists for. The timer
is cleared as soon as the response headers arrive; the tests assert a 504 for a slow downstream *and*
that a 3-frame SSE stream lasting ~120 ms is delivered intact.


**Batch merging by `id`, not by position.** JSON-RPC 2.0 explicitly allows a batch response array in
any order. The gateway merges upstream results into their original positions by matching `id`, falling
back to position only when a response carries no usable id. `mock/downstream.ts` can reverse its
response array on demand, and a test asserts the merged output is still in request order.

**The hardened `tools/list` filter is off by default.** The brief says `tools/list` must be forwarded
*transparently* — a viewer must see exactly what the downstream advertises — so `GATEWAY_FILTER_TOOL_LIST`
defaults to `false` and the default path is asserted to be byte-identical. When enabled it rewrites both
JSON and SSE bodies (the official SDK answers POSTs with an SSE stream by default, so a JSON-only filter
would be dead code against a real downstream) and logs the removed tool names. It is defence in depth,
never a substitute for the `-32001` interception.

**Rejected alternatives.**

- *`express.json()` before the JSON-RPC layer* — it consumes the body and re-serialises it, which makes
  byte-identical forwarding and `-32700` detection impossible. `express.raw` plus
  one manual `JSON.parse` instead.
- *Asking the downstream whether a tool exists* — that defeats the point of an authorization gateway
  (and leaks the call pattern). Interception is a pure prefix decision, and the mock's call counter
  test exists to catch exactly this regression.
- *Case-insensitive prefix matching* — `Admin_reset_key` is a genuinely different MCP tool name, so
  matching case-insensitively would deny tools the downstream never offered. Whitespace *is*
  normalised, because the downstream may trim the name after the gateway has already decided.
- *A role allow-list* (`admin`, `viewer` only) — the policy engine asks one question ("is this
  `admin`?"), so an unknown role gets least privilege instead of a 401. A new role must not become an
  outage; the test asserts an `auditor` token can call non-privileged tools and cannot call `admin_*`.
- *Returning 403 for a policy denial* — see the 200-vs-401 split above.
- *A second credential store for the downstream* — one token secret, verified with `timingSafeEqual`
  over SHA-256 digests so the comparison is constant-time regardless of length.

## Limitations & future work

- **No OAuth 2.1 resource-server flow.** `WWW-Authenticate` advertises `Bearer realm="mcp-gateway"` but
  there is no `/.well-known/oauth-protected-resource` metadata, no audience/scope claims and no
  `resource_metadata` parameter. Signed tokens are self-issued HMAC tokens, which is enough to
  demonstrate method-level authorization but is not a full OAuth deployment.
- **No rate limiting or quotas.** Deliberate: that is Task 4's subject, and duplicating it here would
  blur the two deliverables.
- **A single downstream server.** No routing by tool, tenant or header; no health-based failover (also
  Task 4).
- **`GET /mcp` is not proxied** (405 + `Allow: POST`). The MCP Streamable HTTP standalone GET SSE stream
  and `DELETE`-based session termination would both need session state, which a stateless gateway
  deliberately does not keep. `Mcp-Session-Id` *is* forwarded when the client sends one, so a stateful
  downstream works for POST traffic.
- **Argument-level policy is out of scope.** The brief's rule is method-and-name based; the gateway
  inspects `params.name` (trimmed) and nothing else. Per-argument constraints (amount caps, tenant
  scoping) belong in the policy file and are not implemented.
- **The hardened filter does not rewrite batches.** Hardened `tools/list` filtering applies to single
  messages only; a batch response is merged and returned unmodified. Documented rather than silently
  half-done.
- **Audit lines go to stderr only.** No shipping to a SIEM, no log rotation, no sampling; the
  `policy_decision` / `proxy_request` / `auth_failure` events are the integration point.
- **Token revocation is impossible by design.** Stateless HMAC tokens expire; there is no deny-list, so
  a leaked token is valid until `exp`. A production deployment needs either short TTLs or a revocation
  store.

## Verification evidence

Real captured output — `npm test`, `npm run demo`, `npm run typecheck`. The full transcripts, including
the decisive zero-downstream-call assertions and the root `npm run verify` run, are in
[`VERIFICATION.md`](./VERIFICATION.md).

```console
$ npm test
> task-02-mcp-gateway@1.0.0 test
> node scripts/check-logging-hygiene.mjs && vitest run

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

$ npm run demo
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
```


