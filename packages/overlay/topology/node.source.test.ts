/**
 * [D64] Silence from the source is waited out (SOURCE_SILENT_MS while its link is open), not
 * repaired at deadMs: nobody else has the stream. Gate run 45202616067: a hiccup of 200 ms or more
 * at the source sent five of its six children into cold repairs that excluded it, and with it the
 * whole tree; 182 peers below them froze for up to 11 s.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricsEvent } from "@meetly/overlay";
import { FROZEN_PARENT_MS, SOURCE_SILENT_MS } from "@meetly/overlay/topology/node";
import { SimNet, type SimPeer } from "@meetly/overlay/topology/sim";

type RepairEvent = Extract<MetricsEvent, { t: "repair" }>;
const repairs = (peer: SimPeer) => peer.metrics.filter((event): event is RepairEvent => event.t === "repair");

async function tree() {
  const net = new SimNet({ backups: true });
  const source = net.join("0", "source", []);
  net.publish(source);
  await net.runAsync(500);
  const peers = [source];
  for (const [id, parent, backup] of [
    ["1", "0", null],
    ["2", "0", null],
    ["3", "1", "2"],
    ["4", "1", "2"],
    ["5", "2", "1"],
    ["6", "2", "1"],
  ] as const) {
    peers.push(net.join(id, id === "1" || id === "2" ? "relay" : "leaf", [parent], backup ? [backup] : []));
    await net.runAsync(300);
  }
  await net.runAsync(2000);
  return { net, peers };
}

describe("node: the source is waited for (D64)", () => {
  it("500 ms of silence from the source is no repair anywhere, and the stream comes back where it was", async () => {
    const { net, peers } = await tree();
    // Nothing from the source reaches its children for 500 ms; their links stay open.
    for (const child of ["1", "2"]) net.setWire("0", child, { lossPct: 100 }, false);
    await net.runAsync(500);
    for (const child of ["1", "2"]) net.setWire("0", child, { lossPct: 0 }, false);
    const back = net.published;
    await net.runAsync(3000);
    for (const peer of peers.slice(1)) {
      assert.deepEqual(repairs(peer), [], `peer ${peer.id} repaired`);
      assert.equal(peer.node.status().stripes[0].state, "active");
    }
    for (const peer of peers.slice(1)) {
      const missed: number[] = [];
      // What was sent into the silence is NACK's to recover (or not); from the moment it ends, the
      // same parents carry on with every frame.
      for (let id = back; id < net.published - 5; id++) if (!peer.video.has(id)) missed.push(id);
      assert.deepEqual(missed, [], `peer ${peer.id} missed frames`);
    }
  });

  it("the same silence from a relay is still a repair at deadMs", async () => {
    const { net, peers } = await tree();
    for (const child of ["3", "4"]) net.setWire("1", child, { lossPct: 100 }, false);
    await net.runAsync(500);
    for (const child of ["3", "4"]) net.setWire("1", child, { lossPct: 0 }, false);
    await net.runAsync(2000);
    const [repair] = repairs(peers[3]);
    assert.ok(repair, "the relay's child repaired");
    assert.ok(repair.detected - repair.lastHeard < 250);
  });

  it("D74: a relay whose heartbeats come and whose media does not is left once it has held a keyframe the child could not decode for FROZEN_PARENT_MS", async () => {
    // Gate run 45231661833: a relay moved into a parent whose uplink five replays had filled
    // decoded nothing for 4.5 s while that parent's heartbeats came; its subtree froze with it.
    // (FROZEN_PARENT_MS is longer than a slow link's own recovery: congestion's layer drop, within
    // 2 s, slowChildSim.test.ts; a child of the slow relay froze 1.5-2.5 s there and stays.)
    const { net, peers } = await tree();
    net.setWire("1", "3", { mediaLossPct: 100 }, false);
    await net.runAsync(2000 + FROZEN_PARENT_MS + 1000);
    net.setWire("1", "3", { mediaLossPct: 0 }, false);
    await net.runAsync(1000);
    const [repair] = repairs(peers[3]);
    assert.ok(repair, "the child left the frozen parent");
    assert.equal(repair.next, "2", "for its backup");
    // A keyframe comes every 2 s; the parent holds one the child lacks from then on.
    // Its heartbeats kept coming to the end: the freeze is all before them (`staleMs`, D61).
    const frozenFor = repair.staleMs ?? 0;
    assert.ok(frozenFor >= FROZEN_PARENT_MS && frozenFor <= 2000 + FROZEN_PARENT_MS + 100, `left after ${frozenFor} ms with nothing decodable`);
    assert.deepEqual(repairs(peers[4]), [], "its sibling, whose media came, stayed");
    assert.equal(peers[3].node.status().stripes[0].state, "active");
  });

  it("a source that is really gone is taken for dead after SOURCE_SILENT_MS, not before", async () => {
    const { net, peers } = await tree();
    net.kill("0");
    await net.runAsync(SOURCE_SILENT_MS - 100);
    assert.deepEqual(repairs(peers[1]), []);
    await net.runAsync(3000);
    const detected = peers[1].node.status().stripes[0].state;
    assert.notEqual(detected, "active", "with nobody to watch, the child is not active");
  });
});
