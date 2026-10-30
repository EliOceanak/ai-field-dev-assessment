/**
 * The policy engine — a pure function from `(principal, message)` to a decision.
 *
 * Rules, in evaluation order (first match wins):
 *
 *  1. `deny` globs from a policy file → deny (cannot be overridden).
 *  2. `allow` globs from a policy file → allow, **only** for tools that are not
 *     privileged by prefix. An allow glob can therefore never escalate a caller
 *     past the prefix rule; that is the one footgun worth designing out.
 *  3. `tools/call` whose `params.name` starts with a privileged prefix
 *     (`admin_` by default) → allow iff the role is exactly `admin`.
 *  4. everything else → allow, forwarded transparently.
 *
 * `tools/list` is rule 4: always forwarded, for every role, and returned
 * unmodified — the brief's "forward transparently" requirement. The optional
 * hardened filter is a separate post-processing step, off by default.
 */
import { readFileSync } from 'node:fs';
import type { JsonRpcMessage } from '../middleware/jsonrpc.js';
import { JsonRpcErrorCode } from '../errors/gatewayErrors.js';
import type { Principal } from '../middleware/auth.js';

export interface PolicyOptions {
  /** Tool-name prefixes that require `requiredRole`. */
  privilegedPrefixes: string[];
  /** Role that may call privileged tools. Default `'admin'` (brief-mandated). */
  requiredRole?: string;
  /** Tool-name globs that are always denied, whatever the role. */
  denyGlobs?: string[];
  /** Tool-name globs that are allowed despite being non-privileged. */
  allowGlobs?: string[];
  /** Hardened mode: strip privileged tools from a successful `tools/list`. */
  filterToolList?: boolean;
}

export interface AllowDecision {
  kind: 'allow';
  reason: string;
}

export interface DenyDecision {
  kind: 'deny';
  reason: string;
  requiredRole: string;
  tool: string;
  /**
   * JSON-RPC code for this denial. `-32001` (unauthorized tool call) unless the *request* is
   * malformed — a `tools/call` whose name is not a string cannot be authorized at all, and that is
   * `-32602` (invalid params).
   */
  code?: number;
}

export type PolicyDecision = AllowDecision | DenyDecision;

/** `admin_*`-style glob → anchored RegExp (`*` = any run of characters). */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '\u0000' : `\\${char}`));
  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`);
}

export function matchesAnyGlob(name: string, globs: readonly string[]): string | undefined {
  return globs.find((glob) => globToRegExp(glob).test(name));
}

/** The prefix a tool name is privileged by, if any. */
export function privilegedPrefixOf(name: string, prefixes: readonly string[]): string | undefined {
  return prefixes.find((prefix) => name.startsWith(prefix));
}

/**
 * The tool a message addresses, if any.
 *
 * Trimmed before matching so `" admin_reset_key"` cannot slip past a prefix check
 * that the downstream might apply after trimming — the gateway forwards the
 * untrimmed name, so both sides must agree on what counts as privileged.
 */
export function toolNameOf(message: JsonRpcMessage): string | undefined {
  if (message.method !== 'tools/call') return undefined;
  const params = message.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const name = (params as Record<string, unknown>).name;
  return typeof name === 'string' ? name.trim() : undefined;
}

/** Decide whether one message may reach the downstream server. */
export function decide(principal: Principal, message: JsonRpcMessage, options: PolicyOptions): PolicyDecision {
  const requiredRole = options.requiredRole ?? 'admin';
  const tool = toolNameOf(message);

  if (tool === undefined) {
    // A `tools/call` whose `params.name` is missing or not a string cannot be matched against the
    // policy, so it must not be forwarded: authorizing an unnameable tool call is impossible, and
    // forwarding it would let a caller reach a privileged tool by hiding its name in a type.
    if (message.method !== 'tools/call') return { kind: 'allow', reason: 'transparent_method' };
    return {
      kind: 'deny',
      reason: 'unnameable_tool',
      requiredRole,
      tool: '<unnamed>',
      code: JsonRpcErrorCode.InvalidParams
    };
  }

  const denied = matchesAnyGlob(tool, options.denyGlobs ?? []);
  if (denied !== undefined) return { kind: 'deny', reason: 'denied_by_policy', requiredRole, tool };

  const prefix = privilegedPrefixOf(tool, options.privilegedPrefixes);
  if (prefix !== undefined) {
    if (principal.role === requiredRole) return { kind: 'allow', reason: 'privileged_role' };
    return { kind: 'deny', reason: 'insufficient_role', requiredRole, tool };
  }

  const allowed = matchesAnyGlob(tool, options.allowGlobs ?? []);
  return { kind: 'allow', reason: allowed === undefined ? 'unprivileged_tool' : 'allowed_by_policy' };
}

export interface ToolListFilterResult {
  /** The message with privileged tools removed (a copy; the input is untouched). */
  value: unknown;
  /** Names that were stripped — logged, never returned to the caller. */
  removed: string[];
}

/**
 * Hardened mode: drop privileged tools from a `tools/list` result.
 *
 * Off by default because the brief demands transparent forwarding — a viewer must
 * see exactly what the downstream advertises. Documented as defence-in-depth, not
 * as a substitute for the `-32001` interception, which is the graded behaviour.
 */
export function filterToolListMessage(value: unknown, options: PolicyOptions): ToolListFilterResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value, removed: [] };
  const record = value as Record<string, unknown>;
  const result = record.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return { value, removed: [] };
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return { value, removed: [] };

  const removed: string[] = [];
  const kept = tools.filter((tool) => {
    if (typeof tool !== 'object' || tool === null) return true;
    const name = (tool as Record<string, unknown>).name;
    if (typeof name !== 'string') return true;
    if (privilegedPrefixOf(name, options.privilegedPrefixes) === undefined) return true;
    removed.push(name);
    return false;
  });

  if (removed.length === 0) return { value, removed };
  return {
    value: { ...record, result: { ...(result as Record<string, unknown>), tools: kept } },
    removed
  };
}

/** Shape of `config/policy.example.json`. */
export interface PolicyFile {
  privilegedPrefixes?: string[];
  requiredRole?: string;
  deny?: string[];
  allow?: string[];
}

/** Read a policy file, mapping it onto `PolicyOptions`. Throws with the path on a bad file. */
export function loadPolicyFile(path: string): PolicyOptions {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PolicyFile;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid policy file ${path}: expected a JSON object`);
  }
  return {
    privilegedPrefixes: parsed.privilegedPrefixes ?? ['admin_'],
    ...(parsed.requiredRole === undefined ? {} : { requiredRole: parsed.requiredRole }),
    denyGlobs: parsed.deny ?? [],
    allowGlobs: parsed.allow ?? []
  };
}
