/** PLAN T3–T5: the node, on simulated links and a fake clock. SPEC §7, §4.4–§4.6. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FROM_LATEST_KEYFRAME, type MetricsEvent, type PeerMessage } from "@meetly/overlay";
import { SimNet, type SimOptions, type SimPeer } from "@meetly/overlay/topology/sim";

type RepairEvent = Extract<MetricsEvent, { t: "repair" }>;
const repairs = (peer: SimPeer) => peer.metrics.filter((event): event is RepairEvent => event.t === "repair");
const stateOf = (peer: SimPeer) => peer.node.status().stripes[0];
const sent = (net: SimNet, from: string, type: PeerMessage["t"], since = 0) => net.messages.filter((m) => m.from === from && m.message.t === type && m.at >= since);

/** Video frames `from`..`to` that `peer` never got whole. */
function missing(peer: SimPeer, from: number, to: number): number[] {
  const out: number[] = [];
  for (let id = from; id <= to; id++) if (!peer.video.has(id)) out.push(id);
  return out;
}

/**
 * The proof's tree (SPEC §17): the source feeds relays 1 and 2; 1 feeds 3 and 4; 2 feeds 5 and 6.
 * Each leaf's backup is the other relay.
 */
async function proofTree(options: SimOptions & { warm?: boolean } = {}) {
  const warm = options.warm ?? true;
  const net = new SimNet({ backups: warm, ...options });
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
    peers.push(net.join(id, id === "1" || id === "2" ? "relay" : "leaf", [parent], warm && backup ? [backup] : []));
    await net.runAsync(300);
  }
  await net.runAsync(2000);
  return { net, peers };
}

describe("node: joining and forwarding on a fixed tree", () => {
  it("every peer subscribes to its parent, stands by on its backup, and gets every frame", async () => {
    const { net, peers } = await proofTree();
    assert.deepEqual(
      peers.map((p) => [stateOf(p).state, stateOf(p).parent, stateOf(p).backup]),
      [
        ["active", null, null],
        // Nobody told the relays who to stand by on: each asked the coordinator, and got the other.
        ["active", "0", "2"],
        ["active", "0", "1"],
        ["active", "1", "2"],
        ["active", "1", "2"],
        ["active", "2", "1"],
        ["active", "2", "1"],
      ],
    );
    assert.deepEqual(peers[0].node.status().children, ["1", "2"]);
    assert.deepEqual(peers[1].node.status().children, ["3", "4"]);
    assert.deepEqual(peers[1].node.status().standbyChildren.sort(), ["2", "5", "6"]);
    assert.deepEqual(peers[3].node.status().path, ["3", "1", "0"]);
    assert.deepEqual(
      peers.map((p) => p.node.status().depth),
      [0, 1, 1, 2, 2, 2, 2],
    );
    assert.equal(peers[1].node.status().freeSlots, 2);
    assert.equal(peers[0].node.status().freeSlots, 1);
    assert.equal(peers[3].node.status().freeSlots, 0);
    // A joiner starts from the newest keyframe and then misses nothing.
    await net.runAsync(1000);
    const head = net.published - 3;
    for (const peer of peers.slice(1)) {
      const first = Math.min(...peer.video);
      assert.equal(first % 60, 0, `peer ${peer.id} started at a keyframe`);
      assert.deepEqual(missing(peer, first, head), [], `peer ${peer.id}`);
    }
    // The joiner asked for the latest keyframe, and nothing else was needed.
    const subs = sent(net, "3", "sub");
    assert.deepEqual(
      subs.map((m) => [m.to, (m.message as Extract<PeerMessage, { t: "sub" }>).mode, (m.message as Extract<PeerMessage, { t: "sub" }>).fromFrame]),
      [
        ["1", "active", FROM_LATEST_KEYFRAME],
        ["1", "active", FROM_LATEST_KEYFRAME],
        ["2", "standby", -2],
        ["2", "standby", -2],
      ],
    );
    // The coordinator was asked for backups by the relays, and for nothing else.
    assert.deepEqual([...new Set(net.coordinatorLog.map((entry) => `${entry.peer} ${entry.what}`))].sort(), ["1 need:backup", "2 need:backup"]);
  });

  it("forwards without waiting for the frame, and counts what it did", async () => {
    const { net, peers } = await proofTree();
    for (const peer of peers) peer.node.takeStats();
    await net.runAsync(2000);
    const relay = peers[1].node.takeStats();
    assert.equal(relay.relay!.children, 2);
    assert.equal(relay.relay!.standby, 3);
    assert.ok(relay.relay!.txKbps > 1500, `tx ${relay.relay!.txKbps}`);
    assert.equal(relay.relay!.forwardP50Us, 0); // nothing waits: same instant on a fake clock
    assert.equal(relay.up!.parent, "0");
    assert.ok(relay.up!.rxKbps > 800);
    assert.ok(relay.up!.rttMs !== null && relay.up!.rttMs >= 2 && relay.up!.rttMs <= 4, `rtt ${relay.up!.rttMs}`);
    assert.equal(peers[3].node.takeStats().relay, null);
    assert.equal(peers[0].node.takeStats().up, null);
    // Each audio frame is sent twice on every hop; the second copy is dropped by id.
    assert.ok(peers[3].node.takeStats().up!.duplicates === 0);
    await net.runAsync(1000);
    const leaf = peers[3].node.takeStats();
    assert.ok(leaf.up!.duplicates >= 45 && leaf.up!.duplicates <= 55, `duplicates ${leaf.up!.duplicates}`);
  });
});

