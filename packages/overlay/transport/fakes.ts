/**
 * Stand-ins for tests: a clock that only moves when told to. Not used by the engine itself.
 *
 * Owner: E-transport+topology.
 */
import type { Cancel, Clock } from "../runtime";

type Timer = { at: number; order: number; every: number | null; callback: () => void; dead: boolean };

/** A `Clock` whose time is moved by `advance`. Timers fire in order of time, then of creation. */
export class FakeClock implements Clock {
  private t: number;
  private order = 0;
  private timers: Timer[] = [];

  constructor(start = 1000) {
    this.t = start;
  }

  now = (): number => this.t;

  setTimeout = (callback: () => void, ms: number): Cancel => this.add(callback, ms, null);

  setInterval = (callback: () => void, ms: number): Cancel => this.add(callback, ms, Math.max(ms, 0.001));

  private add(callback: () => void, ms: number, every: number | null): Cancel {
    const timer: Timer = { at: this.t + Math.max(0, ms), order: this.order++, every, callback, dead: false };
    this.insert(timer);
    return () => {
      timer.dead = true;
    };
  }

  /** Kept sorted: `advance` takes from the front. */
  private insert(timer: Timer): void {
    let lo = 0;
    let hi = this.timers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.timers[mid];
      if (other.at < timer.at || (other.at === timer.at && other.order < timer.order)) lo = mid + 1;
      else hi = mid;
    }
    this.timers.splice(lo, 0, timer);
  }

  /** Moves time forward by `ms`, firing every timer that falls due, each at its own time. */
  advance(ms: number): void {
    const until = this.t + ms;
    for (;;) {
      const next = this.timers[0];
      if (!next || next.at > until) break;
      this.timers.shift();
      if (next.dead) continue;
      this.t = Math.max(this.t, next.at);
      if (next.every !== null) {
        next.at += next.every;
        next.order = this.order++;
        this.insert(next);
      }
      next.callback();
    }
    this.t = until;
  }

  /** Timers not yet fired or cancelled. */
  pending(): number {
    return this.timers.filter((timer) => !timer.dead).length;
  }
}
