/**
 * K5 (PLAN §5): who relays (promotion and demotion, SPEC §6.6, §8.1), the coordinator's unasked
 * advice (`assign` "rebalance", §6.6), the audience-wide bitrate hint (§11.4), and `/stats` as
 * Meetly's webinar gate reads it. The core is driven directly, with the time in the test's hands.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyHistogram } from "@meetly/overlay/protocol";
import type { ClientMessage, MetricsSample, PeerId, ServerMessage, ServerMessageOf } from "@meetly/overlay/protocol";
import { Rig, STREAMS, leafCaps, relayCaps } from "./testkit";
import type { RoomStats } from "./types";

const of = <T extends ServerMessage["t"]>(messages: ServerMessage[], t: T): ServerMessageOf<T>[] => messages.filter((message): message is ServerMessageOf<T> => message.t === t);

const status = (parent: PeerId | null, depth: number, free: number, over: Partial<ClientMessageOf<"status">> = {}): ClientMessage => ({
  t: "status",
  depth,
  links: parent === null ? [] : STREAMS.map((stream) => ({ stream: stream.id, stripe: 0, parent, backup: null })),
  children: 0,
  standby: 0,
  free,
  caps: relayCaps({ uplinkKbps: 20_000 }),
  lossPct: 0,
  rttMs: 15,
  ...over,
});
type ClientMessageOf<T extends ClientMessage["t"]> = Extract<ClientMessage, { t: T }>;

const sample = (peer: PeerId, over: Partial<MetricsSample> = {}): MetricsSample => ({ peer, seq: 0, at: 0, intervalMs: 2000, role: "leaf", depth: 2, playoutDelayMs: 80, events: [], ...over });
const up = (parent: PeerId, lossPct: number): NonNullable<MetricsSample["up"]> => ({ parent, rttMs: 20, lossPct, queueDelayMs: 0, rxKbps: 1200, nacksSent: 0, retransmitsReceived: 0, duplicates: 0, turn: false });
const video = (maxTemporal: number): NonNullable<MetricsSample["video"]> => ({ rendered: 60, dropped: 0, lost: 0, glassToGlass: emptyHistogram(), frameGap: emptyHistogram(), maxTemporal });

type Joined = { conn: string; peer: PeerId; heard: ServerMessage[] };

/** A session with a source; peers join and report through `say`, and everything sent to them is kept in `heard`. */
async function session() {
  // SPEC §8.1 as written: D38's provisional relays have tests of their own (provisional.test.ts).
  const rig = new Rig({ moves: false, provisionalRelays: false });
  const host = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
  await rig.say(host.conn, { t: "streams", streams: STREAMS });
  const source: Joined = { conn: host.conn, peer: host.peer, heard: [] };
  const say = async (who: Joined, message: ClientMessage) => {
    who.heard.push(...(await rig.say(who.conn, message)));
  };
  const join = async (identity: string, capable: boolean): Promise<Joined> => {
    const joined = await rig.join(identity, "viewer", capable ? relayCaps() : leafCaps());
    return { conn: joined.conn, peer: joined.peer, heard: [] };
  };
  /** Lets time pass a second at a time, keeping what arrives. */
  const advance = async (ms: number, everySecond?: (second: number) => Promise<void>) => {
    for (let s = 0; s < ms / 1000; s++) {
      await rig.advance(1000);
      for (const who of everyone) who.heard.push(...rig.take(who.conn));
      await everySecond?.(s);
    }
  };
  const everyone: Joined[] = [source];
  return { rig, source, say, join, advance, everyone };
}

const roles = (who: Joined) => of(who.heard, "role").map((message) => message.role);