describe("node: failure detection and warm repair (SPEC §7.4, §7.5)", () => {
  it("a parent silent for 200 ms is detected between 200 and 210 ms, and the backup takes over with nothing lost", async () => {
    const { net, peers } = await proofTree({ keepFrames: true });
    const killedAt = net.clock.now();
    net.kill("1");
    const before = net.messages.length;
    await net.runAsync(3000);
    for (const id of [3, 4]) {
      const peer = peers[id];
      assert.deepEqual([stateOf(peer).state, stateOf(peer).parent], ["active", "2"]);
      const [repair] = repairs(peer);
      assert.ok(repair, "a repair was reported");
      assert.equal(repair.kind, "warm");
      assert.equal(repair.dead, "1");
      assert.equal(repair.next, "2");
      assert.equal(repair.usedCoordinator, false);
      const silentFor = repair.detected - repair.lastHeard;
      assert.ok(silentFor >= 200 && silentFor <= 210, `detected after ${silentFor} ms of silence`);
      assert.ok(repair.detected - net.sessionClock.fromLocal(killedAt) <= 210);
      assert.equal(repair.resubscribed, repair.detected);
      assert.ok(repair.firstPacket! - repair.detected <= 5, "the backup answered at once");
      assert.ok(repair.freezeMs <= 250, `froze for ${repair.freezeMs} ms`);
      assert.equal(repair.framesLost, 0);
      assert.deepEqual(missing(peer, Math.min(...peer.video), net.published - 3), []);
      assert.equal(peer.node.status().depth, 2);
      assert.deepEqual(peer.node.status().path, [peer.id, "2", "0"]);
    }
    // The repair asked the backup for everything after the newest base-layer frame it had.
    const asked = net.messages.slice(before).filter((m) => m.from === "3" && m.message.t === "repair");
    assert.equal(asked.length, 2);
    for (const m of asked) {
      const message = m.message as Extract<PeerMessage, { t: "repair" }>;
      assert.equal(m.to, "2");
      assert.equal(message.dead, "1");
      const had = peers[3].frames.filter((f) => f.header.streamId === message.stream && f.completeAt < m.at);
      const newest = message.stream === 0 ? Math.max(...had.filter((f) => f.header.temporal === 0).map((f) => f.header.frameId)) : Math.max(...had.map((f) => f.header.frameId));
      assert.equal(message.fromFrame, newest);
    }
    // Nothing went to the coordinator before the backup had said yes.
    const ack = net.messages.slice(before).find((m) => m.to === "3" && m.message.t === "sub-ack")!;
    const first = net.coordinatorLog.find((entry) => entry.peer === "3")!;
    assert.ok(first.at >= ack.at, "the coordinator heard nothing before sub-ack");
    assert.deepEqual(
      net.coordinatorLog.filter((entry) => entry.peer === "3").map((entry) => entry.what),
      ["report:parent-dead", "need:backup"],
    );
    assert.equal(first.detail, "1>2");
    // The unaffected side saw nothing.
    assert.deepEqual(repairs(peers[5]), []);
    assert.deepEqual(stateOf(peers[5]).parent, "2");
    // Relay 2 dropped its dead standby-parent... and the source its dead child.
    assert.deepEqual(peers[0].node.status().children, ["2"]);
    assert.deepEqual(peers[2].node.status().children.sort(), ["3", "4", "5", "6"]);
  });

  it("a link that closes is a death at once, without waiting deadMs", async () => {
    const { net, peers } = await proofTree();
    const at = net.clock.now();
    peers[1].links.closeAll();
    await net.runAsync(1500);
    const [repair] = repairs(peers[3]);
    assert.equal(repair.kind, "warm");
    assert.ok(repair.detected - net.sessionClock.fromLocal(at) <= 5);
    assert.ok(repair.freezeMs <= 100, `froze for ${repair.freezeMs} ms`);
    assert.equal(repair.framesLost, 0);
  });
});

