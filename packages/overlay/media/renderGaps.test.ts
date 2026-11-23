/**
 * [D79] Repair time on rendered frames (SPEC §12.2): the longest gap between two rendered frames
 * from the last packet heard until a second after the first packet from the new parent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RENDER_HISTORY_MS, RenderTimes, longestRenderGap } from "./renderGaps";

const every = (from: number, to: number, stepMs: number): number[] => {
  const out: number[] = [];
  for (let t = from; t <= to; t += stepMs) out.push(t);
  return out;
};

describe("repair time on rendered frames (D79)", () => {
  it("is the frame interval when nothing froze", () => {
    assert.equal(longestRenderGap(every(0, 5000, 40), 1000, 2500, 5000), 40);
  });

  it("is the freeze that the lost parent caused, rendered a playout delay later than it arrived", () => {
    // Arrivals stop at 1,000 (lastHeard) and resume at 1,400; the player renders 250 ms later.
    const times = [...every(0, 1250, 40), ...every(1650, 4000, 40)];
    const gap = longestRenderGap(times, 1000, 1400 + 1000, 4000);
    assert.equal(gap, 1650 - 1240);
  });

  it("counts a gap that started before the window and ends inside it, whole", () => {
    const times = [...every(0, 800, 40), ...every(1600, 4000, 40)];
    assert.equal(longestRenderGap(times, 1000, 2000, 4000), 1600 - 800);
  });

  it("does not count a gap that begins after the window has ended", () => {
    const times = [...every(0, 3000, 40), ...every(3600, 5000, 40)];
    assert.equal(longestRenderGap(times, 1000, 2000, 5000), 40);
  });

  it("runs a gap still open to now", () => {
    assert.equal(longestRenderGap(every(0, 1000, 40), 900, 1900, 2500), 2500 - 1000);
  });

  it("is null with nothing rendered", () => {
    assert.equal(longestRenderGap([], 0, 1000, 2000), null);
  });

  it("keeps about the last 30 s, and ignores a time out of order", () => {
    const renders = new RenderTimes();
    for (const t of every(0, 60_000, 40)) renders.add(t);
    renders.add(10);
    assert.equal(renders.last(), 60_000);
    // Long ago is gone: measured from the oldest still kept.
    assert.ok((renders.longestGap(0, 1000, 60_000) ?? 0) >= 60_000 - RENDER_HISTORY_MS - 1000);
    assert.equal(renders.longestGap(50_000, 51_000, 60_000), 40);
  });
});
