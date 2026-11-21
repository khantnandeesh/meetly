/** PLAN T5: NACK and retransmission (SPEC §4.6, D5), and rebalancing with hysteresis (SPEC §7.6). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NACK_WHOLE_FRAME, encodeNack, type MetricsEvent } from "@meetly/overlay";
import { SimNet, type SimPeer } from "@meetly/overlay/topology/sim";

const stateOf = (peer: SimPeer) => peer.node.status().stripes[0];
const repairs = (peer: SimPeer) => peer.metrics.filter((event) => event.t === "repair");
const switches = (peer: SimPeer) => peer.metrics.filter((event): event is Extract<MetricsEvent, { t: "switch" }> => event.t === "switch");

/** Video frames `from`..`to` that `peer` never got whole. */
function missing(peer: SimPeer, from: number, to: number): number[] {
  const out: number[] = [];
  for (let id = from; id <= to; id++) if (!peer.video.has(id)) out.push(id);
  return out;
}

/** The most a packet can be (SPEC D3). */
const MAX_PACKET = 1150;

describe("node: NACK and retransmission (SPEC §4.6, D5)", () => {
  for (const seed of [1, 2, 3]) {
    it(`a link with 3% loss loses under 0.3% of frames at the leaf, for under 20% of the bitrate in retransmissions (seed ${seed})`, async () => {
      // 15 ms a hop: a NACK's round trip is 30 ms, inside the playout delay.
      const net = new SimNet({ seed, backups: false, latencyMs: 15 });
      const source = net.join("0", "source", []);
      net.publish(source);
      await net.runAsync(300);
      const relay = net.join("1", "relay", ["0"]);
      await net.runAsync(300);
      const leaf = net.join("2", "leaf", ["1"]);
      await net.runAsync(2000);
      // Both directions, so NACKs and feedback are lost as well as media.
      net.setWire("1", "2", { lossPct: 3 });
      const from = net.published;
      relay.node.takeStats();
      leaf.node.takeStats();
      const seconds = 30;
      await net.runAsync(seconds * 1000);
      const to = net.published - 10;
      const lost = missing(leaf, from, to).length;
      assert.ok(lost / (to - from + 1) < 0.003, `lost ${lost} of ${to - from + 1} frames`);
      const relayed = relay.node.takeStats().relay!;
      const asked = leaf.node.takeStats().up!;
      assert.ok(asked.nacksSent > 50, `the leaf asked ${asked.nacksSent} times`);
      assert.ok(asked.retransmitsReceived > 50, `received ${asked.retransmitsReceived} retransmissions`);
      const retransmitKbps = (relayed.retransmitsSent * MAX_PACKET * 8) / seconds / 1000;
      assert.ok(retransmitKbps < 0.2 * 1200, `retransmissions took up to ${retransmitKbps.toFixed(1)} kbps`);
      assert.deepEqual(repairs(leaf), []);
    });
  }

  it("a parent answers a child's NACKs with no more than 20% of the stream's bitrate, over any second", async () => {
    const net = new SimNet({ backups: false, latencyMs: 5 });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    net.join("1", "leaf", ["0"]);
    await net.runAsync(2000);
    source.node.takeStats();
    // A greedy child: it asks for every one of the last 60 frames, whole, ten times a second.
    const link = source.links.map.get("1")!;
    const seconds = 5;
    const stop = net.clock.setInterval(() => {
      const head = net.published - 1;
      const items = Array.from({ length: 60 }, (_, i) => ({ streamId: 0, frameId: head - i, firstFrag: NACK_WHOLE_FRAME, mask: 0 }));
      for (let i = 0; i < items.length; i += 30) link.events.emit("packet", encodeNack({ linkSeq: 0, sendMs: 0, items: items.slice(i, i + 30) }), net.clock.now());
    }, 100);
    await net.runAsync(seconds * 1000);
    stop();
    const sent = source.node.takeStats().relay!.retransmitsSent;
    assert.ok(sent > 50, `answered ${sent}`);
    // 20% of 1,200 kbps is 30 kB a second; the bucket starts full, so one second more.
    assert.ok(sent * 1000 <= 0.2 * 1200 * 125 * (seconds + 1), `answered ${sent} packets`);
  });
});

describe("node: rebalancing (SPEC §7.6)", () => {
  /** A source, two relays, and a leaf placed under `a` with `b` standing by, at the one-way delays given. */
  async function twoParents(toA: number, toB: number) {
    const net = new SimNet({ backups: false, latencyMs: 1 });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    net.join("a", "relay", ["0"]);
    net.join("b", "relay", ["0"]);
    await net.runAsync(300);
    net.setWire("L", "a", { latencyMs: toA });
    net.setWire("L", "b", { latencyMs: toB });
    const joinedAt = net.sessionClock.fromLocal(net.clock.now());
    const leaf = net.join("L", "leaf", ["a"], ["b"]);
    return { net, leaf, joinedAt };
  }

  it("a peer under a parent 80 ms away, with one 15 ms away standing by, switches within 45 s, once, with no freeze", async () => {
    const { net, leaf, joinedAt } = await twoParents(40, 7.5);
    await net.runAsync(5000);
    assert.deepEqual([stateOf(leaf).parent, stateOf(leaf).backup], ["a", "b"]);
    await net.runAsync(40_000);
    const moves = switches(leaf);
    assert.equal(moves.length, 1);
    const [move] = moves;
    assert.deepEqual([move.from, move.to], ["a", "b"]);
    const after = move.at - joinedAt;
    assert.ok(after <= 45_000, `switched after ${after} ms`);
    // Not before rebalanceMinMs, and only after three comparisons running.
    assert.ok(after >= 30_000, `switched after ${after} ms`);
    // Make before break: the longest gap is the frame interval.
    assert.ok(move.freezeMs < 50, `froze for ${move.freezeMs} ms`);
    assert.deepEqual(missing(leaf, Math.min(...leaf.video), net.published - 3), []);
    assert.deepEqual(repairs(leaf), []);
    // The old parent stands by.
    assert.deepEqual([stateOf(leaf).state, stateOf(leaf).parent, stateOf(leaf).backup], ["active", "b", "a"]);
    assert.ok(net.nodes.get("a")!.node.status().standbyChildren.includes("L"));
    assert.equal(net.coordinatorLog.filter((entry) => entry.peer === "L" && entry.what === "report:parent-switch").length, 1);
  });

  it("does not switch for a gain under 20% or under 20 ms", async () => {
    // Round trips of 50 and 40 ms: costs of 80 and 70, better by 12.5% and by 10 ms.
    const { net, leaf } = await twoParents(25, 20);
    await net.runAsync(60_000);
    assert.deepEqual(switches(leaf), []);
    assert.equal(stateOf(leaf).parent, "a");
  });
});