describe("coordinator: promotion (SPEC §6.6, §8.1)", () => {
  /** One peer able to relay and `deadEnds` that never can, all under the source, which says it has `free` slots. */
  async function promotionCase(deadEnds: number, free: number) {
    const s = await session();
    const candidate = await s.join("candidate", true);
    const others: Joined[] = [];
    for (let i = 0; i < deadEnds; i++) others.push(await s.join(`leaf-${i}`, false));
    s.everyone.push(candidate, ...others);
    const report = async () => {
      await s.say(s.source, status(null, 0, free, { children: deadEnds + 1 }));
      await s.say(candidate, status(s.source.peer, 1, 0));
      for (const other of others) await s.say(other, status(s.source.peer, 1, 0, { caps: leafCaps() }));
    };
    await report();
    await s.advance(30_000, async (second) => {
      if (second % 5 === 4) await report();
    });
    return { ...s, candidate };
  }

  it("does not promote while the tree's free slots are a fifth of the audience or more", async () => {
    // 1 free slot, an audience of 5: 1 × 5 ≥ 5.
    const { candidate } = await promotionCase(4, 1);
    assert.deepEqual(roles(candidate), []);
  });

  it("promotes an eligible leaf once free slots are under a fifth of the audience, with a relay grant", async () => {
    // 1 free slot, an audience of 6: 1 × 5 < 6.
    const { candidate, rig } = await promotionCase(5, 1);
    const role = of(candidate.heard, "role");
    assert.deepEqual(
      role.map((message) => message.role),
      ["relay"],
    );
    const grant = JSON.parse(Buffer.from(role[0].grant.split(".")[0], "base64url").toString()) as { role: string; scope: string[] };
    assert.deepEqual([grant.role, grant.scope], ["relay", ["view", "relay"]]);
    assert.equal(rig.core.snapshot().peers.find((peer) => peer.peer === candidate.peer)?.role, "relay");
  });

  it("does not promote before probation (D18), nor a peer that can never relay", async () => {
    const s = await session();
    const candidate = await s.join("candidate", true);
    const phone = await s.join("phone", false);
    s.everyone.push(candidate, phone);
    const promotedAt: number[] = [];
    const started = s.rig.now;
    const report = async () => {
      await s.say(s.source, status(null, 0, 0, { children: 2 }));
      await s.say(candidate, status(s.source.peer, 1, 0));
      await s.say(phone, status(s.source.peer, 1, 0, { caps: leafCaps({ uplinkKbps: 50_000 }) }));
    };
    await report();
    await s.advance(30_000, async (second) => {
      if (second % 2 === 1) await report();
      if (promotedAt.length === 0 && roles(candidate).includes("relay")) promotedAt.push(s.rig.now - started);
    });
    assert.ok(promotedAt[0] >= 20_000 && promotedAt[0] <= 22_000, `promoted at ${promotedAt[0]} ms`);
    assert.deepEqual(roles(phone), []);
  });
});

