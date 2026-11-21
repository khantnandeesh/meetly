/**
 * `CoordinatorCore`: everything the coordinator does, with no I/O (SPEC §6, D8). It is told what
 * happened (a socket opened, text arrived, time passed) and answers with effects. The two entry
 * points (./node.ts, ./durableObject.ts) carry the effects out and do nothing else.
 *
 * Owner: E-coordinator.
 */
import {
  DEFAULT_PARAMS,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeClientMessage,
  exportGrantPublicKey,
  fromBase64Url,
  generateGrantKey,
  signGrant,
  toBase64Url,
  verifyGrant,
  verifyTicket,
} from "../protocol";
import type { Assignment, Capabilities, ClientMessage, ClientMessageOf, MetricsSample, OverlayRole, PeerId, ServerMessage, ServerMessageOf, StreamConfig } from "../protocol";
import type { ConnId, ConnMeta, CoordinatorCore, CoordinatorCoreOptions, CoreRequest, CoreResponse, Effect, RoomSnapshot, RoomStats } from "./types";
import { scoring } from "./scoring";
import { DEPTH_UNKNOWN, FORGET_MS, MOVE_SHARE, REBALANCE_EVERY_MS, SUSPECT_MS, TreeMap, newNode } from "./treeMap";
import type { Placement, TreeNode } from "./treeMap";

/** WebSocket close codes (SPEC §6.2). Repeated in ./index.ts for callers. */
const CLOSE = { normal: 1000, badTicket: 4001, full: 4002, kicked: 4003, ended: 4004, badMessage: 4005, replaced: 4006 } as const;

/** SPEC §6.5: a grant lives ten minutes and is replaced two minutes before it expires. */
export const GRANT_LIFE_S = 600;
export const GRANT_RENEW_S = 120;
/** SPEC §6.4: how long an introduction lets two peers signal each other. */
export const INTRODUCED_MS = 60_000;
/** A socket that has not said `hello` in this long is closed. */
export const HELLO_TIMEOUT_MS = 10_000;
/** How often the core wants to be woken while anyone is connected. */
export const HOUSEKEEPING_MS = 1_000;
/** A grant shown in `resume` may be this long past its expiry: the coordinator may have been away. */
const RESUME_LEEWAY_S = 3_600;
/** SPEC §11.4: the audience-wide hint. */
const HINT = { downShare: 0.3, downAfterMs: 10_000, upShare: 0.1, upAfterMs: 60_000, ladderKbps: [800, 500] } as const;
/** SPEC §6.3: messages a second, per peer and type. `time` is not in the spec's list; 20 is ample for §4.1. */
const RATES: Record<string, number> = { signal: 50, need: 5, status: 2, metrics: 1, time: 20, report: 20, streams: 2 };
/** Refusals for rate, or messages that do not parse, in ten seconds, before the socket is closed. */
const STRIKES = 30;

type Bucket = { tokens: number; at: number };

type Conn = {
  id: ConnId;
  identity: string;
  name: string;
  ticketRole: "source" | "viewer";
  region: string | null;
  openedAt: number;
  peer: PeerId | null;
  buckets: Map<string, Bucket>;
  strikes: number;
  strikesAt: number;
};

/** What `attach` keeps with a socket: enough to rebuild `Conn`, and the peer's record, after a restart. */
type Attachment = { i: string; n: string; r: "source" | "viewer"; g: string | null; o: number; p?: PeerId; role?: OverlayRole; j?: number; c?: Capabilities; x?: number };

type SessionKey = { kid: string; privateKey: CryptoKey; publicKey: CryptoKey; pub: string; idKey: CryptoKey; epochMs: number };
type StoredSession = { kid: string; pkcs8: string; pub: string; idSecret: string; epochMs: number };

