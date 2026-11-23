/**
 * [D63] A session whose host disappears without calling `/end` (a crash, a lost network) ends by
 * itself with `source-left` once the source has been gone `SOURCE_GONE_END_MS`; a host that comes
 * back before then keeps it going. Found in QA of the serverless webinar: viewers were told "The
 * host's connection dropped" and the session stayed open forever.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClientMessage, ServerMessageOf } from "@meetly/overlay/protocol";
import { SOURCE_GONE_END_MS } from "./core";
import { Rig, STREAMS, leafCaps, relayCaps } from "./testkit";

const sourceStatus: ClientMessage = { t: "status", depth: 0, links: [], children: 1, standby: 0, free: 2, caps: relayCaps({ uplinkKbps: 50_000 }), lossPct: 0, rttMs: 10 };

async function session() {
  const rig = new Rig({});
  const host = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
  await rig.say(host.conn, { t: "streams", streams: STREAMS });
  await rig.say(host.conn, sourceStatus);
  const viewer = await rig.join("v", "viewer", leafCaps());
  await rig.advance(2_000);
  return { rig, host, viewer };
}

const ends = (rig: Rig, conn: string) => rig.take(conn).filter((message): message is ServerMessageOf<"end"> => message.t === "end");

describe("coordinator: a host gone without /end (D63)", () => {
  it("ends the session with source-left once the source has been gone SOURCE_GONE_END_MS", async () => {
    const { rig, host, viewer } = await session();
    await rig.drop(host.conn);
    rig.take(viewer.conn);
    await rig.advance(SOURCE_GONE_END_MS - 2_000);
    assert.equal(ends(rig, viewer.conn).length, 0, "not yet");
    assert.equal(rig.closes.get(viewer.conn), undefined);
    await rig.advance(3_000);
    assert.deepEqual(ends(rig, viewer.conn).map((message) => message.reason), ["source-left"]);
    assert.deepEqual(rig.closes.get(viewer.conn), { code: 4004, reason: "source-left" });
    assert.equal(rig.stored.get("ended"), "source-left");
    // And nobody gets in afterwards.
    const late = await rig.open("late");
    assert.deepEqual(rig.closes.get(late), { code: 4004, reason: "source-left" });
  });

  it("does not end it if the host comes back in time, and counts afresh from its next loss", async () => {
    const { rig, host, viewer } = await session();
    await rig.drop(host.conn);
    await rig.advance(SOURCE_GONE_END_MS / 2);
    const conn = await rig.open("host", "source");
    await rig.say(conn, { t: "hello", v: 1, caps: relayCaps({ uplinkKbps: 50_000 }), resume: { peer: host.peer, grant: host.welcome.grant } });
    await rig.say(conn, sourceStatus);
    await rig.advance(2_000);
    assert.equal(rig.stored.get("sourceGoneAt"), undefined, "cleared when the source is back");
    rig.take(viewer.conn);
    await rig.advance(SOURCE_GONE_END_MS);
    assert.equal(ends(rig, viewer.conn).length, 0, "the host is here: the session goes on");
    assert.equal(rig.stored.get("ended"), undefined);
    await rig.drop(conn);
    await rig.advance(SOURCE_GONE_END_MS + 1_000);
    assert.deepEqual(ends(rig, viewer.conn).map((message) => message.reason), ["source-left"]);
  });

  it("keeps counting across a coordinator restart, and ends an empty room on time", async () => {
    const { rig, host, viewer } = await session();
    await rig.drop(host.conn);
    await rig.drop(viewer.conn);
    await rig.advance(5_000);
    assert.ok(rig.stored.get("sourceGoneAt"), "kept with the session");
    const next = new Rig(rig.options, { now: rig.now + 1_000, stored: rig.stored });
    next.apply(await next.core.restore(Object.fromEntries(rig.stored), [], next.now));
    await next.advance(SOURCE_GONE_END_MS);
    assert.equal(next.stored.get("ended"), "source-left", "ended with nobody connected, from when the host went");
  });

  it("does not end a session whose source has not started yet", async () => {
    const rig = new Rig({});
    const early = await rig.join("early", "viewer", leafCaps());
    await rig.advance(SOURCE_GONE_END_MS * 2);
    assert.equal(ends(rig, early.conn).length, 0);
    assert.equal(rig.stored.get("ended"), undefined);
  });
});
