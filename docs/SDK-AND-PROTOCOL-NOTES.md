# SDK & protocol notes (why v1, and what the 2026-07-28 revision changes)

This page records the SDK/protocol decisions for Tasks 1 and 2, so the choice is auditable rather
than accidental.

## The MCP TypeScript SDK has two lines

| Line | Package(s) | Protocol revisions | Status |
| --- | --- | --- | --- |
| **v1 (used here)** | `@modelcontextprotocol/sdk@1.32.2` | up to **2025-11-25** | maintenance line; the package named in the task brief; bug/security fixes for ≥ 6 months after the v2 release (2026-07-27) |
| v2 | `@modelcontextprotocol/server@2.4.0`, `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/core@2.4.0` | up to **2026-07-28** | current stable; split packages; `serveStdio()` / `createMcpHandler()` entry points |

**Decision:** Tasks 1 and 2 use **v1**, because (a) the brief names `@modelcontextprotocol/sdk`,
(b) every graded behaviour (stdio isolation, JSON-RPC error mapping, Zod validation, HTTP/JSON-RPC
proxying) is wire-level and therefore SDK-line independent, and (c) v1 is the line with the widest
tooling and documentation coverage.

**Consequence, deliberately accepted:** the servers implement the protocol revisions up to
`2025-11-25`, i.e. the `initialize`-handshake era the brief targets. Task 1's tests drive the wire
protocol by hand (raw JSON-RPC over the child process's stdio) instead of only through the SDK
client, so the suite stays valid if the server is later re-implemented on v2.

## The 2026-07-28 revision ("modern era")

Useful context if a reviewer asks what changed: revisions `2024-10-07 … 2025-11-25` are now called
the **legacy era** (they open with `initialize`/`notifications/initialized`). The `2026-07-28`
revision starts the **modern era**:

- `initialize`, `notifications/initialized`, `ping`, `logging/setLevel` and the `Mcp-Session-Id`
  header are **gone**; the protocol is stateless and every request carries its version, client
  capabilities and log level in `_meta.io.modelcontextprotocol/*`.
- Servers **MUST** implement `server/discover` to advertise supported versions, capabilities and
  identity; a version mismatch returns `UnsupportedProtocolVersionError` (`-32022`).
- Results **MUST** carry `resultType` (`"complete"`, `"input_required"`, …); server→client requests
  are replaced by **Multi Round-Trip Requests**; the HTTP GET endpoint and
  `resources/subscribe` are replaced by a single `subscriptions/listen` stream.
- Client cancellation over Streamable HTTP is "close the request's SSE stream" rather than a
  `notifications/cancelled` POST.

Both eras are served by the same wire format (newline-delimited JSON-RPC on stdio), which is why the
stdio-isolation guarantees in Task 1 are unaffected by the era question.

## Error codes (spec-derived, used by Tasks 1 and 2)

| Code | Meaning | Used in |
| --- | --- | --- |
| `-32700` | Parse error — body is not valid JSON | Task 1, Task 2 |
| `-32600` | Invalid request — not a valid JSON-RPC envelope | Task 2 |
| `-32601` | Method not found — an unknown JSON-RPC **method** | Task 1, Task 2 |
| `-32602` | Invalid params — schema validation failure (`data.issues[]` carries the field paths), **and an unknown tool name**: an unknown tool is an invalid *parameter* of `tools/call`, not an unknown method, which is what both the SDK and the spec's guidance say | Task 1, Task 2 |
| `-32603` | Internal error — unexpected failure, sanitized | Task 1, Task 2 |
| `-32001` | **Unauthorized tool call** — required by the Task 2 brief | Task 2 |
| `-32002` | Resource not found (legacy; clients SHOULD also accept `-32602` with `data.uri`) | reference only |
| `-32021` | `MissingRequiredClientCapability` (modern era) | reference only |
| `-32022` | `UnsupportedProtocolVersion` (modern era) | reference only |

**Allocation policy caveat.** The `-32000 … -32019` sub-range is now *legacy*: new codes must not be
allocated there. Task 2 returns `-32001` anyway, because the brief mandates that exact code and
existing MCP clients already recognise it as an authorization failure. The gateway documents this
trade-off in its README, returns the code with a machine-readable `data` payload
(`{tool, required_role, reason}`), and keeps its own allocation-free: no new codes are invented.

## stdio binding rules quoted by Task 1

> The server **MUST NOT** write anything to its `stdout` that is not a valid MCP message.
> The server **MAY** write UTF-8 strings to `stderr` for any logging purposes including
> informational, debug, and error messages.
> Messages are delimited by newlines, and **MUST NOT** contain embedded newlines.

Task 1 turns those two sentences into executable checks (a static source guard plus a wire-level
test that parses every stdout line).
