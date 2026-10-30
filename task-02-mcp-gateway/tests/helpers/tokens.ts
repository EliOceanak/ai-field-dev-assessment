/**
 * Test helper: mint signed bearer tokens against a fixed clock.
 *
 * The clock is fixed so `exp` assertions are deterministic — a token minted here is
 * always "valid at `FIXED_NOW`" and always "expired 60 s later".
 */
import { signToken, tokenId } from '../../src/middleware/auth.js';
import type { TokenPayload } from '../../src/middleware/auth.js';

export const TEST_SECRET = 'test-secret-value';
export const FIXED_NOW = new Date('2026-01-01T00:00:00Z');
export const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

export interface MintOptions {
  subject?: string;
  /** Seconds of validity from `FIXED_NOW`. Negative produces an expired token. */
  ttlSeconds?: number;
  secret?: string;
  now?: Date;
}

export function mintPayload(role: string, options: MintOptions = {}): TokenPayload {
  const now = options.now ?? FIXED_NOW;
  const issuedAt = Math.floor(now.getTime() / 1000);
  return {
    sub: options.subject ?? `${role}-user`,
    role,
    exp: issuedAt + (options.ttlSeconds ?? 3600),
    iat: issuedAt
  };
}

/** A valid signed token for `role`. */
export function mintToken(role: string, options: MintOptions = {}): string {
  return signToken(mintPayload(role, options), options.secret ?? TEST_SECRET);
}

/** A signed token whose `exp` is already in the past. */
export function expiredToken(role: string, options: MintOptions = {}): string {
  return mintToken(role, { ...options, ttlSeconds: options.ttlSeconds ?? -60 });
}

/**
 * Corrupt the payload segment while leaving the signature untouched.
 *
 * Flipping one character of the base64url payload changes what the token *claims*
 * without changing what was signed, so the verifier must reject it on the HMAC —
 * this is the tampering case, not a malformed-token case.
 */
export function tamperPayload(token: string): string {
  const [payload, signature] = token.split('.');
  if (payload === undefined || signature === undefined) throw new Error('not a signed token');
  const first = payload[0] ?? 'A';
  const flipped = first === 'A' ? 'B' : 'A';
  return `${flipped}${payload.slice(1)}.${signature}`;
}

/** Token fingerprint, as the gateway computes it for logs. */
export function fingerprint(token: string): string {
  return tokenId(token);
}
