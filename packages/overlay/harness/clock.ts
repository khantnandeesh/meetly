/**
 * The harness's own clocks. The rest of the package takes a `Clock` and never reads the time
 * itself (SPEC §3.4); the harness is where the real one is made, for the page and for the driver,
 * and where the tests' fake one lives.
 *
 * Owner: E-harness.
 */
import type { Cancel, Clock } from "../runtime";

/** The machine's monotonic clock and timers. Works in a page and under Node. */
export function realClock(): Clock {
  return {
    now: () => performance.now(),
    setTimeout(callback, ms) {
      const id = setTimeout(callback, ms);
      return () => clearTimeout(id);
    },
    setInterval(callback, ms) {
      const id = setInterval(callback, ms);
      return () => clearInterval(id);
    },
  };
}

export type FakeClock = Clock & {
  /** Moves time forward, running every timer that falls due, in order. */
  advance(ms: number): void;
};

/** A clock a test steps by hand. Timers fire in order of their time, then of their creation. */
export function fakeClock(start = 0): FakeClock {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
  const add = (run: () => void, ms: number, every: number | null): Cancel => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, ms), every, run });
    return () => void timers.delete(id);
  };
  return {
    now: () => now,
    setTimeout: (callback, ms) => add(callback, ms, null),
    setInterval: (callback, ms) => add(callback, ms, Math.max(1, ms)),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due: number | null = null;
        for (const [id, timer] of timers) if (timer.at <= end && (due === null || timer.at < timers.get(due)!.at)) due = id;
        if (due === null) break;
        const timer = timers.get(due)!;
        now = Math.max(now, timer.at);
        if (timer.every === null) timers.delete(due);
        else timer.at += timer.every;
        timer.run();
      }
      now = end;
    },
  };
}

/** A small, fast, seeded generator (mulberry32). Returns 0..1. The same seed gives the same run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from a seed and some text (FNV-1a), so each link and each peer gets its own sequence. */
export function mixSeed(seed: number, ...parts: (string | number)[]): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