describe("node: cold repair (SPEC §7.5)", () => {
  it("with no backup, asks the coordinator, links to who it names and resumes from the same frame with nothing lost", async () => {
    const { net, peers } = await proofTree({ warm: false });
    assert.equal(stateOf(peers[3]).backup, null);
    const killedAt = net.clock.now();
    net.kill("1");
    await net.runAsync(3000);
    for (const id of [3, 4]) {
      const peer = peers[id];
      assert.equal(stateOf(peer).state, "active");
      assert.ok(["0", "2"].includes(stateOf(peer).parent!));
      const [repair] = repairs(peer);
      assert.equal(repair.kind, "cold");
      assert.equal(repair.usedCoordinator, true);
      assert.equal(repair.framesLost, 0);
      // Detection (200–210), the coordinator's answer (5) and the link (20), on this fake network.
      assert.ok(repair.freezeMs <= 300, `froze for ${repair.freezeMs} ms`);
      assert.deepEqual(missing(peer, Math.min(...peer.video), net.published - 3), []);
    }
    assert.equal(net.coordinatorLog.find((entry) => entry.peer === "3" && entry.at >= killedAt)!.what, "need:parent");
  });

  it("keeps trying while the coordinator is away, says it is rejoining after 5 s, and recovers when it is back", async () => {
    const { net, peers } = await proofTree({ warm: false });
    net.coordinatorUp = false;
    net.kill("1");
    await net.runAsync(4000);
    assert.equal(stateOf(peers[3]).state, "cold-repair");
    assert.deepEqual(peers[3].errors, []);
    await net.runAsync(2000);
    assert.equal(stateOf(peers[3]).state, "rejoining");
    assert.equal(peers[3].errors.length, 1);
    net.coordinatorUp = true;
    await net.runAsync(35_000);
    assert.equal(stateOf(peers[3]).state, "active");
    assert.ok(peers[3].video.has(net.published - 3));
  });
});

