/**
 * The coordinator's contract, written against a URL (PLAN K3, K4; SPEC §6, D8): one suite that
 * every entry point must pass, so the Node server the harness uses and the Durable Object that
 * runs in production cannot behave differently. Run by ./contract.node.test.ts and
 * ./contract.worker.test.ts; not a test file itself.
 *
 * Everything goes over real sockets and real HTTP: tickets signed as Meetly's server signs them,
 * a real `CoordinatorClient` where the browser's client is what is under test.
 *
 * Owner: E-coordinator.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PARAMS, decodeServerMessage, encodeClientMessage, importGrantPublicKey, verifyGrant } from "../protocol";
import type { Capabilities, ClientMessage, MetricsSample, PeerId, ServerMessage, ServerMessageOf } from "../protocol";
import type { Cancel, Clock } from "../runtime";
import { CoordinatorError, createClient } from "./client";
import { SERVER_SECRET, STREAMS, leafCaps, relayCaps, ticketFor } from "./testkit";
import type { CoordinatorClient, RoomSnapshot, RoomStats } from "./types";

/** An entry point under test. */
export type ContractTarget = {
  /** "http://127.0.0.1:4260": the coordinator's origin. */
  url: string;
  /** The audience limit it was started with. */
  viewerCap: number;
  /** Drop everything without a goodbye and stop answering, keeping what it stored. */
  kill(): Promise<void>;
  /** Come back after `kill`, with what was stored. */
  restart(): Promise<void>;
  /**
   * Throw away the coordinator's memory while its sockets stay open, as a Durable Object's
   * eviction does. Absent where the entry point has no such thing (a Node process).
   */
  evict?: (room: string) => Promise<void>;
};

/** This machine's clock and timers, for the client under test. */
export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout(callback, ms): Cancel {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  setInterval(callback, ms): Cancel {
    const timer = setInterval(callback, ms);
    return () => clearInterval(timer);
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let rooms = 0;
/** A fresh session for each test: nothing one test does can be seen by another. */
const freshRoom = () => `contract-${process.pid.toString(36)}-${Date.now().toString(36)}-${(rooms++).toString(36)}`;

const sample = (peer: PeerId): MetricsSample => ({ peer, seq: 0, at: 1000, intervalMs: 2000, role: "leaf", depth: 1, playoutDelayMs: 60, events: [] });

/** One raw WebSocket to the coordinator, with what it has been sent so far. */
class Socket {
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly waiters = new Set<() => void>();
  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      this.messages.push(decodeServerMessage(event.data));
      for (const wake of [...this.waiters]) wake();
    });
    this.closed = new Promise((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
    void this.closed.then(() => {
      for (const wake of [...this.waiters]) wake();
    });
  }

  static open(target: ContractTarget, room: string, ticket: string): Socket {
    const url = `${target.url.replace(/^http/, "ws")}/overlay/v1/rooms/${encodeURIComponent(room)}/ws?ticket=${encodeURIComponent(ticket)}`;
    return new Socket(new WebSocket(url));
  }

  /** Opens with a fresh ticket and says hello; resolves with the welcome. */
  static async join(target: ContractTarget, room: string, identity: string, role: "source" | "viewer" = "viewer", caps: Capabilities = relayCaps()): Promise<{ socket: Socket; welcome: ServerMessageOf<"welcome"> }> {
    const socket = Socket.open(target, room, await ticketFor(identity, role, Date.now(), { room }));
    await socket.opened();
    socket.send({ t: "hello", v: 1, caps });
    return { socket, welcome: await socket.next("welcome") };
  }

  opened(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("close", (event) => reject(new Error(`closed before open: ${event.code} ${event.reason}`)), { once: true });
    });
  }

  send(message: ClientMessage | string): void {
    this.ws.send(typeof message === "string" ? message : encodeClientMessage(message));
  }

  /** The first message of type `t` not yet taken, waiting up to `ms` for it. */
  async next<T extends ServerMessage["t"]>(t: T, ms = 5_000): Promise<ServerMessageOf<T>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const index = this.messages.findIndex((message) => message.t === t);
      if (index >= 0) return this.messages.splice(index, 1)[0] as ServerMessageOf<T>;
      if (this.ws.readyState === WebSocket.CLOSED) throw new Error(`no ${t}: socket closed (${JSON.stringify(this.messages)})`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${t} within ${ms} ms (have ${JSON.stringify(this.messages.map((m) => m.t))})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.waiters.add(done);
      }).finally(() => this.waiters.clear());
    }
  }

  /** Waits for whatever arrives within `ms`, and hands it over. */
  async drain(ms = 300): Promise<ServerMessage[]> {
    await sleep(ms);
    return this.messages.splice(0);
  }

  close(): void {
    this.ws.close(1000);
  }
}

