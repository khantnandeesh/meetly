/**
 * SPEC §8.1 [D82]: a peer whose link to its parent goes through TURN only watches. It is never
 * promoted, never offered to anyone as a parent or a backup, and a relay that says so is demoted
 * at once, its children moved first. And §6.7: TURN credentials are minted again at half their
 * life and sent in `grant`, never kept anywhere but the peer's own socket. The core is driven
 * directly, with the time in the test's hands, as in roles.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeClientMessage, decodeServerMessage, encodeServerMessage } from "@meetly/overlay/protocol";
import type { ClientMessage, IceServer, PeerId, ServerMessage, ServerMessageOf } from "@meetly/overlay/protocol";
import { behindTurn } from "../engine";
import { mintTurn, turnFrom } from "./turn";
import { Rig, STREAMS, Swarm, leafCaps, relayCaps, seeded } from "./testkit";

type ClientMessageOf<T extends ClientMessage["t"]> = Extract<ClientMessage, { t: T }>;
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

type Joined = { conn: string; peer: PeerId; heard: ServerMessage[] };

/** A session with a source, as in roles.test.ts: peers join and report, and what they are sent is kept in `heard`. */
async function session(over: ConstructorParameters<typeof Rig>[0] = {}) {
  const rig = new Rig({ moves: false, provisionalRelays: false, ...over });
  const host = await rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
  await rig.say(host.conn, { t: "streams", streams: STREAMS });
  const source: Joined = { conn: host.conn, peer: host.peer, heard: [] };
  const everyone: Joined[] = [source];
  const say = async (who: Joined, message: ClientMessage) => {
    who.heard.push(...(await rig.say(who.conn, message)));
  };
  const join = async (identity: string, capable: boolean): Promise<Joined> => {
    const joined = await rig.join(identity, "viewer", capable ? relayCaps() : leafCaps());
    const who = { conn: joined.conn, peer: joined.peer, heard: [joined.welcome as ServerMessage] };
    everyone.push(who);
    return who;
  };
  const advance = async (ms: number, everySecond?: (second: number) => Promise<void>) => {
    for (let s = 0; s < ms / 1000; s++) {
      await rig.advance(1000);
      for (const who of everyone) who.heard.push(...rig.take(who.conn));
      await everySecond?.(s);
    }
  };
  return { rig, source, say, join, advance, everyone };
}

const roles = (who: Joined) => of(who.heard, "role").map((message) => message.role);
/** Every peer named to `who` as a parent or a backup, in a welcome or an assign. */
const named = (who: Joined): PeerId[] =>
  [...of(who.heard, "welcome").flatMap((message) => message.assign), ...of(who.heard, "assign").flatMap((message) => message.assign)].flatMap((assignment) => [...assignment.parents, ...assignment.backups].map((hint) => hint.peer));

