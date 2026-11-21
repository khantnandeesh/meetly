/**
 * A relay dies with a large subtree under it, and its children have no live backup: cold repair
 * (SPEC §7.5). They ask the coordinator for a parent (`need`), and the slots they could have
 * used are gone with the dead relay's branch. The coordinator must make room by promoting
 * eligible leaves elsewhere in the tree (SPEC §6.6), at once, in its answer; and failing that,
 * offer a parent over its fan-out, since a `repair` is never refused (SPEC §7.5).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Capabilities, ClientMessage, PeerId, ServerMessage, ServerMessageOf } from "@meetly/overlay/protocol";
import { Rig, STREAMS, leafCaps, relayCaps } from "./testkit";

const of = <T extends ServerMessage["t"]>(messages: ServerMessage[], t: T): ServerMessageOf<T>[] => messages.filter((message): message is ServerMessageOf<T> => message.t === t);

type Spec = { name: string; parent: string | null; caps: Capabilities; relay: boolean };
type Member = Spec & { conn: string; peer: PeerId; heard: ServerMessage[] };

/**
 * The tree: the source feeds R1, R2 and R3. Under R1, the branch that will die: `branch` relays
 * with `leavesEach` dead ends each. Under R2, four peers that can relay but have not yet measured
 * their uplink (so are leaves). Under R3, four that never can. Everyone the tree needs as a
 * relay is promoted by the coordinator itself, while everyone says the tree is full.
 */
async function build(branch: number, leavesEach: number, capableUnderR2: boolean) {
  const rig = new Rig({ moves: false });
  const specs: Spec[] = [{ name: "S", parent: null, caps: relayCaps({ uplinkKbps: 50_000 }), relay: true }];
  for (const r of ["R1", "R2", "R3"]) specs.push({ name: r, parent: "S", caps: relayCaps({ uplinkKbps: 20_000 }), relay: true });
  for (let k = 0; k < branch; k++) {
    specs.push({ name: `K${k}`, parent: "R1", caps: relayCaps({ uplinkKbps: 20_000 }), relay: true });
    for (let l = 0; l < leavesEach; l++) specs.push({ name: `K${k}.${l}`, parent: `K${k}`, caps: leafCaps(), relay: false });
  }
  for (let e = 0; e < 4; e++) specs.push({ name: `E${e}`, parent: "R2", caps: capableUnderR2 ? relayCaps({ uplinkKbps: null }) : leafCaps(), relay: false });
  for (let d = 0; d < 4; d++) specs.push({ name: `D${d}`, parent: "R3", caps: leafCaps(), relay: false });

  const members = new Map<string, Member>();
  for (const spec of specs) {
    const joined = await rig.join(spec.name, spec.parent === null ? "source" : "viewer", spec.caps);
    members.set(spec.name, { ...spec, conn: joined.conn, peer: joined.peer, heard: [] });
  }
  const source = members.get("S")!;
  await rig.say(source.conn, { t: "streams", streams: STREAMS });
  const depth = (member: Member): number => (member.parent === null ? 0 : depth(members.get(member.parent)!) + 1);
  const kids = (member: Member) => [...members.values()].filter((other) => other.parent === member.name).length;
  const role = (member: Member) => (member.parent === null ? "source" : of(member.heard, "role").at(-1)?.role ?? "leaf");
  const status = (member: Member, full: boolean): ClientMessage => {
    const parent = member.parent === null ? null : members.get(member.parent)!.peer;
    const fanout = member.parent === null ? 3 : role(member) === "relay" ? 4 : 0;
    return {
      t: "status",
      depth: depth(member),
      links: parent === null ? [] : STREAMS.map((stream) => ({ stream: stream.id, stripe: 0, parent, backup: null })),
      children: kids(member),
      standby: 0,
      free: full ? 0 : Math.max(0, fanout - kids(member)),
      caps: member.caps,
      lossPct: 0,
      rttMs: 20,
    };
  };
  const say = async (member: Member, message: ClientMessage) => member.heard.push(...(await rig.say(member.conn, message)));
  const reportAll = async (full: boolean) => {
    for (const member of members.values()) if (member.parent !== "dead") await say(member, status(member, full));
  };
  // Past probation, everyone saying the tree is full: the coordinator promotes every peer that is eligible.
  for (let s = 0; s < 40; s++) {
    if (s % 2 === 0) await reportAll(true);
    await rig.advance(1000);
    for (const member of members.values()) member.heard.push(...rig.take(member.conn));
  }
  await reportAll(false);
  for (const member of members.values()) assert.equal(role(member) === "relay" || role(member) === "source", member.relay, `${member.name} is ${role(member)}`);
  return { rig, members, say, status, role };
}

