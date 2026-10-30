/**
 * Per-tenant in-process async mutex.
 *
 * Honest framing (see README "Design notes"): Node runs one thread, and `better-sqlite3` is
 * synchronous, so a single process cannot interleave two `admit()` calls anyway. This mutex is
 * therefore **defence in depth and fairness**, not the correctness mechanism:
 *
 *  - it stops a burst of 20 requests from each entering SQLite's write path in the same tick, which
 *    is what turns a `SQLITE_BUSY` storm into a queue when several processes share the file;
 *  - it is the seam a distributed (Redis) backend would slot into without touching the router.
 *
 * The cross-process guarantee is `BEGIN IMMEDIATE` + `busy_timeout` inside `tokenWindow`.
 */
export interface Mutex {
  runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
  /** Keys with a waiter currently queued — used by the concurrency test. */
  pending(): number;
}

export function createMutex(): Mutex {
  const tails = new Map<string, Promise<unknown>>();
  let pending = 0;

  return {
    async runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      pending += 1;

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(key, tail);

      await previous;
      pending -= 1;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },

    pending(): number {
      return pending;
    }
  };
}
