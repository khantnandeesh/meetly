/** PLAN T5: NACK and retransmission (SPEC §4.6, D5), and rebalancing with hysteresis (SPEC §7.6). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NACK_WHOLE_FRAME, PacketType, encodeNack, type MetricsEvent } from "@meetly/overlay";
import type { LinkEstimator, UplinkProbe } from "@meetly/overlay/congestion/types";
import type { LinkEstimate } from "@meetly/overlay/types";
import { createBasicEstimator, createOpenGate, type OpenGate } from "@meetly/overlay/topology/standins";
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

describe("node: NACK under the gate mix's bad profile (SPEC §4.6, §12.3)", () => {
  // The harness's "bad" profile (harness/scenarios.ts): 60 ms, 0–40 ms of jitter, 3% loss in
  // Gilbert–Elliott bursts, on every direction of both hops.
  const BAD = { latencyMs: 60, jitterMs: 40, lossPct: 3, burst: { enterPct: 1, leavePct: 30, lossPctInBurst: 50 } };
  for (const seed of [1, 2, 3]) {
    it(`two bad hops lose under 0.5% of frames at the leaf, retransmitting under twice what was really lost (D39, seed ${seed})`, async () => {
      const net = new SimNet({ seed, backups: false, latencyMs: 5 });
      const source = net.join("0", "source", []);
      net.publish(source);
      await net.runAsync(300);
      const relay = net.join("1", "relay", ["0"]);
      await net.runAsync(300);
      const leaf = net.join("2", "leaf", ["1"]);
      await net.runAsync(2000);
      net.setWire("0", "1", BAD);
      net.setWire("1", "2", BAD);
      source.node.takeStats();
      relay.node.takeStats();
      const hops = [source.links.map.get("1")!, relay.links.map.get("2")!];
      const lostBefore = hops.map((link) => link.lostMedia);
      const from = net.published;
      await net.runAsync(30_000);
      const to = net.published - 20;
      const lost = missing(leaf, from, to).length;
      assert.ok(lost / (to - from + 1) < 0.005, `lost ${lost} of ${to - from + 1}`);
      // 0–40 ms of jitter, against a 10 ms window, made about four retransmissions for each real loss:
      // packets that were only late were asked for. The window follows the jitter now.
      const retransmitted = [source.node.takeStats().relay!.retransmitsSent, relay.node.takeStats().relay!.retransmitsSent];
      hops.forEach((link, hop) => {
        const really = link.lostMedia - lostBefore[hop];
        assert.ok(really > 50, `hop ${hop}: ${really} lost`);
        assert.ok(retransmitted[hop] < 2 * really, `hop ${hop}: ${retransmitted[hop]} retransmissions for ${really} packets lost`);
      });
    });
  }
});

describe("node: a provisional relay (SPEC §8.1 [D38])", () => {
  it("takes the fan-out it is given with its role, and its full one when confirmed", async () => {
    const net = new SimNet({ backups: false, params: { sourceFanout: 3, maxFanout: 4 } });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    const relay = net.join("1", "leaf", ["0"]);
    await net.runAsync(500);
    net.setRole("1", "relay", 2);
    await net.runAsync(100);
    assert.deepEqual([relay.node.status().role, relay.node.status().freeSlots], ["relay", 2]);
    // Two viewers fill it; a third, watching elsewhere (it asks from a frame of its own), is refused.
    net.join("a", "leaf", ["1"]);
    net.join("b", "leaf", ["1"]);
    const c = net.join("c", "leaf", ["0"]);
    await net.runAsync(800);
    assert.deepEqual(relay.node.status().children.sort(), ["a", "b"]);
    assert.equal(relay.node.status().freeSlots, 0);
    net.assign("c", [{ stream: 0, stripe: 0, parents: [{ peer: "1", depth: 1, free: 1 }], backups: [] }], "move");
    await net.runAsync(800);
    assert.equal(stateOf(c).parent, "0");
    // Confirmed past probation: role relay again, with no cap.
    net.setRole("1", "relay");
    await net.runAsync(100);
    assert.equal(relay.node.status().freeSlots, 2);
    net.assign("c", [{ stream: 0, stripe: 0, parents: [{ peer: "1", depth: 1, free: 1 }], backups: [] }], "move");
    await net.runAsync(800);
    assert.equal(stateOf(c).parent, "1");
    assert.deepEqual(relay.node.status().children.sort(), ["a", "b", "c"]);
  });
});

describe("node: its own stall is not its parent's death (SPEC §7.4)", () => {
  async function tree() {
    const net = new SimNet({ backups: true });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    net.join("1", "relay", ["0"]);
    net.join("2", "relay", ["0"]);
    await net.runAsync(300);
    const leaf = net.join("3", "leaf", ["1"], ["2"]);
    await net.runAsync(2000);
    return { net, leaf };
  }

  it("a viewer whose tab is busy for 300 ms keeps its parent, and catches up with nothing lost", async () => {
    const { net, leaf } = await tree();
    const from = net.published;
    // Nothing runs on the viewer for 300 ms; then its late tick runs first, before the packets that queued.
    net.stall("3", 300);
    await net.runAsync(2000);
    assert.deepEqual(repairs(leaf), []);
    assert.deepEqual([stateOf(leaf).state, stateOf(leaf).parent, stateOf(leaf).backup], ["active", "1", "2"]);
    assert.deepEqual(missing(leaf, from, net.published - 3), []);
  });

  it("a parent that really is silent is still found dead in 200–210 ms", async () => {
    const { net, leaf } = await tree();
    net.kill("1");
    await net.runAsync(1500);
    const [repair] = repairs(leaf) as Extract<MetricsEvent, { t: "repair" }>[];
    assert.equal(repair.kind, "warm");
    const silentFor = repair.detected - repair.lastHeard;
    assert.ok(silentFor >= 200 && silentFor <= 210, `detected after ${silentFor} ms`);
  });
});

describe("node: NACK into a backlog (SPEC §4.6, D36)", () => {
  it("a backed-up child is not sent an enhancement layer again; its lost keyframe packet is, once the backlog clears", async () => {
    const net = new SimNet({ backups: false, latencyMs: 5 });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    const leaf = net.join("1", "leaf", ["0"]);
    await net.runAsync(2500);
    const link = source.links.map.get("1")!;
    const head = net.published - 1;
    const keyframe = head - (head % 60);
    const enhancement = head % 2 === 1 ? head : head - 1;
    // The link to the child holds 100 ms of the stream: over the strained line of 50 ms.
    link.bufferedAmount = (1200 * 100) / 8;
    source.node.takeStats();
    const ask = (frameId: number) => link.events.emit("packet", encodeNack({ linkSeq: 0, sendMs: 0, items: [{ streamId: 0, frameId, firstFrag: 0, mask: 0 }] }), net.clock.now());
    ask(keyframe);
    ask(enhancement);
    await net.runAsync(100);
    assert.equal(source.node.takeStats().relay!.retransmitsSent, 0, "nothing goes into the backlog");
    // The backlog clears: the keyframe packet goes, the enhancement packet never does.
    link.bufferedAmount = 0;
    await net.runAsync(100);
    assert.equal(source.node.takeStats().relay!.retransmitsSent, 1);
    void leaf;
  });

  it("with no backlog, both are answered at once", async () => {
    const net = new SimNet({ backups: false, latencyMs: 5 });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    net.join("1", "leaf", ["0"]);
    await net.runAsync(2500);
    const link = source.links.map.get("1")!;
    const head = net.published - 1;
    source.node.takeStats();
    for (const frameId of [head - (head % 60), head % 2 === 1 ? head : head - 1]) link.events.emit("packet", encodeNack({ linkSeq: 0, sendMs: 0, items: [{ streamId: 0, frameId, firstFrag: 0, mask: 0 }] }), net.clock.now());
    await net.runAsync(20);
    assert.equal(source.node.takeStats().relay!.retransmitsSent, 2);
  });
});

describe("node: measuring spare uplink (SPEC §8.1, §11.6)", () => {
  /** A probe that asks for `perTick` packets of 1,000 bytes for `forMs`, then reports what the parent's feedback said was delivered. */
  function fakeProbe(perTick: number, forMs: number) {
    let startedAt: number | null = null;
    let spare: number | null = null;
    const views: LinkEstimate[] = [];
    const probe: UplinkProbe = {
      next(view, now) {
        views.push(view);
        startedAt ??= now;
        if (now - startedAt >= forMs) {
          spare ??= view.deliveredKbps;
          return [];
        }
        return Array.from({ length: perTick }, () => 1000);
      },
      get spareKbps() {
        return spare;
      },
    };
    return { probe, views };
  }

  it("sends PROBE packets to the parent in the lowest class, hears FEEDBACK back while they come, and reports the result", async () => {
    const made: ({ bitrateKbps: number } | undefined)[] = [];
    const heard = new Map<LinkEstimator, number>();
    const net = new SimNet({
      backups: false,
      createLinkEstimator: (options?: { bitrateKbps: number }) => {
        made.push(options);
        const estimator = createBasicEstimator();
        const onFeedback = estimator.onFeedback.bind(estimator);
        estimator.onFeedback = (feedback, now) => {
          heard.set(estimator, (heard.get(estimator) ?? 0) + 1);
          onFeedback(feedback, now);
        };
        return estimator;
      },
    });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    const relay = net.join("1", "relay", ["0"]);
    await net.runAsync(1500);
    // Every estimator is made with the video stream's bitrate, B of SPEC §11.2.
    assert.ok(made.length > 0 && made.every((options) => options?.bitrateKbps === 1200));

    const toParent = relay.links.map.get("0")!;
    const toChild = source.links.map.get("1")!;
    const feedbackDown = () => toChild.sentByType.get(PacketType.Feedback)?.get("control") ?? 0;
    assert.equal(feedbackDown(), 0, "no feedback goes down while nobody probes");

    const results: (number | null)[] = [];
    relay.node.on("probe", (spare) => results.push(spare));
    const { probe, views } = fakeProbe(2, 1000);
    relay.node.runProbe(probe);
    await net.runAsync(1500);
    // About 2 packets every 10 ms for a second, all in class "replay".
    const probes = toParent.sentByType.get(PacketType.Probe)!;
    assert.deepEqual([...probes.keys()], ["replay"]);
    assert.ok(probes.get("replay")! >= 190 && probes.get("replay")! <= 210, `${probes.get("replay")} probes`);
    // The parent told the prober how it fared: every feedbackMs while probes came, and for up to
    // PROBING_MS after the last, the first interval thrown away.
    assert.ok(feedbackDown() >= 8 && feedbackDown() <= 20, `${feedbackDown()} feedback packets down`);
    assert.ok(views.length > 50);
    assert.equal(results.length, 1);
    assert.ok(results[0] !== null && results[0] > 0, `spare ${results[0]}`);
    // Once the probes have stopped for PROBING_MS, so does the feedback.
    await net.runAsync(1000);
    const after = feedbackDown();
    await net.runAsync(2000);
    assert.equal(feedbackDown(), after);
    // And media never stopped.
    assert.deepEqual(missing(relay, Math.min(...relay.video), net.published - 3), []);
  });

  it("a probe with no parent, or cut short by a change of parent, reports null", async () => {
    const net = new SimNet({ backups: true });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    net.join("1", "relay", ["0"]);
    net.join("2", "relay", ["0"]);
    await net.runAsync(300);
    const leaf = net.join("3", "leaf", ["1"], ["2"]);
    await net.runAsync(1500);
    const results: (number | null)[] = [];
    source.node.on("probe", (spare) => results.push(spare));
    leaf.node.on("probe", (spare) => results.push(spare));
    source.node.runProbe(fakeProbe(1, 1000).probe);
    leaf.node.runProbe(fakeProbe(1, 1000).probe);
    await net.runAsync(100);
    net.kill("1");
    await net.runAsync(1500);
    assert.deepEqual(results, [null, null]);
    assert.equal(stateOf(leaf).parent, "2");
  });
});

