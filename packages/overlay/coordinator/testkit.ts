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
  identity: string;
  /** The grant it holds: what it shows in `resume`. */
  grant: string;
  /**
   * Welcomed with no streams: its node has nothing to subscribe to, and nothing it is sent later
   * changes that (topology's node takes its streams from `welcome`). It never joins.
   */
  stuck: boolean;
  capable: boolean;
  role: OverlayRole;
  /** The fan-out its last `role` gave it (a provisional relay, SPEC §8.1 [D38]), or null for the role's own. */
  grantFanout: number | null;
  caps: Capabilities;
  parent: PeerId | null;
  backup: PeerId | null;
  depth: number;
  kids: Set<PeerId>;
  joinedAt: number;
  /** When it first had a parent, or null. */
  placedAt: number | null;
  statusAt: number;
  dirty: boolean;
  alive: boolean;
  /** When it last asked for a backup. */
  backupAskedAt: number;
  /** Asking the coordinator for a parent: a cold repair (whom it lost), or a join none of whose offers would have it; since when. */
  lost: { dead: PeerId | null; at: number } | null;
  /** For `nodeRebalance`: this peer's one-way delay and runner, its streak of better comparisons, and when it last changed parent. */
  oneWayMs?: number;
  runner?: number;
  streak?: number;
  switchedAt?: number;
  /** For `badNetworks`: this peer's link loses packets. */
  bad?: boolean;
};

export type SwarmOptions = {
  /**
   * How long after it first has a parent a peer able to relay has measured its uplink. 21 s is
   * SPEC §8.1 as written (after probation); about 2 s is D38's short probe at session start.
   */
  probeAfterMs?: number;
  /**
   * When a peer able to relay has its uplink measured, from when it joined and when it first had
   * a parent, if not `probeAfterMs` after the second (the engine's timers, for `engineProbe`).
   */
  probeAt?: (peer: { joinedAt: number; placedAt: number }) => number;
  /**
   * What a joiner's first link takes, offer to media (the gate's p50 is about 0.5 s): added to
   * each `joinWaits` entry. The placement itself is immediate.
   */
  linkMs?: number;
  /** What a peer's probe finds (20,000 kbps): less makes a verdict's fan-out under `maxFanout`, which a full relay's node does not know. */
  probedUplinkKbps?: number;
  /**
   * Whether a peer takes a backup offered in an `assign` "rebalance" that has no free slot, only
   * a standby place (SPEC §7.3: that is all a backup needs). False is topology's node as built
   * (d9eb663), which takes only one that says `free > 0`.
   */
  standbyBackups?: boolean;
  /**
   * The node's own rebalancing (SPEC §7.6), with round trips: each peer gets a network (the
   * gate's mix, `GATE_MIX`: one-way 15, 30 or 60 ms, or 30 for "slow") and a runner of 20; a
   * link's round trip is the two ends' one-way delays plus 2 ms on one runner, 10 across. Every
   * 10 s a peer compares its parent's cost (§8.3: rtt + `perHopMs` × depth) with its backup's,
   * and switches to the backup if it is 20% and 20 ms cheaper three comparisons running, 30 s
   * after its last switch. Off when absent: the simulator then has no round trips at all.
   */
  nodeRebalance?: { perHopMs: number; random: () => number };
  /**
   * Viewers on a bad network (the gate's "bad", 15%: 3% loss with bursts): in each `status` such
   * a peer says a loss over `CHILD_LOSS_PCT` with odds `odds`, else 2%. Its own link, not its
   * parent's: it is what a relay's children report of it (SPEC §8.1, demotion). Off when absent.
   */
  badNetworks?: { share: number; odds: number; random: () => number };
};

/** What a peer does with what the coordinator says, as topology's node does (SPEC §7). */
type Pending = { peer: SimPeer; kind: "backup" | "cold"; dead: PeerId | null };

