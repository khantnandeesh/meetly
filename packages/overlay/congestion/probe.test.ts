/**
 * C5 (PLAN §5): the uplink probe. Its own behaviour as a unit, then against simulated links
 * capped at 1, 3 and 10 Mbps. PLAN's test is a harness run against the impairment shim; this is
 * the same question put to this module's own model of a capped link.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinkEstimate } from "../types";
import { createUplinkProbe } from "./probe";
import { createSimTree, viewerStats } from "./sim/tree";

const link = (more: Partial<LinkEstimate> = {}): LinkEstimate => ({
  rttMs: 30,
  lossPct: 0,
  queueDelayMs: 0,
  jitterMs: 1,
  sendKbps: 0,
  deliveredKbps: 0,
  bufferedBytes: 0,
  state: "ok",
  ...more,
});

describe("UplinkProbe", () => {
  it("is idle until first asked, sends probe packets for its duration, then waits for the feedback and answers", () => {
    const probe = createUplinkProbe({ targetKbps: 2400, durationMs: 1000 });
    assert.equal(probe.spareKbps, null);
    let bytes = 0;
    let now = 5000;
    for (; now < 6000; now += 10) {
      const sizes = probe.next(link({ deliveredKbps: 2300 }), now);
      assert.ok(sizes.every((size) => size === 1150));
      bytes += sizes.reduce((sum, size) => sum + size, 0);
    }
    // 2,400 kbps for a second is 300,000 bytes; the first few calls are the ramp.
    assert.ok(bytes > 270_000 && bytes <= 300_000, String(bytes));
    assert.deepEqual(probe.next(link({ deliveredKbps: 2350 }), 6000), []);
    assert.equal(probe.spareKbps, null, "the last packets' feedback is still on its way");
    assert.deepEqual(probe.next(link({ deliveredKbps: 2380 }), 6400), []);
    assert.equal(probe.spareKbps, 2380);
    assert.deepEqual(probe.next(link({ deliveredKbps: 9999 }), 7000), []);
    assert.equal(probe.spareKbps, 2380, "done is done");
  });

  it("never sends faster than its target, and never bursts to make up for a late timer", () => {
    const probe = createUplinkProbe({ targetKbps: 2400, durationMs: 1000 });
    for (let now = 0; now < 300; now += 10) probe.next(link(), now);
    // The timer stalls for 400 ms: the next call sends 25 ms' worth at most, not 400.
    const late = probe.next(link(), 700);
    assert.ok(late.length * 1150 <= (2400 * 25) / 8 + 1150, String(late.length));
  });

  it("adds no more to a channel than the link took since the last call, and a little", () => {
    const probe = createUplinkProbe({ targetKbps: 8000, durationMs: 1000 });
    // A link that takes 1,250 bytes every 10 ms (1 Mbps), under a probe that wants 8.
    let held = 0;
    let most = 0;
    let sent = 0;
    for (let now = 0; now < 1000; now += 10) {
      held = Math.max(0, held - 1250);
      const sizes = probe.next(link({ bufferedBytes: held }), now);
      held += sizes.length * 1150;
      sent += sizes.length * 1150;
      most = Math.max(most, held);
    }
    assert.ok(most <= 8 * 1150, `the channel held ${most} bytes at most`);
    // And it kept the link busy: what it sent is what the link could take.
    assert.ok(sent >= 0.95 * 125_000 && sent <= 125_000 + 8 * 1150, String(sent));
  });

  it("stops at once when the link is congested, and answers with the best rate before that", () => {
    const probe = createUplinkProbe({ targetKbps: 8000, durationMs: 1000 });
    for (let now = 0; now < 300; now += 10) probe.next(link({ deliveredKbps: now * 4 }), now);
    assert.deepEqual(probe.next(link({ deliveredKbps: 5000, state: "congested", lossPct: 15 }), 300), []);
    for (let now = 310; now < 800; now += 10) assert.deepEqual(probe.next(link({ deliveredKbps: 5000, state: "congested", lossPct: 15 }), now), []);
    assert.equal(probe.spareKbps, 1160);
  });

  it("counts only what arrived while the link was ok, and goes on through strained", () => {
    const probe = createUplinkProbe({ targetKbps: 8000, durationMs: 500 });
    let sending = 0;
    for (let now = 0; now < 500; now += 10) {
      const strained = now >= 200 && now < 300;
      const sizes = probe.next(link({ deliveredKbps: strained ? 7000 : 3000, state: strained ? "strained" : "ok", queueDelayMs: strained ? 50 : 0 }), now);
      if (strained) sending += sizes.length;
    }
    for (let now = 500; now <= 900; now += 10) probe.next(link({ deliveredKbps: 3100 }), now);
    assert.ok(sending > 0);
    assert.equal(probe.spareKbps, 3100);
  });

  it("cannot report more than it was asked to send", () => {
    const probe = createUplinkProbe({ targetKbps: 2400, durationMs: 100 });
    for (let now = 0; now <= 600; now += 10) probe.next(link({ deliveredKbps: 4000 }), now);
    assert.equal(probe.spareKbps, 2400);
  });
});

describe("UplinkProbe against a capped link (C5, simulated)", () => {
  /** A peer two hops of 20 ms from the source, whose uplink to its parent is capped. */
  function probed(capKbps: number, targetKbps: number, durationMs: number) {
    const tree = createSimTree({
      tickMs: 10,
      peers: [
        { id: "src", parent: null },
        { id: "p", parent: "src", down: { delayMs: 20, jitterMs: 5 }, up: { delayMs: 20, jitterMs: 5, kbps: capKbps, queueMs: 300 } },
      ],
    });
    tree.run(3000);
    const peer = tree.peer("p");
    peer.probe = createUplinkProbe({ targetKbps, durationMs });
    let mostHeld = 0;
    tree.world.every(1, () => (mostHeld = Math.max(mostHeld, tree.pipes.get("p")!.up.bufferedAmount)));
    tree.run(3000 + durationMs + 1000);
    return { spareKbps: peer.probe.spareKbps, mostHeld, lost: tree.pipes.get("p")!.up.lost, tree };
  }

  for (const capKbps of [1000, 3000, 10_000]) {
    it(`measures a ${capKbps / 1000} Mbps uplink within 25%, probing above it`, () => {
      const result = probed(capKbps, 12_000, 1000);
      assert.ok(result.spareKbps !== null && Math.abs(result.spareKbps - capKbps) <= 0.25 * capKbps, `measured ${result.spareKbps}`);
      assert.equal(result.lost, 0, "the probe did not overflow the link's queue");
      // What it left waiting would take the link under 80 ms to send, at the very most.
      assert.ok((result.mostHeld * 8) / capKbps <= 80, `${result.mostHeld} bytes waiting`);
    });
  }

  it("reports its target, no more, on a link that is faster than the target", () => {
    const spare = probed(10_000, 2400, 1000).spareKbps!;
    assert.ok(spare <= 2400 && spare >= 0.98 * 2400, String(spare));
  });

  it("does not disturb what the prober is receiving", () => {
    const result = probed(1000, 12_000, 1000);
    const during = viewerStats(result.tree.peer("p"), 3000, 4500);
    assert.equal(during.video[0] + during.video[1] + during.video[2], during.captured);
    assert.ok(during.delayMs.max <= 26, `video took ${during.delayMs.max} ms at most`);
    // The parent's view of the child (the downlink) never left ok for the probe.
    assert.equal(result.tree.port("p").caps.length, 1);
  });
});
