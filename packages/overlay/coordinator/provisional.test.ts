/**
 * D38 (integrator, 2026-11-21): provisional relays. At the start of a session nobody has been
 * here the 20 s of probation (D18), so nobody can relay and joiners wait. A viewer that passes
 * every other check of SPEC §8.1, with a short probe sized for two children, is made a relay
 * with a fan-out of 2 ("fanout:2" in its grant's scope); placement sends joiners to it only when
 * no full relay has a free slot; at the end of probation it becomes a full relay; one that
 * misbehaves before then is made a leaf again after 3 s, its children asked to move first.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClientMessage, MetricsSample, PeerId, ServerMessage, ServerMessageOf } from "@meetly/overlay/protocol";
import { PROVISIONAL_FANOUT } from "./treeMap";
import { Rig, STREAMS, Swarm, leafCaps, relayCaps, seeded } from "./testkit";

const of = <T extends ServerMessage["t"]>(messages: ServerMessage[], t: T): ServerMessageOf<T>[] => messages.filter((message): message is ServerMessageOf<T> => message.t === t);
const scope = (grant: string) => (JSON.parse(Buffer.from(grant.split(".")[0], "base64url").toString()) as { scope: string[] }).scope;

const status = (parent: PeerId | null, depth: number, free: number, over: Partial<Extract<ClientMessage, { t: "status" }>> = {}): ClientMessage => ({
  t: "status",
  depth,
  links: parent === null ? [] : STREAMS.map((stream) => ({ stream: stream.id, stripe: 0, parent, backup: null })),
  children: 0,
  standby: 0,
  free,
  // Room for two children by the short probe's rule (SPEC §8.1 [D38]: 2 × 1.15 × B / 0.7).
  caps: relayCaps({ uplinkKbps: 5_000 }),
  lossPct: 0,
  rttMs: 15,
  ...over,
});

type Joined = { conn: string; peer: PeerId; heard: ServerMessage[]; welcome?: ServerMessageOf<"welcome"> };

async function session() {
  const rig = new Rig({ moves: false });
  const host = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
  await rig.say(host.conn, { t: "streams", streams: STREAMS });
  const source: Joined = { conn: host.conn, peer: host.peer, heard: [] };
  const everyone: Joined[] = [source];
  const join = async (identity: string, capable: boolean): Promise<Joined> => {
    const joined = await rig.join(identity, "viewer", capable ? relayCaps() : leafCaps());
    const who: Joined = { conn: joined.conn, peer: joined.peer, heard: [...rig.take(joined.conn)], welcome: joined.welcome };
    everyone.push(who);
    return who;
  };
  const say = async (who: Joined, message: ClientMessage) => who.heard.push(...(await rig.say(who.conn, message)));
  const advance = async (ms: number, everySecond?: (second: number) => Promise<void>) => {
    for (let s = 0; s < ms / 1000; s++) {
      await rig.advance(1000);
      for (const who of everyone) who.heard.push(...rig.take(who.conn));
      await everySecond?.(s);
    }
  };
  return { rig, source, join, say, advance };
}

describe("coordinator: provisional relays (D38)", () => {
  /** The source is full with `viewers` able to relay under it, each 2 s in with the short probe done. Then `joiners` arrive. */
  async function startOfSession(viewers: number) {
    const s = await session();
    const under: Joined[] = [];
    for (let i = 0; i < viewers; i++) under.push(await s.join(`v${i}`, true));
    const report = async (sourceFree = 0) => {
      await s.say(s.source, status(null, 0, sourceFree, { children: viewers }));
      for (const who of under) await s.say(who, status(s.source.peer, 1, 0));
    };
    await s.advance(2_000);
    await report();
    return { ...s, under, report };
  }
  const promotedOf = (who: Joined[]) => who.filter((one) => of(one.heard, "role").some((message) => message.role === "relay"));

  it("makes a viewer in probation a relay of fan-out 2 for a joiner with nowhere to go, and a full one when probation ends", async () => {
    const s = await startOfSession(3);
    // Nobody is promoted while nobody needs it (the fifth-of-the-audience rule makes full relays only).
    await s.advance(1_000);
    assert.deepEqual(promotedOf(s.under), []);
    // A joiner has nowhere to go: one of them is made a provisional relay, in the same answer.
    const joiner = await s.join("first", false);
    for (const who of s.under) who.heard.push(...s.rig.take(who.conn));
    const promoted = promotedOf(s.under);
    assert.equal(promoted.length, 1, "promoted at 2 s, long before the 20 s of probation");
    const role = of(promoted[0].heard, "role")[0];
    assert.deepEqual(scope(role.grant), ["view", "relay"]);
    assert.equal(role.fanout, PROVISIONAL_FANOUT, "the role says the fan-out (SPEC §8.1 [D38])");
    assert.equal(joiner.welcome!.assign[0].parents[0].peer, promoted[0].peer);

    // Joiners go to it, two at most (holds count until they report).
    const offered = new Map<PeerId, number>([[promoted[0].peer, 1]]);
    for (let i = 0; i < 4; i++) {
      const late = await s.join(`late-${i}`, false);
      for (const hint of late.welcome?.assign[0]?.parents.slice(0, 2) ?? []) offered.set(hint.peer, (offered.get(hint.peer) ?? 0) + 1);
    }
    for (const [peer, count] of offered) if (s.under.some((who) => who.peer === peer)) assert.ok(count <= PROVISIONAL_FANOUT, `a provisional relay was held ${count} times`);

    // Probation over: a full relay, with a grant without the limit.
    await s.advance(20_000, async (second) => {
      if (second % 4 === 3) await s.report();
    });
    const last = of(promoted[0].heard, "role").at(-1)!;
    assert.equal(last.role, "relay");
    assert.deepEqual(scope(last.grant), ["view", "relay"]);
    // [D50] A full relay is told its fan-out too: its verdict's, which its node holds to.
    assert.ok(last.fanout !== undefined && last.fanout >= 1, "a full relay's role says its fan-out");
    assert.equal(s.rig.core.snapshot().peers.find((peer) => peer.peer === promoted[0].peer)?.role, "relay");
  });

  it("sends joiners to a provisional relay only when no full relay has a free slot", async () => {
    const s = await startOfSession(1);
    const p = s.under[0];
    await s.join("j0", false);
    p.heard.push(...s.rig.take(p.conn));
    assert.equal(promotedOf([p]).length, 1, "p is provisional");
    await s.advance(1_000);
    await s.say(p, status(s.source.peer, 1, PROVISIONAL_FANOUT));
    // The source says it has room again: the next joiner goes there, not to p.
    await s.report(2);
    const joiner = await s.join("j1", false);
    const parents = joiner.welcome!.assign[0].parents.map((hint) => hint.peer);
    assert.equal(parents[0], s.source.peer);
    assert.ok(!parents.includes(p.peer));
  });

  it("makes a misbehaving provisional relay a leaf after 3 s, its children asked to move first", async () => {
    const s = await startOfSession(2);
    const kids = [await s.join("k0", false), await s.join("k1", false)];
    for (const who of s.under) who.heard.push(...s.rig.take(who.conn));
    const [p] = promotedOf(s.under);
    assert.ok(p, "one of them was made provisional for the joiners");
    const q = s.under.find((who) => who !== p)!;
    const roles = (who: Joined) => of(who.heard, "role").map((message) => message.role);
    // Its two children report 9% loss from it; q, a full relay by then or not, says it has room for them.
    const lossy = async () => {
      await s.say(s.source, status(null, 0, 0, { children: 2 }));
      await s.say(p, status(s.source.peer, 1, 0, { children: 2 }));
      await s.say(q, status(s.source.peer, 1, roles(q).includes("relay") ? 2 : 0));
      for (const kid of kids) {
        await s.say(kid, status(p.peer, 2, 0, { caps: leafCaps() }));
        const sample: MetricsSample = { peer: kid.peer, seq: 0, at: 0, intervalMs: 2000, role: "leaf", depth: 2, playoutDelayMs: 80, events: [], up: { parent: p.peer, rttMs: 20, lossPct: 9, queueDelayMs: 0, rxKbps: 1200, nacksSent: 0, retransmitsReceived: 0, duplicates: 0, turn: false } };
        await s.say(kid, { t: "metrics", sample });
      }
    };
    const start = s.rig.now;
    let movedAt: number | null = null;
    let leafAt: number | null = null;
    await s.advance(12_000, async (second) => {
      if (second % 2 === 0) await lossy();
      if (movedAt === null && kids.some((kid) => of(kid.heard, "assign").some((message) => message.reason === "move"))) movedAt = s.rig.now - start;
      if (leafAt === null && roles(p).includes("leaf")) leafAt = s.rig.now - start;
    });
    console.log(`      lossy children from 0 s: asked to move at ${movedAt} ms, the relay told it is a leaf at ${leafAt} ms`);
    assert.ok(leafAt !== null && leafAt >= 3_000 && leafAt <= 10_000, `a leaf at ${leafAt} ms`);
    assert.ok(movedAt !== null && movedAt <= leafAt!, "the children were asked to move before the relay was told");
  });

  it("at session start, joiners wait far less with provisional relays (simulated: 200 peers joining at 10 a second)", { timeout: 120_000 }, async () => {
    const waits = async (provisional: boolean, share: number) => {
      const random = seeded(5);
      const swarm = new Swarm(new Rig({ random: seeded(5), provisionalRelays: provisional }), undefined, { probeAfterMs: 2_000 });
      await swarm.addSource();
      for (let joined = 0; joined < 199; ) {
        for (let k = 0; k < 10 && joined < 199; k++, joined++) await swarm.addViewer(random() < share);
        await swarm.second();
      }
      for (let s = 0; s < 60; s++) await swarm.second();
      const sorted = [...swarm.joinWaits].sort((a, b) => a - b);
      return { p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], placed: sorted.length, depth: swarm.shape().maxDepth };
    };
    for (const share of [0.25, 0.95]) {
      const without = await waits(false, share);
      const withProvisional = await waits(true, share);
      console.log(`      ${share * 100}% able to relay, join to first parent: without D38 p50 ${without.p50 / 1000} s, p95 ${without.p95 / 1000} s; with D38 p50 ${withProvisional.p50 / 1000} s, p95 ${withProvisional.p95 / 1000} s (depth ${without.depth} / ${withProvisional.depth})`);
      assert.equal(withProvisional.placed, 199);
      assert.ok(withProvisional.p95 <= 0.7 * without.p95, "p95 down by at least 30%");
      assert.ok(withProvisional.depth <= 5);
    }
  });

  it("gate-small's session start, 30 peers joining at 10 a second with the 20 s probation on: join to parent p95 within 4 s (simulated, in whole seconds)", { timeout: 120_000 }, async () => {
    const run = async (provisional: boolean) => {
      const waits: number[] = [];
      for (let seed = 1; seed <= 10; seed++) {
        const random = seeded(seed);
        const swarm = new Swarm(new Rig({ random: seeded(seed), provisionalRelays: provisional }), undefined, { probeAfterMs: 2_000 });
        await swarm.addSource();
        for (let joined = 0; joined < 29; ) {
          for (let k = 0; k < 10 && joined < 29; k++, joined++) await swarm.addViewer(random() < 0.95);
          await swarm.second();
        }
        for (let s = 0; s < 40; s++) await swarm.second();
        assert.equal(swarm.shape().waiting, 0);
        waits.push(...swarm.joinWaits);
      }
      waits.sort((a, b) => a - b);
      return { p50: waits[Math.floor(waits.length / 2)] / 1000, p95: waits[Math.floor(waits.length * 0.95)] / 1000 };
    };
    const without = await run(false);
    const withProvisional = await run(true);
    // The floor is a generation of relays: a link, the 2 s probe, a promotion, a link. The
    // simulator counts in whole seconds, so 3 here is anything from 2 to 3.
    console.log(`      30 peers, 10 joining a second: without D38 p50 ${without.p50} s, p95 ${without.p95} s; with D38 p50 ${withProvisional.p50} s, p95 ${withProvisional.p95} s`);
    assert.ok(withProvisional.p95 <= 4, `p95 ${withProvisional.p95} s`);
    assert.ok(without.p95 >= 15, "without D38 they wait out probation");
  });

  it("the gate's session start with the engine's timers: the probe put off 10 s for want of the NAT type is what the joiners wait for (simulated, 100 ms steps)", { timeout: 120_000 }, async () => {
    // The engine at c0df0fa: the short probe 0.2 s after the first link; a peer whose NAT type
    // (`probeNat`, up to 3 s) is not known by then finds "nat" against it and tries again in
    // 10 s. The gate's two runs: every joiner of the first 40 s promoted within 5 s of its link
    // had linked 2.7 s or more after its welcome, and none that linked sooner was. With the probe
    // waiting for the NAT type instead, the first relays come a probe after the NAT type.
    const NAT_MS = 3000;
    const LINK_MS = 500;
    const run = async (waitsForNat: boolean, perSecond: number) => {
      const probeAt = ({ joinedAt, placedAt }: { joinedAt: number; placedAt: number }) => {
        let start = placedAt + LINK_MS + 200;
        if (waitsForNat) start = Math.max(start, joinedAt + NAT_MS);
        else while (start < joinedAt + NAT_MS) start += 10_000;
        return start + 1000;
      };
      const waits: number[] = [];
      for (let seed = 1; seed <= 3; seed++) {
        const random = seeded(seed);
        const swarm = new Swarm(new Rig({ random: seeded(seed) }), undefined, { probeAt, linkMs: LINK_MS });
        await swarm.addSource();
        // The gate's mix: "bad" (15%, lossy) and "slow" (5%, too little uplink) never relay.
        for (let t = 0, joined = 0; joined < 199; t += 100) {
          while (joined < 199 && 2000 + (joined * 1000) / perSecond <= t) {
            await swarm.addViewer(random() < 0.8);
            joined++;
          }
          await swarm.step(100);
        }
        for (let s = 0; s < 40; s++) await swarm.second();
        assert.equal(swarm.shape().waiting, 0);
        assert.ok(swarm.shape().maxDepth <= 5);
        waits.push(...swarm.joinWaits);
      }
      waits.sort((a, b) => a - b);
      return { p50: waits[Math.floor(waits.length / 2)] / 1000, p95: waits[Math.floor(waits.length * 0.95)] / 1000 };
    };
    for (const perSecond of [4, 200 / 30]) {
      const skipped = await run(false, perSecond);
      const waited = await run(true, perSecond);
      console.log(`      ${perSecond.toFixed(1)} joining a second, welcome to linked: probe put off p50 ${skipped.p50} s, p95 ${skipped.p95} s; probe waiting for the NAT type p50 ${waited.p50} s, p95 ${waited.p95} s`);
      assert.ok(skipped.p95 >= 4, `the gate's ${skipped.p95} s`);
      assert.ok(waited.p95 <= 3.6, `p95 ${waited.p95} s`);
    }
  });
});
