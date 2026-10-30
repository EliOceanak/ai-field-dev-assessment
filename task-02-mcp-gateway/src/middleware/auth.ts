/**
 * Bearer authentication → `Principal`.
 *
 * Two credential kinds are accepted, in this order:
 *
 *  1. **HMAC-signed tokens** — `base64url(payloadJson) + '.' + base64url(HMAC-SHA256(secret, payload))`
 *     with `payload = { sub, role, exp, iat }`. `scripts/mint-token.mjs` mints them; a test spawns
 *     that script and verifies its output through this verifier, so the two cannot drift apart.
 *  2. **Static dev tokens** from `GATEWAY_DEV_TOKENS` (`role:token`), for local demos only.
 *
 * Nothing here ever returns, logs or forwards the raw token. `tokenId` is a
 * truncated SHA-256 of the token, which is enough to correlate audit lines with a
 * credential without storing the credential itself.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface Principal {
  /** Role as claimed by the credential. The policy engine only ever tests for `'admin'`. */
  role: string;
  /** Stable caller identity (`sub` claim, or `dev:<role>` for static dev tokens). */
  subject: string;
  /** Short, non-reversible fingerprint of the credential, for logs. */
  tokenId: string;
}

export interface TokenPayload {
  sub: string;
  role: string;
  /** Expiry, unix **seconds**. */
  exp: number;
  /** Issued-at, unix seconds. */
  iat: number;
}

export type AuthFailureReason =
  | 'missing_header'
  | 'malformed_header'
  | 'malformed_token'
  | 'invalid_signature'
  | 'expired'
  | 'unknown_token';

export interface AuthFailure {
  ok: false;
  reason: AuthFailureReason;
  /** Short, non-leaking description for logs. Never sent verbatim to a client. */
  message: string;
}

export interface AuthSuccess {
  ok: true;
  principal: Principal;
}

export type AuthResult = AuthSuccess | AuthFailure;

export interface AuthenticateOptions {
  tokenSecret: string;
  /** Static dev tokens: role → token. */
  devTokens?: Record<string, string>;
  /** Injectable clock. */
  now?: () => Date;
}

/** Exactly the challenge the README's status contract promises. */
export const WWW_AUTHENTICATE = 'Bearer realm="mcp-gateway", error="invalid_token"';

export function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * Decode a base64url segment, rejecting non-canonical input.
 *
 * `Buffer.from(x, 'base64url')` silently ignores junk, so a round-trip check is
 * what makes tampering detectable rather than merely producing a different string.
 */
export function base64UrlDecode(value: string): Buffer | undefined {
  if (value === '' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const buffer = Buffer.from(value, 'base64url');
  return buffer.toString('base64url') === value ? buffer : undefined;
}

/** Non-reversible credential fingerprint used in logs (`tokenId`). */
export function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function hmac(secret: string, payloadSegment: string): Buffer {
  return createHmac('sha256', secret).update(payloadSegment).digest();
}

/** Mint a signed token. Mirrored by `scripts/mint-token.mjs`. */
export function signToken(payload: TokenPayload, secret: string): string {
  const segment = base64UrlEncode(JSON.stringify(payload));
  return `${segment}.${base64UrlEncode(hmac(secret, segment))}`;
}

function parsePayload(buffer: Buffer): TokenPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { sub, role, exp, iat } = record;
  if (typeof sub !== 'string' || sub.trim() === '') return undefined;
  if (typeof role !== 'string' || role.trim() === '') return undefined;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  if (iat !== undefined && (typeof iat !== 'number' || !Number.isFinite(iat))) return undefined;
  return { sub, role, exp, iat: typeof iat === 'number' ? iat : 0 };
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | {
      ok: false;
      reason: Extract<AuthFailureReason, 'malformed_token' | 'invalid_signature' | 'expired'>;
      message: string;
    };

/** Verify a signed token: structure → signature → expiry, in that order. */
export function verifySignedToken(token: string, secret: string, now: Date = new Date()): VerifyResult {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: 'malformed_token', message: 'token is not <payload>.<signature>' };
  }
  const segment = token.slice(0, dot);
  const signatureSegment = token.slice(dot + 1);

  const payloadBuffer = base64UrlDecode(segment);
  const signature = base64UrlDecode(signatureSegment);
  if (payloadBuffer === undefined || signature === undefined) {
    return { ok: false, reason: 'malformed_token', message: 'token is not valid base64url' };
  }

  const expected = hmac(secret, segment);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return { ok: false, reason: 'invalid_signature', message: 'signature does not match' };
  }

  const payload = parsePayload(payloadBuffer);
  if (payload === undefined) {
    return { ok: false, reason: 'malformed_token', message: 'payload is not {sub, role, exp}' };
  }

  if (payload.exp <= Math.floor(now.getTime() / 1000)) {
    return { ok: false, reason: 'expired', message: 'token expired' };
  }

  return { ok: true, payload };
}

/**
 * Split an `Authorization` header into a token.
 *
 * The scheme is matched case-insensitively and surrounding whitespace (including
 * tabs) is tolerated, because real clients are inconsistent about both.
 */
export function parseBearerHeader(
  header: string | string[] | undefined
): { ok: true; token: string } | AuthFailure {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.trim() === '') {
    return { ok: false, reason: 'missing_header', message: 'Authorization header is missing' };
  }
  const match = /^[ \t]*bearer[ \t]+(\S+)[ \t]*$/i.exec(value);
  if (match === null) {
    return { ok: false, reason: 'malformed_header', message: 'Authorization header is not a Bearer credential' };
  }
  const token = match[1];
  if (token === undefined || token === '') {
    return { ok: false, reason: 'malformed_header', message: 'Bearer credential is empty' };
  }
  return { ok: true, token };
}

/** Constant-time comparison of two candidate credentials, independent of length. */
function sameToken(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/** Resolve a static dev token to a role without leaking which role was probed. */
function roleForDevToken(token: string, devTokens: Record<string, string>): string | undefined {
  let matched: string | undefined;
  for (const [role, candidate] of Object.entries(devTokens)) {
    if (sameToken(token, candidate)) matched ??= role;
  }
  return matched;
}

/**
 * Authenticate a request. Returns a `Principal` or a typed failure — never throws.
 *
 * A signed token whose `role` is neither `admin` nor `viewer` is still valid: the
 * policy engine is role-agnostic (it only asks "is this `admin`?"), so an unknown
 * role simply gets least privilege. That is deliberate — a role allow-list would
 * turn every new role into an outage.
 */
export function authenticate(
  req: { headers: Record<string, string | string[] | undefined> },
  options: AuthenticateOptions
): AuthResult {
  const parsed = parseBearerHeader(req.headers.authorization ?? req.headers.Authorization);
  if (!parsed.ok) return parsed;

  const { token } = parsed;
  const id = tokenId(token);
  const now = options.now?.() ?? new Date();

  const verified = verifySignedToken(token, options.tokenSecret, now);
  if (verified.ok) {
    return {
      ok: true,
      principal: { role: verified.payload.role, subject: verified.payload.sub, tokenId: id }
    };
  }

  const devRole = roleForDevToken(token, options.devTokens ?? {});
  if (devRole !== undefined) {
    return { ok: true, principal: { role: devRole, subject: `dev:${devRole}`, tokenId: id } };
  }

  // `malformed_token` and `invalid_signature` reach the client as the same 401;
  // the distinction survives only in the audit log.
  return { ok: false, reason: verified.reason, message: verified.message };
}
