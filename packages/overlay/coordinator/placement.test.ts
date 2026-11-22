/**
 * K2 (PLAN §5): the tree map from `status`, placement, and `need`. Simulated peers join a real
 * core through its real messages; see `Swarm` in ./testkit.ts for what they do.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PARAMS } from "@meetly/overlay/protocol";
import type { ClientMessage, PeerId, ServerMessage, ServerMessageOf } from "@meetly/overlay/protocol";
import { Rig, STREAMS, Swarm, leafCaps, relayCaps, seeded } from "./testkit";

const of = <T extends ServerMessage["t"]>(messages: ServerMessage[], t: T): ServerMessageOf<T>[] => messages.filter((message): message is ServerMessageOf<T> => message.t === t);

/** `n` peers in all (one is the source); exactly a quarter of the viewers can relay, in a shuffled order. */
async function fill(n: number, perSecond: number, seed: number, moves: boolean, settleS: number): Promise<Swarm> {
  const random = seeded(seed);
  const viewers = n - 1;
  const capable = new Array<boolean>(viewers).fill(false).map((_, index) => index < Math.ceil(viewers / 4));
  for (let i = viewers - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [capable[i], capable[j]] = [capable[j], capable[i]];
  }
  const swarm = new Swarm(new Rig({ moves, random: seeded(seed) }));
  await swarm.addSource();
  let joined = 0;
  while (joined < viewers) {
    for (let k = 0; k < perSecond && joined < viewers; k++) await swarm.addViewer(capable[joined++]);
    await swarm.second();
  }
  for (let s = 0; s < settleS; s++) await swarm.second();
  return swarm;
}

const bound = (n: number) => Math.ceil(Math.log(n) / Math.log(4)) + 1;

describe("coordinator placement: a growing tree (SPEC §6.6)", () => {
  it("200 joins, a quarter able to relay: depth ≤ ⌈log₄ n⌉ + 1, nobody offered a full relay, backups clear of parents", async () => {
    const swarm = await fill(200, 1, 11, true, 150);
    const shape = swarm.shape();
    const apart = swarm.backupsApart / swarm.placements;
    console.log(`      200 peers: depth ${shape.maxDepth} (bound ${bound(200)}), mean ${shape.meanDepth.toFixed(2)}, ${shape.relays} relays, ${swarm.moves} moves, backups apart ${(apart * 100).toFixed(1)}%`);
    assert.equal(shape.waiting, 0, "everyone has a parent");
    assert.ok(shape.maxDepth <= bound(200), `depth ${shape.maxDepth}`);
    assert.equal(swarm.offeredBeyondFree, 0);
    assert.ok(apart >= 0.95, `first backup clear of first parent for ${(apart * 100).toFixed(1)}%`);
    // The coordinator's map is what the peers said: the same tree.
    const records = new Map(swarm.rig.core.snapshot().peers.map((peer) => [peer.peer, peer]));
    for (const peer of swarm.peers.values()) {
      const record = records.get(peer.peer)!;
      assert.deepEqual([record.depth, record.links[0]?.parent ?? null, record.role], [peer.depth, peer.parent, peer.role]);
    }
  });

  it("1,000 joins at five a second: the same", { timeout: 120_000 }, async () => {
    const swarm = await fill(1000, 5, 12, true, 200);
    const shape = swarm.shape();
    const apart = swarm.backupsApart / swarm.placements;
    console.log(`      1,000 peers: depth ${shape.maxDepth} (bound ${bound(1000)}), mean ${shape.meanDepth.toFixed(2)}, ${shape.relays} relays, ${swarm.moves} moves, backups apart ${(apart * 100).toFixed(1)}%`);
    assert.equal(shape.waiting, 0);
    assert.ok(shape.maxDepth <= bound(1000), `depth ${shape.maxDepth}`);
    assert.equal(swarm.offeredBeyondFree, 0);
    assert.ok(apart >= 0.95);
  });

  it("without the coordinator's moves the same audience makes a deeper tree than the bound", async () => {
    // Why `assign` "move" exists: arrivals in no order leave relays below dead ends that came
    // first. If this starts to fail, placement alone got good enough: tighten the test.
    const swarm = await fill(200, 1, 11, false, 60);
    const shape = swarm.shape();
    console.log(`      200 peers, no moves: depth ${shape.maxDepth}, mean ${shape.meanDepth.toFixed(2)}, ${shape.waiting} without a parent`);
    assert.ok(shape.maxDepth > bound(200) || shape.waiting > 0);
    assert.equal(swarm.offeredBeyondFree, 0);
  });

  it("the smoke's tree (7 peers, fan-outs 2): a full relay whose verdict says one child keeps the two its node takes", async () => {
    // A full relay's `role` carries no fan-out: its node takes `maxFanout`, and says so in its
    // free slots, which placement offers. Relief by the verdict (here 1: a probe short of its
    // target, or sized by the video where the verdict is by the session) moved its second child
    // to a sibling, a level down; the swarm smoke test's kill then orphaned one viewer, not two.
    for (let seed = 1; seed <= 3; seed++) {
      const params = { ...DEFAULT_PARAMS, sourceFanout: 2, maxFanout: 2, probationMs: 3000 };
      const swarm = new Swarm(new Rig({ random: seeded(seed), params }), undefined, { probeAt: ({ placedAt }) => placedAt + 1300, linkMs: 100, probedUplinkKbps: 3000 });
      await swarm.addSource();
      for (let t = 0, joined = 0; t < 35_000; t += 100) {
        while (joined < 6 && 2000 + joined * 500 <= t) {
          await swarm.addViewer(true);
          joined++;
        }
        await swarm.step(100);
      }
      const children = [...swarm.source!.kids].map((id) => swarm.peers.get(id)!.kids.size);
      assert.deepEqual(children, [2, 2], `seed ${seed}: the source's children have ${children.join(" and ")}`);
      assert.equal(swarm.shape().maxDepth, 2);
      assert.equal(swarm.moves, 0);
    }
  });
});

