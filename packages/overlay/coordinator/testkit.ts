/**
 * What the coordinator's tests share: a core with its effects carried out in memory, a clock
 * that is stepped by hand, and a swarm of simulated peers that do what real ones would with the
 * coordinator's messages. Not used outside tests.
 *
 * Owner: E-coordinator.
 */
import { DEFAULT_PARAMS, encodeClientMessage, signTicket } from "../protocol";
import type { Assignment, Capabilities, ClientMessage, OverlayRole, PeerId, ServerMessage, ServerMessageOf, StreamConfig, Ticket } from "../protocol";
import type { Cancel, Clock } from "../runtime";
import { createCore } from "./core";
import type { ConnId, CoordinatorCore, CoordinatorCoreOptions, CoreResponse, Effect } from "./types";

export const ROOM = "abc-defg-hij";
export const ADMISSION_SECRET = "admission-secret-for-tests";
export const SERVER_SECRET = "server-secret-for-tests";

/** A desktop Chromium on mains power behind a friendly NAT: what may relay (SPEC §8.1). */
export const relayCaps = (over: Partial<Capabilities> = {}): Capabilities => ({
  browser: "chromium",
  desktop: true,
  onPower: true,
  nat: "cone",
  uplinkKbps: null,
  cores: 8,
  decode: ["vp8", "opus"],
  dataSaver: false,
  visible: true,
  ...over,
});

/** A phone: never a relay. */
export const leafCaps = (over: Partial<Capabilities> = {}): Capabilities => relayCaps({ browser: "safari", desktop: false, onPower: false, nat: "symmetric", ...over });

export const STREAMS: StreamConfig[] = [
  { id: 0, kind: "video", configId: 0, codec: "vp8", bitrateKbps: 1200, width: 1280, height: 720, fps: 30, scalability: "L1T3", keyIntervalFrames: 60, stripes: [{ index: 0, kind: "data", temporal: [0, 1, 2] }], sframe: false },
  { id: 1, kind: "audio", configId: 0, codec: "opus", bitrateKbps: 32, sampleRate: 48000, channels: 1, frameUs: 20000, stripes: [{ index: 0, kind: "data", temporal: [0] }], sframe: false },
];

let nonces = 0;

export function ticketFor(identity: string, role: "source" | "viewer", now: number, over: Partial<Ticket> & { secret?: string } = {}): Promise<string> {
  const { secret, ...fields } = over;
  return signTicket({ v: 1, room: ROOM, identity, name: identity, role, exp: Math.floor(now / 1000) + 60, nonce: `nonce-${(nonces++).toString(36).padStart(6, "0")}`, ...fields }, secret ?? ADMISSION_SECRET);
}

export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/* ------------------------------ a core, driven directly ------------------------------ */

/** A `CoordinatorCore` with its effects carried out in memory, and the time in the test's hands. */
export class Rig {
  readonly core: CoordinatorCore;
  now: number;
  /** Messages sent to each socket and not yet looked at. */
  readonly inbox = new Map<ConnId, ServerMessage[]>();
  readonly closes = new Map<ConnId, { code: number; reason: string }>();
  readonly stored: Map<string, string>;
  readonly attachments = new Map<ConnId, string>();
  wakeAt: number | null = null;
  readonly options: CoordinatorCoreOptions;
  private conns = 0;

  constructor(over: Partial<CoordinatorCoreOptions> = {}, from?: { now: number; stored: Map<string, string> }) {
    this.now = from?.now ?? 1_700_000_000_000;
    this.stored = from?.stored ?? new Map();
    this.options = {
      room: ROOM,
      admissionSecret: ADMISSION_SECRET,
      serverSecret: SERVER_SECRET,
      params: DEFAULT_PARAMS,
      viewerCap: 10_000,
      iceServers: async () => [{ urls: ["stun:stun.example.org:3478"] }],
      random: seeded(7),
      ...over,
    };
    this.core = createCore(this.options);
  }