const utf8 = new TextEncoder();
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class Core implements CoordinatorCore {
  private readonly o: CoordinatorCoreOptions;
  private readonly map: TreeMap;
  private readonly conns = new Map<ConnId, Conn>();
  private readonly byIdentity = new Map<string, PeerId>();
  private readonly banned = new Set<string>();
  /** Ticket nonces already used, and when each ticket expires (seconds). */
  private readonly nonces = new Map<string, number>();
  private readonly samples: MetricsSample[] = [];
  private streams: StreamConfig[] = [];
  private key: SessionKey | null = null;
  private ended: string | null = null;
  private lastWake: number | null = null;
  private lastHousekeeping = 0;
  private lastPrune = 0;
  /** SPEC §11.4: the step of the bitrate ladder the source has been told, and since when the audience has been above or below the thresholds. */
  private hint = { step: 0, badSince: null as number | null, goodSince: null as number | null };

  constructor(options: CoordinatorCoreOptions) {
    this.o = options;
    this.map = new TreeMap({ params: options.params, scoring: options.scoring ?? scoring(), streamKbps: () => this.sessionKbps() });
  }

  /* ------------------------------ the interface ------------------------------ */

  async restore(stored: Record<string, string>, conns: { conn: ConnId; attachment: string }[], now: number): Promise<Effect[]> {
    const fx: Effect[] = [];
    if (stored.session) this.key = await this.importSession(stored.session).catch(() => null);
    await this.ready(fx, now);
    this.ended = stored.ended ?? null;
    for (const [key, value] of Object.entries(stored)) if (key.startsWith("nonce:")) this.nonces.set(key.slice(6), Number(value));
    for (const { conn: id, attachment } of conns) {
      let a: Attachment;
      try {
        a = JSON.parse(attachment) as Attachment;
        if (typeof a.i !== "string" || (a.r !== "source" && a.r !== "viewer")) throw new Error("not an attachment");
      } catch {
        fx.push({ type: "close", conn: id, code: CLOSE.badMessage, reason: "lost" });
        continue;
      }
      const conn: Conn = { id, identity: a.i, name: a.n ?? "", ticketRole: a.r, region: a.g ?? null, openedAt: a.o ?? now, peer: null, buckets: new Map(), strikes: 0, strikesAt: now };
      this.conns.set(id, conn);
      if (a.p && a.role && a.c) {
        const node = newNode({ peer: a.p, identity: a.i, name: conn.name, ticketRole: a.r, role: a.role, caps: a.c, region: conn.region, conn: id, joinedAt: a.j ?? now });
        // Where it sits is not known until it says so: stale, so not offered, until its next `status`.
        node.lastStatusAt = 0;
        node.grantExp = a.x ?? 0;
        conn.peer = node.peer;
        this.map.add(node, now);
        this.byIdentity.set(node.identity, node.peer);
      }
    }
    if (this.ended !== null) for (const conn of this.conns.values()) fx.push({ type: "close", conn: conn.id, code: CLOSE.ended, reason: this.ended });
    return this.done(fx, now);
  }

  async open(id: ConnId, ticketText: string, meta: ConnMeta, now: number): Promise<Effect[]> {
    const fx: Effect[] = [];
    await this.ready(fx, now);
    const refuse = (code: number, reason: string) => {
      fx.push({ type: "close", conn: id, code, reason });
      return this.done(fx, now);
    };
    const ticket = await verifyTicket(ticketText, this.o.admissionSecret, { room: this.o.room, now });
    if (!ticket || ticket.v !== PROTOCOL_VERSION) return refuse(CLOSE.badTicket, "bad ticket");
    if (this.nonces.has(ticket.nonce)) return refuse(CLOSE.badTicket, "ticket already used");
    this.nonces.set(ticket.nonce, ticket.exp);
    fx.push({ type: "persist", key: `nonce:${ticket.nonce}`, value: String(ticket.exp) });
    if (this.ended !== null) return refuse(CLOSE.ended, this.ended);
    if (this.banned.has(ticket.identity)) return refuse(CLOSE.kicked, "removed");
    // The audience limit (SPEC §6.1). Someone already counted, coming back, is not counted twice.
    if (ticket.role === "viewer" && !this.byIdentity.has(ticket.identity) && this.viewersHeld() >= this.o.viewerCap) return refuse(CLOSE.full, "full");
    const conn: Conn = { id, identity: ticket.identity, name: ticket.name, ticketRole: ticket.role, region: meta.region ?? null, openedAt: now, peer: null, buckets: new Map(), strikes: 0, strikesAt: now };
    this.conns.set(id, conn);
    this.attach(fx, conn, null);
    return this.done(fx, now);
  }

  async message(id: ConnId, text: string, now: number): Promise<Effect[]> {
    const fx: Effect[] = [];
    await this.ready(fx, now);
    const conn = this.conns.get(id);
    if (!conn) {
      fx.push({ type: "close", conn: id, code: CLOSE.badMessage, reason: "unknown socket" });
      return this.done(fx, now);
    }
    let message: ClientMessage;
    try {
      message = decodeClientMessage(text);
    } catch (error) {
      this.send(fx, id, { t: "error", code: "bad-message", message: (error instanceof ProtocolError ? error.message : "not understood").slice(0, 256) });
      this.strike(fx, conn, now, "too many bad messages");
      return this.done(fx, now);
    }
    if (!this.allow(conn, message.t, now)) {
      this.send(fx, id, { t: "error", code: "rate", message: `too many ${message.t}`, ...(message.t === "need" ? { id: message.id } : {}) });
      this.strike(fx, conn, now, "rate");
      return this.done(fx, now);
    }
    const node = conn.peer !== null ? this.map.nodes.get(conn.peer) : undefined;
    if (message.t === "hello") await this.onHello(fx, conn, message, now);
    else if (!node) {
      this.send(fx, id, { t: "error", code: "bad-message", message: "hello first" });
      this.strike(fx, conn, now, "no hello");
    } else {
      switch (message.t) {
        case "time":
          this.send(fx, id, { t: "time", t0: message.t0, t1: Math.max(0, now - this.key!.epochMs) });
          break;
        case "signal":
          this.onSignal(fx, node, message, now);
          break;
        case "need":
          await this.onNeed(fx, node, message, now);
          break;
        case "status":
          if (this.map.applyStatus(node, message, now)) await this.serveWaiting(fx, now);
          break;
        case "report":
          await this.onReport(fx, node, message, now);
          break;
        case "metrics":
          this.onMetrics(node, message.sample, now);
          break;
        case "streams":
          await this.onStreams(fx, node, message.streams, now);
          break;
        case "bye":
          fx.push({ type: "close", conn: id, code: CLOSE.normal, reason: "bye" });
          this.conns.delete(id);
          this.forget(fx, node);
          break;
      }
    }
    return this.done(fx, now);
  }

  async closed(id: ConnId, now: number): Promise<Effect[]> {
    const fx: Effect[] = [];
    await this.ready(fx, now);
    const conn = this.conns.get(id);
    this.conns.delete(id);
    const node = conn && conn.peer !== null ? this.map.nodes.get(conn.peer) : undefined;
    if (node && node.conn === id) {
      // Not gone, as far as anyone knows: its socket is. It keeps its place for `FORGET_MS`.
      node.conn = null;
      node.closedAt = now;
    }
    return this.done(fx, now);
  }

  async tick(now: number): Promise<Effect[]> {
    const fx: Effect[] = [];
    await this.ready(fx, now);
    this.lastWake = null;
    await this.housekeeping(fx, now);
    return this.done(fx, now);
  }

  async http(request: CoreRequest, now: number): Promise<{ response: CoreResponse; effects: Effect[] }> {
    const fx: Effect[] = [];
    await this.ready(fx, now);
    const response = this.route(fx, request);
    return { response, effects: await this.done(fx, now) };
  }

  snapshot(): RoomSnapshot {
    return {
      room: this.o.room,
      startedAt: this.key?.epochMs ?? 0,
      ended: this.ended !== null,
      source: this.map.source,
      streams: this.streams,
      peers: [...this.map.nodes.values()].map((node) => this.map.record(node)),
    };
  }

  metrics(): MetricsSample[] {
    return this.samples.slice();
  }

  /* ------------------------------ the session's key and clock ------------------------------ */

  private async ready(fx: Effect[], now: number): Promise<void> {
    if (this.key) return;
    const pair = await generateGrantKey();
    const idSecret = new Uint8Array(32);
    crypto.getRandomValues(idSecret);
    const stored: StoredSession = {
      kid: this.randomId(8),
      pkcs8: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
      pub: await exportGrantPublicKey(pair.publicKey),
      idSecret: toBase64Url(idSecret),
      epochMs: now,
    };
    this.key = await this.importSession(JSON.stringify(stored));
    // With the key goes the moment the session clock started: a clock that restarted with the
    // coordinator would move every capture time under the audience's feet.
    fx.push({ type: "persist", key: "session", value: JSON.stringify(stored) });
  }

  private async importSession(text: string): Promise<SessionKey> {
    const stored = JSON.parse(text) as StoredSession;
    const pkcs8 = fromBase64Url(stored.pkcs8);
    const pub = fromBase64Url(stored.pub);
    const idSecret = fromBase64Url(stored.idSecret);
    if (!pkcs8 || !pub || !idSecret) throw new ProtocolError("session: not a stored key");
    return {
      kid: stored.kid,
      privateKey: await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]),
      publicKey: await crypto.subtle.importKey("raw", pub, "Ed25519", true, ["verify"]),
      pub: stored.pub,
      idKey: await crypto.subtle.importKey("raw", idSecret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      epochMs: stored.epochMs,
    };
  }

  private randomId(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += ALPHABET[Math.min(ALPHABET.length - 1, Math.floor(this.o.random() * ALPHABET.length))];
    return out;
  }

  /**
   * A `PeerId` is eight random characters and eight that bind them to the ticket's identity,
   * under a key only the coordinator has. So a coordinator that has lost its memory can still
   * tell that a `resume` comes from whoever was given that id, and not from a neighbour who saw
   * its grant on a link.
   */
  private async idTag(nonce: string, identity: string): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", this.key!.idKey, utf8.encode(`${nonce}\n${identity}`));
    return toBase64Url(new Uint8Array(mac)).replace(/[-_]/g, "x").slice(0, 8).toLowerCase();
  }

  private async mintPeerId(identity: string): Promise<PeerId> {
    for (;;) {
      const nonce = this.randomId(8);
      const peer = nonce + (await this.idTag(nonce, identity));
      if (!this.map.nodes.has(peer)) return peer;
    }
  }

  /** The streams the source's grant lets it publish: those it has named, or stage 1's two before it has. */
  private publishIds(): number[] {
    return (this.streams.length > 0 ? this.streams.map((stream) => stream.id) : [0, 1]).slice(0, 14);
  }

  private async grantFor(node: TreeNode, now: number): Promise<string> {
    const iat = Math.floor(now / 1000);
    const publish = this.publishIds().map((id) => `publish:${id}`);
    const scope = node.role === "source" ? ["view", "relay", ...publish] : node.role === "relay" ? ["view", "relay"] : ["view"];
    node.grantExp = iat + GRANT_LIFE_S;
    return signGrant({ v: PROTOCOL_VERSION, room: this.o.room, peer: node.peer, role: node.role, scope, iat, exp: node.grantExp, kid: this.key!.kid }, this.key!.privateKey);
  }

  /* ------------------------------ effects ------------------------------ */

  private send(fx: Effect[], conn: ConnId | null, message: ServerMessage): void {
    if (conn !== null) fx.push({ type: "send", conn, message });
  }

  private attach(fx: Effect[], conn: Conn, node: TreeNode | null): void {
    const value: Attachment = { i: conn.identity, n: conn.name.slice(0, 64), r: conn.ticketRole, g: conn.region, o: conn.openedAt };
    if (node) Object.assign(value, { p: node.peer, role: node.role, j: node.joinedAt, c: node.caps, x: node.grantExp });
    fx.push({ type: "attach", conn: conn.id, value: JSON.stringify(value) });
  }

  /** Every call ends here: housekeeping if it is due, then when to be woken next. */
  private async done(fx: Effect[], now: number): Promise<Effect[]> {
    if (now - this.lastHousekeeping >= HOUSEKEEPING_MS) await this.housekeeping(fx, now);
    let at: number | null = null;
    if (this.conns.size > 0 || this.map.nodes.size > 0) at = this.lastHousekeeping + HOUSEKEEPING_MS;
    else for (const exp of this.nonces.values()) at = Math.min(at ?? Infinity, exp * 1000 + 1000);
    if (at !== null && at !== this.lastWake) {
      this.lastWake = at;
      fx.push({ type: "wake", at });
    }
    return fx;
  }

  private allow(conn: Conn, type: string, now: number): boolean {
    const rate = RATES[type];
    if (rate === undefined) return true;
    const burst = Math.max(2, rate);
    let bucket = conn.buckets.get(type);
    if (!bucket) conn.buckets.set(type, (bucket = { tokens: burst, at: now }));
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * rate);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** SPEC §6.3: "and, if it goes on, closes the socket". */
  private strike(fx: Effect[], conn: Conn, now: number, why: string): void {
    if (now - conn.strikesAt > 10_000) {
      conn.strikes = 0;
      conn.strikesAt = now;
    }
    if (++conn.strikes < STRIKES) return;
    fx.push({ type: "close", conn: conn.id, code: CLOSE.badMessage, reason: why });
    this.dropConn(conn, now);
  }

  private dropConn(conn: Conn, now: number): void {
    this.conns.delete(conn.id);
    const node = conn.peer !== null ? this.map.nodes.get(conn.peer) : undefined;
    if (node && node.conn === conn.id) {
      node.conn = null;
      node.closedAt = now;
    }
  }

  /* ------------------------------ joining ------------------------------ */

  /** Viewers holding a place: admitted, or with a socket open and not yet through `hello`. */
  private viewersHeld(): number {
    let count = 0;
    for (const node of this.map.nodes.values()) if (node.role !== "source") count++;
    for (const conn of this.conns.values()) if (conn.peer === null && conn.ticketRole === "viewer") count++;
    return count;
  }

  private sessionKbps(): number {
    let total = 0;
    for (const stream of this.streams) total += stream.bitrateKbps;
    return total > 0 ? total : 1232;
  }

  private async onHello(fx: Effect[], conn: Conn, hello: ClientMessageOf<"hello">, now: number): Promise<void> {
    if (conn.peer !== null) {
      this.send(fx, conn.id, { t: "error", code: "bad-message", message: "hello twice" });
      return;
    }
    if (hello.v !== PROTOCOL_VERSION) {
      this.send(fx, conn.id, { t: "error", code: "version", message: `this coordinator speaks version ${PROTOCOL_VERSION}` });
      fx.push({ type: "close", conn: conn.id, code: CLOSE.badMessage, reason: "version" });
      this.conns.delete(conn.id);
      return;
    }
    const role: OverlayRole = conn.ticketRole === "source" ? "source" : "leaf";

    // One source per session (stage 2 adds handover). Its own return, by the same identity, replaces it.
    if (role === "source" && this.map.source !== null) {
      const sitting = this.map.nodes.get(this.map.source)!;
      if (sitting.identity !== conn.identity && sitting.conn !== null) {
        this.send(fx, conn.id, { t: "error", code: "denied", message: "this session already has a source" });
        fx.push({ type: "close", conn: conn.id, code: CLOSE.badTicket, reason: "source present" });
        this.conns.delete(conn.id);
        return;
      }
      if (sitting.identity !== conn.identity) this.forget(fx, sitting);
    }

    let node: TreeNode | undefined;
    let resumed = false;
    if (hello.resume) {
      const grant = await verifyGrant(hello.resume.grant, this.key!.publicKey, { room: this.o.room, now, peer: hello.resume.peer, leewayS: RESUME_LEEWAY_S });
      const known = this.map.nodes.get(hello.resume.peer);
      const peer = hello.resume.peer;
      const theirs = known ? known.identity === conn.identity : peer.length === 16 && (await this.idTag(peer.slice(0, 8), conn.identity)) === peer.slice(8);
      if (grant && theirs && (grant.role === "source") === (role === "source")) {
        resumed = true;
        if (known) {
          node = known;
          if (node.conn !== null && node.conn !== conn.id) {
            fx.push({ type: "close", conn: node.conn, code: CLOSE.replaced, reason: "replaced" });
            this.conns.delete(node.conn);
          }
          node.conn = conn.id;
          node.closedAt = null;
          node.caps = hello.caps;
        } else {
          // The coordinator has been away and remembers nobody. The grant is its own word for the role.
          node = newNode({ peer, identity: conn.identity, name: conn.name, ticketRole: conn.ticketRole, role: grant.role, caps: hello.caps, region: conn.region, conn: conn.id, joinedAt: now });
          node.lastStatusAt = 0;
        }
      }
    }
    if (!node) {
      // A new peer. Whoever this identity was before (a reloaded tab) is gone.
      const before = this.byIdentity.get(conn.identity);
      const old = before !== undefined ? this.map.nodes.get(before) : undefined;
      if (old) {
        if (old.conn !== null) {
          fx.push({ type: "close", conn: old.conn, code: CLOSE.replaced, reason: "replaced" });
          this.conns.delete(old.conn);
        }
        this.forget(fx, old);
      }
      node = newNode({ peer: await this.mintPeerId(conn.identity), identity: conn.identity, name: conn.name, ticketRole: conn.ticketRole, role, caps: hello.caps, region: conn.region, conn: conn.id, joinedAt: now });
    }
    conn.peer = node.peer;
    if (!this.map.nodes.has(node.peer)) this.map.add(node, now);
    else this.map.judge(node, now);
    this.byIdentity.set(node.identity, node.peer);

    const grant = await this.grantFor(node, now);
    // Someone coming back is where it was; it asks (`need`) if that is no longer true.
    const assign = resumed || node.role === "source" ? [] : await this.offer(fx, node, now);
    let ice: ServerMessageOf<"welcome">["ice"] = [];
    try {
      ice = await this.o.iceServers();
    } catch (error) {
      this.o.logger?.warn("coordinator", "no ICE servers", error);
    }
    this.attach(fx, conn, node);
    this.send(fx, conn.id, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      peer: node.peer,
      room: this.o.room,
      role: node.role,
      grant,
      key: { kid: this.key!.kid, pub: this.key!.pub },
      epochMs: this.key!.epochMs,
      ice,
      params: this.o.params,
      streams: this.streams,
      assign,
    });
    if (node.role === "source") {
      if (this.hint.step > 0) this.sendHint(fx);
      await this.serveWaiting(fx, now);
    }
  }

  /* ------------------------------ placement ------------------------------ */

  /** In stage 1 every stream and stripe comes from the same parent (D14): one placement, said once for each. */
  private assignments(placement: Placement): Assignment[] {
    const out: Assignment[] = [];
    for (const stream of this.streams) for (const stripe of stream.stripes) out.push({ stream: stream.id, stripe: stripe.index, parents: placement.parents, backups: placement.backups });
    return out;
  }

  private introduce(node: TreeNode, placement: Placement, now: number): void {
    for (const hint of [...placement.parents, ...placement.backups]) {
      node.introduced.set(hint.peer, now);
      this.map.nodes.get(hint.peer)?.introduced.set(node.peer, now);
    }
  }

  /**
   * Where a peer with no parent should connect; it is marked as waiting if there is nowhere. A
   * joiner with nowhere to go makes room by promotion first (SPEC §6.6), if anyone is eligible.
   */
  private async offer(fx: Effect[], node: TreeNode, now: number): Promise<Assignment[]> {
    if (this.streams.length === 0) {
      node.waitingSince ??= now;
      return [];
    }
    let placement = this.map.place(node, { want: "parent", exclude: [], now, join: true });
    if (placement.parents.length === 0 && (await this.promoteFor(fx, node, [], now))) placement = this.map.place(node, { want: "parent", exclude: [], now, join: true });
    if (placement.parents.length === 0) {
      node.waitingSince ??= now;
      return [];
    }
    this.map.hold(node, placement, now);
    this.introduce(node, placement, now);
    node.lastAssignAt = now;
    return this.assignments(placement);
  }

  /** Slots have opened: peers left with nowhere to connect are told where, without their asking again. */
  private async serveWaiting(fx: Effect[], now: number): Promise<void> {
    for (const node of this.map.waiting()) {
      if (now - node.lastAssignAt < 2_000) continue;
      const assign = await this.offer(fx, node, now);
      if (assign.length > 0) this.send(fx, node.conn, { t: "assign", reason: "join", assign });
    }
  }

  /**
   * Makes room for `node` by promoting one eligible leaf that it could hang from (SPEC §6.6,
   * §8.1): a peer outside its own subtree, connected to the source. The spec's rule (free slots
   * under a fifth of the audience) is met over the whole tree; this is the same rule applied to
   * the slots this peer can actually use, which a dead relay's orphans need at once (cold repair,
   * SPEC §7.5): the slots below the dead relay are cut off with it. True if anyone was promoted.
   */
  private async promoteFor(fx: Effect[], node: TreeNode, exclude: readonly PeerId[], now: number): Promise<boolean> {
    for (const candidate of this.map.promotableFor(node, exclude, now)) {
      await this.setRole(fx, candidate, "relay", now);
      return true;
    }
    return false;
  }

  private async onNeed(fx: Effect[], node: TreeNode, need: ClientMessageOf<"need">, now: number): Promise<void> {
    if (node.role === "source") {
      this.send(fx, node.conn, { t: "error", code: "denied", message: "the source needs no parent", id: need.id });
      return;
    }
    let placement = this.map.place(node, { want: need.want, exclude: need.exclude, excludeBelow: true, now });
    if (need.want === "parent" && placement.parents.length === 0) {
      // A peer that has lost its parent: make room by promotion; failing that, a parent over its
      // fan-out, which takes a `repair` all the same and sheds a layer (SPEC §7.5), and is
      // relieved by promotion and `move`s afterwards. Better than no parent at all.
      if (await this.promoteFor(fx, node, need.exclude, now)) placement = this.map.place(node, { want: "parent", exclude: need.exclude, excludeBelow: true, now });
      if (placement.parents.length === 0) placement = this.map.place(node, { want: "parent", exclude: need.exclude, excludeBelow: true, now, overload: true });
    }
    if (need.want === "parent") {
      if (placement.parents.length === 0) node.waitingSince ??= now;
      else this.map.hold(node, placement, now);
      node.lastAssignAt = now;
    }
    this.introduce(node, placement, now);
    this.send(fx, node.conn, { t: "assign", id: need.id, reason: "need", assign: [{ stream: need.stream, stripe: need.stripe, parents: placement.parents, backups: placement.backups }] });
  }

  private onSignal(fx: Effect[], node: TreeNode, signal: ClientMessageOf<"signal">, now: number): void {
    const to = this.map.nodes.get(signal.to);
    if (!to || to.conn === null) {
      this.send(fx, node.conn, { t: "error", code: "not-found", message: "no such peer here now" });
      return;
    }
    // SPEC §6.4 (D10): only between peers the coordinator has named to each other, lately.
    const at = node.introduced.get(to.peer);
    if (at === undefined || now - at > INTRODUCED_MS) {
      this.send(fx, node.conn, { t: "error", code: "denied", message: "not introduced" });
      return;
    }
    this.send(fx, to.conn, { t: "signal", from: node.peer, data: signal.data });
  }

  private async onReport(fx: Effect[], node: TreeNode, report: ClientMessageOf<"report">, now: number): Promise<void> {
    const about = this.map.nodes.get(report.peer);
    switch (report.event) {
      case "parent-dead":
      case "parent-switch":
        node.parentChanges.push(now);
        if (report.next !== undefined) this.map.setParent(node, report.next !== node.peer ? report.next : null);
        if (report.event === "parent-dead" && about && about.role !== "source") {
          // If its socket is gone as well, it is gone. If not, it is not offered until it speaks again.
          if (about.conn === null) this.forget(fx, about);
          else about.suspectUntil = now + SUSPECT_MS;
        }
        break;
      case "child-gone":
        if (about && about.parent === node.peer) {
          if (about.conn === null) this.forget(fx, about);
          else this.map.setParent(about, null);
        }
        break;
      case "link-failed":
        // These two could not reach each other. That says nothing of anyone else.
        node.avoid.set(report.peer, now + INTRODUCED_MS);
        about?.held.delete(node.peer);
        break;
      case "backup-lost":
        break;
    }
    await this.serveWaiting(fx, now);
  }

  private onMetrics(node: TreeNode, sample: MetricsSample, now: number): void {
    if (sample.peer !== node.peer) return;
    const keep = this.o.metricsKeep ?? 2_000;
    this.samples.push(sample);
    if (this.samples.length > keep) this.samples.splice(0, this.samples.length - keep);
    if (sample.up) node.up = { parent: sample.up.parent, lossPct: sample.up.lossPct, at: now };
    if (sample.video) {
      node.maxTemporal = sample.video.maxTemporal;
      node.maxTemporalAt = now;
    }
  }

  private async onStreams(fx: Effect[], node: TreeNode, streams: StreamConfig[], now: number): Promise<void> {
    if (node.role !== "source") {
      this.send(fx, node.conn, { t: "error", code: "denied", message: "only the source says what the streams are" });
      return;
    }
    if (sameJson(streams, this.streams)) return;
    const before = this.publishIds().join();
    this.streams = streams;
    const idsChanged = this.publishIds().join() !== before;
    for (const other of this.map.nodes.values()) if (other !== node) this.send(fx, other.conn, { t: "streams", streams });
    // The source's grant names the streams it may publish.
    if (idsChanged) this.send(fx, node.conn, { t: "grant", grant: await this.grantFor(node, now) });
    for (const other of this.map.nodes.values()) if (other.role !== "source" && other.parent === null) other.waitingSince ??= now;
    await this.serveWaiting(fx, now);
  }

  /* ------------------------------ leaving ------------------------------ */

  /** Removes a peer from the session, and tells those linked to it (SPEC §6.3 `peer-gone`). */
  private forget(fx: Effect[], node: TreeNode): void {
    const tell = new Set<PeerId>(this.map.childrenOf(node.peer));
    for (const link of node.links) {
      if (link.parent) tell.add(link.parent);
      if (link.backup) tell.add(link.backup);
    }
    for (const other of this.map.nodes.values()) if (other.links.some((link) => link.backup === node.peer || link.parent === node.peer)) tell.add(other.peer);
    tell.delete(node.peer);
    this.map.remove(node.peer);
    if (this.byIdentity.get(node.identity) === node.peer) this.byIdentity.delete(node.identity);
    for (const peer of tell) {
      const other = this.map.nodes.get(peer);
      if (!other) continue;
      other.introduced.delete(node.peer);
      this.send(fx, other.conn, { t: "peer-gone", peer: node.peer });
    }
  }

  /* ------------------------------ time passing ------------------------------ */

  private async housekeeping(fx: Effect[], now: number): Promise<void> {
    this.lastHousekeeping = now;

    for (const [nonce, exp] of this.nonces) {
      if (now / 1000 <= exp) continue;
      this.nonces.delete(nonce);
      fx.push({ type: "persist", key: `nonce:${nonce}`, value: null });
    }
    for (const conn of [...this.conns.values()]) {
      if (conn.peer !== null || now - conn.openedAt < HELLO_TIMEOUT_MS) continue;
      fx.push({ type: "close", conn: conn.id, code: CLOSE.badMessage, reason: "no hello" });
      this.conns.delete(conn.id);
    }
    for (const node of [...this.map.nodes.values()]) if (node.conn === null && node.closedAt !== null && now - node.closedAt >= FORGET_MS) this.forget(fx, node);
    if (this.ended !== null) return;

    for (const node of this.map.nodes.values()) {
      if (node.conn === null || node.grantExp - now / 1000 > GRANT_RENEW_S) continue;
      this.send(fx, node.conn, { t: "grant", grant: await this.grantFor(node, now) });
      this.reattach(fx, node);
    }

    // SPEC §6.6, §8.1: who relays.
    for (const node of this.map.demotable(now)) {
      node.demotedAt = now;
      node.ineligibleSince = null;
      await this.setRole(fx, node, "leaf", now);
    }
    for (const node of this.map.promotable(now)) await this.setRole(fx, node, "relay", now);

    if (this.o.moves !== false && this.streams.length > 0) {
      const budget = Math.max(1, Math.ceil(this.map.audience() * MOVE_SHARE));
      for (const move of this.map.moves(now, budget)) {
        move.node.lastRebalanceAt = now;
        this.introduce(move.node, move.placement, now);
        this.send(fx, move.node.conn, { t: "assign", reason: "move", assign: this.assignments(move.placement) });
      }
    }
    // Relays over their fan-out after taking in repairs (SPEC §7.5): the coordinator "moves
    // someone". Room is made by promotion if need be, then the excess children are moved.
    if (this.streams.length > 0) {
      for (const relief of this.map.overloaded(now)) {
        for (const child of relief.excess) {
          let placement = this.map.place(child, { want: "parent", exclude: [relief.node.peer], now, move: true });
          if (placement.parents.length === 0 && (await this.promoteFor(fx, child, [], now))) placement = this.map.place(child, { want: "parent", exclude: [relief.node.peer], now, move: true });
          if (placement.parents.length === 0) break;
          child.lastRebalanceAt = now;
          this.map.hold(child, placement, now);
          this.introduce(child, placement, now);
          this.send(fx, child.conn, { t: "assign", reason: "move", assign: this.assignments(placement) });
        }
      }
    }
    await this.serveWaiting(fx, now);

    // SPEC §6.6: advice to peers more than two levels deeper than the tree needs.
    if (this.streams.length > 0) {
      for (const node of this.map.tooDeep(now)) {
        const placement = this.map.place(node, { want: "parent", exclude: node.parent ? [node.parent] : [], now, shallowerThan: node.depth - 1 });
        if (placement.parents.length === 0) continue;
        node.lastRebalanceAt = now;
        this.introduce(node, placement, now);
        this.send(fx, node.conn, { t: "assign", reason: "rebalance", assign: this.assignments(placement) });
      }
    }

    this.updateHint(fx, now);

    if (now - this.lastPrune >= REBALANCE_EVERY_MS) {
      this.lastPrune = now;
      for (const node of this.map.nodes.values()) {
        for (const [peer, at] of node.introduced) if (now - at > INTRODUCED_MS) node.introduced.delete(peer);
        for (const [peer, until] of node.avoid) if (until <= now) node.avoid.delete(peer);
      }
    }
  }

  private reattach(fx: Effect[], node: TreeNode): void {
    const conn = node.conn !== null ? this.conns.get(node.conn) : undefined;
    if (conn) this.attach(fx, conn, node);
  }

  private async setRole(fx: Effect[], node: TreeNode, role: OverlayRole, now: number): Promise<void> {
    this.map.setRole(node, role, now);
    this.send(fx, node.conn, { t: "role", role, grant: await this.grantFor(node, now) });
    this.reattach(fx, node);
  }

  /** SPEC §11.4: the audience as a whole. */
  private updateHint(fx: Effect[], now: number): void {
    const video = this.streams.find((stream) => stream.kind === "video");
    if (!video) return;
    const top = Math.max(0, Number(/T(\d+)/.exec(video.scalability ?? "")?.[1] ?? 1) - 1);
    let reporting = 0;
    let below = 0;
    for (const node of this.map.nodes.values()) {
      if (node.role === "source" || node.conn === null || node.maxTemporal === null || now - node.maxTemporalAt > 3 * this.o.params.metricsMs) continue;
      reporting++;
      if (node.maxTemporal < top) below++;
    }
    const share = reporting > 0 ? below / reporting : 0;
    const ladder = [video.bitrateKbps, ...HINT.ladderKbps.filter((kbps) => kbps < video.bitrateKbps)];
    const state = this.hint;
    state.badSince = share > HINT.downShare ? (state.badSince ?? now) : null;
    state.goodSince = share < HINT.upShare ? (state.goodSince ?? now) : null;
    if (state.badSince !== null && now - state.badSince >= HINT.downAfterMs && state.step < ladder.length - 1) {
      state.step++;
      state.badSince = now;
      this.sendHint(fx);
    } else if (state.goodSince !== null && now - state.goodSince >= HINT.upAfterMs && state.step > 0) {
      state.step--;
      state.goodSince = now;
      this.sendHint(fx);
    }
  }

  private sendHint(fx: Effect[]): void {
    const video = this.streams.find((stream) => stream.kind === "video");
    const source = this.map.source !== null ? this.map.nodes.get(this.map.source) : undefined;
    if (!video || !source) return;
    const ladder = [video.bitrateKbps, ...HINT.ladderKbps.filter((kbps) => kbps < video.bitrateKbps)];
    this.send(fx, source.conn, { t: "hint", stream: video.id, bitrateKbps: ladder[Math.min(this.hint.step, ladder.length - 1)] });
  }

  /* ------------------------------ HTTP (SPEC §6.2) ------------------------------ */

  private stats(): RoomStats {
    let viewers = 0;
    let relays = 0;
    let maxDepth = 0;
    for (const node of this.map.nodes.values()) {
      if (node.role === "source" || node.conn === null) continue;
      viewers++;
      if (node.role === "relay") relays++;
      if (node.depth !== DEPTH_UNKNOWN) maxDepth = Math.max(maxDepth, node.depth);
    }
    return { viewers, relays, maxDepth, started: this.map.source !== null && this.ended === null, ended: this.ended !== null };
  }

  private route(fx: Effect[], request: CoreRequest): CoreResponse {
    if (!this.o.serverSecret || request.bearer !== this.o.serverSecret) return { status: 401, body: { error: "unauthorized" } };
    const routes: Record<string, "GET" | "POST"> = { "/stats": "GET", "/tree": "GET", "/metrics": "GET", "/end": "POST", "/kick": "POST" };
    const method = routes[request.path];
    if (!method) return { status: 404, body: { error: "not found" } };
    if (method !== request.method) return { status: 405, body: { error: "method not allowed" } };
    const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
    switch (request.path) {
      case "/stats":
        return { status: 200, body: this.stats() };
      case "/tree":
        return { status: 200, body: this.snapshot() };
      case "/metrics":
        return { status: 200, body: { samples: this.samples } };
      case "/end": {
        const reason = (["ended", "limit", "paused", "source-left"] as const).find((value) => value === body.reason) ?? "ended";
        if (this.ended === null) {
          this.ended = reason;
          fx.push({ type: "persist", key: "ended", value: reason });
          for (const conn of this.conns.values()) {
            if (conn.peer !== null) this.send(fx, conn.id, { t: "end", reason });
            fx.push({ type: "close", conn: conn.id, code: CLOSE.ended, reason });
          }
          this.conns.clear();
          for (const node of [...this.map.nodes.values()]) this.map.remove(node.peer);
          this.byIdentity.clear();
        }
        return { status: 200, body: { ended: true } };
      }
      default: {
        if (typeof body.identity !== "string" || body.identity.length === 0) return { status: 400, body: { error: "identity" } };
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 256) : "removed";
        this.banned.add(body.identity);
        let kicked = 0;
        for (const conn of [...this.conns.values()]) {
          if (conn.identity !== body.identity) continue;
          if (conn.peer !== null) this.send(fx, conn.id, { t: "kick", reason });
          fx.push({ type: "close", conn: conn.id, code: CLOSE.kicked, reason: "removed" });
          this.conns.delete(conn.id);
          kicked++;
        }
        const peer = this.byIdentity.get(body.identity);
        const node = peer !== undefined ? this.map.nodes.get(peer) : undefined;
        if (node) this.forget(fx, node);
        return { status: 200, body: { kicked } };
      }
    }
  }
}

export const createCore = (options: CoordinatorCoreOptions): CoordinatorCore => new Core({ ...options, params: options.params ?? DEFAULT_PARAMS });
