/**
 * K1 (PLAN §5): the core driven directly. Tickets, `hello` / `welcome`, grants, `time`, the
 * signalling relay, limits, and what is kept across a restart.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PARAMS, importGrantPublicKey, readGrantUnverified, verifyGrant } from "@meetly/overlay/protocol";
import type { ClientMessage, MetricsSample, ServerMessage, ServerMessageOf } from "@meetly/overlay/protocol";
import { GRANT_LIFE_S, GRANT_RENEW_S, INTRODUCED_MS } from "./core";
import { ADMISSION_SECRET, ROOM, Rig, STREAMS, leafCaps, relayCaps, ticketFor } from "./testkit";

const of = <T extends ServerMessage["t"]>(messages: ServerMessage[], t: T): ServerMessageOf<T>[] => messages.filter((message): message is ServerMessageOf<T> => message.t === t);

const sample = (peer: string, over: Partial<MetricsSample> = {}): MetricsSample => ({ peer, seq: 0, at: 1000, intervalMs: 2000, role: "leaf", depth: 1, playoutDelayMs: 60, events: [], ...over });

/** A source that has said what it sends, so viewers are placed. */
async function withSource(rig: Rig) {
  const source = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
  await rig.say(source.conn, { t: "streams", streams: STREAMS });
  return source;
}

describe("coordinator core: admission (SPEC §6.1, D9)", () => {
  it("accepts a ticket once and never twice", async () => {
    const rig = new Rig();
    const ticket = await ticketFor("ana", "viewer", rig.now);
    const first = await rig.openWith(ticket);
    assert.equal(rig.closes.get(first), undefined);
    const again = await rig.openWith(ticket);
    assert.deepEqual(rig.closes.get(again), { code: 4001, reason: "ticket already used" });
    // Not even after the socket that used it has gone.
    await rig.drop(first);
    const third = await rig.openWith(ticket);
    assert.equal(rig.closes.get(third)?.code, 4001);
  });

  it("closes with 4001 for a wrong secret, a wrong room, an expired ticket and nonsense", async () => {
    const rig = new Rig();
    const cases: [string, Promise<string> | string][] = [
      ["secret", ticketFor("ana", "viewer", rig.now, { secret: "not-the-secret" })],
      ["room", ticketFor("ana", "viewer", rig.now, { room: "another-room" })],
      ["expiry", ticketFor("ana", "viewer", rig.now, { exp: Math.floor(rig.now / 1000) - 1 })],
      ["nonsense", "not.a.ticket"],
      ["empty", ""],
    ];
    for (const [what, ticket] of cases) {
      const conn = await rig.openWith(await ticket);
      assert.equal(rig.closes.get(conn)?.code, 4001, what);
    }
    // A ticket altered after signing: the role raised to "source".
    const [body, mac] = (await ticketFor("ana", "viewer", rig.now)).split(".");
    const forged = Buffer.from(Buffer.from(body, "base64url").toString().replace('"viewer"', '"source"')).toString("base64url");
    assert.equal(rig.closes.get(await rig.openWith(`${forged}.${mac}`))?.code, 4001);
    assert.equal(rig.core.snapshot().peers.length, 0);
  });

  it("a ticket good for 60 s is refused in the 61st", async () => {
    const rig = new Rig();
    const ticket = await ticketFor("ana", "viewer", rig.now);
    await rig.advance(61_000);
    assert.equal(rig.closes.get(await rig.openWith(ticket))?.code, 4001);
  });

  it("closes with 4002 at the audience limit, but never the source, and not someone coming back", async () => {
    const rig = new Rig({ viewerCap: 2 });
    const a = await rig.join("ana");
    await rig.join("ben");
    const refused = await rig.open("cy");
    assert.deepEqual(rig.closes.get(refused), { code: 4002, reason: "full" });
    const source = await rig.join("host", "source");
    assert.equal(source.welcome.role, "source");
    // Ana's socket drops and she comes back: she is already counted.
    await rig.drop(a.conn);
    const back = await rig.join("ana", "viewer", relayCaps(), { peer: a.peer, grant: a.welcome.grant });
    assert.equal(back.peer, a.peer);
    // A place freed by someone leaving for good can be taken.
    await rig.say(back.conn, { t: "bye" });
    assert.equal((await rig.join("cy")).welcome.role, "leaf");
  });

  it("remembers used tickets across a restart, and forgets them once they have expired", async () => {
    const rig = new Rig();
    const ticket = await ticketFor("ana", "viewer", rig.now);
    await rig.openWith(ticket);
    assert.equal([...rig.stored.keys()].filter((key) => key.startsWith("nonce:")).length, 1);
    const next = await rig.evicted();
    assert.equal(next.closes.get(await next.openWith(ticket))?.code, 4001);
    await next.advance(70_000);
    assert.equal([...next.stored.keys()].filter((key) => key.startsWith("nonce:")).length, 0);
  });
});