describe("node: a repair onto a backup over its fan-out (SPEC §7.5 step 2)", () => {
  it("counts as lost only what was sent and never arrived, not the layer the backup sheds", async () => {
    // A gate that does what congestion's does under overload: the top temporal layer stops.
    const shedding = (options: Parameters<typeof createOpenGate>[0]): OpenGate => {
      const gate = createOpenGate(options);
      const admit = gate.admit;
      gate.admit = (header, ...rest) => (gate.overload && header.temporal >= 2 ? false : admit(header, ...rest));
      return gate;
    };
    const net = new SimNet({ backups: true, params: { sourceFanout: 2, maxFanout: 2 }, createLayerGate: shedding });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    for (const [id, parent, backup] of [["1", "0", null], ["2", "0", null], ["3", "1", "0"], ["4", "1", "0"]] as const) {
      net.join(id, id === "1" || id === "2" ? "relay" : "leaf", [parent], backup ? [backup] : []);
      await net.runAsync(300);
    }
    await net.runAsync(2000);
    source.node.takeStats();
    net.kill("1");
    await net.runAsync(2500);
    // Both orphans went to the source, which is now over its fan-out of two and sheds layer 2.
    assert.deepEqual(source.node.status().children.sort(), ["2", "3", "4"]);
    assert.ok(source.node.takeStats().relay!.layerDrops > 10);
    for (const id of ["3", "4"]) {
      const [repair] = repairs(net.nodes.get(id)!) as Extract<MetricsEvent, { t: "repair" }>[];
      assert.equal(repair.kind, "warm");
      assert.equal(repair.framesLost, 0, `peer ${id}: ${repair.framesLost} frames counted lost`);
      assert.ok(repair.freezeMs <= 250, `froze for ${repair.freezeMs} ms`);
    }
  });
});

