/**
 * Attempt ordering and failover eligibility.
 *
 * The router never hard-codes "primary then secondary": it asks this module for the ordered attempt
 * list (bounded by `ROUTER_MAX_ATTEMPTS`) and for a verdict on every non-ok result. That is what
 * keeps the failover policy a *configuration* (`ROUTER_FAILOVER_ON=429,503,timeout,network`) rather
 * than a chain of `if`s in the request path.
 */
import type { FailoverTrigger, ProviderConfig, RouterConfig } from '../config.js';
import type { ProviderResult } from './providerClient.js';
import type { AttemptFailure } from '../errors/gatewayErrors.js';

export type ProviderRole = 'primary' | 'secondary';

export interface Attempt {
  provider: ProviderConfig;
  role: ProviderRole;
  /** 1-based position in the attempt list. */
  index: number;
}

/** `[primary]` for `maxAttempts: 1`, `[primary, secondary]` for the default `2`. */
export function resolveAttemptOrder(config: Pick<RouterConfig, 'providers' | 'maxAttempts'>): Attempt[] {
  const order: Attempt[] = [
    { provider: config.providers.primary, role: 'primary', index: 1 },
    { provider: config.providers.secondary, role: 'secondary', index: 2 }
  ];
  return order.slice(0, Math.max(1, Math.min(config.maxAttempts, order.length)));
}

/** The failure vocabulary for one attempt; `undefined` for a success. */
export function failureKind(result: ProviderResult): AttemptFailure | undefined {
  switch (result.kind) {
    case 'ok':
      return undefined;
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'http':
      return result.status === 429 ? 'rate_limited' : 'http';
  }
}

/**
 * `ROUTER_FAILOVER_ON` semantics:
 *  - `'any'` in the list  → every non-ok result is eligible;
 *  - `'timeout'`          → the deadline fired;
 *  - `'network'`          → DNS/connect/reset, i.e. we never got a status;
 *  - a number             → that exact HTTP status (`429` is the brief's headline case).
 *
 * A successful response is never eligible: failover after a 2xx would duplicate tokens.
 */
export function isFailoverEligible(result: ProviderResult, failoverOn: readonly FailoverTrigger[]): boolean {
  if (result.kind === 'ok') return false;
  if (failoverOn.includes('any')) return true;
  if (result.kind === 'timeout') return failoverOn.includes('timeout');
  if (result.kind === 'network') return failoverOn.includes('network');
  return failoverOn.some((trigger) => typeof trigger === 'number' && trigger === result.status);
}