describe("coordinator core: hello, welcome and grants (SPEC §6.3, §6.5, D11)", () => {
  it("answers hello with everything a peer needs to start", async () => {
    const rig = new Rig();
    await withSource(rig);
    const { welcome } = await rig.join("ana");
    assert.equal(welcome.v, 1);
    assert.equal(welcome.room, ROOM);
    assert.equal(welcome.role, "leaf");
    assert.deepEqual(welcome.params, DEFAULT_PARAMS);
    assert.deepEqual(welcome.streams, STREAMS);
    assert.deepEqual(welcome.ice, [{ urls: ["stun:stun.example.org:3478"] }]);
    assert.equal(welcome.epochMs, rig.core.snapshot().startedAt);
    // One assignment per stream and stripe, all to the same parent in stage 1 (D14).
    assert.deepEqual(
      welcome.assign.map((assignment) => [assignment.stream, assignment.stripe, assignment.parents[0]?.depth]),
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
    );
    assert.equal(welcome.assign[0].parents[0].peer, rig.core.snapshot().source);
  });

  it("signs grants that any peer can check with the key in welcome, and nobody can alter", async () => {
    const rig = new Rig();
    const source = await withSource(rig);
    const viewer = await rig.join("ana");
    const key = await importGrantPublicKey(viewer.welcome.key.pub);
    const mine = await verifyGrant(viewer.welcome.grant, key, { room: ROOM, now: rig.now, peer: viewer.peer });
    assert.ok(mine);
    assert.deepEqual([mine.role, mine.scope, mine.kid, mine.exp - mine.iat], ["leaf", ["view"], viewer.welcome.key.kid, GRANT_LIFE_S]);
    // The viewer checks the source's grant with its own copy of the key (SPEC §5.2).
    const theirs = await verifyGrant(source.welcome.grant, key, { room: ROOM, now: rig.now, peer: source.peer });
    assert.ok(theirs);
    assert.equal(theirs.role, "source");
    assert.ok(theirs.scope.includes("relay") && theirs.scope.includes("publish:0") && theirs.scope.includes("publish:1"));
    // Not for another peer, another room, or after it has expired; and not if the role is edited.
    assert.equal(await verifyGrant(viewer.welcome.grant, key, { room: ROOM, now: rig.now, peer: source.peer }), null);
    assert.equal(await verifyGrant(viewer.welcome.grant, key, { room: "other", now: rig.now }), null);
    assert.equal(await verifyGrant(viewer.welcome.grant, key, { room: ROOM, now: rig.now + (GRANT_LIFE_S + 31) * 1000 }), null);
    const [body, signature] = viewer.welcome.grant.split(".");
    const edited = Buffer.from(Buffer.from(body, "base64url").toString().replace('"leaf"', '"relay"')).toString("base64url");
    assert.equal(await verifyGrant(`${edited}.${signature}`, key, { room: ROOM, now: rig.now }), null);
  });

  it("replaces a grant two minutes before it expires", async () => {
    const rig = new Rig();
    const viewer = await rig.join("ana");
    await rig.advance((GRANT_LIFE_S - GRANT_RENEW_S - 5) * 1000);
    assert.equal(of(rig.take(viewer.conn), "grant").length, 0);
    await rig.advance(10_000);
    const [fresh] = of(rig.take(viewer.conn), "grant");
    assert.ok(fresh);
    const key = await importGrantPublicKey(viewer.welcome.key.pub);
    const grant = await verifyGrant(fresh.grant, key, { room: ROOM, now: rig.now, peer: viewer.peer });
    assert.ok(grant && grant.exp > readGrantUnverified(viewer.welcome.grant)!.exp);
  });

  it("refuses another protocol version, a second hello, and anything before hello", async () => {
    const rig = new Rig();
    const conn = await rig.open("ana");
    assert.deepEqual(
      (await rig.say(conn, { t: "time", t0: 1 })).map((message) => [message.t, message.t === "error" && message.code]),
      [["error", "bad-message"]],
    );
    const { conn: joined } = await rig.join("ben");
    assert.equal(of(await rig.say(joined, { t: "hello", v: 1, caps: relayCaps() }), "error")[0]?.code, "bad-message");
    const other = await rig.open("cy");
    assert.equal(of(await rig.say(other, { t: "hello", v: 2, caps: relayCaps() }), "error")[0]?.code, "version");
    assert.equal(rig.closes.get(other)?.code, 4005);
  });

  it("closes a socket that never says hello", async () => {
    const rig = new Rig();
    const conn = await rig.open("ana");
    await rig.advance(12_000);
    assert.equal(rig.closes.get(conn)?.code, 4005);
  });

  it("admits one source: a second, of another identity, is refused while the first is here", async () => {
    const rig = new Rig();
    const first = await rig.join("host", "source");
    const conn = await rig.open("impostor", "source");
    assert.equal(of(await rig.say(conn, { t: "hello", v: 1, caps: relayCaps() }), "error")[0]?.code, "denied");
    assert.equal(rig.closes.get(conn)?.code, 4001);
    assert.equal(rig.core.snapshot().source, first.peer);
  });

  it("answers time with the session clock", async () => {
    const rig = new Rig();
    const { conn, welcome } = await rig.join("ana");
    await rig.advance(1234);
    assert.deepEqual(await rig.say(conn, { t: "time", t0: 99.5 }), [{ t: "time", t0: 99.5, t1: rig.now - welcome.epochMs }]);
  });
});