  apply(effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.type === "send") {
        // What goes on the wire is what a peer would get: encode it, as an entry point does.
        const message = JSON.parse(JSON.stringify(effect.message)) as ServerMessage;
        const list = this.inbox.get(effect.conn);
        if (list) list.push(message);
        else this.inbox.set(effect.conn, [message]);
      } else if (effect.type === "close") {
        this.closes.set(effect.conn, { code: effect.code, reason: effect.reason });
        this.attachments.delete(effect.conn);
      } else if (effect.type === "wake") this.wakeAt = effect.at;
      else if (effect.type === "persist") {
        if (effect.value === null) this.stored.delete(effect.key);
        else this.stored.set(effect.key, effect.value);
      } else this.attachments.set(effect.conn, effect.value);
    }
  }

  /** Opens a socket with a fresh ticket. Look in `closes` to see whether it was let in. */
  async open(identity: string, role: "source" | "viewer" = "viewer", over: Partial<Ticket> & { secret?: string; region?: string } = {}): Promise<ConnId> {
    const { region, ...ticket } = over;
    return this.openWith(await ticketFor(identity, role, this.now, ticket), region);
  }

  async openWith(ticket: string, region?: string): Promise<ConnId> {
    const conn = `conn-${++this.conns}`;
    this.apply(await this.core.open(conn, ticket, region ? { region } : {}, this.now));
    return conn;
  }

  /** Sends one message (or raw text) and returns what came back on that socket. */
  async say(conn: ConnId, message: ClientMessage | string): Promise<ServerMessage[]> {
    this.apply(await this.core.message(conn, typeof message === "string" ? message : encodeClientMessage(message), this.now));
    return this.take(conn);
  }

  take(conn: ConnId): ServerMessage[] {
    const list = this.inbox.get(conn) ?? [];
    this.inbox.delete(conn);
    return list;
  }

  async join(identity: string, role: "source" | "viewer" = "viewer", caps: Capabilities = relayCaps(), resume?: { peer: PeerId; grant: string }): Promise<{ conn: ConnId; welcome: ServerMessageOf<"welcome">; peer: PeerId }> {
    const conn = await this.open(identity, role);
    const answers = await this.say(conn, { t: "hello", v: 1, caps, ...(resume ? { resume } : {}) });
    const welcome = answers.find((message): message is ServerMessageOf<"welcome"> => message.t === "welcome");
    if (!welcome) throw new Error(`no welcome for ${identity}: ${JSON.stringify(answers)} ${JSON.stringify(this.closes.get(conn))}`);
    this.inbox.set(conn, answers.filter((message) => message !== welcome));
    return { conn, welcome, peer: welcome.peer };
  }

  async drop(conn: ConnId): Promise<void> {
    this.attachments.delete(conn);
    this.apply(await this.core.closed(conn, this.now));
  }

  /** Lets time pass, waking the core whenever it asked to be. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    while (this.wakeAt !== null && this.wakeAt <= end) {
      this.now = Math.max(this.now, this.wakeAt);
      this.wakeAt = null;
      this.apply(await this.core.tick(this.now));
    }
    this.now = end;
  }

  async http(method: "GET" | "POST", path: string, body: unknown = null, bearer: string | null = SERVER_SECRET): Promise<CoreResponse> {
    const { response, effects } = await this.core.http({ method, path, bearer, body }, this.now);
    this.apply(effects);
    return response;
  }

  /**
   * The coordinator loses its memory, as a Durable Object does when it is evicted: a new core,
   * given back only what was stored and what was attached to the sockets still open.
   */
  async evicted(over: Partial<CoordinatorCoreOptions> = {}): Promise<Rig> {
    const next = new Rig({ ...this.options, ...over }, { now: this.now, stored: this.stored });
    next.conns = this.conns;
    for (const [conn, value] of this.attachments) next.attachments.set(conn, value);
    next.apply(await next.core.restore(Object.fromEntries(this.stored), [...this.attachments].map(([conn, attachment]) => ({ conn, attachment })), next.now));
    return next;
  }
}

/* ------------------------------ a clock stepped by hand ------------------------------ */

export class FakeClock implements Clock {
  private at = 5_000;
  private next = 1;
  private timers = new Map<number, { due: number; every: number | null; run: () => void }>();

  now(): number {
    return this.at;
  }

  setTimeout(callback: () => void, ms: number): Cancel {
    const id = this.next++;
    this.timers.set(id, { due: this.at + Math.max(0, ms), every: null, run: callback });
    return () => void this.timers.delete(id);
  }

