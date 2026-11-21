/**
 * C4 (PLAN §5): the rules of SPEC §11.4, and [D27]: the source's bitrate follows its own uplink
 * and the audience as a whole, never one viewer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinkEstimate } from "../types";
import { createSimTree, viewerStats } from "./sim/tree";
import { createSourceRateController } from "./sourceRate";

const link = (state: LinkEstimate["state"]): LinkEstimate => ({
  rttMs: 30,
  lossPct: 0,
  queueDelayMs: 0,
  jitterMs: 1,
  sendKbps: 1300,
  deliveredKbps: 1300,
  bufferedBytes: 0,
  state,
});
const links = (...states: LinkEstimate["state"][]): LinkEstimate[] => states.map(link);

function harness() {
  const controller = createSourceRateController({ maxKbps: 1200, minKbps: 300 });
  const targets: number[] = [];
  controller.on("target", (kbps) => targets.push(kbps));
  let now = 0;
  return {
    controller,
    targets,
    /** One look a second, for `seconds`, at children in these states. */
    run(seconds: number, ...states: LinkEstimate["state"][]): void {
      for (let i = 0; i < seconds; i++) {
        controller.onChildren(links(...states), now);
        now += 1000;
      }
    },
    get now() {
      return now;
    },
  };
}

describe("SourceRateController: the source's own uplink (SPEC §11.4)", () => {
  it("starts at the configured bitrate and stays there while its children are fine", () => {
    const h = harness();
    assert.equal(h.controller.targetKbps, 1200);
    h.run(60, "ok", "ok", "ok");
    assert.equal(h.controller.targetKbps, 1200);
    assert.deepEqual(h.targets, []);
  });

  it("multiplies the target by 0.85 once a second while at least half its children's links are congested", () => {
    const h = harness();
    h.run(3, "congested", "congested", "ok");
    assert.deepEqual(h.targets, [1020, 867, 737]);
    const four = harness();
    four.run(1, "congested", "congested", "ok", "strained");
    assert.deepEqual(four.targets, [1020]);
  });

  it("does not go below 300 kbps", () => {
    const h = harness();
    h.run(30, "congested", "congested", "congested");
    assert.equal(h.controller.targetKbps, 300);
    assert.equal(h.targets[h.targets.length - 1], 300);
    assert.equal(h.targets.length, 9); // 1200 × 0.85⁹ is under 300
  });

  it("applies the rule once a second however often it is shown its children", () => {
    const controller = createSourceRateController({ maxKbps: 1200, minKbps: 300 });
    for (let now = 0; now < 3000; now += 100) controller.onChildren(links("congested", "congested", "congested"), now);
    assert.equal(controller.targetKbps, 737);
  });

  it("counts congestion seen between two applications of the rule", () => {
    const controller = createSourceRateController({ maxKbps: 1200, minKbps: 300 });
    controller.onChildren(links("ok", "ok", "ok"), 0);
    controller.onChildren(links("congested", "congested", "ok"), 300); // the gates shed it by the next look
    controller.onChildren(links("ok", "ok", "ok"), 1000);
    assert.equal(controller.targetKbps, 1020);
    controller.onChildren(links("ok", "ok", "ok"), 2000);
    assert.equal(controller.targetKbps, 1020);
  });

  it("multiplies the target by 1.05 once a second after every link has been ok for 10 s, up to the configured bitrate", () => {
    const h = harness();
    h.run(4, "congested", "congested", "congested"); // 626
    h.run(10, "ok", "ok", "ok");
    assert.equal(h.controller.targetKbps, 626, "not before the ten seconds are up");
    h.run(1, "ok", "ok", "ok");
    assert.equal(h.controller.targetKbps, 658);
    h.run(30, "ok", "ok", "ok");
    assert.equal(h.controller.targetKbps, 1200);
    assert.ok(h.targets.every((kbps) => kbps <= 1200));
  });

  it("starts the ten seconds again when any link is less than ok", () => {
    const h = harness();
    h.run(2, "congested", "congested", "congested");
    h.run(9, "ok", "ok", "ok");
    h.run(1, "ok", "strained", "ok");
    h.run(10, "ok", "ok", "ok");
    assert.equal(h.controller.targetKbps, 867);
    h.run(1, "ok", "ok", "ok");
    assert.equal(h.controller.targetKbps, 910);
  });

  it("does nothing with no children", () => {
    const h = harness();
    h.run(30);
    assert.deepEqual(h.targets, []);
  });
});