describe("coordinator placement: the map is soft state (SPEC §6.6, D12)", () => {
  const status = (parent: PeerId | null, depth: number, free: number, over: Partial<Extract<ClientMessage, { t: "status" }>> = {}): ClientMessage => ({
    t: "status",
    depth,
    links: parent === null ? [] : [{ stream: 0, stripe: 0, parent, backup: null }],
    children: 0,
    standby: 0,
    free,
    caps: relayCaps({ uplinkKbps: 20_000 }),
    lossPct: 0,
    rttMs: 15,
    ...over,
  });

  /** A source and two relays under it, each with free slots, built by hand. */
  async function small() {
    const rig = new Rig({ moves: false });
    const source = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
    await rig.say(source.conn, { t: "streams", streams: STREAMS });
    const a = await rig.join("relay-a");
    const b = await rig.join("relay-b");
    const made = { rig, source, a: { ...a, role: "leaf" as string }, b: { ...b, role: "leaf" as string } };
    /** What came back to each of them while reporting: `say` hands over the socket's inbox. */
    const heard = new Map<string, ServerMessage[]>([
      [a.conn, []],
      [b.conn, []],
    ]);
    // The source says it is full, so the tree is short of slots.
    const beat = async () => {
      await rig.say(source.conn, status(null, 0, 0, { children: 2 }));
      for (const peer of [made.a, made.b]) heard.get(peer.conn)!.push(...(await rig.say(peer.conn, status(source.peer, 1, peer.role === "relay" ? 4 : 0))));
    };
    // Past probation, with a measured uplink, and the tree short of slots: both are promoted.
    for (let s = 0; s < 25; s += 5) {
      await beat();
      await rig.advance(5000);
    }
    for (const peer of [made.a, made.b]) {
      const role = of([...heard.get(peer.conn)!, ...rig.take(peer.conn)], "role")[0];
      assert.equal(role?.role, "relay");
      peer.role = "relay";
    }
    const settled = async () => {
      await rig.say(source.conn, status(null, 0, 1, { children: 2 }));
      await rig.say(made.a.conn, status(source.peer, 1, 4));
      await rig.say(made.b.conn, status(source.peer, 1, 4));
    };
    await settled();
    return { ...made, beat: settled };
  }

  it("orders candidates shallowest first, and holds a place for each joiner it sends", async () => {
    const { rig, source, a, b } = await small();
    const first = await rig.join("v1");
    assert.deepEqual(first.welcome.assign[0].parents.map((hint) => [hint.peer, hint.depth]), [
      [source.peer, 0],
      [a.peer < b.peer ? a.peer : b.peer, 1],
      [a.peer < b.peer ? b.peer : a.peer, 1],
    ]);
    // The source had one slot and it is now held for v1: the next joiner is not sent there.
    const second = await rig.join("v2");
    assert.ok(!second.welcome.assign[0].parents.some((hint) => hint.peer === source.peer));
    // Each relay has four. Whoever of the next joiners is offered a relay first takes a hold on
    // it; nobody is offered one whose every slot is held or taken.
    const offered = new Map<PeerId, number>();
    for (let i = 3; i <= 12; i++) {
      const joiner = await rig.join(`v${i}`);
      for (const hint of joiner.welcome.assign[0]?.parents.slice(0, 2) ?? []) offered.set(hint.peer, (offered.get(hint.peer) ?? 0) + 1);
    }
    for (const [, count] of offered) assert.ok(count <= 4, `a relay with four slots was held ${count} times`);
  });

  it("stops offering a relay that has said nothing for 3 × statusMs", async () => {
    const { rig, source, a, b } = await small();
    // b goes quiet (its socket stays open); a and the source keep reporting.
    for (let s = 0; s < 20; s += 5) {
      await rig.advance(5000);
      await rig.say(source.conn, status(null, 0, 0, { children: 3 }));
      await rig.say(a.conn, status(source.peer, 1, 4));
    }
    const joiner = await rig.join("late");
    const hints = [...joiner.welcome.assign[0].parents, ...joiner.welcome.assign[0].backups].map((hint) => hint.peer);
    assert.ok(hints.includes(a.peer));
    assert.ok(!hints.includes(b.peer), "the silent relay is not offered, as a parent or a backup");
    // It speaks again, and is offered again.
    await rig.say(b.conn, status(source.peer, 1, 4));
    const next = await rig.join("later");
    assert.ok(next.welcome.assign[0].parents.some((hint) => hint.peer === b.peer));
  });

  it("answers need without the excluded, without the asker's own subtree, and backups not below its parent", async () => {
    const { rig, source, a, b } = await small();
    const kid = await rig.join("kid");
    await rig.say(kid.conn, status(a.peer, 2, 0));
    await rig.say(a.conn, status(source.peer, 1, 3, { children: 1 }));

    const need = async (conn: string, want: "parent" | "backup", exclude: PeerId[] = []) =>
      of(await rig.say(conn, { t: "need", id: 1, stream: 0, stripe: 0, want, exclude }), "assign")[0].assign[0];
    assert.ok(!(await need(kid.conn, "parent", [a.peer])).parents.some((hint) => hint.peer === a.peer), "exclude");
    // a's own child is no parent for a, and a is not its own.
    await rig.advance(1000);
    const forA = await need(a.conn, "parent");
    assert.ok(!forA.parents.some((hint) => hint.peer === kid.peer || hint.peer === a.peer));
    // The kid's parent is a. A backup must not have a in its path (SPEC §6.6): not a, and nothing
    // under a. The source (path: itself) and b (path: b, source) are both fine.
    const backup = await need(kid.conn, "backup");
    assert.deepEqual(backup.parents, []);
    assert.deepEqual(new Set(backup.backups.map((hint) => hint.peer)), new Set([source.peer, b.peer]));
  });

  it("rebuilds the map from status within one statusMs after losing its memory", async () => {
    const swarm = await fill(40, 2, 5, true, 60);
    const before = swarm.rig.core.snapshot();
    const tree = (peers: typeof before.peers) => peers.map((peer) => [peer.peer, peer.role, peer.depth, peer.links[0]?.parent ?? null, peer.children, peer.free].join()).sort();

    const rig = await swarm.rig.evicted();
    // What came back with the sockets: who is who, and nothing of where anyone is.
    const woken = rig.core.snapshot();
    assert.equal(woken.peers.length, before.peers.length);
    assert.equal(woken.startedAt, before.startedAt);
    assert.ok(woken.peers.every((peer) => peer.links.length === 0));
    assert.deepEqual(woken.peers.map((peer) => [peer.peer, peer.role].join()).sort(), before.peers.map((peer) => [peer.peer, peer.role].join()).sort());
    // Until peers have spoken, nobody is offered: a joiner waits rather than being sent to a guess.
    const early = await rig.join("early", "viewer", leafCaps());
    assert.deepEqual(early.welcome.assign, []);

    // Every peer's next status arrives within statusMs.
    const again = new Swarm(rig);
    for (const peer of swarm.peers.values()) again.peers.set(peer.peer, { ...peer, statusAt: rig.now - DEFAULT_PARAMS.statusMs });
    again.source = again.peers.get(swarm.source!.peer)!;
    await rig.say(again.source.conn, { t: "streams", streams: STREAMS });
    await again.second();
    const after = rig.core.snapshot();
    assert.deepEqual(tree(after.peers.filter((peer) => peer.identity !== "early")), tree(before.peers));
    assert.ok(rig.now - swarm.rig.now <= DEFAULT_PARAMS.statusMs);
    // And placement works again: the joiner who was waiting has been told where to go.
    assert.equal(of(rig.take(early.conn), "assign")[0]?.reason, "join");
  });
});