describe("node: STALLED, so one death is one repair (SPEC §7.4, D17)", () => {
  /** A chain: 0 → 1 → 2 → 3, and 4 beside 3. Peer 2 stands by on the source. */
  async function chain(options: SimOptions = {}) {
    const net = new SimNet({ backups: false, params: { sourceFanout: 3 }, ...options });
    const source = net.join("0", "source", []);
    net.publish(source);
    await net.runAsync(300);
    const one = net.join("1", "relay", ["0"]);
    await net.runAsync(300);
    const two = net.join("2", "relay", ["1"], ["0"]);
    await net.runAsync(300);
    const three = net.join("3", "leaf", ["2"]);
    const four = net.join("4", "relay", ["2"]);
    await net.runAsync(2000);
    return { net, source, one, two, three, four };
  }

  it("the depth-1 relay dies: its child repairs, and the peers below that wait and keep their parent", async () => {
    const { net, two, three, four } = await chain();
    assert.deepEqual(three.node.status().path, ["3", "2", "1", "0"]);
    net.kill("1");
    await net.runAsync(3000);
    // Depth 2 repaired to its backup.
    assert.deepEqual([stateOf(two).state, stateOf(two).parent], ["active", "0"]);
    assert.equal(repairs(two)[0].kind, "warm");
    // Depth 3 waited: same parent, no repair of its own, nothing lost, and a short freeze.
    for (const peer of [three, four]) {
      assert.deepEqual([stateOf(peer).state, stateOf(peer).parent], ["active", "2"]);
      const [event, ...more] = repairs(peer);
      assert.deepEqual(more, []);
      assert.equal(event.kind, "wait");
      assert.equal(event.dead, "2");
      assert.equal(event.next, "2");
      assert.equal(event.usedCoordinator, false);
      assert.ok(event.freezeMs <= 300, `froze for ${event.freezeMs} ms`);
      assert.equal(event.framesLost, 0);
      assert.deepEqual(missing(peer, Math.min(...peer.video), net.published - 3), []);
      // And it learned its new place.
      assert.deepEqual(peer.node.status().path, [peer.id, "2", "0"]);
      assert.equal(peer.node.status().depth, 2);
      assert.deepEqual(sent(net, peer.id, "repair"), []);
    }
    // Nor did they tell the coordinator anything about it. (A peer without a backup keeps asking
    // for one, every few seconds, whatever happens: SPEC §7.3. That is all it said.)
    for (const peer of ["3", "4"]) assert.deepEqual(net.coordinatorLog.filter((entry) => entry.peer === peer && entry.what !== "need:backup"), []);
  });

  it("a relay that stays cut off past stallGraceMs is left: its children repair for themselves", async () => {
    const { net, two, three } = await chain();
    // Peer 2 has nowhere to go: its backup dies with its parent, and the coordinator is away.
    net.coordinatorUp = false;
    const at = net.clock.now();
    net.kill("1");
    net.kill("0");
    await net.runAsync(700);
    // Peer 2 is asking a backup that will never answer; peer 3 is told to wait, and does.
    assert.equal(stateOf(two).state, "repairing");
    assert.deepEqual([stateOf(three).state, stateOf(three).parent], ["waiting", "2"]);
    await net.runAsync(150);
    // 200 ms for peer 2 to notice, then 600 ms of grace.
    assert.equal(stateOf(three).state, "cold-repair");
    assert.equal(stateOf(three).parent, null);
    assert.ok(net.clock.now() - at >= 800);
    // It asked nobody for a parent before the grace ran out (only, as always, for a backup).
    assert.deepEqual(net.coordinatorLog.filter((entry) => entry.peer === "3" && entry.what !== "need:backup" && entry.at < at + 800), []);
    assert.ok(net.coordinatorLog.some((entry) => entry.peer === "3" && entry.what === "need:parent"));
  });
});

describe("node: leaving (SPEC §7.7)", () => {
  it("a relay that leaves says so: its children repair at once, losing nothing, and the freeze is under 100 ms", async () => {
    const { net, peers } = await proofTree();
    const left = peers[1].node.stop();
    await net.runAsync(2000);
    await left;
    for (const id of [3, 4]) {
      const [repair] = repairs(peers[id]);
      assert.equal(repair.kind, "warm");
      assert.equal(repair.next, "2");
      assert.ok(repair.freezeMs <= 100, `froze for ${repair.freezeMs} ms`);
      assert.equal(repair.framesLost, 0);
      assert.deepEqual(missing(peers[id], Math.min(...peers[id].video), net.published - 3), []);
    }
    // bye went to the children with somewhere to go, and to the parent and backup.
    const byes = sent(net, "1", "bye");
    assert.deepEqual(byes.map((m) => m.to).sort(), ["0", "2", "3", "4", "5", "6"]);
    const toChild = byes.find((m) => m.to === "3")!.message as Extract<PeerMessage, { t: "bye" }>;
    assert.equal(toChild.reason, "leave");
    assert.deepEqual(toChild.alt!.map((alt) => alt.peer), ["0", "2"]);
    // Those who stood by on it found another backup; the source dropped it as a child.
    assert.deepEqual(peers[0].node.status().children, ["2"]);
    assert.equal(peers[1].node.status().stripes[0].state, "idle");
    assert.equal(peers[1].links.links().length, 0);
  });

  it("a relay told it is a leaf sends its children away with bye, reason rebalance", async () => {
    const { net, peers } = await proofTree();
    net.setRole("1", "leaf");
    await net.runAsync(1500);
    assert.deepEqual(peers[1].node.status().children, []);
    assert.equal(peers[1].node.status().role, "leaf");
    assert.equal(peers[1].node.status().freeSlots, 0);
    assert.equal((sent(net, "1", "bye")[0].message as Extract<PeerMessage, { t: "bye" }>).reason, "rebalance");
    for (const id of [3, 4]) assert.deepEqual([stateOf(peers[id]).state, stateOf(peers[id]).parent], ["active", "2"]);
    // It still watches.
    assert.equal(stateOf(peers[1]).state, "active");
    assert.ok(peers[1].video.has(net.published - 3));
  });

  it("closes the link to a peer the coordinator says is gone", async () => {
    const { net, peers } = await proofTree();
    net.peerGone("3", "1");
    await net.runAsync(1500);
    assert.equal(stateOf(peers[3]).parent, "2");
  });
});

