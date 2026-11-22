/** The repair metric's freeze and loss (SPEC §12.1): `DecodeTracker.gap`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MediaFlag } from "@meetly/overlay";
import { DecodeTracker, temporalOfKeyDelta } from "@meetly/overlay/topology/node";

/** L1T3, a keyframe every 60 frames, one frame every 33 ms. */
const header = (frameId: number) => {
  const inGop = frameId % 60;
  const temporal = inGop % 4 === 0 ? 0 : inGop % 2 === 0 ? 1 : 2;
  return { frameId, flags: inGop === 0 ? MediaFlag.Key : 0, refDelta: inGop === 0 ? 0 : temporal === 0 ? 4 : temporal === 1 ? 2 : 1, keyDelta: inGop, temporal };
};
const at = (frameId: number) => frameId * 33;

describe("DecodeTracker.gap", () => {
  it("a base-layer frame lost for good: what came after it, undecodable, is lost too, though nothing in the window was decodable", () => {
    const tracker = new DecodeTracker(false);
    for (let id = 0; id < 10; id++) tracker.push(header(id), at(id));
    // Frames 10 to 12 never come (12 is the base layer); 13 onwards come, and all need 12.
    for (let id = 13; id < 40; id++) tracker.push(header(id), at(id) + 5);
    const { freezeMs, lost } = tracker.gap(at(10), at(40));
    // Before, nothing decodable in the window read as "0 lost".
    assert.equal(lost, 30, "frames 10 to 39");
    assert.equal(freezeMs, at(40) - at(9));
  });

  it("nothing lost when every frame came", () => {
    const tracker = new DecodeTracker(false);
    for (let id = 0; id < 40; id++) tracker.push(header(id), at(id));
    assert.deepEqual(tracker.gap(at(10), at(40)), { freezeMs: 33, lost: 0 });
  });

  it("a frame that was never sent (a shed layer) is not lost", () => {
    const tracker = new DecodeTracker(false);
    for (let id = 0; id < 40; id++) if (header(id).temporal !== 2) tracker.push(header(id), at(id));
    assert.equal(tracker.gap(at(10), at(40), (id) => header(id).temporal === 2).lost, 0);
    assert.equal(tracker.gap(at(10), at(40)).lost, 15);
  });

  it("D55: the layer of a frame from its place in the GOP, and the keyframe of a frame that never came", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((d) => temporalOfKeyDelta(3, d)), [0, 2, 1, 2, 0, 2, 1, 2]);
    assert.equal(temporalOfKeyDelta(1, 5), 0);
    const tracker = new DecodeTracker(false);
    for (let id = 60; id < 70; id++) tracker.push(header(id), at(id));
    assert.equal(tracker.keyNear(71), 60);
    assert.equal(tracker.keyNear(10), null);
  });
});
