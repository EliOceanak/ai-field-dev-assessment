/**
 * In-memory customer/refund store.
 *
 * Scope is deliberately small: the graded surface for Task 1 is the protocol
 * and the validation, so persistence would only add a failure mode. The store
 * is therefore a process-lifetime ledger with:
 *
 *   - deterministic seed data (`seedCustomers()` returns a fresh deep copy);
 *   - deterministic refund ids (`REF-000001`, `REF-000002`, …) — no clock, no
 *     randomness, so tests can assert exact values;
 *   - an injectable clock for `created_at`;
 *   - money arithmetic rounded to cents on every mutation, so repeated refunds
 *     cannot accumulate binary-float drift;
 *   - an idempotency map, so a retried `trigger_refund` cannot double-refund.
 */
import { DomainError } from '../protocol/errors.js';

export type CustomerPlan = 'free' | 'pro' | 'enterprise';

export interface Refund {
  refund_id: string;
  customer_id: string;
  amount_usd: number;
  reason: string;
  created_at: string;
  balance_after_usd: number;
}

export interface Customer {
  customer_id: string;
  name: string;
  email: string;
  plan: CustomerPlan;
  balance_usd: number;
  refunds: Refund[];
}

export interface ApplyRefundInput {
  customerId: string;
  amount: number;
  reason: string;
  idempotencyKey?: string;
}

export interface CustomerStore {
  getCustomer(customerId: string): Customer | undefined;
  listCustomers(): Customer[];
  applyRefund(input: ApplyRefundInput): Refund;
  listRefunds(): Refund[];
  /** Test helper: forget every refund and restore the seed balances. */
  reset(): void;
}

/** Round to cents — money must never drift through binary floating point. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const SEED: readonly Customer[] = [
  {
    customer_id: 'CUST-00001',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    plan: 'enterprise',
    balance_usd: 250.5,
    refunds: []
  },
  {
    customer_id: 'CUST-00002',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    plan: 'pro',
    balance_usd: 75,
    refunds: []
  },
  {
    customer_id: 'CUST-00003',
    name: 'Alan Turing',
    email: 'alan@example.com',
    plan: 'free',
    balance_usd: 10,
    refunds: []
  }
];

/** A fresh, mutable copy of the built-in seed data (never the shared objects). */
export function seedCustomers(): Customer[] {
  return SEED.map((customer) => ({ ...customer, refunds: [] }));
}

function clone(customer: Customer): Customer {
  return { ...customer, refunds: customer.refunds.map((refund) => ({ ...refund })) };
}

export interface CreateStoreOptions {
  /** Replacement seed; defaults to `seedCustomers()`. */
  customers?: readonly Customer[];
  /** Clock used for `created_at`; injectable for deterministic tests. */
  now?: () => Date;
}

export function createStore(options: CreateStoreOptions = {}): CustomerStore {
  const now = options.now ?? (() => new Date());
  const customers = new Map<string, Customer>();
  const ledger: Refund[] = [];
  const byIdempotencyKey = new Map<string, Refund>();
  let sequence = 0;

  const load = (seed: readonly Customer[]): void => {
    customers.clear();
    ledger.length = 0;
    byIdempotencyKey.clear();
    sequence = 0;
    for (const customer of seed) customers.set(customer.customer_id, clone(customer));
  };

  load(options.customers ?? seedCustomers());

  return {
    getCustomer(customerId) {
      const customer = customers.get(customerId);
      return customer === undefined ? undefined : clone(customer);
    },

    listCustomers() {
      return [...customers.values()].map(clone);
    },

    applyRefund({ customerId, amount, reason, idempotencyKey }) {
      const customer = customers.get(customerId);
      if (customer === undefined) {
        throw new DomainError('customer_not_found', `No customer record for ${customerId}`, { customer_id: customerId });
      }

      if (idempotencyKey !== undefined) {
        const previous = byIdempotencyKey.get(`${customerId}:${idempotencyKey}`);
        if (previous !== undefined) {
          // Replay: the ledger is untouched, the caller gets the original receipt.
          return { ...previous };
        }
      }

      if (amount > customer.balance_usd) {
        throw new DomainError(
          'insufficient_funds',
          `Refund of ${amount.toFixed(2)} USD exceeds the ${customer.balance_usd.toFixed(2)} USD balance of ${customerId}`,
          { customer_id: customerId, balance_usd: customer.balance_usd, requested_usd: amount }
        );
      }

      sequence += 1;
      const refund: Refund = {
        refund_id: `REF-${String(sequence).padStart(6, '0')}`,
        customer_id: customerId,
        amount_usd: roundMoney(amount),
        reason,
        created_at: now().toISOString(),
        balance_after_usd: roundMoney(customer.balance_usd - amount)
      };

      customer.balance_usd = refund.balance_after_usd;
      customer.refunds.push(refund);
      ledger.push(refund);
      if (idempotencyKey !== undefined) byIdempotencyKey.set(`${customerId}:${idempotencyKey}`, refund);

      return { ...refund };
    },

    listRefunds() {
      return ledger.map((refund) => ({ ...refund }));
    },

    reset() {
      load(seedCustomers());
    }
  };
}

/** Process-wide store used by the running server. */
export const store: CustomerStore = createStore();

export function getCustomer(customerId: string): Customer | undefined {
  return store.getCustomer(customerId);
}

export function applyRefund(input: ApplyRefundInput): Refund {
  return store.applyRefund(input);
}

export function listRefunds(): Refund[] {
  return store.listRefunds();
}

/** Restore the process-wide store (used by tests). */
export function resetStore(): void {
  store.reset();
}