describe("coordinator: a peer behind TURN only watches (SPEC §8.1 [D82])", () => {
  /** One peer able to relay and five that never can, under a source with one free slot: the candidate is promoted unless it is behind TURN. */
  async function promotionCase(turn: ClientMessageOf<"status">["turn"]) {
    const s = await session();
    const candidate = await s.join("candidate", true);
    const others: Joined[] = [];
    for (let i = 0; i < 5; i++) others.push(await s.join(`leaf-${i}`, false));
    const report = async () => {
      await s.say(s.source, status(null, 0, 1, { children: 6 }));
      await s.say(candidate, status(s.source.peer, 1, 0, turn === undefined ? {} : { turn }));
      for (const other of others) await s.say(other, status(s.source.peer, 1, 0, { caps: leafCaps() }));
    };
    await report();
    await s.advance(40_000, async (second) => {
      if (second % 5 === 4) await report();
    });
    return { ...s, candidate };
  }

  it("is never promoted, where the same peer not behind TURN is", async () => {
    assert.deepEqual(roles((await promotionCase(undefined)).candidate), ["relay"], "an old client, which never says `turn`, is promoted as before");
    assert.deepEqual(roles((await promotionCase(false)).candidate), ["relay"]);
    const { candidate, rig } = await promotionCase(true);
    assert.deepEqual(roles(candidate), []);
    assert.equal(rig.core.snapshot().peers.find((peer) => peer.peer === candidate.peer)?.role, "leaf");
  });

  it("is never promoted for a joiner with nowhere to go, provisional relays on", async () => {
    const s = await session({ provisionalRelays: true });
    const candidate = await s.join("candidate", true);
    await s.say(s.source, status(null, 0, 0, { children: 1 }));
    await s.say(candidate, status(s.source.peer, 1, 0, { turn: true }));
    await s.advance(25_000, async (second) => {
      if (second % 5 === 4) {
        await s.say(s.source, status(null, 0, 0, { children: 1 }));
        await s.say(candidate, status(s.source.peer, 1, 0, { turn: true }));
      }
    });
    const joiner = await s.join("joiner", false);
    await s.say(joiner, { t: "need", id: 1, stream: 0, stripe: 0, want: "parent", exclude: [] });
    await s.advance(5_000);
    assert.deepEqual(roles(candidate), []);
    assert.ok(!named(joiner).includes(candidate.peer), "not offered either");
  });

  it("stays a leaf for the session: a later status without `turn` does not undo it", async () => {
    const s = await session();
    const candidate = await s.join("candidate", true);
    const others: Joined[] = [];
    for (let i = 0; i < 5; i++) others.push(await s.join(`leaf-${i}`, false));
    let turn = true;
    const report = async () => {
      await s.say(s.source, status(null, 0, 1, { children: 6 }));
      await s.say(candidate, status(s.source.peer, 1, 0, turn ? { turn } : {}));
      for (const other of others) await s.say(other, status(s.source.peer, 1, 0, { caps: leafCaps() }));
    };
    await report();
    turn = false;
    await s.advance(40_000, async (second) => {
      if (second % 5 === 4) await report();
    });
    assert.deepEqual(roles(candidate), []);
  });

  it("a relay that says it is behind TURN is offered to nobody from that moment, and demoted at once, its children moved first", async () => {
    const s = await session();
    const relay = await s.join("relay", true);
    const early = async () => {
      await s.say(s.source, status(null, 0, 0, { children: 1 }));
      await s.say(relay, status(s.source.peer, 1, 0));
    };
    await early();
    await s.advance(25_000, async (second) => {
      if (second % 5 === 4) await early();
    });
    assert.deepEqual(roles(relay), ["relay"]);
    const other = await s.join("other", true);
    const kids: Joined[] = [];
    for (let i = 0; i < 2; i++) kids.push(await s.join(`kid-${i}`, false));
    let turn = false;
    const report = async () => {
      // Room at the source for the joiner below and both of the relay's children.
      await s.say(s.source, status(null, 0, 3, { children: 2 }));
      await s.say(relay, status(s.source.peer, 1, 2, { children: 2, ...(turn ? { turn } : {}) }));
      await s.say(other, status(s.source.peer, 1, 0));
      for (const kid of kids) await s.say(kid, status(relay.peer, 2, 0, { caps: leafCaps() }));
    };
    await report();
    await s.advance(2_000);

    // Its route falls back to TURN. A joiner asking in the same moment is not sent to it.
    turn = true;
    await s.say(relay, status(s.source.peer, 1, 2, { children: 2, turn: true }));
    const joiner = await s.join("joiner", false);
    await s.say(joiner, { t: "need", id: 7, stream: 0, stripe: 0, want: "parent", exclude: [] });
    await s.say(joiner, { t: "need", id: 8, stream: 0, stripe: 0, want: "backup", exclude: [] });
    const start = s.rig.now;
    let movedAt: number | null = null;
    let demotedAt: number | null = null;
    await s.advance(10_000, async (second) => {
      if (movedAt === null && kids.every((kid) => of(kid.heard, "assign").some((message) => message.reason === "move"))) movedAt = s.rig.now - start;
      if (demotedAt === null && roles(relay).includes("leaf")) demotedAt = s.rig.now - start;
      if (second % 5 === 4) await report();
    });
    assert.ok(!named(joiner).includes(relay.peer), `the joiner was offered ${JSON.stringify(named(joiner))}`);
    assert.ok(movedAt !== null && movedAt <= 1_000, `its children were asked to move ${movedAt} ms on`);
    for (const kid of kids) {
      const move = of(kid.heard, "assign").find((message) => message.reason === "move")!;
      assert.ok(!move.assign.some((assignment) => assignment.parents.some((hint) => hint.peer === relay.peer)), "nor back to it");
    }
    // Not the 10 s a failing relay is given: told when its grace (5 s) is over, or its children gone.
    assert.ok(demotedAt !== null && demotedAt <= 6_000, `demoted ${demotedAt} ms on`);
    const grant = JSON.parse(Buffer.from(of(relay.heard, "role").at(-1)!.grant.split(".")[0], "base64url").toString()) as { scope: string[] };
    assert.deepEqual(grant.scope, ["view"]);
  });

  it("a host on a strict network does not bar its children: they judge by their own candidate, and are promoted", async () => {
    // The reviewer's case: the host's candidate is a relay, so every child's link to it has a
    // remote relay. Judged by either end (before), all three flagged themselves and nobody could
    // relay: every joiner went to the source. Judged by their own end, none is behind TURN.
    const s = await session();
    await s.say(s.source, status(null, 0, 3, { turn: true }));
    const hostLink = { turn: true, localTurn: false };
    const children: Joined[] = [];
    for (let i = 0; i < 3; i++) children.push(await s.join(`child-${i}`, true));
    const flags = children.map(() => behindTurn([{ parent: s.source.peer }], { get: () => hostLink }));
    assert.deepEqual(flags, [false, false, false]);
    assert.equal(behindTurn([{ parent: s.source.peer }], { get: () => ({ turn: true, localTurn: true }) }), true, "its own relay: behind TURN");
    assert.equal(behindTurn([{ parent: null }], { get: () => ({ turn: true, localTurn: true }) }), false, "no parent yet: nothing to judge");
    const others: Joined[] = [];
    for (let i = 0; i < 4; i++) others.push(await s.join(`leaf-${i}`, false));
    const report = async () => {
      await s.say(s.source, status(null, 0, 0, { children: 3, turn: true }));
      for (const [i, child] of children.entries()) await s.say(child, status(s.source.peer, 1, 0, flags[i] ? { turn: true } : {}));
      for (const other of others) await s.say(other, status(null, 255, 0, { caps: leafCaps() }));
    };
    await report();
    await s.advance(40_000, async (second) => {
      if (second % 5 === 4) await report();
    });
    assert.ok(children.filter((child) => roles(child).includes("relay")).length >= 1, `promoted: ${children.map((child) => roles(child).join("/") || "-").join(", ")}`);
  });

  it("the source is exempt: it has to send, behind TURN or not", async () => {
    const s = await session();
    await s.say(s.source, status(null, 0, 3, { turn: true }));
    const viewer = await s.join("viewer", false);
    assert.deepEqual(named(viewer).slice(0, 1), [s.source.peer]);
  });

  it("is remembered with its socket: a coordinator that wakes from hibernation does not offer or promote it", async () => {
    const s = await session();
    const candidate = await s.join("candidate", true);
    await s.say(s.source, status(null, 0, 1, { children: 1 }));
    await s.say(candidate, status(s.source.peer, 1, 0, { turn: true }));
    assert.equal((JSON.parse(s.rig.attachments.get(candidate.conn)!) as { tu?: boolean }).tu, true);
    const woken = await s.rig.evicted();
    const others: Joined[] = [];
    for (let i = 0; i < 5; i++) {
      const joined = await woken.join(`leaf-${i}`, "viewer", leafCaps());
      others.push({ conn: joined.conn, peer: joined.peer, heard: [] });
    }
    const heard: ServerMessage[] = [];
    for (let second = 0; second < 40; second++) {
      if (second % 5 === 0) {
        await woken.say(s.source.conn, status(null, 0, 1, { children: 6 }));
        // An old client, or one that has not said it since the coordinator woke: the attachment holds it.
        heard.push(...(await woken.say(candidate.conn, status(s.source.peer, 1, 0))));
        for (const other of others) await woken.say(other.conn, status(s.source.peer, 1, 0, { caps: leafCaps() }));
      }
      await woken.advance(1000);
      heard.push(...woken.take(candidate.conn));
    }
    assert.deepEqual(of(heard, "role"), []);
  });

  for (const peers of [60, 200]) {
    it(`${peers} peers, a fifth of those able to relay behind TURN: none of them ever relays, is anyone's backup, or has a child; everyone is placed`, { timeout: 60_000 }, async () => {
      const random = seeded(peers + 1);
      const swarm = new Swarm(new Rig({ random: seeded(5) }), undefined, { probeAfterMs: 2_000 });
      await swarm.addSource();
      const behind: Awaited<ReturnType<Swarm["addViewer"]>>[] = [];
      let violations = 0;
      const check = () => {
        const turned = new Set(behind.map((peer) => peer.peer));
        for (const peer of swarm.peers.values()) {
          if (!peer.alive) continue;
          if (turned.has(peer.peer) && (peer.role !== "leaf" || peer.kids.size > 0)) violations++;
          if (peer.backup !== null && turned.has(peer.backup)) violations++;
        }
      };
      for (let joined = 0; joined < peers - 1; ) {
        for (let k = 0; k < 10 && joined < peers - 1; k++, joined++) {
          const capable = random() < 0.6;
          const viewer = await swarm.addViewer(capable);
          if (capable && random() < 0.2) {
            viewer.turn = true;
            behind.push(viewer);
          }
        }
        await swarm.second();
        check();
      }
      for (let s = 0; s < 60; s++) {
        await swarm.second();
        check();
      }
      const shape = swarm.shape();
      console.log(`      ${peers} peers, ${behind.length} behind TURN: ${shape.relays} relays, depth ${shape.maxDepth}, ${shape.waiting} waiting`);
      assert.ok(behind.length > 0);
      assert.equal(violations, 0);
      assert.equal(shape.waiting, 0, "everyone placed");
      assert.ok(shape.relays > 0, "the others relay");
      assert.ok(behind.every((peer) => peer.parent !== null), "and those behind TURN watch");
    });
  }
});

