/**
 * A whole overlay in one process, for tests: links that are function calls delayed by a fake
 * clock, a coordinator that reads the tree straight from the nodes, and a source that makes
 * frames shaped like the program feed. Real `OverlayNode`s run on it unchanged.
 *
 * Not used by the engine itself. The links here do what transport's do at their interface (the
 * `hello` check is taken as passed); transport's own tests cover the real ones.
 *
 * Owner: E-transport+topology.
 */
import {
  DEFAULT_PARAMS,
  MediaFlag,
  PacketType,
  decodePeerMessage,
  encodePeerMessage,
  ms16,
  type Assignment,
  type MetricsEvent,
  type OverlayParams,
  type OverlayRole,
  type PeerHint,
  type PeerId,
  type PeerMessage,
  type StreamConfig,
} from "../protocol";
import type { SessionClock } from "../runtime";
import type { EncodedFrame, ReceivedFrame } from "../types";
import type { LayerGateOptions, LinkEstimator } from "../congestion/types";
import { Emitter } from "../transport/emitter";
import { FakeClock } from "../transport/fakes";
import type { Link, LinkCloseReason, LinkCounters, LinkEvents, LinkManager, LinkManagerEvents, LinkState, SendClass } from "../transport/types";
import { createOverlayNode } from "./node";
import { createBasicEstimator, createOpenGate, type OpenGate } from "./standins";
import type { CoordinatorPort, OverlayNode } from "./types";

export const VIDEO: StreamConfig = {
  id: 0,
  kind: "video",
  configId: 0,
  codec: "vp8",
  bitrateKbps: 1200,
  width: 1280,
  height: 720,
  fps: 30,
  scalability: "L1T3",
  keyIntervalFrames: 60,
  stripes: [{ index: 0, kind: "data", temporal: [0, 1, 2] }],
  sframe: false,
};
export const AUDIO: StreamConfig = {
  id: 1,
  kind: "audio",
  configId: 0,
  codec: "opus",
  bitrateKbps: 32,
  sampleRate: 48000,
  channels: 1,
  frameUs: 20000,
  stripes: [{ index: 0, kind: "data", temporal: [0] }],
  sframe: false,
};

/** A small seeded generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The header of video frame `frameId` of an L1T3 stream with a keyframe every `gop` frames (SPEC §9.2). */
export function videoFrame(frameId: number, captureUs: number, bytes: number, gop = 60): EncodedFrame {
  const inGop = frameId % gop;
  const key = inGop === 0;
  const temporal = inGop % 4 === 0 ? 0 : inGop % 2 === 0 ? 1 : 2;
  const refDelta = key ? 0 : temporal === 0 ? 4 : temporal === 1 ? 2 : 1;
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 97) data[i] = (frameId + i) & 0xff;
  return {
    header: {
      type: PacketType.Media,
      flags: key ? MediaFlag.Key : temporal === 2 ? MediaFlag.Discardable : 0,
      streamId: 0,
      stripe: 0,
      spatial: 0,
      temporal,
      refDelta,
      keyDelta: inGop,
      frameId,
      captureUs,
      configId: 0,
    },
    data,
  };
}

export function audioFrame(frameId: number, captureUs: number): EncodedFrame {
  return {
    header: { type: PacketType.Media, flags: MediaFlag.Key, streamId: 1, stripe: 0, spatial: 0, temporal: 0, refDelta: 0, keyDelta: 0, frameId, captureUs, configId: 0 },
    data: new Uint8Array(80).fill(frameId & 0xff),
  };
}

type Wire = { latencyMs: number; lossPct: number };