describe('node: the coordinator says "move" (coordinator/README.md, "Keeping the tree short")', () => {
  /** The source feeds relays a and b; leaf L sits under a, standing by on b; relay c (under b) is free. */
  async function tree() {
    const net = new SimNet({ backups: false });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    net.join("a", "relay", ["0"]);
    net.join("b", "relay", ["0"]);
    await net.runAsync(300);
    net.join("c", "relay", ["b"]);
    await net.runAsync(300);
    const leaf = net.join("L", "leaf", ["a"], ["b"]);
    await net.runAsync(2000);
    return { net, leaf };
  }
  const move = (net: SimNet, to: string, parents: string[]) =>
    net.assign(to, [{ stream: 0, stripe: 0, parents: parents.map((peer) => ({ peer, depth: 1, free: 1 })), backups: [] }], "move");

  it("changes to the first parent that will have it, make-before-break, whatever its cost rule says", async () => {
    const { net, leaf } = await tree();
    // c is deeper than a: the cost rule would never move there.
    move(net, "L", ["c"]);
    await net.runAsync(2000);
    assert.equal(stateOf(leaf).parent, "c");
    const [moved, ...more] = switches(leaf);
    assert.deepEqual(more, []);
    assert.deepEqual([moved.from, moved.to], ["a", "c"]);
    assert.ok(moved.freezeMs < 50, `froze for ${moved.freezeMs} ms`);
    assert.deepEqual(missing(leaf, Math.min(...leaf.video), net.published - 3), []);
    assert.deepEqual(leaf.node.status().path, ["L", "c", "b", "0"]);
    // The old parent stands by, and the old backup, b, is let go.
    assert.equal(stateOf(leaf).backup, "a");
    assert.ok(!net.nodes.get("b")!.node.status().standbyChildren.includes("L"));
    assert.deepEqual(repairs(leaf), []);
  });

  it("tries the next when one will not have it, and stays where it is when none will", async () => {
    const { net, leaf } = await tree();
    // A leaf refuses ("denied"); the source is not on offer; c will.
    net.join("x", "leaf", ["b"]);
    await net.runAsync(500);
    move(net, "L", ["x", "L", "c"]);
    await net.runAsync(2000);
    assert.equal(stateOf(leaf).parent, "c");
    // Nobody will: it stays.
    move(net, "L", ["x"]);
    await net.runAsync(2000);
    assert.deepEqual([stateOf(leaf).state, stateOf(leaf).parent], ["active", "c"]);
    assert.equal(switches(leaf).length, 1);
    assert.deepEqual(missing(leaf, Math.min(...leaf.video), net.published - 3), []);
  });

  it("never moves below itself", async () => {
    const { net } = await tree();
    // b is told to move under c, its own child.
    move(net, "b", ["c"]);
    await net.runAsync(2000);
    assert.equal(stateOf(net.nodes.get("b")!).parent, "0");
    assert.equal(stateOf(net.nodes.get("c")!).parent, "b");
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