describe("coordinator: TURN credentials over a long session (SPEC §6.7 [D82])", () => {
  let minted = 0;
  const turn = async (): Promise<IceServer[]> => [{ urls: ["stun:stun.example.org:3478"] }, { urls: ["turn:turn.example.org:3478?transport=udp"], username: `user-${++minted}`, credential: `secret-${minted}` }];

  it("sends fresh ICE servers in a grant once a peer's are half their life old, and keeps sending them", async () => {
    minted = 0;
    const s = await session({ iceServers: turn, iceRefreshMs: 3 * 3_600_000 });
    const viewer = await s.join("viewer", false);
    const welcome = of(viewer.heard, "welcome")[0];
    assert.equal(welcome.ice[1].username, "user-2", "the source's were the first");
    const fresh: string[] = [];
    // Seven hours, a minute at a time: longer than the six-hour TTL.
    for (let minute = 0; minute < 7 * 60; minute++) {
      await s.rig.advance(60_000);
      for (const message of of(s.rig.take(viewer.conn), "grant")) if (message.ice) fresh.push(`${Math.round((s.rig.now - (1_700_000_000_000)) / 60_000)}:${message.ice[1].username}`);
    }
    assert.equal(fresh.length, 2, fresh.join(" "));
    assert.ok(fresh.every((entry) => /^(18[0-2]|36[0-2]):user-\d+$/.test(entry)), `at 3 h and 6 h: ${fresh.join(" ")}`);
  });

  it("refreshes only the peers that may need TURN: not one whose NAT others can reach and that is not behind TURN", async () => {
    minted = 0;
    const s = await session({ iceServers: turn, iceRefreshMs: 60 * 60_000 });
    const a = await s.rig.join("cone", "viewer", relayCaps({ nat: "cone" }));
    const b = await s.rig.join("strict", "viewer", leafCaps());
    await s.rig.advance(61 * 60_000);
    assert.equal(of(s.rig.take(a.conn), "grant").filter((message) => message.ice).length, 0, "a cone NAT's are left to expire");
    assert.equal(of(s.rig.take(b.conn), "grant").filter((message) => message.ice).length, 1);
  });

  it("mints a tick's refreshes at once, not one after another", async () => {
    let running = 0;
    let most = 0;
    const slow = async (): Promise<IceServer[]> => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return turn();
    };
    const s = await session({ iceServers: slow, iceRefreshMs: 60 * 60_000 });
    for (let i = 0; i < 5; i++) await s.rig.join(`viewer-${i}`, "viewer", leafCaps());
    most = 0;
    await s.rig.advance(61 * 60_000);
    assert.ok(most >= 5, `${most} at once`);
  });

  it("backs off for the whole room when mints bring no TURN: 30 s, doubling; welcomes meanwhile get STUN without a mint, and are given TURN once it works", async () => {
    minted = 0;
    let broken = false;
    let start = 0;
    let clock = () => 0;
    const asked: string[] = [];
    const ice = async (want?: { turn?: boolean }): Promise<IceServer[]> => {
      asked.push(`${Math.round((clock() - start) / 1000)}:${want?.turn === false ? "stun" : "mint"}`);
      return broken || want?.turn === false ? [{ urls: ["stun:stun.example.org:3478"] }] : turn();
    };
    const s = await session({ iceServers: ice, iceRefreshMs: 60 * 60_000 });
    clock = () => s.rig.now;
    start = s.rig.now;
    broken = true;
    asked.length = 0;
    const first = await s.join("first", false);
    assert.deepEqual(of(first.heard, "welcome")[0].ice.map((server) => server.urls[0]), ["stun:stun.example.org:3478"], "its welcome had no TURN");
    await s.rig.advance(5_000);
    const second = await s.join("second", false);
    await s.rig.advance(100_000);
    // One mint fails (at 0 s), the room waits 30 s; the welcome at 5 s does not mint; the retry
    // at 30 s fails, the next waits 60 s (at 90 s) and fails, then 120 s.
    assert.deepEqual(asked, ["0:mint", "5:stun", "30:mint", "30:mint", "90:mint", "90:mint"]);
    broken = false;
    await s.rig.advance(200_000);
    for (const who of [first, second]) {
      const grants = of(s.rig.take(who.conn), "grant").filter((message) => message.ice);
      assert.equal(grants.length, 1, "given TURN once it works, not before");
    }
  });

  it("does not send ICE servers with no TURN in them: they would take the relay away from links that need it", async () => {
    minted = 0;
    let broken = false;
    const s = await session({ iceServers: async () => (broken ? [{ urls: ["stun:stun.example.org:3478"] }] : turn()), iceRefreshMs: 60 * 60_000 });
    const viewer = await s.join("viewer", false);
    broken = true;
    await s.rig.advance(61 * 60_000);
    assert.equal(of(s.rig.take(viewer.conn), "grant").filter((message) => message.ice).length, 0);
    broken = false;
    await s.rig.advance(2 * 60_000);
    assert.equal(of(s.rig.take(viewer.conn), "grant").filter((message) => message.ice).length, 1, "tried again a minute later");
  });

  it("never refreshes without TURN (no `iceRefreshMs`), and never keeps credentials beside the socket", async () => {
    minted = 0;
    const s = await session({ iceServers: turn });
    const viewer = await s.join("viewer", false);
    await s.rig.advance(8 * 3_600_000);
    assert.equal(of(s.rig.take(viewer.conn), "grant").filter((message) => message.ice).length, 0);
    const kept = [...s.rig.attachments.values(), ...s.rig.stored.values(), JSON.stringify(s.rig.core.snapshot())].join("\n");
    assert.ok(!/secret-\d|user-\d/.test(kept), "no credentials in attachments, storage or /tree");
  });

  it("old peers and coordinators: `turn` in status and `ice` in grant are optional, and ignored where unknown", () => {
    const withTurn = decodeClientMessage(JSON.stringify(status("p", 1, 0, { turn: true }))) as ClientMessageOf<"status">;
    assert.equal(withTurn.turn, true);
    assert.equal((decodeClientMessage(JSON.stringify(status("p", 1, 0))) as ClientMessageOf<"status">).turn, undefined);
    assert.deepEqual(decodeServerMessage(encodeServerMessage({ t: "grant", grant: "g" })), { t: "grant", grant: "g" });
    const ice = [{ urls: ["turn:t.example.org:3478"], username: "u", credential: "c" }];
    assert.deepEqual(decodeServerMessage(encodeServerMessage({ t: "grant", grant: "g", ice })), { t: "grant", grant: "g", ice });
  });
});