describe("coordinator: an orphaned subtree finds slots (SPEC §6.6, §7.5)", () => {
  it("promotes an eligible leaf at once for the dead relay's children, outside the dead branch", async () => {
    const { rig, members, say } = await build(4, 4, true);
    const R1 = members.get("R1")!;
    const orphans = [...members.values()].filter((member) => member.parent === "R1");
    const deadBranch = new Set([R1, ...orphans, ...[...members.values()].filter((member) => orphans.some((orphan) => orphan.name === member.parent))].map((member) => member.peer));
    assert.equal(deadBranch.size, 1 + 4 + 16, "a branch of 21 peers dies with R1");
    // The R2 peers have measured their uplink by now: eligible, but the tree's own rule (free
    // slots under a fifth of the audience) does not call for them, so they are still leaves.
    for (const e of [...members.values()].filter((member) => member.name.startsWith("E"))) {
      e.caps = relayCaps({ uplinkKbps: 20_000 });
      await say(e, { t: "status", depth: 2, links: STREAMS.map((stream) => ({ stream: stream.id, stripe: 0, parent: members.get("R2")!.peer, backup: null })), children: 0, standby: 0, free: 0, caps: e.caps, lossPct: 0, rttMs: 20 });
    }
    // R1's tab is killed. Its children have no live backup: each says it has no parent, and asks.
    const assigned = new Map<string, ServerMessageOf<"assign">["assign"][number]>();
    for (const [index, orphan] of orphans.entries()) {
      orphan.heard.length = 0;
      await say(orphan, { t: "status", depth: 255, links: [], children: 4, standby: 0, free: 0, caps: orphan.caps, lossPct: 0, rttMs: null });
      await say(orphan, { t: "need", id: 10 + index, stream: 0, stripe: 0, want: "parent", exclude: [R1.peer] });
      const answer = of(orphan.heard, "assign").find((message) => message.id === 10 + index);
      assert.ok(answer, `${orphan.name} is answered`);
      assigned.set(orphan.name, answer.assign[0]);
    }
    for (const member of members.values()) member.heard.push(...rig.take(member.conn));
    const promoted = [...members.values()].filter((member) => member.name.startsWith("E") && of(member.heard, "role").some((message) => message.role === "relay"));
    console.log(`      4 orphans of a 21-peer branch: ${promoted.length} promoted (${promoted.map((member) => member.name).join(", ")}); parents ${[...assigned.entries()].map(([name, a]) => `${name}→${[...members.values()].find((m) => m.peer === a.parents[0]?.peer)?.name}`).join(", ")}`);
    assert.equal(promoted.length, 1, "one relay's four slots are enough for four orphans");
    for (const [name, assignment] of assigned) {
      assert.ok(assignment.parents.length > 0, `${name} has somewhere to go`);
      assert.ok(assignment.parents.every((hint) => !deadBranch.has(hint.peer)), `${name} is not sent into the dead branch`);
      assert.ok(assignment.parents[0].free > 0, `${name}'s first parent has a slot`);
      assert.equal(assignment.parents[0].peer, promoted[0].peer);
    }
    // Promoted with a relay grant, before the orphans were told to go there.
    const grant = JSON.parse(Buffer.from(of(promoted[0].heard, "role")[0].grant.split(".")[0], "base64url").toString()) as { scope: string[] };
    assert.deepEqual(grant.scope, ["view", "relay"]);
    assert.equal(rig.core.snapshot().peers.find((peer) => peer.peer === promoted[0].peer)?.role, "relay");
  });

  it("with nobody to promote, offers the least loaded parent over its fan-out: a repair is never refused (SPEC §7.5)", async () => {
    const { rig, members, say } = await build(2, 2, false);
    const R1 = members.get("R1")!;
    const orphans = [...members.values()].filter((member) => member.parent === "R1");
    for (const member of members.values()) member.heard.length = 0;
    for (const [index, orphan] of orphans.entries()) {
      orphan.heard.length = 0;
      await say(orphan, { t: "status", depth: 255, links: [], children: 2, standby: 0, free: 0, caps: orphan.caps, lossPct: 0, rttMs: null });
      await say(orphan, { t: "need", id: 20 + index, stream: 0, stripe: 0, want: "parent", exclude: [R1.peer] });
      const assignment = of(orphan.heard, "assign").find((message) => message.id === 20 + index)!.assign[0];
      assert.ok(assignment.parents.length > 0, `${orphan.name} has somewhere to go`);
      assert.ok(assignment.parents.every((hint) => hint.free === 0 && hint.peer !== R1.peer && !orphans.some((other) => other.peer === hint.peer)));
    }
    for (const member of members.values()) member.heard.push(...rig.take(member.conn));
    assert.ok([...members.values()].every((member) => !of(member.heard, "role").some((message) => message.role === "relay")), "nobody could be promoted");
  });

  it("does not offer a relay cut off from the source", async () => {
    const { rig, members, say, status } = await build(2, 2, false);
    // R1 has lost the source and is repairing; K0 below it still says R1 is its parent, and has room.
    const r1 = members.get("R1")!;
    const k0 = members.get("K0")!;
    await say(r1, { t: "status", depth: 255, links: [], children: 2, standby: 0, free: 2, caps: r1.caps, lossPct: 0, rttMs: null });
    await say(k0, { ...(status(k0, false) as Extract<ClientMessage, { t: "status" }>), free: 2 });
    const joiner = await rig.join("late", "viewer", relayCaps());
    const offered = [...(joiner.welcome.assign[0]?.parents ?? []), ...(joiner.welcome.assign[0]?.backups ?? [])].map((hint) => hint.peer);
    assert.ok(!offered.includes(k0.peer) && !offered.includes(r1.peer), "nothing on the cut-off branch");
  });

  it("relieves a parent over its fan-out once there is room: promotion, then a move (SPEC §7.5)", async () => {
    const { rig, members, say, status } = await build(2, 2, true);
    const R1 = members.get("R1")!;
    const orphans = [...members.values()].filter((member) => member.parent === "R1");
    // Nobody can be promoted yet (the R2 peers have not measured their uplink): over its fan-out it is.
    let host: Member | undefined;
    for (const [index, orphan] of orphans.entries()) {
      await say(orphan, { t: "status", depth: 255, links: [], children: 2, standby: 0, free: 0, caps: orphan.caps, lossPct: 0, rttMs: null });
      await say(orphan, { t: "need", id: 30 + index, stream: 0, stripe: 0, want: "parent", exclude: [R1.peer] });
      const offered = of(orphan.heard, "assign").find((message) => message.id === 30 + index)!.assign[0].parents[0].peer;
      host ??= [...members.values()].find((member) => member.peer === offered);
    }
    assert.ok(host);
    // The orphans repair to it, and it takes them in over its fan-out.
    // R1's socket closes too, as a killed tab's does. A moment later (a peer says `status` at most
    // twice a second) the orphans say where they now are.
    R1.parent = "dead";
    await rig.drop(R1.conn);
    await rig.advance(1_000);
    for (const orphan of orphans) {
      orphan.parent = host.name;
      await say(orphan, status(orphan, false));
    }
    await say(host, status(host, false));
    const children = [...members.values()].filter((member) => member.parent === host!.name);
    const fanout = host.name === "S" ? 3 : 4;
    assert.ok(children.length > fanout, `${host.name} has ${children.length} children`);
    // Then the R2 peers' uplink is measured: room can be made.
    for (const e of [...members.values()].filter((member) => member.name.startsWith("E"))) {
      e.caps = relayCaps({ uplinkKbps: 20_000 });
      await say(e, status(e, false));
    }
    for (const member of members.values()) member.heard.length = 0;
    await rig.advance(2_000);
    for (const member of members.values()) member.heard.push(...rig.take(member.conn));
    const moved = children.filter((child) => of(child.heard, "assign").some((message) => message.reason === "move"));
    const promoted = [...members.values()].filter((member) => of(member.heard, "role").some((message) => message.role === "relay"));
    console.log(`      ${host.name} over its fan-out by ${children.length - fanout}: ${moved.map((m) => m.name).join(", ")} asked to move; ${promoted.map((m) => m.name).join(", ")} promoted`);
    assert.equal(moved.length, children.length - fanout, "the excess is asked to move");
    for (const child of moved) {
      const move = of(child.heard, "assign").find((message) => message.reason === "move")!;
      assert.ok(move.assign[0].parents.length > 0 && move.assign[0].parents.every((hint) => hint.peer !== host!.peer && hint.free > 0));
    }
  });
});