class SimLink implements Link {
  state: LinkState = "connecting";
  turn = false;
  other: SimLink | null = null;
  readonly events = new Emitter<LinkEvents>();
  private linkSeq = 0;
  private readonly count: LinkCounters = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, bytesReceived: 0, packetsShed: 0 };
  private outbox: PeerMessage[] = [];
  /** Tests set this to play a backed-up channel. */
  bufferedAmount = 0;

  constructor(
    readonly owner: SimLinks,
    readonly peer: PeerId,
  ) {}

  on<K extends keyof LinkEvents>(event: K, listener: (...args: LinkEvents[K]) => void) {
    return this.events.on(event, listener);
  }

  private get wire(): Wire {
    return this.owner.net.wire(this.owner.self, this.peer);
  }

  open(): void {
    if (this.state !== "connecting") return;
    this.state = "open";
    for (const message of this.outbox.splice(0)) this.sendMessage(message);
    this.events.emit("state", "open");
  }

  sendPacket(packet: Uint8Array, _sendClass: SendClass): boolean {
    if (this.state !== "open") {
      this.count.packetsShed++;
      return false;
    }
    const type = packet[0] & 0x0f;
    const at = type === PacketType.Media || type === PacketType.Parity ? 26 : 2;
    const sendMs = ms16(this.owner.net.clock.now());
    packet[at] = this.linkSeq >> 8;
    packet[at + 1] = this.linkSeq & 0xff;
    packet[at + 2] = sendMs >> 8;
    packet[at + 3] = sendMs & 0xff;
    this.linkSeq = (this.linkSeq + 1) & 0xffff;
    this.count.packetsSent++;
    this.count.bytesSent += packet.byteLength;
    const net = this.owner.net;
    net.packets++;
    const other = this.other;
    const wire = this.wire;
    if (!other || this.owner.dead || (wire.lossPct > 0 && net.random() * 100 < wire.lossPct)) return true;
    const copy = packet.slice();
    net.clock.setTimeout(() => {
      if (other.state !== "open" || other.owner.dead) return;
      other.count.packetsReceived++;
      other.count.bytesReceived += copy.byteLength;
      other.events.emit("packet", copy, net.clock.now());
    }, wire.latencyMs);
    return true;
  }

  sendMessage(message: PeerMessage): void {
    if (this.state === "closed") return;
    if (this.state !== "open") {
      this.outbox.push(message);
      return;
    }
    const net = this.owner.net;
    // Through the wire format, so a message the schema would refuse fails the test that sent it.
    const text = encodePeerMessage(message);
    const decoded = decodePeerMessage(text);
    net.messages.push({ at: net.clock.now(), from: this.owner.self, to: this.peer, message: decoded });
    const other = this.other;
    if (!other || this.owner.dead) return;
    net.clock.setTimeout(() => {
      if (other.state !== "open" || other.owner.dead) return;
      other.events.emit("message", decoded);
      if (decoded.t === "bye") other.shut("remote-bye", false);
    }, this.wire.latencyMs);
  }

  counters(): LinkCounters {
    return { ...this.count };
  }

  close(reason: LinkCloseReason = "local"): void {
    this.shut(reason, true);
  }

  shut(reason: LinkCloseReason, tellOther: boolean): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.owner.forget(this);
    const other = this.other;
    if (tellOther && other && !this.owner.dead) this.owner.net.clock.setTimeout(() => other.shut("channel-closed", false), this.wire.latencyMs);
    this.events.emit("state", "closed", reason);
  }
}

class SimLinks implements LinkManager {
  readonly events = new Emitter<LinkManagerEvents>();
  readonly map = new Map<PeerId, SimLink>();
  dead = false;

  constructor(
    readonly net: SimNet,
    readonly self: PeerId,
  ) {}

  on<K extends keyof LinkManagerEvents>(event: K, listener: (...args: LinkManagerEvents[K]) => void) {
    return this.events.on(event, listener);
  }

