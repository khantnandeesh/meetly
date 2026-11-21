/**
 * C3 (PLAN §5), the deterministic half: the estimator and the gate wired into a node's send path
 * (the fake of it in sim/peer.ts), on a tree of eight over simulated links, with one child's link
 * capped under the stream's bitrate.
 *
 * The slow child must lose its enhancement layers within the spec's reaction time; its siblings
 * and their subtrees must not notice. Everything here is simulated: the links are this module's
 * model of a capped link, the program is synthetic. The browser run (browser/run.ts) puts the
 * same code on real data channels.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesOf } from "./tuning";
import { STAGE1_SHAPE } from "./sim/program";
import { createSimTree, viewerStats } from "./sim/tree";

/**
 *            src
 *      /      |       \
 *     a       b      slow        <- slow's link from the source is capped at 900 kbps at 5 s
 *    / \      |        |
 *   a1  a2    b1       s1
 */
function slowChildTree(seed = 1) {
  const hop = { delayMs: 15 };
  return createSimTree({
    seed,
    peers: [
      { id: "src", parent: null },
      { id: "a", parent: "src", down: hop },
      { id: "b", parent: "src", down: hop },
      { id: "slow", parent: "src", down: hop },
      { id: "a1", parent: "a", down: hop },
      { id: "a2", parent: "a", down: hop },
      { id: "b1", parent: "b", down: hop },
      { id: "s1", parent: "slow", down: hop },
    ],
  });
}

const CAP_AT = 5000;
const END = 65_000;

describe("a slow child (C3, simulated): one of three children capped at 900 kbps under a 1,200 kbps stream", () => {
  const tree = slowChildTree();
  tree.run(CAP_AT);
  tree.setDown("slow", { delayMs: 15, kbps: 900, queueMs: 300 });
  tree.run(END);
  const port = tree.port("slow");
  const drops = port.caps.filter((change) => change.at >= CAP_AT);

  it("sent every layer to everyone before the cap", () => {
    for (const id of ["a", "b", "slow", "a1", "a2", "b1", "s1"]) {
      const stats = viewerStats(tree.peer(id), 1000, CAP_AT - 500);
      assert.deepEqual(stats.video, [26, 27, 52], id);
      assert.equal(stats.decodable, stats.captured, id);
    }
    assert.equal(port.caps.length - drops.length, 1, "no cap change before the link was capped");
  });

  it("drops the slow child's top layer within the spec's reaction time", () => {
    // SPEC §11.2–§11.3: congested once the channel holds more than 150 ms of B, acted on at the
    // next frame. The link is short by about 420 kbps (video, audio twice, headers), so 22,500
    // bytes take about 430 ms to pile up; a frame interval more and the layer is gone.
    const first = drops[0];
    assert.equal(first.maxTemporal, 1);
    assert.equal(first.reason, "congestion");
    assert.ok(first.at - CAP_AT <= 700, `first drop after ${first.at - CAP_AT} ms`);
    // And not before the link had said so: the state at that frame was congested, by backlog.
    const state = port.states.find((entry) => entry.at === first.at)!;
    assert.equal(state.state, "congested");
    assert.ok(state.bufferedBytes > bytesOf(STAGE1_SHAPE.videoKbps, 150));
  });

  it("settles the slow child's cap within 2 s, and keeps it there", () => {
    assert.ok(drops.length >= 1 && drops.length <= 2);
    const last = drops[drops.length - 1];
    assert.ok(last.at - CAP_AT <= 2000, `settled after ${last.at - CAP_AT} ms`);
    assert.ok(last.maxTemporal < 2);
    assert.deepEqual(port.starvedAt, [], "the base layer fits: the child is not starved");
  });

  it("sends the slow child what fits, whole and decodable, and no stale video", () => {
    // From the first GOP that starts after the cap has settled. (The one before it took the
    // link's queue overflowing in the first second: 6 packets of its keyframe. Getting those back
    // is NACK's work, T5, and this fake has none.)
    const stats = viewerStats(tree.peer("slow"), CAP_AT + 3000, END - 1000);
    // The base layer, all of it, and nothing above the cap.
    assert.ok(Math.abs(stats.video[0] - stats.captured / 4) <= 1, `${stats.video[0]} base-layer frames of ${stats.captured / 4}`);
    assert.equal(stats.video[1] + stats.video[2], 0);
    assert.equal(stats.decodable, stats.video[0]);
    // Once settled the backlog is a keyframe at most (26,667 bytes here): under rule 6's line of
    // 200 ms of B, so nothing was held back as stale, and nothing overflowed the link's queue.
    const worst = Math.max(...port.states.filter((entry) => entry.at > CAP_AT + 3000).map((entry) => entry.bufferedBytes));
    assert.ok(worst <= bytesOf(STAGE1_SHAPE.videoKbps, 200), String(worst));
    assert.equal(port.refused.stale, 0);
    assert.equal(tree.pipes.get("slow")!.down.lost <= 8, true, "next to nothing overflowed the link's queue");
  });

  it("never stops the slow child's audio", () => {
    const stats = viewerStats(tree.peer("slow"), CAP_AT, END - 1000);
    assert.equal(stats.audio, stats.audioCaptured);
    const below = viewerStats(tree.peer("s1"), CAP_AT, END - 1000);
    assert.equal(below.audio, below.audioCaptured);
  });

  it("passes on to the slow child's own subtree exactly what the slow child gets", () => {
    const mine = viewerStats(tree.peer("slow"), CAP_AT, END - 1000);
    const below = viewerStats(tree.peer("s1"), CAP_AT, END - 1000);
    assert.deepEqual(below.video, mine.video);
    assert.equal(below.decodable, mine.decodable);
  });

  it("leaves its siblings and their subtrees at full quality, to the frame and to the millisecond", () => {
    for (const [id, hops] of [
      ["a", 1],
      ["b", 1],
      ["a1", 2],
      ["a2", 2],
      ["b1", 2],
    ] as const) {
      const before = viewerStats(tree.peer(id), 1000, CAP_AT);
      const after = viewerStats(tree.peer(id), CAP_AT, END - 1000);
      // Every frame of every layer, decodable.
      assert.equal(after.video[0] + after.video[1] + after.video[2], after.captured, id);
      assert.equal(after.decodable, after.captured, id);
      assert.equal(after.audio, after.audioCaptured, id);
      // PLAN C3: "its siblings' latency p95 moves by under 10 ms". Here it does not move at all.
      assert.ok(Math.abs(after.delayMs.p95 - before.delayMs.p95) < 0.01, id);
      assert.ok(Math.abs(after.delayMs.max - hops * 15) < 0.01, id);
      assert.equal(tree.port(id).caps.length, 1, `${id}'s cap never moved`);
    }
  });

  it("does not lower the cap of the slow child's own child: that link is fine", () => {
    assert.equal(tree.port("s1").caps.length, 1);
  });
});

