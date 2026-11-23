/**
 * [D79] Repair time as SPEC §12.2 defines it: "the longest gap between two rendered frames from
 * the last packet heard from the lost parent until one second after the first packet from the new
 * one". The node can only see frames become decodable as they arrive (its `DecodeTracker`); the
 * player renders them later, at their playout time, and a replay held back until it reaches the
 * playout point (§10.4) is not rendered at all. So the engine keeps the times the player rendered
 * frames at, and measures each `repair` event's window on those.
 *
 * Owner: E-media.
 */

/** How long rendered times are kept: longer than any repair window that is still measured. */
export const RENDER_HISTORY_MS = 30_000;
/** A repair whose window has ended is measured once a frame has been rendered past it, or this long after it. */
export const RENDER_SETTLE_MS = 4_000;

/** The times (session clock, ms) frames of one stream were rendered at, in order. */
export class RenderTimes {
  private times: number[] = [];

  add(atMs: number): void {
    const times = this.times;
    if (times.length > 0 && atMs < times[times.length - 1]) return;
    times.push(atMs);
    if (times.length > 64 && times[0] < atMs - RENDER_HISTORY_MS) {
      let drop = 0;
      while (drop < times.length && times[drop] < atMs - RENDER_HISTORY_MS) drop++;
      this.times = times.slice(drop);
    }
  }

  /** The newest rendered time, or null. */
  last(): number | null {
    return this.times.length > 0 ? this.times[this.times.length - 1] : null;
  }

  /**
   * The longest gap between two consecutive rendered frames that overlaps `[fromMs, toMs]`: the
   * last frame before `fromMs` counts as the gap's start. A gap still open (nothing rendered
   * after its start) runs to `nowMs`. Null if nothing was ever rendered.
   */
  longestGap(fromMs: number, toMs: number, nowMs: number): number | null {
    return longestRenderGap(this.times, fromMs, toMs, nowMs);
  }
}

/** See `RenderTimes.longestGap`. `times` ascending. */
export function longestRenderGap(times: readonly number[], fromMs: number, toMs: number, nowMs: number): number | null {
  if (times.length === 0) return null;
  // The last frame rendered at or before `fromMs`, or the first one after it.
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= fromMs) lo = mid;
    else hi = mid - 1;
  }
  let longest = times[lo] > fromMs ? times[lo] - fromMs : 0;
  for (let i = lo; i < times.length && times[i] < toMs; i++) {
    const next = i + 1 < times.length ? times[i + 1] : Math.max(times[i], nowMs);
    longest = Math.max(longest, next - times[i]);
  }
  return longest;
}