describe("coordinator: Cloudflare's TURN servers (SPEC §6.7 [D82])", () => {
  it("mints with the key, trimmed, under a 3 s timeout, and says why when it gets none", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answer = (status: number, body: unknown): typeof fetch => async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    };
    assert.deepEqual(await mintTurn(undefined, "t", 60, answer(200, {})), { servers: [], problem: "TURN key not configured" });
    assert.equal(calls.length, 0);
    const good = { iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" }] };
    assert.deepEqual(await mintTurn("key-id\n", " token\n", 60, answer(201, good)), { servers: good.iceServers, problem: null });
    assert.equal(calls[0].url, "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer token");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ttl: 60 });
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.equal((await mintTurn("k", "t", 60, answer(404, { errors: [] }))).problem, "HTTP 404");
    assert.equal((await mintTurn("k", "t", 60, answer(200, "<html>"))).problem, "an answer that is not JSON");
    assert.equal((await mintTurn("k", "t", 60, answer(200, { iceServers: [] }))).problem, "no TURN servers in the answer");
    const timeout: typeof fetch = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    assert.equal((await mintTurn("k", "t", 60, timeout)).problem, "no answer in 3 s");
  });

  it("keeps TURN URLs only, none on port 53, with their credentials; takes the older one-object answer too", () => {
    const answer = {
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"],
          username: "u",
          credential: "c",
        },
      ],
    };
    assert.deepEqual(turnFrom(answer), [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" }]);
    assert.deepEqual(turnFrom({ iceServers: { urls: "turn:t.example.org:3478", username: "u", credential: "c" } }), [{ urls: ["turn:t.example.org:3478"], username: "u", credential: "c" }]);
    assert.deepEqual(turnFrom({ iceServers: [{ urls: ["turn:t.example.org:3478"] }] }), [], "no credentials: no use");
    assert.deepEqual(turnFrom(null), []);
  });
});
