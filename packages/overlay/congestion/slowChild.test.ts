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
  tree.run(CAP_AT + 3000);
  /** Packets the capped link's queue overflowed with, while the cap was settling. */
  const lostSettling = tree.pipes.get("slow")!.down.lost;
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
    // bytes take about 430 ms to pile up; the backlog must then stand for 150 ms (C6, README) and
    // a frame interval more and the layer is gone: 700 ms here.
    const first = drops[0];
    assert.equal(first.maxTemporal, 1);
    assert.equal(first.reason, "congestion");
    assert.ok(first.at - CAP_AT <= 800, `first drop after ${first.at - CAP_AT} ms`);
    // And not before the link had said so: the state at that frame was congested, by backlog.
    const state = port.states.find((entry) => entry.at === first.at)!;
    assert.equal(state.state, "congested");
    assert.ok(state.bufferedBytes > bytesOf(STAGE1_SHAPE.videoKbps, 150));
  });

  it("settles the slow child's cap on the middle layer within 2 s, and keeps it there", () => {
    // Rule 3 as the integrator decided it: after the first drop the gate watches a window (1 s
    // here) and, with the backlog going down, does not drop again. The middle layer (about 830
    // of 900 kbps with audio and headers) is what fits.
    assert.equal(drops.length, 1);
    assert.equal(drops[0].maxTemporal, 1);
    assert.ok(drops[0].at - CAP_AT <= 2000, `settled after ${drops[0].at - CAP_AT} ms`);
    assert.deepEqual(port.starvedAt, [], "the child is not starved");
  });

  it("sends the slow child what fits, whole and decodable, and no stale video", () => {
    // From the first GOP that starts after the cap has settled. (The one before it took the
    // link's queue overflowing in the first second: 13 packets, of its keyframe. Getting those
    // back is NACK's work, T5, and this fake has none.)
    const stats = viewerStats(tree.peer("slow"), CAP_AT + 3000, END - 1000);
    // The base and middle layers, all of them, and nothing above the cap: 15 fps.
    assert.ok(Math.abs(stats.video[0] - stats.captured / 4) <= 1, `${stats.video[0]} base-layer frames of ${stats.captured / 4}`);
    assert.ok(Math.abs(stats.video[1] - stats.captured / 4) <= 1, `${stats.video[1]} middle-layer frames of ${stats.captured / 4}`);
    assert.equal(stats.video[2], 0);
    assert.equal(stats.decodable, stats.video[0] + stats.video[1]);
    // Once settled the backlog is a keyframe and a little at most (26,667 bytes is the keyframe):
    // under rule 6's line of 200 ms of B, so nothing was held back as stale, and nothing
    // overflowed the link's queue.
    const worst = Math.max(...port.states.filter((entry) => entry.at > CAP_AT + 3000).map((entry) => entry.bufferedBytes));
    assert.ok(worst <= bytesOf(STAGE1_SHAPE.videoKbps, 200), String(worst));
    assert.equal(port.refused.stale, 0);
    assert.ok(lostSettling <= 16, `${lostSettling} packets overflowed the link's queue while the cap settled`);
    assert.equal(tree.pipes.get("slow")!.down.lost, lostSettling, "and none once it had");
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

  it("tells the slow child of every change of its cap, and nobody else of anything (`layers`, SPEC §11.3)", () => {
    const heard = tree.peer("slow").layersHeard;
    assert.deepEqual(
      heard.map((entry) => [entry.message.stream, entry.message.maxTemporal, entry.message.reason]),
      drops.map((change) => [0, change.maxTemporal, change.reason]),
    );
    // On the reliable channel, one hop's delay (15 ms) after the change, as the child's last tick saw it.
    for (const [i, entry] of heard.entries()) assert.ok(entry.at - drops[i].at >= 10 && entry.at - drops[i].at <= 15, String(entry.at - drops[i].at));
    for (const id of ["a", "b", "a1", "a2", "b1", "s1"]) assert.deepEqual(tree.peer(id).layersHeard, [], id);
  });

  it("sends through transport's Link: control, audio and video each in their class, nothing shed", () => {
    const toSlow = tree.links.get("slow")!.down;
    const toA = tree.links.get("a")!.down;
    for (const link of [toSlow, toA]) {
      assert.ok(link.sentByClass.control > 0 && link.sentByClass.audio > 0 && link.sentByClass.video > 0);
      assert.equal(link.counters().packetsShed, 0);
    }
    // The gate decided what not to send: the slow child's link was handed fewer video packets.
    assert.ok(toSlow.sentByClass.video < 0.75 * toA.sentByClass.video);
    // Audio twice to each, the same to both (SPEC [D25], rule 1).
    assert.equal(toSlow.sentByClass.audio, toA.sentByClass.audio);
  });
});