describe("SourceRateController: never one viewer [D27]", () => {
  it("does not move for one congested child among three, however long", () => {
    const h = harness();
    h.run(600, "congested", "ok", "ok");
    assert.deepEqual(h.targets, []);
  });

  it("does not move for one congested child of two: that is one viewer's trouble", () => {
    const h = harness();
    h.run(600, "congested", "ok");
    assert.deepEqual(h.targets, []);
    h.run(1, "congested", "congested");
    assert.deepEqual(h.targets, [1020]);
  });

  it("does not move for one child of four", () => {
    const h = harness();
    h.run(600, "congested", "ok", "ok", "strained");
    assert.deepEqual(h.targets, []);
  });

  it("with a single child, that link is all the uplink there is", () => {
    const h = harness();
    h.run(1, "congested");
    assert.deepEqual(h.targets, [1020]);
  });

  it("does not climb while one child is congested either: it holds", () => {
    const h = harness();
    h.run(2, "congested", "congested", "congested");
    h.run(60, "congested", "ok", "ok");
    assert.equal(h.controller.targetKbps, 867);
  });
});

describe("SourceRateController: the audience as a whole (the coordinator's hint)", () => {
  it("takes the hint as a ceiling on the target", () => {
    const h = harness();
    h.controller.onHint(800, 0);
    assert.equal(h.controller.targetKbps, 800);
    h.controller.onHint(500, 1);
    assert.equal(h.controller.targetKbps, 500);
    assert.deepEqual(h.targets, [800, 500]);
  });

  it("goes below the ceiling for its own uplink, and comes back up only as far as the ceiling", () => {
    const h = harness();
    h.controller.onHint(800, 0);
    h.run(4, "congested", "congested", "congested"); // the uplink says 626
    assert.equal(h.controller.targetKbps, 626);
    h.run(40, "ok", "ok", "ok");
    assert.equal(h.controller.targetKbps, 800);
  });

  it("is free again when the coordinator raises the hint to the configured bitrate", () => {
    const h = harness();
    h.controller.onHint(500, 0);
    h.controller.onHint(1200, 1);
    assert.equal(h.controller.targetKbps, 1200);
    assert.deepEqual(h.targets, [500, 1200]);
  });

  it("never goes under the floor, whatever the hint, and says nothing when nothing changes", () => {
    const h = harness();
    h.controller.onHint(100, 0);
    assert.equal(h.controller.targetKbps, 300);
    h.controller.onHint(100, 1);
    h.controller.onHint(250, 2);
    assert.deepEqual(h.targets, [300]);
  });
});

describe("SourceRateController in the simulated tree (C4, simulated)", () => {
  // PLAN's harness test caps the source's uplink at 2 Mbps with three children. The simulation
  // has no shared uplink, only links: a third of 2 Mbps on each is the nearest it comes.
  const tree = createSimTree({
    sourceRate: { minKbps: 300 },
    peers: [
      { id: "src", parent: null },
      { id: "a", parent: "src", down: { delayMs: 15 } },
      { id: "b", parent: "src", down: { delayMs: 15 } },
      { id: "c", parent: "src", down: { delayMs: 15 } },
    ],
  });
  const capAt = 5000;
  const liftAt = 35_000;
  tree.run(capAt);
  for (const id of ["a", "b", "c"]) tree.setDown(id, { delayMs: 15, kbps: 667, queueMs: 300 });
  tree.run(liftAt);
  const whileCapped = tree.rate!.targetKbps;
  for (const id of ["a", "b", "c"]) tree.setDown(id, { delayMs: 15 });
  tree.run(liftAt + 45_000);

  it("lowers the encoder within 3 s of the uplink filling", () => {
    assert.ok(tree.targets.length > 0);
    assert.ok(tree.targets[0].at - capAt <= 3000, `first lowered after ${tree.targets[0].at - capAt} ms`);
    assert.ok(tree.targets[0].kbps < 1200);
    assert.ok(whileCapped < 1200);
  });

  it("restores it within 30 s of the cap lifting", () => {
    const restored = tree.targets.find((target) => target.at > liftAt && target.kbps === 1200)!;
    assert.ok(restored.at - liftAt <= 30_000, `restored after ${restored.at - liftAt} ms`);
    // And the children have every layer back.
    const stats = viewerStats(tree.peer("a"), liftAt + 35_000, liftAt + 44_000);
    assert.deepEqual(stats.video, [68, 67, 135]);
  });

  it("does not move for one slow child among three", () => {
    const other = createSimTree({
      sourceRate: { minKbps: 300 },
      peers: [
        { id: "src", parent: null },
        { id: "a", parent: "src", down: { delayMs: 15 } },
        { id: "b", parent: "src", down: { delayMs: 15 } },
        { id: "slow", parent: "src", down: { delayMs: 15, kbps: 900, queueMs: 300 } },
      ],
    });
    other.run(60_000);
    assert.deepEqual(other.targets, []);
    assert.ok(other.port("slow").caps.length > 1, "the slow child's own gate dealt with it");
  });
});