  setInterval(callback: () => void, ms: number): Cancel {
    const id = this.next++;
    this.timers.set(id, { due: this.at + ms, every: Math.max(1, ms), run: callback });
    return () => void this.timers.delete(id);
  }

  /** Runs every timer that falls due within `ms`, in order, at its own time. */
  advance(ms: number): void {
    const end = this.at + ms;
    for (;;) {
      let first: [number, { due: number; every: number | null; run: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].due <= end && (!first || entry[1].due < first[1].due)) first = entry;
      if (!first) break;
      const [id, timer] = first;
      this.at = Math.max(this.at, timer.due);
      if (timer.every === null) this.timers.delete(id);
      else timer.due += timer.every;
      timer.run();
    }
    this.at = end;
  }

  /** Moves this clock without running anything: for giving a peer a clock that disagrees with the coordinator's. */
  skew(ms: number): void {
    this.at += ms;
  }
}

/* ------------------------------ simulated peers ------------------------------ */

export type SimPeer = {
  conn: ConnId;
  peer: PeerId;
  capable: boolean;
  role: OverlayRole;
  caps: Capabilities;
  parent: PeerId | null;
  backup: PeerId | null;
  depth: number;
  kids: Set<PeerId>;
  joinedAt: number;
  statusAt: number;
  dirty: boolean;
  alive: boolean;
};

/**
 * Peers that do what the topology module will: take the first parent offered that has room,
 * keep the first backup, say where they are in `status` when it changes and every `statusMs`,
 * measure their uplink once they have been in the tree past probation, and obey `role` and
 * `assign` "move". Driven through the core's real messages, one simulated second at a time.
 */
export class Swarm {
  readonly peers = new Map<PeerId, SimPeer>();
  source: SimPeer | null = null;
  /** Times a peer was sent to a parent that, in truth, had no slot left. */
  offeredBeyondFree = 0;
  /** Of the placements that came with a parent: how many had a first backup clear of the first parent. */
  backupsApart = 0;
  placements = 0;
  moves = 0;
  private count = 0;

  constructor(
    readonly rig: Rig,
    readonly streams: StreamConfig[] = STREAMS,
  ) {}

  private fanout(peer: SimPeer): number {
    return peer.role === "source" ? this.rig.options.params.sourceFanout : peer.role === "relay" ? this.rig.options.params.maxFanout : 0;
  }

  path(peer: PeerId | null): PeerId[] {
    const out: PeerId[] = [];
    for (let at = peer; at !== null && out.length < 64; at = this.peers.get(at)?.parent ?? null) out.push(at);
    return out;
  }

  async addSource(): Promise<SimPeer> {
    const { conn, peer } = await this.rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
    const sim: SimPeer = { conn, peer, capable: true, role: "source", caps: relayCaps({ uplinkKbps: 50_000 }), parent: null, backup: null, depth: 0, kids: new Set(), joinedAt: this.rig.now, statusAt: 0, dirty: true, alive: true };
    this.peers.set(peer, sim);
    this.source = sim;
    await this.rig.say(conn, { t: "streams", streams: this.streams });
    await this.flush();
    return sim;
  }

  async addViewer(capable: boolean): Promise<SimPeer> {
    const caps = capable ? relayCaps() : leafCaps();
    const { conn, peer, welcome } = await this.rig.join(`viewer-${this.count++}`, "viewer", caps);
    const sim: SimPeer = { conn, peer, capable, role: "leaf", caps, parent: null, backup: null, depth: 255, kids: new Set(), joinedAt: this.rig.now, statusAt: 0, dirty: false, alive: true };
    this.peers.set(peer, sim);
    this.onAssign(sim, welcome.assign, "join");
    return sim;
  }

  private redepth(peer: SimPeer, depth: number): void {
    peer.depth = depth;
    peer.dirty = true;
    for (const kid of peer.kids) this.redepth(this.peers.get(kid)!, depth + 1);
  }