/**
 * Peers that do what the topology module does with the coordinator: take the first parent
 * offered that has room, keep a backup and ask for another when it is gone, say where they are
 * in `status` when it changes and every `statusMs`, measure their uplink, obey `role` and
 * `assign` "move", follow a "rebalance" that is two levels shallower, and repair when a parent
 * dies: warm to the backup (taken in up to twice its fan-out, D37), else cold through `need`.
 * Driven through the core's real messages, one simulated second at a time.
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
  /** Per kill: how many peers were below the one killed, every one of which sees it (a repair, or a wait). */
  readonly killEvents: number[] = [];
  /** Per joiner: ms from its welcome to its first parent. */
  readonly joinWaits: number[] = [];
  warmRepairs = 0;
  /** Moves the coordinator asked for that left the peer deeper than it was: a peer that relays, or could. */
  deepeningMoves = 0;
  /** The same, of a dead end (a leaf that can never relay) stepping down to let a relay up. */
  deadEndSwaps = 0;
  /** The same, of a leaf moved off a parent over its fan-out (relief, SPEC §7.5 [D37]). */
  reliefDown = 0;
  coldRepairs = 0;
  /** Cold repairs still without a parent after 5 s (SPEC §7.5: the peer would start again). */
  rejoins = 0;
  private count = 0;
  private needId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly probeAfterMs: number;
  private readonly probeAt: SwarmOptions["probeAt"];
  private readonly linkMs: number;
  private readonly standbyBackups: boolean;
  private readonly nodeRebalance: SwarmOptions["nodeRebalance"];
  private readonly badNetworks: SwarmOptions["badNetworks"];
  private readonly probedUplinkKbps: number;
  /** Switches the peers made by their own cost rule, and how many of them took the peer deeper. */
  nodeSwitches = 0;
  nodeSwitchesDeeper = 0;
  /** Relays made leaves (SPEC §8.1). */
  demotions = 0;

  constructor(
    public rig: Rig,
    readonly streams: StreamConfig[] = STREAMS,
    options: SwarmOptions = {},
  ) {
    this.probeAfterMs = options.probeAfterMs ?? 21_000;
    this.probeAt = options.probeAt;
    this.linkMs = options.linkMs ?? 0;
    this.standbyBackups = options.standbyBackups ?? false;
    this.nodeRebalance = options.nodeRebalance;
    this.badNetworks = options.badNetworks;
    this.probedUplinkKbps = options.probedUplinkKbps ?? 20_000;
  }

  private network(peer: SimPeer): void {
    if (this.badNetworks && peer.role !== "source") peer.bad = this.badNetworks.random() < this.badNetworks.share;
    const random = this.nodeRebalance?.random;
    if (!random) return;
    const draw = random();
    peer.oneWayMs = draw < 0.5 ? 15 : draw < 0.8 ? 30 : draw < 0.95 ? 60 : 30;
    peer.runner = Math.floor(random() * 20);
    peer.streak = 0;
    peer.switchedAt = -Infinity;
  }

  private rtt(a: SimPeer, b: SimPeer): number {
    return (a.oneWayMs ?? 0) + (b.oneWayMs ?? 0) + (a.runner === b.runner ? 2 : 10);
  }

  /** SPEC §7.6 as topology's node runs it, once every 10 s per peer. */
  private async rebalanceOwn(peer: SimPeer): Promise<void> {
    const rule = this.nodeRebalance;
    if (!rule || peer.parent === null || peer.backup === null || peer.role === "source") return;
    const parent = this.peers.get(peer.parent);
    const backup = this.peers.get(peer.backup);
    if (!parent || !backup || !backup.alive || backup.role === "leaf" || this.path(backup.peer).includes(peer.peer)) return;
    const cost = (x: SimPeer) => this.rtt(peer, x) + rule.perHopMs * x.depth;
    const now = cost(parent);
    const then = cost(backup);
    const better = then <= now * 0.8 && now - then >= 20;
    peer.streak = better ? (peer.streak ?? 0) + 1 : 0;
    if ((peer.streak ?? 0) < 3 || this.rig.now - (peer.switchedAt ?? -Infinity) < this.rig.options.params.rebalanceMinMs) return;
    // A full backup refuses a switch (a `sub` from FROM_LIVE, not a repair).
    if (backup.kids.size >= this.fanout(backup)) return;
    peer.streak = 0;
    this.nodeSwitches++;
    if (backup.depth + 1 > peer.depth) this.nodeSwitchesDeeper++;
    const old = peer.parent;
    this.attach(peer, backup);
    peer.backup = old;
    peer.switchedAt = this.rig.now;
    await this.say(peer, { t: "report", event: "parent-switch", stream: 0, stripe: 0, peer: old, next: backup.peer });
  }

  private fanout(peer: SimPeer): number {
    if (peer.role === "source") return this.rig.options.params.sourceFanout;
    if (peer.role !== "relay") return 0;
    return peer.grantFanout ?? this.rig.options.params.maxFanout;
  }

  path(peer: PeerId | null): PeerId[] {
    const out: PeerId[] = [];
    for (let at = peer; at !== null && out.length < 64; at = this.peers.get(at)?.parent ?? null) out.push(at);
    return out;
  }

  private size(peer: SimPeer): number {
    let n = 0;
    for (const kid of peer.kids) n += 1 + this.size(this.peers.get(kid)!);
    return n;
  }

  async addSource(): Promise<SimPeer> {
    const { conn, peer, welcome } = await this.rig.join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
    const sim: SimPeer = { conn, peer, identity: "host", grant: welcome.grant, stuck: false, capable: true, role: "source", grantFanout: null, caps: relayCaps({ uplinkKbps: 50_000 }), parent: null, backup: null, depth: 0, kids: new Set(), joinedAt: this.rig.now, placedAt: this.rig.now, statusAt: 0, dirty: true, alive: true, backupAskedAt: 0, lost: null };
    this.network(sim);
    this.peers.set(peer, sim);
    this.source = sim;
    await this.rig.say(conn, { t: "streams", streams: this.streams });
    await this.flush();
    return sim;
  }

  async addViewer(capable: boolean): Promise<SimPeer> {
    const caps = capable ? relayCaps() : leafCaps();
    const identity = `viewer-${this.count++}`;
    const conn = await this.rig.open(identity, "viewer");
    const answers = await this.rig.say(conn, { t: "hello", v: 1, caps });
    // A welcome may wait for the streams (core.ts `helloWaiting`): it then comes in `flush`.
    const welcome = answers.find((message): message is ServerMessageOf<"welcome"> => message.t === "welcome");
    this.rig.inbox.set(conn, answers.filter((message) => message !== welcome));
    const sim: SimPeer = { conn, peer: welcome?.peer ?? `(waiting ${identity})`, identity, grant: welcome?.grant ?? "", stuck: welcome !== undefined && welcome.streams.length === 0, capable, role: "leaf", grantFanout: null, caps, parent: null, backup: null, depth: 255, kids: new Set(), joinedAt: this.rig.now, placedAt: null, statusAt: 0, dirty: false, alive: true, backupAskedAt: 0, lost: null };
    this.network(sim);
    if (welcome) {
      this.peers.set(sim.peer, sim);
      // A `role` sent with this welcome (a relay promoted for the joiner) reaches that relay
      // before the joiner's `sub` does: the joiner's link is set up through it, after.
      await this.flush();
      this.onAssign(sim, welcome.assign, "join");
    } else this.unwelcomed.add(sim);
    return sim;
  }

  /** Viewers whose `hello` has not been answered yet. */
  readonly unwelcomed = new Set<SimPeer>();

  /**
   * The Node coordinator is killed and started again with the same storage (SPEC §6.6): every
   * socket drops; each peer comes back with `resume` in its own time over `spreadS` seconds,
   * in a random order, and says where it is; `during` runs at each of those seconds (joiners).
   */
  async restart(spreadS: number, random: () => number, during?: (second: number) => Promise<void>): Promise<void> {
    const next = new Rig(this.rig.options, { now: this.rig.now + 500, stored: this.rig.stored });
    next.apply(await next.core.restore(Object.fromEntries(this.rig.stored), [], next.now));
    this.rig = next;
    const live = [...this.peers.values()].filter((peer) => peer.alive);
    // Until it is back, a peer cannot reach the coordinator: it says nothing (see `say`).
    for (const peer of live) peer.conn = "";
    const at = new Map(live.map((peer) => [peer, Math.floor(random() * spreadS)]));
    for (let second = 0; second <= spreadS; second++) {
      for (const peer of live) {
        if (at.get(peer) !== second) continue;
        const conn = await next.open(peer.identity, peer.role === "source" ? "source" : "viewer");
        const answers = await next.say(conn, { t: "hello", v: 1, caps: peer.caps, ...(peer.grant ? { resume: { peer: peer.peer, grant: peer.grant } } : {}) });
        const welcome = answers.find((message): message is ServerMessageOf<"welcome"> => message.t === "welcome");
        next.inbox.set(conn, answers.filter((message) => message !== welcome));
        peer.conn = conn;
        if (welcome) peer.grant = welcome.grant;
        if (peer.role === "source") await this.say(peer, { t: "streams", streams: this.streams });
        peer.statusAt = 0;
        peer.dirty = true;
      }
      await during?.(second);
      await this.second();
    }
  }

  /** A tab killed without warning (SPEC §7.4): its socket drops, its children repair. */
  async kill(peer: SimPeer): Promise<void> {
    this.killEvents.push(this.size(peer));
    await this.gone(peer, false);
  }

  /** A viewer that leaves (SPEC §7.7): `bye` to its children and the coordinator. */
  async leave(peer: SimPeer): Promise<void> {
    await this.gone(peer, true);
  }

  private async gone(peer: SimPeer, graceful: boolean): Promise<void> {
    peer.alive = false;
    if (graceful) this.rig.apply(await this.rig.core.message(peer.conn, encodeClientMessage({ t: "bye" }), this.rig.now));
    else await this.rig.drop(peer.conn);
    if (peer.parent !== null) {
      const parent = this.peers.get(peer.parent);
      parent?.kids.delete(peer.peer);
      if (parent) parent.dirty = true;
    }
    for (const kid of [...peer.kids]) await this.repair(this.peers.get(kid)!, peer.peer);
    peer.kids.clear();
  }

  private detach(peer: SimPeer): void {
    if (peer.parent === null) return;
    const old = this.peers.get(peer.parent);
    old?.kids.delete(peer.peer);
    if (old) old.dirty = true;
    peer.parent = null;
  }

  private attach(peer: SimPeer, parent: SimPeer): void {
    this.detach(peer);
    peer.parent = parent.peer;
    parent.kids.add(peer.peer);
    parent.dirty = true;
    if (peer.backup === parent.peer) peer.backup = null;
    if (peer.placedAt === null) this.joinWaits.push(this.rig.now - peer.joinedAt + this.linkMs);
    peer.placedAt ??= this.rig.now;
    peer.lost = null;
    this.redepth(peer, parent.depth + 1);
  }

  /** May `peer` (and its subtree) hang from `parent`, which takes children up to `factor` × its fan-out? */
  private fits(peer: SimPeer, parent: SimPeer | undefined, factor: number): parent is SimPeer {
    return !!parent && parent.alive && parent !== peer && parent.kids.size < factor * this.fanout(parent) && !this.path(parent.peer).includes(peer.peer);
  }

  /** Its parent is gone: warm to the backup if it will do, else cold, through the coordinator (SPEC §7.5). */
  private async repair(kid: SimPeer, dead: PeerId): Promise<void> {
    this.detach(kid);
    const backup = kid.backup !== null ? this.peers.get(kid.backup) : undefined;
    kid.backup = null;
    if (this.fits(kid, backup, 2)) {
      this.warmRepairs++;
      this.attach(kid, backup);
      await this.say(kid, { t: "report", event: "parent-dead", stream: 0, stripe: 0, peer: dead, next: backup.peer });
      return;
    }
    this.coldRepairs++;
    kid.lost = { dead, at: this.rig.now };
    kid.dirty = true;
    await this.need(kid, "cold", dead);
  }

  private async need(peer: SimPeer, kind: "backup" | "cold", dead: PeerId | null): Promise<void> {
    const id = this.needId++;
    this.pending.set(id, { peer, kind, dead });
    if (kind === "backup") peer.backupAskedAt = this.rig.now;
    const exclude = kind === "cold" && dead !== null ? [dead] : [];
    await this.say(peer, { t: "need", id, stream: 0, stripe: 0, want: kind === "cold" ? "parent" : "backup", exclude });
  }

  private async say(peer: SimPeer, message: ClientMessage): Promise<void> {
    if (peer.conn === "") return;
    this.rig.apply(await this.rig.core.message(peer.conn, encodeClientMessage(message), this.rig.now));
  }

  private redepth(peer: SimPeer, depth: number): void {
    peer.depth = depth;
    peer.dirty = true;
    for (const kid of peer.kids) this.redepth(this.peers.get(kid)!, depth + 1);
  }

  private onAnswer(message: ServerMessageOf<"assign">): void {
    const pending = this.pending.get(message.id!);
    this.pending.delete(message.id!);
    if (!pending || !pending.peer.alive) return;
    const { peer, kind } = pending;
    const first = message.assign[0];
    if (kind === "backup") {
      const backup = first?.backups.map((hint) => this.peers.get(hint.peer)).find((candidate) => candidate && candidate.alive && candidate !== peer && candidate.peer !== peer.parent && !this.path(candidate.peer).includes(peer.peer));
      if (backup) {
        peer.backup = backup.peer;
        peer.dirty = true;
      }
      return;
    }
    // Cold repair: a `repair`, never refused for want of a slot (SPEC §7.5), up to twice the fan-out (D37).
    if (peer.parent !== null || !first) return;
    const parent = first.parents.map((hint) => this.peers.get(hint.peer)).find((candidate) => this.fits(peer, candidate, 2));
    if (parent) this.attach(peer, parent);
  }

  private onAssign(peer: SimPeer, assign: Assignment[], reason: "join" | "need" | "rebalance" | "move"): void {
    if (peer.stuck) return;
    const first = assign[0];
    if (!first) return;
    if (reason === "rebalance") {
      // As topology's node does: the best of the candidates becomes the backup, if it sits nearer
      // the source than the one it has; the parent changes only by the cost rule (SPEC §7.6),
      // which this simulation leaves out.
      if (peer.parent === null) return;
      const current = peer.backup !== null ? this.peers.get(peer.backup) : undefined;
      const better = assign
        .flatMap((assignment) => [...assignment.parents, ...assignment.backups])
        .find((hint) => hint.peer !== peer.peer && hint.peer !== peer.parent && hint.peer !== peer.backup && (this.standbyBackups || hint.free > 0) && hint.depth < (current?.alive ? current.depth : 255) && !this.path(hint.peer).includes(peer.peer));
      if (better && this.peers.get(better.peer)?.alive) {
        peer.backup = better.peer;
        peer.dirty = true;
      }
      return;
    }
    if (first.parents.length === 0) return;
    if (reason === "join" && peer.parent !== null) return;
    // PLAN K2: "the first backup's path avoids the first parent", for each placement that offers
    // a backup at all. A "move" offers none: the peer keeps the backup it has.
    if (reason !== "move") {
      this.placements++;
      const clear = first.backups[0] !== undefined && !this.path(first.backups[0].peer).includes(first.parents[0].peer);
      if (clear) this.backupsApart++;
    }
    const offered = this.peers.get(first.parents[0].peer);
    // An offer over a fan-out says so (`free: 0`, D37: a joiner that waited 3 s with nowhere to go); one that claims a slot must have it.
    if ((!offered || offered.kids.size >= this.fanout(offered)) && first.parents[0].free > 0) this.offeredBeyondFree++;
    // A viewer with nothing to watch is taken in up to twice the fan-out, as topology's node does.
    const parent = first.parents.map((hint) => this.peers.get(hint.peer)).find((candidate) => this.fits(peer, candidate, reason === "join" && peer.parent === null ? 2 : 1));
    if (!parent) {
      // A joiner none of whose offers will have it asks again, as the node does once no link has
      // opened (SPEC §7.1: cold repair). A sub is refused when full; a later `repair` is not.
      if (reason === "join" && peer.parent === null && !peer.lost) peer.lost = { dead: null, at: this.rig.now };
      return;
    }
    if (peer.parent !== null) this.moves++;
    if (peer.parent !== null && parent.depth + 1 > peer.depth) {
      const from = this.peers.get(peer.parent);
      if (from && from.kids.size > this.fanout(from)) this.reliefDown++;
      else if (peer.role === "leaf" && !peer.capable) this.deadEndSwaps++;
      else this.deepeningMoves++;
    }
    const old = peer.parent;
    const backup = first.backups.map((hint) => this.peers.get(hint.peer)).find((candidate) => candidate && candidate.alive && candidate !== parent && candidate !== peer);
    this.attach(peer, parent);
    // After a move the old parent becomes the backup, as topology's node does (SPEC §7.6).
    if (reason === "move") {
      peer.backup = old;
      peer.switchedAt = this.rig.now;
      peer.streak = 0;
    }
    else if (backup) peer.backup = backup.peer;
  }

  private async status(peer: SimPeer): Promise<void> {
    peer.dirty = false;
    peer.statusAt = this.rig.now;
    const free = Math.max(0, this.fanout(peer) - peer.kids.size);
    const links = peer.parent === null && peer.role !== "source" ? [] : this.streams.map((stream) => ({ stream: stream.id, stripe: 0, parent: peer.parent, backup: peer.backup }));
    await this.say(peer, { t: "status", depth: peer.parent === null && peer.role !== "source" ? 255 : peer.depth, links, children: peer.kids.size, standby: 0, free, caps: peer.caps, lossPct: this.lossOf(peer), rttMs: 20 });
  }

  private lossOf(peer: SimPeer): number {
    if (!peer.bad || !this.badNetworks || peer.parent === null) return 0;
    return this.badNetworks.random() < this.badNetworks.odds ? 8 : 2;
  }

  /** Reads what the coordinator sent, acts on it, and says what changed, until nothing more is said. */
  async flush(): Promise<void> {
    for (let round = 0; round < 8; round++) {
      let acted = false;
      // A `role` is acted on before any `assign` sent in the same moment: the coordinator sent
      // it first, and a joiner sent to the new relay needs a link set up before it arrives.
      const assigns: [SimPeer, ServerMessageOf<"assign">][] = [];
      const demoted: SimPeer[] = [];
      for (const peer of [...this.unwelcomed]) {
        const messages = this.rig.take(peer.conn);
        const welcome = messages.find((message): message is ServerMessageOf<"welcome"> => message.t === "welcome");
        if (!welcome) {
          this.rig.inbox.set(peer.conn, messages);
          continue;
        }
        this.unwelcomed.delete(peer);
        peer.peer = welcome.peer;
        peer.grant = welcome.grant;
        peer.stuck = welcome.streams.length === 0;
        peer.joinedAt = this.rig.now;
        this.peers.set(peer.peer, peer);
        this.rig.inbox.set(peer.conn, messages.filter((message) => message !== welcome));
        this.onAssign(peer, welcome.assign, "join");
      }
      for (const peer of this.peers.values()) {
        if (!peer.alive) continue;
        for (const message of this.rig.take(peer.conn)) {
          if (message.t === "assign") assigns.push([peer, message]);
          else if (message.t === "grant") peer.grant = message.grant;
          else if (message.t === "role") {
            peer.grant = message.grant;
            if (peer.role === "relay" && message.role === "leaf") {
              demoted.push(peer);
              this.demotions++;
            }
            peer.role = message.role;
            peer.grantFanout = message.fanout ?? null;
            peer.dirty = true;
          }
        }
      }
      // A relay made a leaf says `bye` to its children (SPEC §6.6, §7.7): they repair.
      for (const peer of demoted) for (const kid of [...peer.kids]) await this.repair(this.peers.get(kid)!, peer.peer);
      for (const [peer, message] of assigns) {
        if (message.id !== undefined && this.pending.has(message.id)) this.onAnswer(message);
        else this.onAssign(peer, message.assign, message.reason);
      }
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
    await this.step(1000);
  }

  /**
   * `ms` pass (a second, or a part of one for a finer clock: what peers do once a second, a cold
   * repair asking again, is done when a second is crossed).
   */
  async step(ms: number): Promise<void> {
    const before = this.rig.now;
    await this.rig.advance(ms);
    const crossed = (unit: number) => Math.floor(this.rig.now / unit) !== Math.floor(before / unit);
    if (this.nodeRebalance && crossed(10_000)) for (const peer of [...this.peers.values()]) if (peer.alive) await this.rebalanceOwn(peer);
    for (const peer of this.peers.values()) {
      if (!peer.alive) continue;
      // SPEC §8.1: a peer able to relay, in the tree, measures its spare uplink (D19, D38).
      if (peer.capable && peer.role === "leaf" && peer.placedAt !== null && peer.caps.uplinkKbps === null && this.rig.now >= (this.probeAt ? this.probeAt({ joinedAt: peer.joinedAt, placedAt: peer.placedAt }) : peer.placedAt + this.probeAfterMs)) {
        peer.caps = relayCaps({ uplinkKbps: this.probedUplinkKbps });
        peer.dirty = true;
      }
      if (this.rig.now - peer.statusAt >= this.rig.options.params.statusMs) peer.dirty = true;
    }
    for (const peer of [...this.peers.values()]) {
      if (!peer.alive || peer.role === "source") continue;
      // A cold repair that found nothing asks again; after 5 s it would start over (SPEC §7.5).
      if (peer.parent === null && peer.lost) {
        if (this.rig.now - peer.lost.at >= 5_000) {
          this.rejoins++;
          // It starts over (SPEC §7.5, "rejoining"): as far as the coordinator goes, it asks again from scratch.
          peer.lost = { dead: null, at: this.rig.now };
        } else if (crossed(1000)) await this.need(peer, "cold", peer.lost.dead);
      }
      // A backup that is gone, or never was, is asked for (SPEC §7.3). A child of the source has none to have.
      const backup = peer.backup !== null ? this.peers.get(peer.backup) : undefined;
      const stale = backup !== undefined && (!backup.alive || backup.role === "leaf" || this.path(backup.peer).includes(peer.peer));
      if (stale) peer.backup = null;
      if (peer.parent !== null && peer.parent !== this.source?.peer && peer.backup === null && this.rig.now - peer.backupAskedAt >= 2_000) await this.need(peer, "backup", null);
    }
    await this.flush();
  }

  /** The live viewers who relay, as the coordinator made them. */
  relays(): SimPeer[] {
    return [...this.peers.values()].filter((peer) => peer.alive && peer.role === "relay");
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