describe("node: who may subscribe (SPEC §5.3, §7.2, §7.3)", () => {
  const acks = (net: SimNet, to: string) =>
    net.messages.filter((m) => m.to === to && m.message.t === "sub-ack").map((m) => m.message as Extract<PeerMessage, { t: "sub-ack" }>);

  it("a leaf refuses with \"denied\"; the joiner moves to its next candidate", async () => {
    const { net } = await proofTree();
    const joiner = net.join("9", "leaf", ["3", "1"]);
    await net.runAsync(500);
    assert.equal(acks(net, "9").find((ack) => !ack.ok)!.code, "denied");
    assert.equal(stateOf(joiner).parent, "1");
  });

  it("a relay at its fan-out takes a joiner all the same, up to twice it, and caps everyone; a peer watching elsewhere is refused", async () => {
    const { net, peers } = await proofTree({ params: { maxFanout: 2 } });
    const relay = peers[1];
    // Two joiners with nothing to watch: relay 1 takes both, over its fan-out of two.
    const joiners = [net.join("8", "leaf", ["1"]), net.join("9", "leaf", ["1"])];
    await net.runAsync(800);
    for (const joiner of joiners) assert.deepEqual([stateOf(joiner).state, stateOf(joiner).parent], ["active", "1"]);
    assert.deepEqual(relay.node.status().children.sort(), ["3", "4", "8", "9"]);
    assert.equal(relay.node.status().freeSlots, 0);
    const live = relay.gates.filter((gate) => gate.listeners > 0 && gate.overload);
    assert.ok(live.length >= 8, `${live.length} gates told of the overload`);
    // Twice the fan-out is the end of it: the next joiner is refused and goes on to relay 2.
    const late = net.join("10", "leaf", ["1", "2"]);
    await net.runAsync(800);
    assert.ok(acks(net, "10").some((ack) => !ack.ok && ack.code === "full"));
    assert.equal(stateOf(late).parent, "2");
    // A peer that is watching (it asks from a frame of its own) is refused, overloaded or not.
    net.assign("5", [{ stream: 0, stripe: 0, parents: [{ peer: "1", depth: 1, free: 1 }], backups: [] }], "move");
    await net.runAsync(800);
    assert.ok(acks(net, "5").some((ack) => !ack.ok && ack.code === "full"));
    assert.equal(stateOf(peers[5]).parent, "2");
  });

  it("a relay holds 2 × maxFanout standby places, and no more", async () => {
    const net = new SimNet({ backups: false, params: { maxFanout: 1, sourceFanout: 8 } });
    net.publish(net.join("0", "source", []));
    const relay = net.join("1", "relay", ["0"]);
    await net.runAsync(300);
    const leaves = ["a", "b", "c"].map((id) => net.join(id, "leaf", ["0"], ["1"]));
    await net.runAsync(1500);
    assert.equal(relay.node.status().standbyChildren.length, 2);
    assert.deepEqual(leaves.map((leaf) => stateOf(leaf).backup).sort(), ["1", "1", null]);
    assert.ok(acks(net, leaves.find((leaf) => stateOf(leaf).backup === null)!.id).some((ack) => ack.code === "full"));
  });

  it("refuses with \"loop\" a sub from one of its own ancestors, and the stream it does not carry with \"no-stream\"", async () => {
    const { net, peers } = await proofTree();
    // Relay 1 is told (wrongly) that its child 3 could be its backup, and that 3 could be a parent.
    net.setRole("3", "relay");
    net.assign("1", [{ stream: 0, stripe: 0, parents: [{ peer: "3", depth: 0, free: 1 }], backups: [] }], "rebalance");
    await net.runAsync(1500);
    assert.ok(acks(net, "1").some((ack) => !ack.ok && ack.code === "loop"));
    assert.notEqual(stateOf(peers[1]).backup, "3");
    assert.equal(stateOf(peers[1]).parent, "0");
  });

  it("a peer that finds itself in the path it is given unsubscribes at once and repairs cold", async () => {
    const net = new SimNet({ backups: false });
    net.publish(net.join("0", "source", []));
    const a = net.join("a", "relay", ["0"]);
    await net.runAsync(300);
    const b = net.join("b", "relay", ["a"]);
    await net.runAsync(1000);
    // "a" is made to believe it sits under "b": the path "b" sends has "a" in it.
    const link = [...a.links.map.values()].find((l) => l.peer === "0")!;
    link.events.emit("message", { t: "path", path: ["0", "b", "a", "0"] });
    assert.equal(stateOf(a).parent, null);
    assert.equal(stateOf(a).state, "cold-repair");
    assert.equal(sent(net, "a", "unsub").length, 2);
    void b;
  });

  it("drops a packet that has made 32 hops", async () => {
    const net = new SimNet({ backups: false, params: { sourceFanout: 1, maxFanout: 1 } });
    net.publish(net.join("0", "source", []));
    let last: SimPeer | null = null;
    for (let i = 1; i <= 34; i++) {
      last = net.join(String(i), "relay", [String(i - 1)]);
      await net.runAsync(60);
    }
    await net.runAsync(3000);
    assert.ok(net.nodes.get("32")!.video.size > 30);
    assert.equal(net.nodes.get("33")!.video.size, 0);
    assert.equal(last!.video.size, 0);
  });
});