describe("coordinator core: resume (SPEC §6.3, §6.6)", () => {
  it("gives a returning peer the same PeerId, and closes its older socket with 4006", async () => {
    const rig = new Rig();
    await withSource(rig);
    const first = await rig.join("ana");
    const second = await rig.join("ana", "viewer", relayCaps(), { peer: first.peer, grant: first.welcome.grant });
    assert.equal(second.peer, first.peer);
    assert.equal(rig.closes.get(first.conn)?.code, 4006);
    assert.deepEqual(second.welcome.assign, [], "someone coming back is where it was");
    assert.equal(rig.core.snapshot().peers.filter((peer) => peer.identity === "ana").length, 1);
  });

  it("does not let one peer come back as another, even holding the other's grant", async () => {
    const rig = new Rig();
    const ana = await rig.join("ana");
    // Ben saw Ana's grant in `hello` on a link between them (SPEC §5.2).
    const ben = await rig.join("ben", "viewer", relayCaps(), { peer: ana.peer, grant: ana.welcome.grant });
    assert.notEqual(ben.peer, ana.peer);
    assert.equal(rig.closes.get(ana.conn), undefined);
    // Nor after the coordinator has lost its memory, when only the grant and the id speak for him.
    const next = await rig.evicted();
    await next.drop(ana.conn);
    await next.drop(ben.conn);
    await next.advance(31_000);
    assert.equal(next.core.snapshot().peers.length, 0);
    const cy = await next.join("cy", "viewer", relayCaps(), { peer: ana.peer, grant: ana.welcome.grant });
    assert.notEqual(cy.peer, ana.peer);
    const back = await next.join("ana", "viewer", relayCaps(), { peer: ana.peer, grant: ana.welcome.grant });
    assert.equal(back.peer, ana.peer);
  });

  it("a reloaded tab (no resume) is a new peer, and the old one is gone at once", async () => {
    const rig = new Rig();
    const source = await withSource(rig);
    const first = await rig.join("ana");
    await rig.say(first.conn, { t: "status", depth: 1, links: [{ stream: 0, stripe: 0, parent: source.peer, backup: null }], children: 0, standby: 0, free: 0, caps: relayCaps(), lossPct: 0, rttMs: 10 });
    rig.take(source.conn);
    const second = await rig.join("ana");
    assert.notEqual(second.peer, first.peer);
    assert.equal(rig.closes.get(first.conn)?.code, 4006);
    assert.deepEqual(rig.take(source.conn), [{ t: "peer-gone", peer: first.peer }]);
  });

  it("keeps the signing key, the session clock and the end of the session, and nothing else", async () => {
    const rig = new Rig();
    const ana = await rig.join("ana");
    assert.deepEqual(
      [...rig.stored.keys()].map((key) => key.split(":")[0]).sort(),
      ["nonce", "session"],
    );
    const next = await rig.evicted();
    const ben = await next.join("ben");
    assert.deepEqual(ben.welcome.key, ana.welcome.key);
    assert.equal(ben.welcome.epochMs, ana.welcome.epochMs);
    // The grant Ana holds from before is still good to Ben.
    assert.ok(await verifyGrant(ana.welcome.grant, await importGrantPublicKey(ben.welcome.key.pub), { room: ROOM, now: next.now, peer: ana.peer }));
    assert.equal((await next.http("POST", "/end", { reason: "ended" })).status, 200);
    assert.equal(next.stored.get("ended"), "ended");
    const after = await next.evicted();
    assert.equal(after.closes.get(await after.open("cy"))?.code, 4004);
  });
});