describe("a slow child (C3, simulated): what the link looks like afterwards", () => {
  it("gives the layers back when the link recovers: one after 5 s ok, the next after 5 more", () => {
    const tree = slowChildTree();
    tree.run(CAP_AT);
    tree.setDown("slow", { delayMs: 15, kbps: 900, queueMs: 300 });
    tree.run(20_000);
    assert.equal(tree.port("slow").gate.cap.maxTemporal, 0);
    tree.setDown("slow", { delayMs: 15 });
    tree.run(40_000);
    const rises = tree.port("slow").caps.filter((change) => change.reason === "restore" && change.at > 20_000);
    assert.deepEqual(
      rises.map((change) => change.maxTemporal),
      [1, 2],
    );
    // Five seconds after the link was last anything but ok (the last keyframe it struggled with,
    // a little before the cap came off), and then five more.
    const states = tree.port("slow").states;
    const lastTrouble = Math.max(...states.filter((entry) => entry.state !== "ok").map((entry) => entry.at));
    assert.ok(lastTrouble < 20_000);
    assert.ok(rises[0].at - lastTrouble >= 5000 && rises[0].at - lastTrouble <= 5100, String(rises[0].at - lastTrouble));
    assert.ok(rises[0].at - 20_000 <= 5100);
    assert.ok(rises[1].at - rises[0].at >= 5000 && rises[1].at - rises[0].at <= 5100);
    const stats = viewerStats(tree.peer("slow"), 32_000, 39_000);
    assert.equal(stats.decodable, stats.captured);
  });

  it("holds on a jittery, lossy link that is not short of capacity: no layer is dropped for 1% loss", () => {
    const tree = createSimTree({
      seed: 4,
      peers: [
        { id: "src", parent: null },
        { id: "home", parent: "src", down: { delayMs: 30, jitterMs: 15, lossPct: 1 } },
      ],
    });
    tree.run(60_000);
    assert.equal(tree.port("home").caps.length, 1);
  });

  it("announces starved on a link that cannot carry even the base layer", () => {
    const tree = createSimTree({
      peers: [
        { id: "src", parent: null },
        { id: "a", parent: "src", down: { delayMs: 15 } },
        { id: "dial-up", parent: "src", down: { delayMs: 15, kbps: 300, queueMs: 300 } },
      ],
    });
    tree.run(20_000);
    const port = tree.port("dial-up");
    assert.equal(port.gate.cap.maxTemporal, 0);
    assert.ok(port.starvedAt.length >= 1);
    assert.ok(port.starvedAt[0] <= 4000, `starved after ${port.starvedAt[0]} ms`);
    // Audio still gets through, and the sibling is untouched.
    const stats = viewerStats(tree.peer("dial-up"), 4000, 19_000);
    assert.ok(stats.audio >= 0.99 * stats.audioCaptured, `${stats.audio} of ${stats.audioCaptured}`);
    const sibling = viewerStats(tree.peer("a"), 1000, 19_000);
    assert.equal(sibling.decodable, sibling.captured);
  });

  it("is the same run every time", () => {
    const run = () => {
      const tree = slowChildTree(9);
      tree.run(3000);
      tree.setDown("slow", { delayMs: 15, jitterMs: 10, lossPct: 0.5, kbps: 900, queueMs: 300 });
      tree.run(15_000);
      return JSON.stringify([tree.port("slow").caps, viewerStats(tree.peer("s1"), 0, 15_000)]);
    };
    assert.equal(run(), run());
  });
});