async function api(target: ContractTarget, method: "GET" | "POST", room: string, path: string, body?: unknown, bearer: string | null = SERVER_SECRET): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${target.url}/overlay/v1/rooms/${encodeURIComponent(room)}${path}`, {
    method,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const status = (parent: PeerId | null, depth: number, free: number): ClientMessage => ({
  t: "status",
  depth,
  links: parent === null ? [] : [{ stream: 0, stripe: 0, parent, backup: null }],
  children: 0,
  standby: 0,
  free,
  caps: relayCaps({ uplinkKbps: 20_000 }),
  lossPct: 0,
  rttMs: 10,
});

function clientFor(target: ContractTarget, room: string, identity: string, role: "source" | "viewer" = "viewer"): CoordinatorClient {
  return createClient({
    url: `${target.url.replace(/^http/, "ws")}/overlay/v1/rooms/${encodeURIComponent(room)}/ws`,
    ticket: () => ticketFor(identity, role, Date.now(), { room }),
    clock: realClock,
    connectTimeoutMs: 3_000,
    maxBackoffMs: 1_000,
  });
}

/**
 * The whole suite against one entry point. `get` is called inside the tests, so the target may
 * be started by the caller's `before`.
 */
export function coordinatorContract(name: string, get: () => ContractTarget): void {
  describe(`coordinator contract: ${name}`, () => {
    it("answers health, refuses unknown paths, and wants an upgrade on /ws", async () => {
      const target = get();
      const health = await fetch(`${target.url}/overlay/v1/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
      assert.equal((await fetch(`${target.url}/elsewhere`)).status, 404);
      assert.equal((await api(target, "GET", freshRoom(), "/ws")).status, 426);
    });

    it("serves the HTTP API to Meetly's server only (SPEC §6.2)", async () => {
      const target = get();
      const room = freshRoom();
      assert.equal((await api(target, "GET", room, "/stats", undefined, null)).status, 401);
      assert.equal((await api(target, "GET", room, "/stats", undefined, "wrong")).status, 401);
      const stats = await api(target, "GET", room, "/stats");
      assert.equal(stats.status, 200);
      assert.deepEqual(stats.body, { viewers: 0, relays: 0, maxDepth: 0, started: false, ended: false } satisfies RoomStats);
      assert.equal((await api(target, "POST", room, "/stats", {})).status, 405);
      assert.equal((await api(target, "GET", room, "/nothing")).status, 404);
    });

    it("closes with 4001 for a ticket of another secret, another room, an expired one, and a used one (D9)", async () => {
      const target = get();
      const room = freshRoom();
      const bad = [
        await ticketFor("ana", "viewer", Date.now(), { room, secret: "not-the-secret" }),
        await ticketFor("ana", "viewer", Date.now(), { room: `${room}-other` }),
        await ticketFor("ana", "viewer", Date.now(), { room, exp: Math.floor(Date.now() / 1000) - 1 }),
        "nonsense",
      ];
      for (const ticket of bad) assert.equal((await Socket.open(target, room, ticket).closed).code, 4001);
      const ticket = await ticketFor("ana", "viewer", Date.now(), { room });
      const first = Socket.open(target, room, ticket);
      await first.opened();
      first.send({ t: "hello", v: 1, caps: leafCaps() });
      await first.next("welcome");
      assert.equal((await Socket.open(target, room, ticket).closed).code, 4001, "a ticket is used once");
      first.close();
    });

    it("welcomes with a grant any peer can check, the session clock and the parameters (SPEC §6.3, §6.5)", async () => {
      const target = get();
      const room = freshRoom();
      const { socket, welcome } = await Socket.join(target, room, "host", "source");
      assert.equal(welcome.room, room);
      assert.equal(welcome.role, "source");
      assert.deepEqual(welcome.params, DEFAULT_PARAMS);
      const grant = await verifyGrant(welcome.grant, await importGrantPublicKey(welcome.key.pub), { room, now: Date.now(), peer: welcome.peer });
      assert.ok(grant, "the grant verifies with welcome.key");
      assert.equal(grant.role, "source");
      assert.ok(grant.scope.includes("publish:0") && grant.exp - grant.iat === 600);
      assert.ok(Math.abs(welcome.epochMs - Date.now()) < 10_000);
      socket.send({ t: "time", t0: 123.5 });
      const time = await socket.next("time");
      assert.equal(time.t0, 123.5);
      assert.ok(Math.abs(time.t1 - (Date.now() - welcome.epochMs)) < 1_000);
      socket.close();
    });

    it("answers garbage with error bad-message, and anything before hello too", async () => {
      const target = get();
      const room = freshRoom();
      const socket = Socket.open(target, room, await ticketFor("ana", "viewer", Date.now(), { room }));
      await socket.opened();
      socket.send({ t: "time", t0: 1 });
      assert.equal((await socket.next("error")).code, "bad-message");
      socket.send("{ not json");
      assert.equal((await socket.next("error")).code, "bad-message");
      socket.send({ t: "hello", v: 1, caps: leafCaps() });
      await socket.next("welcome");
      socket.send(JSON.stringify({ t: "need", id: "x" }));
      assert.equal((await socket.next("error")).code, "bad-message");
      socket.close();
    });

    it("refuses viewers beyond the cap with 4002, but never the source (SPEC §6.1)", async () => {
      const target = get();
      const room = freshRoom();
      const viewers: Socket[] = [];
      for (let i = 0; i < target.viewerCap; i++) viewers.push((await Socket.join(target, room, `v${i}`, "viewer", leafCaps())).socket);
      const over = Socket.open(target, room, await ticketFor("one-too-many", "viewer", Date.now(), { room }));
      assert.equal((await over.closed).code, 4002);
      const { socket: source, welcome } = await Socket.join(target, room, "host", "source");
      assert.equal(welcome.role, "source");
      for (const socket of [...viewers, source]) socket.close();
    });

    it("places a joiner, and relays signalling only between peers it introduced (SPEC §6.4, D10)", async () => {
      const target = get();
      const room = freshRoom();
      const { socket: source, welcome: hostWelcome } = await Socket.join(target, room, "host", "source", relayCaps({ uplinkKbps: 50_000 }));
      source.send({ t: "streams", streams: STREAMS });
      source.send(status(null, 0, 3));
      await sleep(100);
      const { socket: ana, welcome: anaWelcome } = await Socket.join(target, room, "ana", "viewer", leafCaps());
      assert.deepEqual(
        anaWelcome.assign.map((assignment) => [assignment.stream, assignment.parents[0]?.peer]),
        [
          [0, hostWelcome.peer],
          [1, hostWelcome.peer],
        ],
      );
      assert.deepEqual(anaWelcome.streams, STREAMS);
      // ana and the source were introduced: both ways.
      ana.send({ t: "signal", to: hostWelcome.peer, data: { sdp: { type: "offer", sdp: "v=0" } } });
      const toHost = await source.next("signal");
      assert.deepEqual(toHost, { t: "signal", from: anaWelcome.peer, data: { sdp: { type: "offer", sdp: "v=0" } } });
      source.send({ t: "signal", to: anaWelcome.peer, data: { candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 } } });
      assert.equal((await ana.next("signal")).from, hostWelcome.peer);
      // bob is a leaf too, and nobody named the two to each other.
      const { socket: bob, welcome: bobWelcome } = await Socket.join(target, room, "bob", "viewer", leafCaps());
      ana.send({ t: "signal", to: bobWelcome.peer, data: { sdp: { type: "offer", sdp: "v=0" } } });
      assert.equal((await ana.next("error")).code, "denied");
      assert.ok(!(await bob.drain(200)).some((message) => message.t === "signal"));
      // need is answered, with its id.
      ana.send({ t: "need", id: 41, stream: 0, stripe: 0, want: "backup", exclude: [] });
      const answer = await ana.next("assign");
      assert.equal(answer.id, 41);
      for (const socket of [source, ana, bob]) socket.close();
    });

    it("builds its map from status, and reports it on /tree and /stats (SPEC §6.6, D12)", async () => {
      const target = get();
      const room = freshRoom();
      const { socket: source, welcome: host } = await Socket.join(target, room, "host", "source", relayCaps({ uplinkKbps: 50_000 }));
      source.send({ t: "streams", streams: STREAMS });
      source.send(status(null, 0, 2));
      const { socket: ana, welcome } = await Socket.join(target, room, "ana", "viewer", leafCaps());
      ana.send(status(host.peer, 1, 0));
      ana.send({ t: "metrics", sample: sample(welcome.peer) });
      await sleep(200);
      const tree = (await api(target, "GET", room, "/tree")).body as RoomSnapshot;
      assert.equal(tree.source, host.peer);
      const record = tree.peers.find((peer) => peer.peer === welcome.peer);
      assert.deepEqual([record?.depth, record?.links[0]?.parent, record?.role], [1, host.peer, "leaf"]);
      assert.deepEqual((await api(target, "GET", room, "/stats")).body, { viewers: 1, relays: 0, maxDepth: 1, started: true, ended: false });
      const metrics = (await api(target, "GET", room, "/metrics")).body as { samples: MetricsSample[] };
      assert.deepEqual(metrics.samples, [sample(welcome.peer)]);
      for (const socket of [source, ana]) socket.close();
    });

    it("gives a returning peer its PeerId back, and closes the older socket with 4006", async () => {
      const target = get();
      const room = freshRoom();
      const { socket: first, welcome } = await Socket.join(target, room, "ana", "viewer", leafCaps());
      const again = Socket.open(target, room, await ticketFor("ana", "viewer", Date.now(), { room }));
      await again.opened();
      again.send({ t: "hello", v: 1, caps: leafCaps(), resume: { peer: welcome.peer, grant: welcome.grant } });
      assert.equal((await again.next("welcome")).peer, welcome.peer);
      assert.equal((await first.closed).code, 4006);
      again.close();
    });

    it("kicks with 4003 and keeps the door shut; ends with 4004 for everyone (SPEC §6.2)", async () => {
      const target = get();
      const room = freshRoom();
      const { socket: source } = await Socket.join(target, room, "host", "source");
      const { socket: ana } = await Socket.join(target, room, "ana", "viewer", leafCaps());
      const { socket: bob } = await Socket.join(target, room, "bob", "viewer", leafCaps());
      assert.equal((await api(target, "POST", room, "/kick", { identity: "ana", reason: "spam" })).status, 200);
      assert.equal((await ana.next("kick")).reason, "spam");
      assert.equal((await ana.closed).code, 4003);
      assert.equal((await Socket.open(target, room, await ticketFor("ana", "viewer", Date.now(), { room })).closed).code, 4003);
      assert.equal((await api(target, "POST", room, "/end", { reason: "ended" })).status, 200);
      for (const socket of [source, bob]) {
        assert.equal((await socket.next("end")).reason, "ended");
        assert.equal((await socket.closed).code, 4004);
      }
      assert.equal((await Socket.open(target, room, await ticketFor("carl", "viewer", Date.now(), { room })).closed).code, 4004);
      assert.equal(((await api(target, "GET", room, "/stats")).body as RoomStats).ended, true);
    });

    it("the client: a session clock within 5 ms of the coordinator's, on loopback (SPEC §4.1)", async () => {
      const target = get();
      const room = freshRoom();
      const client = clientFor(target, room, "ana");
      const welcome = await client.connect(leafCaps());
      await sleep(700);
      const errors: number[] = [];
      for (let i = 0; i < 5; i++) {
        errors.push(Math.abs(client.sessionClock.now() - (Date.now() - welcome.epochMs)));
        await sleep(20);
      }
      console.log(`      clock error ${Math.max(...errors).toFixed(2)} ms at most, uncertainty ${client.sessionClock.uncertaintyMs.toFixed(2)} ms`);
      assert.ok(client.sessionClock.uncertaintyMs < 5, `uncertainty ${client.sessionClock.uncertaintyMs} ms`);
      assert.ok(Math.max(...errors) < 5, `clock error ${errors.map((e) => e.toFixed(2)).join(", ")} ms`);
      client.close();
    });

    it("the client: comes back with the same PeerId within 3 s of a restart, raising offline once; a joiner meanwhile is refused cleanly", async () => {
      const target = get();
      const room = freshRoom();
      const client = clientFor(target, room, "ana");
      const welcome = await client.connect(leafCaps());
      let offline = 0;
      const welcomes: ServerMessageOf<"welcome">[] = [];
      client.on("offline", () => offline++);
      client.on("welcome", (again) => welcomes.push(again));
      await target.kill();
      await sleep(300);
      assert.equal(client.connected, false);
      assert.equal(offline, 1);
      assert.equal(await client.need(0, 0, "parent", []), null, "need answers null while the coordinator is away");

      // SPEC §7.5: only joining needs the coordinator. A joiner now is told so, promptly, and nothing else breaks.
      const joiner = clientFor(target, room, "late");
      const started = Date.now();
      const refusal = await joiner.connect(leafCaps()).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refusal instanceof CoordinatorError && refusal.reason === "unreachable", String(refusal));
      const refusedIn = Date.now() - started;
      assert.ok(refusedIn < 3_500, `refused after ${refusedIn} ms`);

      await target.restart();
      const up = Date.now();
      while (!client.connected && Date.now() - up < 5_000) await sleep(25);
      const took = Date.now() - up;
      console.log(`      reconnected ${took} ms after the restart; the joiner was refused in ${refusedIn} ms`);
      assert.ok(client.connected, "reconnected");
      assert.ok(took < 3_000, `reconnected ${took} ms after the restart`);
      assert.equal(welcomes.at(-1)?.peer, welcome.peer, "the same PeerId");
      assert.equal(welcomes.at(-1)?.epochMs, welcome.epochMs, "the same session clock");
      assert.equal(offline, 1);
      // And a new joiner is let in again.
      const now = clientFor(target, room, "later");
      assert.ok((await now.connect(leafCaps())).peer);
      for (const c of [client, now]) c.close();
    });

    it("survives losing its memory with its sockets open: they stay, and the map returns from status (SPEC §6.7)", async (t) => {
      const target = get();
      if (!target.evict) return t.skip("this entry point keeps no sockets across a restart");
      const room = freshRoom();
      const { socket: source, welcome: host } = await Socket.join(target, room, "host", "source", relayCaps({ uplinkKbps: 50_000 }));
      source.send({ t: "streams", streams: STREAMS });
      source.send(status(null, 0, 2));
      const { socket: ana, welcome } = await Socket.join(target, room, "ana", "viewer", leafCaps());
      ana.send(status(host.peer, 1, 0));
      await sleep(200);
      const before = (await api(target, "GET", room, "/tree")).body as RoomSnapshot;
      await target.evict(room);
      // Who is who came back with the sockets; where they are did not.
      const woken = (await api(target, "GET", room, "/tree")).body as RoomSnapshot;
      assert.equal(woken.startedAt, before.startedAt);
      assert.deepEqual(woken.peers.map((peer) => peer.peer).sort(), before.peers.map((peer) => peer.peer).sort());
      assert.ok(woken.peers.every((peer) => peer.links.length === 0));
      // The sockets are still open and still answered.
      ana.send({ t: "time", t0: 7 });
      assert.equal((await ana.next("time")).t0, 7);
      source.send({ t: "streams", streams: STREAMS });
      source.send(status(null, 0, 2));
      ana.send(status(host.peer, 1, 0));
      await sleep(200);
      const after = (await api(target, "GET", room, "/tree")).body as RoomSnapshot;
      assert.deepEqual(after.peers.find((peer) => peer.peer === welcome.peer)?.links[0]?.parent, host.peer);
      // Introductions (D10) are soft state too: lost with the memory, and made again by the next answer. The source is ana's parent, so it comes as a parent, not a backup.
      ana.send({ t: "need", id: 2, stream: 0, stripe: 0, want: "parent", exclude: [] });
      await ana.next("assign");
      ana.send({ t: "signal", to: host.peer, data: { sdp: { type: "offer", sdp: "v=0" } } });
      assert.equal((await source.next("signal")).from, welcome.peer);
      for (const socket of [source, ana]) socket.close();
    });
  });
}