  connect(peer: PeerId): Link {
    const existing = this.map.get(peer);
    if (existing) return existing;
    const link = new SimLink(this, peer);
    this.map.set(peer, link);
    const net = this.net;
    net.linksMade++;
    net.clock.setTimeout(() => {
      const them = net.peers.get(peer);
      if (!them || them.dead || this.dead || link.state !== "connecting") return;
      // Both sides connecting at once end with one link (transport's glare handling).
      let theirs = them.map.get(this.self);
      if (!theirs) {
        theirs = new SimLink(them, this.self);
        them.map.set(this.self, theirs);
        them.events.emit("incoming", theirs);
      }
      link.other = theirs;
      theirs.other = link;
      theirs.open();
      link.open();
    }, net.connectMs);
    net.clock.setTimeout(() => {
      if (link.state === "connecting") link.shut("timeout", false);
    }, 15_000);
    return link;
  }

  get(peer: PeerId): Link | undefined {
    return this.map.get(peer);
  }

  links(): Link[] {
    return [...this.map.values()];
  }

  closeAll(): void {
    for (const link of [...this.map.values()]) link.close("local");
  }

  forget(link: SimLink): void {
    if (this.map.get(link.peer) === link) this.map.delete(link.peer);
  }
}

export type SimPeer = {
  id: PeerId;
  node: OverlayNode;
  links: SimLinks;
  port: CoordinatorPort & { connected: boolean };
  role: OverlayRole;
  frames: ReceivedFrame[];
  /** Frame ids of stream 0 received whole. */
  video: Set<number>;
  metrics: MetricsEvent[];
  errors: Error[];
  gates: OpenGate[];
  alive: boolean;
  joinedAt: number;
};

export type SimOptions = {
  seed?: number;
  params?: Partial<OverlayParams>;
  /** One-way delay of every link, unless `wires` says otherwise. */
  latencyMs?: number;
  connectMs?: number;
  /** How long the coordinator takes to answer `need`. */
  coordinatorMs?: number;
  /** A coordinator that does not check paths: it may offer a peer its own descendants. */
  naiveCoordinator?: boolean;
  /** False: the coordinator has no backup to offer anyone, so every repair is a cold one. */
  backups?: boolean;
  keepFrames?: boolean;
  createLayerGate?: (options: LayerGateOptions) => OpenGate;
  createLinkEstimator?: () => LinkEstimator;
};

/** The world: a clock, the peers, and what the coordinator was told. */
export class SimNet {
  readonly clock = new FakeClock(100_000);
  readonly peers = new Map<PeerId, SimLinks>();
  readonly nodes = new Map<PeerId, SimPeer>();
  readonly params: OverlayParams;
  readonly random: () => number;
  /** Every message put on a ctl channel. */
  readonly messages: { at: number; from: PeerId; to: PeerId; message: PeerMessage }[] = [];
  /** Everything the coordinator was asked or told. */
  readonly coordinatorLog: { at: number; peer: PeerId; what: string; detail: string }[] = [];
  private readonly wires = new Map<string, Wire>();
  private readonly listeners = new Map<PeerId, { assign: ((a: Assignment[], reason: "join" | "need" | "rebalance") => void)[]; role: ((role: OverlayRole) => void)[]; gone: ((peer: PeerId) => void)[] }>();
  connectMs: number;
  packets = 0;
  linksMade = 0;
  coordinatorUp = true;
  private frameId = 0;
  private audioId = 0;
  private stopSource: (() => void)[] = [];

  readonly sessionClock: SessionClock;

  constructor(readonly options: SimOptions = {}) {
    this.params = { ...DEFAULT_PARAMS, ...options.params };
    this.random = seeded(options.seed ?? 1);
    this.connectMs = options.connectMs ?? 20;
    const clock = this.clock;
    this.sessionClock = { now: () => clock.now() - 100_000, fromLocal: (local) => local - 100_000, uncertaintyMs: 0 };
  }

  wire(from: PeerId, to: PeerId): Wire {
    return this.wires.get(`${from}>${to}`) ?? { latencyMs: this.options.latencyMs ?? 1, lossPct: 0 };
  }

  /** Sets one direction of one link, or both. */
  setWire(a: PeerId, b: PeerId, wire: Partial<Wire>, bothWays = true): void {
    this.wires.set(`${a}>${b}`, { ...this.wire(a, b), ...wire });
    if (bothWays) this.wires.set(`${b}>${a}`, { ...this.wire(b, a), ...wire });
  }

