/**
 * Audit trail — one structured stderr line per decision.
 *
 * The gateway makes an authorization decision on every message it sees; that
 * decision is the product. Logging it as a stable, greppable event is what makes
 * the gateway auditable:
 *
 *   `{"event":"policy_decision","reqId":"…","role":"viewer","method":"tools/call",
 *     "tool":"admin_reset_key","decision":"deny","reason":"insufficient_role"}`
 *
 * Hard rule: the raw bearer token never
 * appears. Only `tokenId` — a truncated SHA-256 — and `subject` are logged, plus
 * identifiers and byte counts rather than bodies.
 */
import type { Logger } from '../logging/logger.js';

export interface PolicyDecisionLine {
  reqId: string;
  role: string;
  subject: string;
  tokenId: string;
  method: string;
  tool?: string;
  decision: 'allow' | 'deny';
  reason: string;
  requiredRole?: string;
  /** Batch position, when the decision was made per element. */
  batchIndex?: number;
}

export interface ProxyRequestLine {
  reqId: string;
  upstreamStatus: number;
  durationMs: number;
  bytesOut: number;
  /** True when the response body was piped rather than buffered. */
  streaming: boolean;
}

export interface AuthFailureLine {
  reqId: string;
  reason: string;
  tokenId?: string;
  path: string;
}

export interface HttpRequestLine {
  reqId: string;
  method: string;
  path: string;
  bytesIn: number;
}

export interface AuditLog {
  request(line: HttpRequestLine): void;
  authFailure(line: AuthFailureLine): void;
  policyDecision(line: PolicyDecisionLine): void;
  proxyRequest(line: ProxyRequestLine): void;
  /** A locally generated error response (400/401/502/504/500). */
  gatewayError(line: { reqId: string; status: number; code: number; reason: string }): void;
}

export function createAuditLog(logger: Logger): AuditLog {
  return {
    request: (line) => logger.info('http_request', { ...line }),
    authFailure: (line) => logger.warn('auth_failure', { ...line }),
    policyDecision: (line) => logger.info('policy_decision', { ...line }),
    proxyRequest: (line) => logger.info('proxy_request', { ...line }),
    gatewayError: (line) => logger.warn('gateway_error', { ...line })
  };
}