describe("coordinator core: signalling (SPEC §6.4, D10)", () => {
  const offer = { sdp: { type: "offer" as const, sdp: "v=0" } };

  it("relays between peers it introduced, in both directions, and not after a minute", async () => {
    const rig = new Rig();
    const source = await withSource(rig);
    const ana = await rig.join("ana");
    assert.equal(ana.welcome.assign[0].parents[0].peer, source.peer);
    assert.deepEqual(await rig.say(ana.conn, { t: "signal", to: source.peer, data: offer }), []);
    assert.deepEqual(rig.take(source.conn), [{ t: "signal", from: ana.peer, data: offer }]);
    assert.deepEqual(await rig.say(source.conn, { t: "signal", to: ana.peer, data: { candidate: null } }), []);
    assert.deepEqual(rig.take(ana.conn), [{ t: "signal", from: source.peer, data: { candidate: null } }]);
    await rig.advance(INTRODUCED_MS + 1000);
    assert.equal(of(await rig.say(ana.conn, { t: "signal", to: source.peer, data: offer }), "error")[0]?.code, "denied");
  });

  it("[D83] passes hello's offer to the first parent with welcome, says so, and relays the answer back", async () => {
    const rig = new Rig();
    const source = await withSource(rig);
    rig.take(source.conn);
    const conn = await rig.open("ana");
    const answers = await rig.say(conn, { t: "hello", v: 1, caps: relayCaps(), offer: "v=0 prepared" });
    const [welcome] = of(answers, "welcome");
    assert.equal(welcome.assign[0].parents[0].peer, source.peer);
    assert.equal(welcome.offered, source.peer);
    assert.deepEqual(rig.take(source.conn), [{ t: "signal", from: welcome.peer, data: { sdp: { type: "offer", sdp: "v=0 prepared" } } }]);
    const answer = { sdp: { type: "answer" as const, sdp: "v=0 answer" } };
    assert.deepEqual(await rig.say(source.conn, { t: "signal", to: welcome.peer, data: answer }), []);
    assert.deepEqual(rig.take(conn), [{ t: "signal", from: source.peer, data: answer }]);
  });

  it("[D83] drops hello's offer where there is no parent yet, and never passes on one in a resume", async () => {
    const rig = new Rig();
    // No source yet: nowhere to place anyone.
    const conn = await rig.open("ana");
    const [early] = of(await rig.say(conn, { t: "hello", v: 1, caps: relayCaps(), offer: "v=0 early" }), "welcome");
    assert.deepEqual(early.assign, []);
    assert.equal(early.offered, undefined);
    const source = await withSource(rig);
    rig.take(source.conn);
    const ben = await rig.join("ben");
    await rig.drop(ben.conn);
    const back = await rig.open("ben");
    const [resumed] = of(await rig.say(back, { t: "hello", v: 1, caps: relayCaps(), resume: { peer: ben.peer, grant: ben.welcome.grant }, offer: "v=0 again" }), "welcome");
    assert.equal(resumed.peer, ben.peer);
    assert.equal(resumed.offered, undefined);
    assert.deepEqual(of(rig.take(source.conn), "signal"), []);
  });

  it("refuses signalling between peers it never introduced", async () => {
    const rig = new Rig();
    await withSource(rig);
    const ana = await rig.join("ana");
    const ben = await rig.join("ben");
    const errors = of(await rig.say(ana.conn, { t: "signal", to: ben.peer, data: offer }), "error");
    assert.deepEqual(errors.map((error) => error.code), ["denied"]);
    assert.deepEqual(rig.take(ben.conn), []);
    assert.equal(of(await rig.say(ana.conn, { t: "signal", to: "nobody", data: offer }), "error")[0]?.code, "not-found");
  });

  it("an answer to need is an introduction too", async () => {
    const rig = new Rig();
    const source = await withSource(rig);
    const ana = await rig.join("ana");
    await rig.advance(INTRODUCED_MS + 1000);
    await rig.say(source.conn, { t: "status", depth: 0, links: [], children: 0, standby: 0, free: 3, caps: relayCaps(), lossPct: 0, rttMs: null });
    const [assign] = of(await rig.say(ana.conn, { t: "need", id: 7, stream: 0, stripe: 0, want: "parent", exclude: [] }), "assign");
    assert.deepEqual([assign.id, assign.reason, assign.assign[0].parents[0].peer], [7, "need", source.peer]);
    assert.deepEqual(await rig.say(ana.conn, { t: "signal", to: source.peer, data: offer }), []);
  });

  it("[D64] a need that excludes the source, while the source is connected and reporting, is answered with the source", async () => {
    const rig = new Rig();
    const source = await withSource(rig);
    const ana = await rig.join("ana");
    await rig.say(source.conn, { t: "status", depth: 0, links: [], children: 0, standby: 0, free: 3, caps: relayCaps(), lossPct: 0, rttMs: null });
    // Excluded with what hangs below it, the source would leave nowhere at all: everyone is below it.
    const [assign] = of(await rig.say(ana.conn, { t: "need", id: 8, stream: 0, stripe: 0, want: "parent", exclude: [source.peer] }), "assign");
    assert.equal(assign.assign[0].parents[0]?.peer, source.peer);
    // A source whose socket has gone is excluded as asked.
    await rig.drop(source.conn);
    const [after] = of(await rig.say(ana.conn, { t: "need", id: 9, stream: 0, stripe: 0, want: "parent", exclude: [source.peer] }), "assign");
    assert.ok(!after.assign[0].parents.some((hint) => hint.peer === source.peer));
  });
});