describe("a slow child (C3, simulated): what the link looks like afterwards", () => {
  it("gives the top layer back when the link recovers, 5 s after it was last anything but ok", () => {
    const tree = slowChildTree();
    tree.run(CAP_AT);
    tree.setDown("slow", { delayMs: 15, kbps: 900, queueMs: 300 });
    tree.run(20_000);
    assert.equal(tree.port("slow").gate.cap.maxTemporal, 1);
    tree.setDown("slow", { delayMs: 15 });
    tree.run(40_000);
    const rises = tree.port("slow").caps.filter((change) => change.reason === "restore" && change.at > 20_000);
    assert.deepEqual(
      rises.map((change) => change.maxTemporal),
      [2],
    );
    // Five seconds after the link was last anything but ok (the last keyframe it struggled with,
    // a little before the cap came off).
    const states = tree.port("slow").states;
    const lastTrouble = Math.max(...states.filter((entry) => entry.state !== "ok").map((entry) => entry.at));
    assert.ok(lastTrouble < 20_000);
    assert.ok(rises[0].at - lastTrouble >= 5000 && rises[0].at - lastTrouble <= 5100, String(rises[0].at - lastTrouble));
    assert.ok(rises[0].at - 20_000 <= 5100);
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

describe("rule 3's observation window (integrator, 2026-11-21): a child settles on the layer that fits", () => {
  const capped = (kbps: number) => {
    const tree = createSimTree({
      seed: 5,
      peers: [
        { id: "src", parent: null },
        { id: "a", parent: "src", down: { delayMs: 15 } },
        { id: "x", parent: "src", down: { delayMs: 15 } },
      ],
    });
    tree.run(CAP_AT);
    tree.setDown("x", { delayMs: 15, kbps, queueMs: 300 });
    tree.run(40_000);
    return { tree, drops: tree.port("x").caps.filter((change) => change.at >= CAP_AT), stats: viewerStats(tree.peer("x"), CAP_AT + 5000, 39_000) };
  };

  for (const kbps of [900, 1100]) {
    it(`at ${kbps} kbps: one drop, to the middle layer, and 15 fps of it whole`, () => {
      const { drops, stats } = capped(kbps);
      assert.deepEqual(
        drops.map((change) => change.maxTemporal),
        [1],
      );
      assert.ok(drops[0].at - CAP_AT <= 2000, `dropped after ${drops[0].at - CAP_AT} ms`);
      assert.ok(Math.abs(stats.video[1] - stats.captured / 4) <= 1 && stats.video[2] === 0, String(stats.video));
      assert.equal(stats.decodable, stats.video[0] + stats.video[1]);
    });
  }

  it("at 600 kbps, where the middle layer does not fit, the second drop comes one window after the first, within 2 s", () => {
    const { drops } = capped(600);
    assert.deepEqual(
      drops.map((change) => change.maxTemporal),
      [1, 0],
    );
    const between = drops[1].at - drops[0].at;
    assert.ok(between >= 1000 && between <= 1100, String(between));
    assert.ok(drops[1].at - CAP_AT <= 2000, `settled after ${drops[1].at - CAP_AT} ms`);
  });
});

describe("a squeeze, then room (C6): a link that has room for the stream gets every layer back", () => {
  // The child's link is squeezed to 500 kbps for 3 s, long enough to take it to the base layer,
  // and then left at a rate with room for the whole stream (about 1,330 kbps with audio and
  // headers). Keyframes are 27 kB, more than 150 ms of B: each one leaves a backlog the link
  // drains within a few frames.
  const squeeze = (kbps: number, estimatorTuning?: { backlogWindowMs: number }) => {
    const tree = createSimTree({
      seed: 3,
      estimatorTuning,
      peers: [
        { id: "src", parent: null },
        { id: "x", parent: "src", down: { delayMs: 15 } },
      ],
    });
    tree.run(3000);
    tree.setDown("x", { delayMs: 15, kbps: 500, queueMs: 300 });
    tree.run(6000);
    assert.equal(tree.port("x").gate.cap.maxTemporal, 0, "the squeeze took it to the base layer");
    tree.setDown("x", { delayMs: 15, kbps, queueMs: 300 });
    tree.run(40_000);
    return tree;
  };

  for (const kbps of [2000, 3000]) {
    it(`at ${kbps / 1000} Mbps: the middle layer about 5 s after the squeeze, the top 5 s later, all of it whole`, () => {
      const tree = squeeze(kbps);
      const rises = tree.port("x").caps.filter((change) => change.at > 6000);
      assert.deepEqual(
        rises.map((change) => [change.maxTemporal, change.reason]),
        [
          [1, "restore"],
          [2, "restore"],
        ],
      );
      assert.ok(rises[0].at - 6000 <= 7000, `first rise ${rises[0].at - 6000} ms after the squeeze`);
      assert.ok(rises[1].at - rises[0].at >= 5000 && rises[1].at - rises[0].at <= 5100);
      const stats = viewerStats(tree.peer("x"), 20_000, 39_000);
      assert.equal(stats.decodable, stats.captured);
    });
  }

  it("at 1.5 Mbps, 89% full at the top layer, it holds the middle one", () => {
    assert.equal(squeeze(1500).port("x").gate.cap.maxTemporal, 1);
  });

  it("with every backlog sample read as it comes (the spec to the letter), a 3 Mbps link stays at the base layer", () => {
    // Why the backlog must stand before it counts: each keyframe makes the link strained for a
    // frame or two, so five seconds of ok never come on a link under about 4.6 Mbps, and the
    // layers never come back.
    assert.equal(squeeze(3000, { backlogWindowMs: 0 }).port("x").gate.cap.maxTemporal, 0);
  });
});

describe("the gate mix's four networks (C6, simulated): one child of each under the source, two minutes", () => {
  // SPEC §12.3's profiles, as E-harness's PROFILES has them, on the link from the source to the
  // child; the way back has the same delay, jitter and loss, without the cap.
  const MIX = {
    good: { delayMs: 15, jitterMs: 5, lossPct: 0.1 },
    home: { delayMs: 30, jitterMs: 15, lossPct: 1 },
    bad: { delayMs: 60, jitterMs: 40, lossPct: 3, burst: { enterPct: 1, leavePct: 30, lossPctInBurst: 50 } },
    slow: { delayMs: 40, jitterMs: 20, lossPct: 1, kbps: 900, queueMs: 300 },
  };
  const run = (seed: number, estimatorTuning?: { lossNeedsQueue: boolean }) => {
    const tree = createSimTree({
      seed,
      estimatorTuning,
      sourceRate: { minKbps: 300 },
      peers: [
        { id: "src", parent: null },
        ...Object.entries(MIX).map(([id, down]) => {
          const { kbps: _kbps, queueMs: _queueMs, ...up } = down as typeof down & { kbps?: number; queueMs?: number };
          return { id, parent: "src", down, up };
        }),
      ],
    });
    tree.run(120_000);
    return tree;
  };

  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: good, home and bad keep every layer; slow settles on the middle one at once; the source does not move`, () => {
      const tree = run(seed);
      for (const id of ["good", "home", "bad"]) assert.equal(tree.port(id).caps.length, 1, `${id}'s cap moved`);
      const slow = tree.port("slow").caps.slice(1);
      assert.deepEqual(
        slow.map((change) => change.maxTemporal),
        [1],
      );
      assert.ok(slow[0].at <= 2000);
      assert.deepEqual(tree.targets, [], "one viewer's trouble is not the source's [D27]");
    });
  }

  it("with loss read to the spec's letter, the bad link, which has room to spare, loses layers to its bursts", () => {
    // Why loss counts only where the link shows a queue (README item 16): a burst of loss on a
    // link with no queue reads as 10% for a second, and a layer goes for nothing; at 3% the link
    // is strained half the time, and the layer never comes back.
    const lost = [1, 3].map((seed) => run(seed, { lossNeedsQueue: false }).port("bad").caps.length - 1);
    assert.ok(lost.every((changes) => changes >= 1), String(lost));
  });
});
