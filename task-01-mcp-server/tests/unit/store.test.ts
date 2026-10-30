/**
 * Store behaviour: seed data, money arithmetic, domain rejections and the
 * refund ledger. Pure logic — no process, no transport.
 */
import { describe, expect, it } from 'vitest';
import { createStore, roundMoney, seedCustomers } from '../../src/data/store.js';
import { DomainError } from '../../src/protocol/errors.js';

const FIXED_NOW = () => new Date('2026-01-01T00:00:00.000Z');

function newStore() {
  return createStore({ now: FIXED_NOW });
}

describe('seed data', () => {
  it('returns a fresh copy every time, so callers cannot corrupt the seed', () => {
    const first = seedCustomers();
    first[0]!.balance_usd = -1;
    first[0]!.refunds.push({
      refund_id: 'REF-999999',
      customer_id: 'CUST-00001',
      amount_usd: 1,
      reason: 'tampering',
      created_at: '2026-01-01T00:00:00.000Z',
      balance_after_usd: 0
    });

    const second = seedCustomers();
    expect(second[0]!.balance_usd).toBe(250.5);
    expect(second[0]!.refunds).toEqual([]);
  });

  it('ships three customers with deterministic ids and balances', () => {
    const store = newStore();
    expect(store.listCustomers().map((customer) => customer.customer_id)).toEqual([
      'CUST-00001',
      'CUST-00002',
      'CUST-00003'
    ]);
    expect(store.getCustomer('CUST-00001')).toMatchObject({ name: 'Ada Lovelace', plan: 'enterprise' });
    expect(store.getCustomer('CUST-00002')?.balance_usd).toBe(75);
  });

  it('returns a copy, so mutating a record cannot change the store', () => {
    const store = newStore();
    const customer = store.getCustomer('CUST-00001');
    expect(customer).toBeDefined();
    customer!.balance_usd = 0;
    expect(store.getCustomer('CUST-00001')?.balance_usd).toBe(250.5);
  });

  it('returns undefined for an unknown (but well-formed) id', () => {
    expect(newStore().getCustomer('CUST-09999')).toBeUndefined();
  });
});

describe('applyRefund', () => {
  it('debits the balance, appends to the ledger and issues a sequential id', () => {
    const store = newStore();
    const first = store.applyRefund({ customerId: 'CUST-00001', amount: 25, reason: 'outage credit' });

    expect(first).toEqual({
      refund_id: 'REF-000001',
      customer_id: 'CUST-00001',
      amount_usd: 25,
      reason: 'outage credit',
      created_at: '2026-01-01T00:00:00.000Z',
      balance_after_usd: 225.5
    });
    expect(store.getCustomer('CUST-00001')?.balance_usd).toBe(225.5);
    expect(store.listRefunds()).toHaveLength(1);

    const second = store.applyRefund({ customerId: 'CUST-00002', amount: 75, reason: 'second refund' });
    expect(second.refund_id).toBe('REF-000002');
    expect(store.getCustomer('CUST-00002')?.balance_usd).toBe(0);
  });

  it('keeps balance arithmetic exact across many cent-level refunds', () => {
    const store = newStore();
    for (let index = 0; index < 30; index += 1) {
      store.applyRefund({ customerId: 'CUST-00001', amount: 0.1, reason: `tenth refund ${index}` });
    }
    // 250.50 - 30 * 0.10 = 247.50, with no binary-float residue.
    expect(store.getCustomer('CUST-00001')?.balance_usd).toBe(247.5);
    expect(store.listRefunds()).toHaveLength(30);
  });

  it('records the refund on the customer record as well as the ledger', () => {
    const store = newStore();
    store.applyRefund({ customerId: 'CUST-00003', amount: 4, reason: 'goodwill credit' });
    const customer = store.getCustomer('CUST-00003');
    expect(customer?.refunds).toHaveLength(1);
    expect(customer?.refunds[0]).toMatchObject({ refund_id: 'REF-000001', amount_usd: 4, balance_after_usd: 6 });
  });

  it('rejects a refund larger than the balance with a typed domain error', () => {
    const store = newStore();
    let caught: unknown;
    try {
      store.applyRefund({ customerId: 'CUST-00002', amount: 75.01, reason: 'too much' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect(caught).toMatchObject({
      code: 'insufficient_funds',
      details: { customer_id: 'CUST-00002', balance_usd: 75, requested_usd: 75.01 }
    });
    // Nothing was applied.
    expect(store.getCustomer('CUST-00002')?.balance_usd).toBe(75);
    expect(store.listRefunds()).toHaveLength(0);
  });

  it('allows a refund of exactly the remaining balance', () => {
    const store = newStore();
    const refund = store.applyRefund({ customerId: 'CUST-00003', amount: 10, reason: 'full refund' });
    expect(refund.balance_after_usd).toBe(0);
  });

  it('rejects an unknown customer with a typed domain error', () => {
    const store = newStore();
    expect(() => store.applyRefund({ customerId: 'CUST-09999', amount: 1, reason: 'unknown customer' })).toThrow(
      DomainError
    );
    expect(store.listRefunds()).toHaveLength(0);
  });

  it('replays a repeated idempotency key instead of refunding twice', () => {
    const store = newStore();
    const first = store.applyRefund({
      customerId: 'CUST-00001',
      amount: 25,
      reason: 'outage credit',
      idempotencyKey: 'req-abc'
    });
    const replay = store.applyRefund({
      customerId: 'CUST-00001',
      amount: 25,
      reason: 'outage credit',
      idempotencyKey: 'req-abc'
    });

    expect(replay.refund_id).toBe(first.refund_id);
    expect(store.listRefunds()).toHaveLength(1);
    expect(store.getCustomer('CUST-00001')?.balance_usd).toBe(225.5);
  });

  it('treats the same key on a different customer as a different refund', () => {
    const store = newStore();
    store.applyRefund({ customerId: 'CUST-00001', amount: 5, reason: 'first credit', idempotencyKey: 'k1' });
    store.applyRefund({ customerId: 'CUST-00002', amount: 5, reason: 'second credit', idempotencyKey: 'k1' });
    expect(store.listRefunds()).toHaveLength(2);
  });

  it('restores the seed on reset', () => {
    const store = newStore();
    store.applyRefund({ customerId: 'CUST-00001', amount: 25, reason: 'outage credit' });
    store.reset();
    expect(store.listRefunds()).toHaveLength(0);
    expect(store.getCustomer('CUST-00001')?.balance_usd).toBe(250.5);
  });
});

describe('roundMoney', () => {
  it('rounds half-up to cents', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(2.675)).toBe(2.68);
  });
});