  /** Makes a peer. It does nothing until `start`. */
  add(id: PeerId, role: OverlayRole): SimPeer {
    const links = new SimLinks(this, id);
    this.peers.set(id, links);
    const listeners = { assign: [], role: [], gone: [] } as NonNullable<ReturnType<typeof this.listeners.get>>;
    this.listeners.set(id, listeners);
    // A killed tab says nothing more, to anyone: its node may still be ticking, but nothing it
    // asks or tells reaches the coordinator.
    const log = (what: string, detail: string) => {
      if (peer.alive) this.coordinatorLog.push({ at: this.clock.now(), peer: id, what, detail });
    };
    const port: CoordinatorPort & { connected: boolean } = {
      connected: true,
      need: (stream, stripe, want, exclude) => {
        log(`need:${want}`, exclude.join(","));
        return new Promise((resolve) => {
          this.clock.setTimeout(() => resolve(this.coordinatorUp && port.connected && peer.alive ? this.place(id, want, exclude, stream, stripe) : null), this.options.coordinatorMs ?? 5);
        });
      },
      report: (event, _stream, _stripe, peer, nextPeer) => log(`report:${event}`, `${peer}${nextPeer ? `>${nextPeer}` : ""}`),
      onAssign: (listener) => {
        listeners.assign.push(listener);
        return () => {};
      },
      onRole: (listener) => {
        listeners.role.push(listener);
        return () => {};
      },
      onPeerGone: (listener) => {
        listeners.gone.push(listener);
        return () => {};
      },
    };
    const gates: OpenGate[] = [];
    const node = createOverlayNode({
      self: id,
      links,
      coordinator: port,
      params: this.params,
      clock: this.clock,
      sessionClock: this.sessionClock,
      createLinkEstimator: this.options.createLinkEstimator ?? createBasicEstimator,
      createLayerGate: (gateOptions) => {
        const gate = (this.options.createLayerGate ?? createOpenGate)(gateOptions);
        gates.push(gate);
        return gate;
      },
    });
    const peer: SimPeer = { id, node, links, port, role, frames: [], video: new Set(), metrics: [], errors: [], gates, alive: true, joinedAt: this.clock.now() };
    node.on("frame", (frame) => {
      if (this.options.keepFrames) peer.frames.push(frame);
      if (frame.header.streamId === 0) peer.video.add(frame.header.frameId);
    });
    node.on("metric", (event) => peer.metrics.push(event));
    node.on("error", (error) => peer.errors.push(error));
    this.nodes.set(id, peer);
    return peer;
  }

  /** Makes a peer and starts it where it is told to go: `parents` and `backups` are tried in order. */
  join(id: PeerId, role: OverlayRole, parents: PeerId[], backups: PeerId[] = []): SimPeer {
    const peer = this.add(id, role);
    const hintOf = (other: PeerId): PeerHint => ({ peer: other, depth: 1, free: 1 });
    peer.node.start(role, [VIDEO, AUDIO], role === "source" ? [] : [{ stream: 0, stripe: 0, parents: parents.map(hintOf), backups: backups.map(hintOf) }]);
    return peer;
  }

  /** Makes a peer and starts it where the coordinator would put it. */
  joinPlaced(id: PeerId, role: OverlayRole): SimPeer {
    const peer = this.add(id, role);
    const assignment = this.place(id, "parent", [], 0, 0) ?? { stream: 0, stripe: 0, parents: [], backups: [] };
    peer.node.start(role, [VIDEO, AUDIO], [assignment]);
    return peer;
  }