describe("coordinator: demotion (SPEC §8.1)", () => {
  /** A relay with `children` children (three); `lossy` of them report `lossPct` from it in their metrics. */
  async function demotionCase(lossy: number, lossPct: number, seconds: number, children = 3) {
    const s = await session();
    const relay = await s.join("relay", true);
    s.everyone.push(relay);
    // Through probation and promoted, the tree being short of slots.
    const early = async () => {
      await s.say(s.source, status(null, 0, 0, { children: 1 }));
      await s.say(relay, status(s.source.peer, 1, 0));
    };
    await early();
    await s.advance(25_000, async (second) => {
      if (second % 5 === 4) await early();
    });
    assert.deepEqual(roles(relay), ["relay"]);
    const kids: Joined[] = [];
    for (let i = 0; i < children; i++) kids.push(await s.join(`kid-${i}`, false));
    s.everyone.push(...kids);
    const report = async () => {
      await s.say(s.source, status(null, 0, 0, { children: 1 }));
      await s.say(relay, status(s.source.peer, 1, Math.max(0, 4 - children), { children }));
      for (const kid of kids) await s.say(kid, status(relay.peer, 2, 0, { caps: leafCaps() }));
    };
    const metrics = async () => {
      for (const [index, kid] of kids.entries()) await s.say(kid, { t: "metrics", sample: sample(kid.peer, { up: up(relay.peer, index < lossy ? lossPct : 0.5) }) });
    };
    await report();
    await metrics();
    const start = s.rig.now;
    let demotedAfter: number | null = null;
    await s.advance(seconds * 1000, async (second) => {
      if (second % 2 === 1) await metrics();
      if (second % 5 === 4) await report();
      if (demotedAfter === null && roles(relay).includes("leaf")) demotedAfter = s.rig.now - start;
    });
    return { relay, demotedAfter: demotedAfter as number | null, rig: s.rig };
  }

  it("demotes a relay whose children report over 5% loss from it for 10 s, not sooner", async () => {
    const { relay, demotedAfter, rig } = await demotionCase(3, 6, 25);
    // Found failing after 10 s; told after its children have had DEMOTE_GRACE_MS (5 s) to move.
    assert.ok(demotedAfter !== null && demotedAfter >= 15_000 && demotedAfter <= 17_000, `demoted after ${demotedAfter} ms`);
    const grant = JSON.parse(Buffer.from(of(relay.heard, "role").at(-1)!.grant.split(".")[0], "base64url").toString()) as { scope: string[] };
    assert.deepEqual(grant.scope, ["view"]);
    assert.equal(rig.core.snapshot().peers.find((peer) => peer.peer === relay.peer)?.role, "leaf");
  });

  it("does not demote for loss under 5%, nor for one child of three with a bad line of its own", async () => {
    assert.equal((await demotionCase(3, 4.5, 20)).demotedAfter, null);
    assert.equal((await demotionCase(1, 30, 20)).demotedAfter, null);
  });

  it("takes more than half of the children, and two at least: not one of two, nor two of four; two of three, yes", async () => {
    // One of two is a provisional relay's lot whenever one child is on a bad network (the gate's
    // "bad", 15%): demoted for it, the relay's children were moved, and the tree churned.
    assert.equal((await demotionCase(1, 30, 20, 2)).demotedAfter, null);
    assert.equal((await demotionCase(2, 30, 20, 4)).demotedAfter, null);
    assert.ok((await demotionCase(2, 30, 20, 3)).demotedAfter !== null);
    assert.ok((await demotionCase(2, 30, 20, 2)).demotedAfter !== null);
  });

  it("demotes a relay that stops being eligible itself (here: its tab hidden) for 10 s", async () => {
    const s = await session();
    const relay = await s.join("relay", true);
    s.everyone.push(relay);
    const report = async (visible: boolean) => {
      await s.say(s.source, status(null, 0, 0, { children: 1 }));
      await s.say(relay, status(s.source.peer, 1, 0, { caps: relayCaps({ uplinkKbps: 20_000, visible }) }));
    };
    await report(true);
    await s.advance(25_000, async (second) => {
      if (second % 5 === 4) await report(true);
    });
    assert.deepEqual(roles(relay), ["relay"]);
    await report(false);
    await s.advance(9_000, async (second) => {
      if (second % 3 === 2) await report(false);
    });
    assert.deepEqual(roles(relay), ["relay"], "not yet");
    await s.advance(8_000, async () => report(false));
    assert.deepEqual(roles(relay), ["relay", "leaf"]);
  });
});

describe("coordinator: unasked advice (SPEC §6.6)", () => {
  it("sends assign rebalance to a peer more than two levels deeper than the tree needs, at most once a minute", async () => {
    const s = await session();
    const deep = await s.join("deep", false);
    const mid = await s.join("mid", true);
    s.everyone.push(deep, mid);
    // Two viewers need one level; deep says it is at 5 (a chain the map cannot see the whole of).
    const report = async () => {
      await s.say(s.source, status(null, 0, 2, { children: 1 }));
      await s.say(mid, status(s.source.peer, 1, 0));
      await s.say(deep, status(mid.peer, 5, 0, { caps: leafCaps() }));
    };
    await report();
    await s.advance(150_000, async (second) => {
      if (second % 4 === 3) await report();
    });
    // Advice of a parent (a "rebalance" may also offer only better backups: see the tests of the tree under churn).
    const advice = of(deep.heard, "assign").filter((message) => message.reason === "rebalance" && message.assign[0].parents.length > 0);
    assert.ok(advice.length >= 2 && advice.length <= 3, `${advice.length} pieces of advice in 150 s`);
    assert.equal(advice[0].assign[0].parents[0].peer, s.source.peer, "somewhere shallower: the source");
    assert.deepEqual(
      of(mid.heard, "assign").filter((message) => message.assign[0].parents.length > 0),
      [],
      "a peer where it should be is left alone",
    );
  });
});

