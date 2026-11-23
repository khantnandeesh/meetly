/**
 * [D65] A relay reported for changed frames (`report parent-bad`) by two different children within
 * a minute is offered to nobody for DISTRUST_MS; one report alone is not enough, and the source
 * is never distrusted (D64).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Rig, Swarm, seeded } from "./testkit";

async function grown() {
  const swarm = new Swarm(new Rig({ random: seeded(5) }), undefined, { probeAfterMs: 2_000 });
  await swarm.addSource();
  for (let i = 0; i < 24; i++) {
    await swarm.addViewer(true);
    if (i % 4 === 3) await swarm.second();
  }
  for (let s = 0; s < 40; s++) await swarm.second();
  const relay = swarm.relays().find((peer) => peer.role !== "source" && [...swarm.peers.values()].filter((p) => p.parent === peer.peer).length >= 2);
  assert.ok(relay, "a relay with two children");
  const children = [...swarm.peers.values()].filter((p) => p.parent === relay.peer);
  return { swarm, relay, children };
}

const bad = (peer: string) => ({ t: "report" as const, event: "parent-bad" as const, stream: 0, stripe: 0, peer });

describe("coordinator: parent-bad (D65)", () => {
  it("two children's reports and the relay is offered to nobody; joiners go elsewhere", async () => {
    const { swarm, relay, children } = await grown();
    await swarm.rig.say(children[0].conn, bad(relay.peer));
    await swarm.rig.say(children[1].conn, bad(relay.peer));
    const joiners = [];
    for (let i = 0; i < 8; i++) {
      joiners.push(await swarm.addViewer(false));
      await swarm.second();
    }
    for (let s = 0; s < 5; s++) await swarm.second();
    for (const joiner of joiners) assert.notEqual(joiner.parent, relay.peer, `${joiner.identity} was sent to the distrusted relay`);
    const offered = joiners.flatMap((joiner) => swarm.rig.inbox.get(joiner.conn) ?? []);
    assert.ok(!JSON.stringify(offered).includes(relay.peer), "not even as a backup");
  });

  it("the same child twice, or the source, is not enough", async () => {
    const { swarm, relay, children } = await grown();
    await swarm.rig.say(children[0].conn, bad(relay.peer));
    await swarm.rig.say(children[0].conn, bad(relay.peer));
    await swarm.rig.say(children[0].conn, bad(swarm.source!.peer));
    await swarm.rig.say(children[1].conn, bad(swarm.source!.peer));
    // Still placeable: a joiner may be sent there.
    let sentThere = false;
    for (let i = 0; i < 20 && !sentThere; i++) {
      const joiner = await swarm.addViewer(false);
      await swarm.second();
      sentThere = joiner.parent === relay.peer || JSON.stringify(swarm.rig.inbox.get(joiner.conn) ?? []).includes(relay.peer);
    }
    assert.ok(sentThere, "one child's word does not push a relay out");
  });
});
