/**
 * [D65] A viewer whose parent sends frames that fail their integrity checks (the application's
 * frameTransform says so, through the engine) leaves that parent: the node reports it
 * (`parent-bad`), rules it out for BAD_PARENT_MS, and repairs. Never the source (D64).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricsEvent } from "@meetly/overlay";
import { BAD_PARENT_MS } from "@meetly/overlay/topology/node";
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
  ] as const) {
    peers.push(net.join(id, id === "1" || id === "2" ? "relay" : "leaf", [parent], backup ? [backup] : []));
    await net.runAsync(300);
  }
  await net.runAsync(2000);
  return { net, peers };
}

describe("node: a parent that sends changed frames is left (D65)", () => {
  it("reports it, repairs to the backup at once, and does not ask for it again", async () => {
    const { net, peers } = await tree();
    const at = net.clock.now();
    assert.equal(peers[3].node.rejectParent("1"), true);
    // A repair is reported a second after its first packet (the window its freeze is measured over).
    await net.runAsync(2500);
    assert.deepEqual([peers[3].node.status().stripes[0].state, peers[3].node.status().stripes[0].parent], ["active", "2"]);
    const [repair] = repairs(peers[3]);
    assert.equal(repair.dead, "1");
    assert.ok(repair.detected - net.sessionClock.fromLocal(at) <= 5, "at once, not after deadMs");
    const told = net.coordinatorLog.filter((entry) => entry.peer === "3").map((entry) => `${entry.what} ${entry.detail}`);
    assert.ok(told.includes("report:parent-bad 1"), told.join("; "));
    // Its sibling, which said nothing, keeps the parent.
    assert.equal(peers[4].node.status().stripes[0].parent, "1");
    // It is excluded from what the node asks the coordinator for, for BAD_PARENT_MS.
    const asked = net.coordinatorLog.filter((entry) => entry.peer === "3" && entry.what.startsWith("need:"));
    assert.ok(asked.every((entry) => entry.detail.split(",").includes("1")), asked.map((entry) => entry.detail).join("; "));
    assert.ok(BAD_PARENT_MS >= 60_000);
  });

  it("does nothing for a peer that is not its parent, nor for the source", async () => {
    const { net, peers } = await tree();
    assert.equal(peers[3].node.rejectParent("2"), false, "the backup is not the parent");
    assert.equal(peers[1].node.rejectParent("0"), false, "the source: nobody else has the stream");
    await net.runAsync(1000);
    assert.deepEqual(repairs(peers[1]), []);
    assert.deepEqual(repairs(peers[3]), []);
    assert.equal(peers[1].node.status().stripes[0].parent, "0");
  });
});