  /** The coordinator's placement (SPEC §6.6), from the nodes' own account of themselves. */
  place(asker: PeerId, want: "parent" | "backup", exclude: PeerId[], stream: number, stripe: number): Assignment | null {
    const askerStatus = this.nodes.get(asker)?.node.status();
    const askerParent = askerStatus?.stripes[0]?.parent ?? null;
    const usable: (PeerHint & { path: PeerId[] })[] = [];
    for (const peer of this.nodes.values()) {
      if (!peer.alive || peer.id === asker || exclude.includes(peer.id)) continue;
      const status = peer.node.status();
      if (status.role === "leaf" || status.freeSlots <= 0) continue;
      if (status.role !== "source" && status.stripes[0]?.state !== "active") continue;
      if (!this.options.naiveCoordinator && status.path.includes(asker)) continue;
      usable.push({ peer: peer.id, depth: Math.min(254, status.depth), free: status.freeSlots, path: status.path });
    }
    usable.sort((a, b) => a.depth - b.depth || (a.peer < b.peer ? -1 : 1));
    const strip = ({ peer, depth, free }: PeerHint): PeerHint => ({ peer, depth, free });
    if (want === "backup") {
      if (this.options.backups === false) return null;
      const apart = usable.filter((c) => askerParent === null || !c.path.includes(askerParent));
      return { stream, stripe, parents: [], backups: (apart.length > 0 ? apart : usable).slice(0, 3).map(strip) };
    }
    const parents = usable.slice(0, 3);
    const rest = usable.slice(3);
    const apart = rest.filter((c) => !parents.some((p) => c.path.includes(p.peer)));
    return { stream, stripe, parents: parents.map(strip), backups: (apart.length > 0 ? apart : rest).slice(0, 3).map(strip) };
  }

  /** A tab that is killed: it says nothing more, and nobody is told (SPEC §7.4). */
  kill(id: PeerId): void {
    const peer = this.nodes.get(id);
    if (!peer || !peer.alive) return;
    peer.alive = false;
    peer.links.dead = true;
  }

  /** The coordinator tells `to` something, unasked. */
  assign(to: PeerId, assignments: Assignment[], reason: "join" | "need" | "rebalance"): void {
    for (const listener of this.listeners.get(to)?.assign ?? []) listener(assignments, reason);
  }
  setRole(to: PeerId, role: OverlayRole): void {
    for (const listener of this.listeners.get(to)?.role ?? []) listener(role);
  }
  peerGone(to: PeerId, peer: PeerId): void {
    for (const listener of this.listeners.get(to)?.gone ?? []) listener(peer);
  }

  /** The source publishes video at 30 fps (or `fps`) and audio at 50, until `stopPublishing`. */
  publish(source: SimPeer, options: { video?: boolean; audio?: boolean; fps?: number; frameBytes?: (frameId: number) => number } = {}): void {
    const bytes = options.frameBytes ?? ((frameId) => (frameId % 60 === 0 ? 12_000 : frameId % 4 === 0 ? 5000 : frameId % 2 === 0 ? 3000 : 2000));
    if (options.video !== false) {
      this.stopSource.push(
        this.clock.setInterval(() => {
          if (!source.alive) return;
          const id = this.frameId++;
          source.node.publish(videoFrame(id, Math.round(this.sessionClock.now() * 1000), bytes(id)));
        }, 1000 / (options.fps ?? 30)),
      );
    }
    if (options.audio !== false) {
      this.stopSource.push(
        this.clock.setInterval(() => {
          if (!source.alive) return;
          source.node.publish(audioFrame(this.audioId++, Math.round(this.sessionClock.now() * 1000)));
        }, 20),
      );
    }
  }

  stopPublishing(): void {
    for (const stop of this.stopSource.splice(0)) stop();
  }

  /** How many video frames the source has published. */
  get published(): number {
    return this.frameId;
  }

  run(ms: number): void {
    this.clock.advance(ms);
  }

  /** Lets promises settle (the coordinator's answers), then moves time on; in steps of `stepMs`. */
  async runAsync(ms: number, stepMs = 5): Promise<void> {
    for (let done = 0; done < ms; done += stepMs) {
      this.clock.advance(Math.min(stepMs, ms - done));
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}