describe("coordinator: the audience-wide hint (SPEC §11.4, D27)", () => {
  it("lowers the source's ceiling a step after 10 s with over 30% below the top layer, and raises it after 60 s under 10%", async () => {
    const s = await session();
    const viewers: Joined[] = [];
    for (let i = 0; i < 3; i++) viewers.push(await s.join(`v${i}`, false));
    s.everyone.push(...viewers);
    let below = 2;
    const report = async () => {
      await s.say(s.source, status(null, 0, 0, { children: 3 }));
      for (const viewer of viewers) await s.say(viewer, status(s.source.peer, 1, 0, { caps: leafCaps() }));
    };
    const metrics = async () => {
      for (const [index, viewer] of viewers.entries()) await s.say(viewer, { t: "metrics", sample: sample(viewer.peer, { up: up(s.source.peer, 0), video: video(index < below ? 1 : 2) }) });
    };
    const hints: [number, number][] = [];
    const start = s.rig.now;
    const run = async (ms: number) =>
      s.advance(ms, async (second) => {
        if (second % 2 === 1) await metrics();
        if (second % 4 === 3) await report();
        for (const hint of of(s.source.heard.splice(0), "hint")) hints.push([Math.round((s.rig.now - start) / 1000), hint.bitrateKbps]);
      });
    await report();
    await metrics();
    await run(30_000);
    // Two of three below the top layer: 1,200 → 800 after 10 s, → 500 after 10 s more, and no lower.
    assert.deepEqual(
      hints.map(([, kbps]) => kbps),
      [800, 500],
    );
    assert.ok(hints[0][0] >= 10 && hints[0][0] <= 13, `first hint at ${hints[0][0]} s`);
    below = 0;
    hints.length = 0;
    await run(130_000);
    assert.deepEqual(
      hints.map(([, kbps]) => kbps),
      [800, 1200],
    );
  });

  it("does not move for one viewer of four below the top layer (25%)", async () => {
    const s = await session();
    const viewers: Joined[] = [];
    for (let i = 0; i < 4; i++) viewers.push(await s.join(`v${i}`, false));
    s.everyone.push(...viewers);
    await s.advance(40_000, async (second) => {
      if (second % 2 === 1) for (const [index, viewer] of viewers.entries()) await s.say(viewer, { t: "metrics", sample: sample(viewer.peer, { video: video(index === 0 ? 0 : 2) }) });
      if (second % 4 === 3) for (const viewer of viewers) await s.say(viewer, status(s.source.peer, 1, 0, { caps: leafCaps() }));
    });
    assert.deepEqual(of(s.source.heard, "hint"), []);
  });
});

describe("coordinator: /stats for the webinar gate (SPEC §6.2)", () => {
  it("counts who is watching now: not the source, relays included, and nobody whose socket has gone", async () => {
    const s = await session();
    const stats = async () => (await s.rig.http("GET", "/stats")).body as RoomStats;
    assert.deepEqual(await stats(), { viewers: 0, relays: 0, maxDepth: 0, started: true, ended: false });
    const a = await s.join("a", true);
    const b = await s.join("b", false);
    const c = await s.join("c", false);
    await s.say(a, status(s.source.peer, 1, 0));
    await s.say(b, status(a.peer, 2, 0, { caps: leafCaps() }));
    assert.deepEqual(await stats(), { viewers: 3, relays: 0, maxDepth: 2, started: true, ended: false });
    await s.say(c, { t: "bye" });
    await s.rig.drop(b.conn);
    assert.equal((await stats()).viewers, 1);
    // The webinar gate is told the session ended, and so is everyone else.
    await s.rig.http("POST", "/end", { reason: "ended" });
    assert.deepEqual(await stats(), { viewers: 0, relays: 0, maxDepth: 0, started: false, ended: true });
  });
});