  private onAssign(peer: SimPeer, assign: Assignment[], reason: "join" | "need" | "rebalance" | "move"): void {
    const first = assign[0];
    if (!first || first.parents.length === 0) return;
    if (reason === "rebalance") return;
    if (reason === "join" && peer.parent !== null) return;
    // PLAN K2: "the first backup's path avoids the first parent", for each placement that offers
    // a backup at all. A "move" offers none: the peer keeps the backup it has.
    if (reason !== "move") {
      this.placements++;
      const clear = first.backups[0] !== undefined && !this.path(first.backups[0].peer).includes(first.parents[0].peer);
      if (clear) this.backupsApart++;
    }
    const offered = this.peers.get(first.parents[0].peer);
    if (!offered || offered.kids.size >= this.fanout(offered)) this.offeredBeyondFree++;
    const parent = first.parents.map((hint) => this.peers.get(hint.peer)).find((candidate) => candidate && candidate.alive && candidate.kids.size < this.fanout(candidate) && !this.path(candidate.peer).includes(peer.peer));
    if (!parent) return;
    if (peer.parent !== null) {
      const old = this.peers.get(peer.parent);
      old?.kids.delete(peer.peer);
      if (old) old.dirty = true;
      this.moves++;
    }
    peer.parent = parent.peer;
    peer.backup = first.backups[0]?.peer ?? peer.backup;
    parent.kids.add(peer.peer);
    parent.dirty = true;
    this.redepth(peer, parent.depth + 1);
  }

  private async status(peer: SimPeer): Promise<void> {
    peer.dirty = false;
    peer.statusAt = this.rig.now;
    const free = Math.max(0, this.fanout(peer) - peer.kids.size);
    this.rig.apply(
      await this.rig.core.message(
        peer.conn,
        encodeClientMessage({ t: "status", depth: peer.depth, links: this.streams.map((stream) => ({ stream: stream.id, stripe: 0, parent: peer.parent, backup: peer.backup })), children: peer.kids.size, standby: 0, free, caps: peer.caps, lossPct: 0, rttMs: 20 }),
        this.rig.now,
      ),
    );
  }

  /** Reads what the coordinator sent, acts on it, and says what changed, until nothing more is said. */
  async flush(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      let acted = false;
      // A `role` is acted on before any `assign` sent in the same moment: the coordinator sent
      // it first, and a joiner sent to the new relay needs a link set up before it arrives.
      const assigns: [SimPeer, ServerMessageOf<"assign">][] = [];
      for (const peer of this.peers.values()) {
        if (!peer.alive) continue;
        for (const message of this.rig.take(peer.conn)) {
          if (message.t === "assign") assigns.push([peer, message]);
          else if (message.t === "role") {
            peer.role = message.role;
            peer.dirty = true;
          }
        }
      }
      for (const [peer, message] of assigns) this.onAssign(peer, message.assign, message.reason);
      for (const peer of this.peers.values()) {
        if (!peer.alive || !peer.dirty || this.rig.now - peer.statusAt < 500) continue;
        acted = true;
        await this.status(peer);
      }
      if (!acted) break;
    }
  }

  /** One second passes. */
  async second(): Promise<void> {
    await this.rig.advance(1000);
    for (const peer of this.peers.values()) {
      if (!peer.alive) continue;
      // SPEC §8.1: after probation, in the tree, a peer measures its spare uplink (D19).
      if (peer.capable && peer.role === "leaf" && peer.parent !== null && peer.caps.uplinkKbps === null && this.rig.now - peer.joinedAt >= 21_000) {
        peer.caps = relayCaps({ uplinkKbps: 20_000 });
        peer.dirty = true;
      }
      if (this.rig.now - peer.statusAt >= this.rig.options.params.statusMs) peer.dirty = true;
    }
    await this.flush();
  }

  /** The deepest peer, the mean depth, and who is still without a parent. */
  shape(): { maxDepth: number; meanDepth: number; waiting: number; relays: number; placed: number } {
    let maxDepth = 0;
    let sum = 0;
    let placed = 0;
    let waiting = 0;
    let relays = 0;
    for (const peer of this.peers.values()) {
      if (peer.role === "source" || !peer.alive) continue;
      if (peer.parent === null) {
        waiting++;
        continue;
      }
      placed++;
      sum += peer.depth;
      maxDepth = Math.max(maxDepth, peer.depth);
      if (peer.role === "relay") relays++;
    }
    return { maxDepth, meanDepth: placed > 0 ? sum / placed : 0, waiting, relays, placed };
  }
}
