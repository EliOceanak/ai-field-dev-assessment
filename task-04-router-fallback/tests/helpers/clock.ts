/** Injectable clock: eviction/rollover tests move time by hand, never by sleeping. */
export interface TestClock {
  now(): number;
  /** Advances the clock and returns the new value. */
  advance(ms: number): number;
  /** Jumps to an absolute epoch ms value. */
  set(ms: number): number;
  current(): number;
}

export const CLOCK_START = 1_700_000_000_000;

export function createClock(start: number = CLOCK_START): TestClock {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => (value += ms),
    set: (ms) => (value = ms),
    current: () => value
  };
}
