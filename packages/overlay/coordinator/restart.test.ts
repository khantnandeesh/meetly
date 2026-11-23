/**
 * Joiners admitted just after a coordinator restart (found by the harness: two 8-peer runs, with
 * stand-in peers on this branch at 315d92a and 8112372, and on the whole engine). The Node
 * coordinator was killed and started again with the same storage: the session's key, nonces and
 * end came back, but the streams are soft state and only the source says what they are. A viewer
 * whose `hello` came before the source had resumed was welcomed with no streams; its node, which
 * takes its streams from `welcome`, had nothing to subscribe to, and nothing it was sent later
 * changed that. It was offered parents, again and again, and never placed.
 *
 * Fixed by keeping the streams with the session: a fourth durable thing, beside the three of
 * SPEC §6.6 (a few hundred bytes, written when the source changes them). A viewer that arrives in
 * a session whose source has never started is still welcomed without streams, and is sent
 * `streams` when the source says what they are: topology's node must take them from there.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClientMessage, ServerMessageOf } from "@meetly/overlay/protocol";
import { Rig, STREAMS, Swarm, leafCaps, relayCaps, seeded } from "./testkit";

const status = (parent: string | null, depth: number, free: number, children = 0): ClientMessage => ({
  t: "status",
  depth,
  links: parent === null ? [] : STREAMS.map((stream) => ({ stream: stream.id, stripe: 0, parent, backup: null })),
  children,
  standby: 0,
  free,
  caps: leafCaps(),
  lossPct: 0,
  rttMs: 10,
});

describe("coordinator: joiners just after a restart", () => {
  it("welcomes a joiner with the streams, before the source has resumed, and places it once the feeders report", async () => {
    const rig = new Rig({});
    const host = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
    await rig.say(host.conn, { t: "streams", streams: STREAMS });
    await rig.say(host.conn, status(null, 0, 2, 1));
    const a = await rig.join("a", "viewer", leafCaps());
    await rig.say(a.conn, status(host.peer, 1, 0));
    await rig.advance(3_000);

    // Killed, and started again with the same storage: no socket survives.
    const next = new Rig(rig.options, { now: rig.now + 1_000, stored: rig.stored });
    next.apply(await next.core.restore(Object.fromEntries(rig.stored), [], next.now));
    const late = await next.join("late", "viewer", leafCaps());
    assert.deepEqual(late.welcome.streams, STREAMS, "the streams came back with the session");
    assert.deepEqual(late.welcome.assign, [], "nobody has reported yet: nowhere to send it");

    // The source resumes and reports: the joiner is sent there, without asking.
    const conn = await next.open("host", "source");
    await next.say(conn, { t: "hello", v: 1, caps: relayCaps({ uplinkKbps: 50_000 }), resume: { peer: host.peer, grant: host.welcome.grant } });
    await next.say(conn, { t: "streams", streams: STREAMS });
    await next.say(conn, status(null, 0, 2, 1));
    await next.advance(3_000);
    const offers = next.take(late.conn).filter((message): message is ServerMessageOf<"assign"> => message.t === "assign");
    assert.equal(offers[0]?.reason, "join");
    assert.equal(offers[0].assign[0].parents[0].peer, host.peer);
  });

  it("tells a viewer that came before the source what the streams are, when the source says, and keeps them", async () => {
    const rig = new Rig({});
    const early = await rig.join("early", "viewer", leafCaps());
    assert.deepEqual(early.welcome.streams, []);
    const host = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
    await rig.say(host.conn, { t: "streams", streams: STREAMS });
    assert.deepEqual(rig.take(early.conn).find((message): message is ServerMessageOf<"streams"> => message.t === "streams")?.streams, STREAMS);
    assert.deepEqual(JSON.parse(rig.stored.get("streams")!), STREAMS, "kept with the session");
  });

  for (const peers of [8, 200]) {
    it(`${peers} peers: a restart with joiners arriving while the others resume; every joiner is placed`, { timeout: 60_000 }, async () => {
      const random = seeded(peers);
      const swarm = new Swarm(new Rig({ random: seeded(3) }), undefined, { probeAfterMs: 2_000 });
      await swarm.addSource();
      for (let joined = 0; joined < peers - 1; ) {
        for (let k = 0; k < 10 && joined < peers - 1; k++, joined++) await swarm.addViewer(random() < 0.5);
        await swarm.second();
      }
      for (let s = 0; s < 40; s++) await swarm.second();
      assert.equal(swarm.shape().waiting, 0);
      const joiners: Awaited<ReturnType<Swarm["addViewer"]>>[] = [];
      // Everyone comes back over 3 s, in a random order; two join in each of those seconds.
      await swarm.restart(3, random, async () => {
        joiners.push(await swarm.addViewer(random() < 0.5), await swarm.addViewer(random() < 0.5));
      });
      for (let s = 0; s < 10; s++) await swarm.second();
      const placed = joiners.filter((joiner) => joiner.parent !== null);
      const waits = joiners.map((joiner) => (joiner.placedAt ?? Infinity) - joiner.joinedAt).sort((a, b) => a - b);
      console.log(`      ${peers} peers: ${placed.length} of ${joiners.length} joiners placed, ${joiners.filter((joiner) => joiner.stuck).length} welcomed without streams; join to parent ${waits[0] / 1000}–${waits.at(-1)! / 1000} s; depth ${swarm.shape().maxDepth}`);
      assert.equal(joiners.filter((joiner) => joiner.stuck).length, 0, "nobody welcomed without streams");
      assert.equal(placed.length, joiners.length, "every joiner placed");
      assert.equal(swarm.shape().waiting, 0, "and everyone else back in place");
    });
  }
});
