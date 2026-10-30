/**
 * Tenant identity.
 *
 * The API key is the tenant identity (the brief: "50 000 tokens/minute per tenant API key"), but
 * the key itself must never be stored or logged. So the tenant id is a **truncated SHA-256 of the
 * key**: stable across processes and restarts (which the cross-process test depends on), one-way,
 * and useless as a credential.
 *
 * Accepted headers, in priority order: `Authorization: Bearer <key>`, `x-tenant-key`, `x-api-key`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RouterConfig } from '../config.js';

export interface TenantHeaders {
  authorization?: string | string[] | undefined;
  'x-tenant-key'?: string | string[] | undefined;
  'x-api-key'?: string | string[] | undefined;
}

function first(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (Array.isArray(value)) return value[0]?.trim() === '' ? undefined : value[0]?.trim();
  return undefined;
}

/** `Bearer <key>` (scheme is case-insensitive per RFC 7235). */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = first(header);
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() === '' ? undefined : match?.[1]?.trim();
}

/** Returns the raw key, or `undefined` when the client presented nothing usable. */
export function extractTenantKey(headers: TenantHeaders): string | undefined {
  return bearerToken(headers.authorization) ?? first(headers['x-tenant-key']) ?? first(headers['x-api-key']);
}

/** `t_` + 16 hex chars of the key's SHA-256 — never the key. */
export function tenantIdForKey(key: string): string {
  return `t_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Short, non-reversible correlation id for logs (the key is never logged, not even truncated). */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
}

export type TenantResolution = { ok: true; tenantId: string } | { ok: false };

export interface TenantResolver {
  /** True when `ROUTER_TENANT_KEYS` is set: only listed keys are accepted. */
  readonly strict: boolean;
  /** How many keys are allowed (0 = every bearer is auto-provisioned). */
  readonly knownKeys: number;
  resolve(key: string): TenantResolution;
}

/**
 * Decides whether a bearer token is a tenant, and which one.
 *
 * The default is deliberately permissive — any string becomes its own 50 000-token tenant, which is
 * convenient for a demo but means rotating the key mints a fresh window. Setting `ROUTER_TENANT_KEYS`
 * turns that into an allow-list: unlisted keys get 401 and create no row.
 *
 * Comparison is over SHA-256 digests with `timingSafeEqual`, so an unknown key cannot be recovered by
 * timing the allow-list scan.
 */
export function createTenantResolver(config: Pick<RouterConfig, 'tenantKeys'>): TenantResolver {
  const allowed = config.tenantKeys.map((key) => createHash('sha256').update(key, 'utf8').digest());
  const strict = allowed.length > 0;

  return {
    strict,
    knownKeys: allowed.length,
    resolve(key: string): TenantResolution {
      const tenantId = tenantIdForKey(key);
      if (!strict) return { ok: true, tenantId };

      const digest = createHash('sha256').update(key, 'utf8').digest();
      let match = false;
      for (const candidate of allowed) {
        // `timingSafeEqual` needs equal lengths; SHA-256 digests always are.
        if (timingSafeEqual(candidate, digest)) match = true;
      }
      return match ? { ok: true, tenantId } : { ok: false };
    }
  };
}