describe("coordinator core: every client message (SPEC §6.3)", () => {
  it("answers or ignores each type as the table says", async () => {
    const rig = new Rig();
    const source = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
    const ana = await rig.join("ana");
    const status: ClientMessage = { t: "status", depth: 1, links: [{ stream: 0, stripe: 0, parent: source.peer, backup: null }], children: 0, standby: 0, free: 0, caps: relayCaps(), lossPct: 0.5, rttMs: 12 };

    // streams: from the source it reaches everyone else; from anyone else it is refused.
    assert.deepEqual(await rig.say(source.conn, { t: "streams", streams: STREAMS }), []);
    const told = rig.take(ana.conn);
    assert.deepEqual(told[0], { t: "streams", streams: STREAMS });
    assert.equal(of(told, "assign")[0]?.reason, "join", "a viewer who was waiting for a stream is told where to connect");
    assert.equal(of(await rig.say(ana.conn, { t: "streams", streams: STREAMS }), "error")[0]?.code, "denied");

    // status, report and metrics are taken in silence.
    assert.deepEqual(await rig.say(ana.conn, status), []);
    assert.deepEqual(await rig.say(ana.conn, { t: "report", event: "backup-lost", stream: 0, stripe: 0, peer: source.peer }), []);
    assert.deepEqual(await rig.say(ana.conn, { t: "metrics", sample: sample(ana.peer) }), []);
    assert.deepEqual(rig.core.metrics(), [sample(ana.peer)]);
    const record = rig.core.snapshot().peers.find((peer) => peer.peer === ana.peer)!;
    assert.deepEqual([record.depth, record.links[0].parent, record.lastStatusAt], [1, source.peer, rig.now]);

    // time and need are answered; need carries its id back.
    assert.equal((await rig.say(ana.conn, { t: "time", t0: 5 }))[0].t, "time");
    assert.equal(of(await rig.say(ana.conn, { t: "need", id: 3, stream: 0, stripe: 0, want: "backup", exclude: [] }), "assign")[0]?.id, 3);
    assert.equal(of(await rig.say(source.conn, { t: "need", id: 4, stream: 0, stripe: 0, want: "parent", exclude: [] }), "error")[0]?.id, 4);

    // bye: the socket is closed, the peer is gone at once, and its neighbours are told.
    rig.take(source.conn);
    assert.deepEqual(await rig.say(ana.conn, { t: "bye" }), []);
    assert.equal(rig.closes.get(ana.conn)?.code, 1000);
    assert.deepEqual(rig.take(source.conn), [{ t: "peer-gone", peer: ana.peer }]);
    assert.equal(rig.core.snapshot().peers.length, 1);
  });

  it("answers garbage with error bad-message, and closes with 4005 if it goes on", async () => {
    const rig = new Rig();
    const { conn } = await rig.join("ana");
    for (const text of ["", "{", "[]", "null", '{"t":"nope"}', '{"t":"time"}', '{"t":"time","t0":"soon"}', '{"t":"signal","to":"x","data":{"sdp":{"type":"evil","sdp":""}}}', JSON.stringify({ t: "time", t0: 1, pad: "x".repeat(70_000) })]) {
      const answers = await rig.say(conn, text);
      assert.deepEqual(answers.map((message) => [message.t, message.t === "error" && message.code]), [["error", "bad-message"]], text.slice(0, 40));
    }
    assert.equal(rig.closes.get(conn), undefined);
    for (let i = 0; i < 30; i++) await rig.say(conn, "garbage");
    assert.equal(rig.closes.get(conn)?.code, 4005);
  });

  it("holds each peer to the limits: error rate, then the door", async () => {
    const rig = new Rig();
    await withSource(rig);
    const { conn } = await rig.join("ana");
    let refused = 0;
    for (let i = 0; i < 8; i++) refused += of(await rig.say(conn, { t: "need", id: i, stream: 0, stripe: 0, want: "parent", exclude: [] }), "error").filter((error) => error.code === "rate").length;
    assert.equal(refused, 3, "5 need a second");
    await rig.advance(1000);
    assert.equal(of(await rig.say(conn, { t: "need", id: 9, stream: 0, stripe: 0, want: "parent", exclude: [] }), "assign").length, 1, "and again a second later");
    for (let i = 0; i < 40 && !rig.closes.has(conn); i++) await rig.say(conn, { t: "metrics", sample: sample("x") });
    assert.equal(rig.closes.get(conn)?.code, 4005);
  });

  it("serves the HTTP API to Meetly's server only (SPEC §6.2)", async () => {
    const rig = new Rig();
    assert.deepEqual((await rig.http("GET", "/stats")).body, { viewers: 0, relays: 0, maxDepth: 0, started: false, ended: false });
    const source = await withSource(rig);
    const ana = await rig.join("ana", "viewer", leafCaps());
    await rig.say(ana.conn, { t: "status", depth: 1, links: [{ stream: 0, stripe: 0, parent: source.peer, backup: null }], children: 0, standby: 0, free: 0, caps: leafCaps(), lossPct: 0, rttMs: 10 });
    assert.equal((await rig.http("GET", "/stats", null, null)).status, 401);
    assert.equal((await rig.http("GET", "/stats", null, ADMISSION_SECRET)).status, 401);
    assert.equal((await rig.http("GET", "/nothing")).status, 404);
    assert.equal((await rig.http("GET", "/end")).status, 405);
    assert.deepEqual((await rig.http("GET", "/stats")).body, { viewers: 1, relays: 0, maxDepth: 1, started: true, ended: false });
    assert.equal(((await rig.http("GET", "/tree")).body as { peers: unknown[] }).peers.length, 2);

    // kick: the peer is told, shown out with 4003, its neighbours are told, and it cannot come back.
    rig.take(source.conn);
    assert.deepEqual((await rig.http("POST", "/kick", { identity: "ana" })).body, { kicked: 1 });
    assert.equal(rig.take(ana.conn)[0].t, "kick");
    assert.equal(rig.closes.get(ana.conn)?.code, 4003);
    assert.deepEqual(rig.take(source.conn), [{ t: "peer-gone", peer: ana.peer }]);
    assert.equal(rig.closes.get(await rig.open("ana"))?.code, 4003);
    assert.equal((await rig.http("POST", "/kick", {})).status, 400);

    // end: everyone is told and shown out with 4004, and nobody gets in afterwards.
    const ben = await rig.join("ben");
    assert.equal((await rig.http("POST", "/end", { reason: "limit" })).status, 200);
    assert.deepEqual(rig.take(ben.conn), [{ t: "end", reason: "limit" }]);
    assert.equal(rig.closes.get(ben.conn)?.code, 4004);
    assert.equal(rig.closes.get(source.conn)?.code, 4004);
    assert.equal(rig.closes.get(await rig.open("cy"))?.code, 4004);
    assert.deepEqual((await rig.http("GET", "/stats")).body, { viewers: 0, relays: 0, maxDepth: 0, started: false, ended: true });
  });
});