describe("node: keeping a backup (SPEC §7.3)", () => {
  it("replaces a backup that goes silent for standbyDeadMs, telling the coordinator", async () => {
    const { net, peers } = await proofTree();
    await net.runAsync(500);
    const at = net.clock.now();
    // Peer 5's backup is relay 1. Its parent, relay 2, lives on.
    net.kill("1");
    await net.runAsync(1300);
    const log = net.coordinatorLog.filter((entry) => entry.peer === "5" && entry.at >= at).map((entry) => `${entry.what} ${entry.detail}`);
    assert.equal(log[0], "report:backup-lost 1");
    assert.ok(log[1].startsWith("need:backup"));
    await net.runAsync(1500);
    assert.equal(stateOf(peers[5]).parent, "2");
    assert.equal(stateOf(peers[5]).backup, "0");
    assert.deepEqual(repairs(peers[5]), []);
  });

  it("a false alarm costs one switch: the old parent, alive after all, becomes the backup", async () => {
    const { net, peers } = await proofTree();
    // Relay 1 falls silent toward peer 3 for 300 ms, and then is back.
    net.setWire("1", "3", { lossPct: 100 }, false);
    await net.runAsync(300);
    net.setWire("1", "3", { lossPct: 0 }, false);
    await net.runAsync(2000);
    assert.deepEqual([stateOf(peers[3]).state, stateOf(peers[3]).parent, stateOf(peers[3]).backup], ["active", "2", "1"]);
    assert.equal(repairs(peers[3]).length, 1);
    assert.equal(repairs(peers[3])[0].framesLost, 0);
    assert.ok(peers[1].node.status().standbyChildren.includes("3"));
  });

  it("a relay over its fan-out after a repair takes the child in and sheds a layer for everyone, until it is back within it", async () => {
    const { net, peers } = await proofTree({ params: { maxFanout: 3 } });
    net.kill("1");
    await net.runAsync(1500);
    // Relay 2 had two children and a fan-out of three; both of relay 1's came to it.
    assert.equal(peers[2].node.status().children.length, 4);
    assert.equal(peers[2].node.status().freeSlots, 0);
    assert.equal(sent(net, "2", "sub-ack").filter((m) => !(m.message as Extract<PeerMessage, { t: "sub-ack" }>).ok).length, 0);
    const live = () => peers[2].gates.filter((gate) => gate.listeners > 0);
    // Two streams for each of four children.
    assert.equal(live().length, 8);
    assert.ok(live().every((gate) => gate.overload));
    // One leaves: within its fan-out again, and nobody is capped any more.
    net.kill("6");
    await net.runAsync(1500);
    assert.equal(peers[2].node.status().children.length, 3);
    assert.equal(live().length, 6);
    assert.ok(live().every((gate) => !gate.overload));
  });
});
