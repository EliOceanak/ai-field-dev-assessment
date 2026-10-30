/**
 * The per-tenant in-process mutex.
 *
 * It is *not* the correctness mechanism (SQLite's `BEGIN IMMEDIATE` is — see the cross-process
 * suite); it exists to queue same-tenant bursts and as the seam a distributed backend would use.
 * These tests pin its contract: mutual exclusion per key, no serialisation across keys, and no
 * deadlock or lost wakeup when a holder throws.
 */
import { describe, expect, it } from 'vitest';
import { createMutex } from '../../src/ratelimit/mutex.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('per-tenant mutex', () => {
  it('never runs two critical sections for the same key at once', async () => {
    const mutex = createMutex();
    let inside = 0;
    let maxInside = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        mutex.runExclusive('t_a', async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await tick();
          inside -= 1;
        })
      )
    );

    expect(maxInside).toBe(1);
    expect(inside).toBe(0);
  });

  it('does not serialise different keys against each other', async () => {
    const mutex = createMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.runExclusive('t_a', async () => {
        order.push('a:start');
        await tick();
        order.push('a:end');
      }),
      mutex.runExclusive('t_b', async () => {
        order.push('b:start');
        await tick();
        order.push('b:end');
      })
    ]);

    expect(order.slice(0, 2).sort()).toEqual(['a:start', 'b:start']);
  });

  it('returns the value of the critical section and keeps the queue moving', async () => {
    const mutex = createMutex();
    const results = await Promise.all([
      mutex.runExclusive('t_a', () => 1),
      mutex.runExclusive('t_a', () => 2),
      mutex.runExclusive('t_a', () => 3)
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('releases the lock when the critical section throws', async () => {
    const mutex = createMutex();
    await expect(
      mutex.runExclusive('t_a', () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await expect(mutex.runExclusive('t_a', () => 'recovered')).resolves.toBe('recovered');
  });

  it('reports how many callers are queued', async () => {
    const mutex = createMutex();
    const first = mutex.runExclusive('t_a', async () => {
      await tick();
      expect(mutex.pending()).toBe(2); // the two waiters behind us
    });
    const second = mutex.runExclusive('t_a', () => 'b');
    const third = mutex.runExclusive('t_a', () => 'c');

    await Promise.all([first, second, third]);
    expect(mutex.pending()).toBe(0);
  });
});
