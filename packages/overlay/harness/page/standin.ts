/**
 * A STAND-IN for the overlay engine: one peer, in a page, written so that the harness (the
 * impairment shim, shards, churn, metrics, the report) can be built and tested before
 * `createOverlayViewer` and `createOverlaySource` exist. It is the proof's `node.html` grown just
 * far enough to speak the real wire (packets and messages from protocol.ts, the coordinator's
 * WebSocket of SPEC §6.3) and to fill in a real `MetricsSample`.
 *
 * What it does: links of two negotiated data channels; forwarding without decoding; a GOP cache
 * and subscribe-from-frame; heartbeats on the media channel and a parent declared dead after
 * `deadMs`; warm repair to a standby backup and cold repair through the coordinator; STALLED and
 * waiting; a loop check on paths; NACK and retransmission; a playout delay; light and decoding
 * viewers; reconnecting to a coordinator that died.
 *
 * What it does not do, so no number it produces is a number about the engine: grants are sent
 * and not checked; no layer dropping, no congestion control, no send classes, no uplink probe;
 * no audio; no rebalancing; no retransmission budget; the playout delay is a simple maximum
 * rather than SPEC §10.2's formula; a relay is whoever the stand-in coordinator says.
 *
 * Owner: E-harness. Delete when the composition root exists and the harness has run against it.
 */
import {
  FROM_LATEST_KEYFRAME,
  FROM_LIVE,
  FeedbackFlag,
  HeartbeatFlag,
  HopFlag,
  MediaFlag,
  PROTOCOL_VERSION,
  PacketType,
  decodeHeartbeat,
  decodeMediaHeader,
  decodeNack,
  decodePeerMessage,
  decodeServerMessage,
  emptyHistogram,
  encodeClientMessage,
  encodeFeedback,
  encodeHeartbeat,
  encodeNack,
  encodePeerMessage,
  latencyBucket,
  mediaPayload,
  ms16,
  nackFragments,
  nackItemsFor,
  packetLinkFields,
  packetizeFrame,
  rttFromEcho,
  seq16Diff,
  writeHopFields,
  ECHO_NONE,
  NACK_WHOLE_FRAME,
  DEFAULT_PARAMS,
  type Assignment,
  type Capabilities,
  type ClientMessage,
  type IceServer,
  type MetricsEvent,
  type MetricsSample,
  type NackItem,
  type OverlayParams,
  type OverlayRole,
  type PeerId,
  type PeerMessage,
  type ServerMessage,
  type SignalData,
  type StreamConfig,
} from "../../protocol";
import type { Cancel, Clock } from "../../runtime";
import type { ChannelKind, PacketChannel } from "../../transport/types";
import type { ImpairmentProfile, PageStartOptions } from "../types";

export type StandinOptions = PageStartOptions & {
  clock: Clock;
  /** A fresh ticket: one is used per connection to the coordinator. */
  nextTicket: () => Promise<string>;
  wrapChannel: (channel: PacketChannel, info: { peer: PeerId; kind: ChannelKind }) => PacketChannel;
  /** The network this peer says it has, for the capabilities it reports. */
  profile: ImpairmentProfile | null;
};

export type LinkInfo = { peer: PeerId; open: boolean; failed: boolean; turn: boolean; candidates: string | null };

export interface StandinPeer {
  start(): Promise<void>;
  leave(): Promise<void>;
  takeSamples(): MetricsSample[];
  readonly peer: PeerId | null;
  readonly started: boolean;
  readonly error: string | null;
  clockUncertaintyMs(): number;
  /** Session time now, or null before the clock is known. */
  sessionTime(): number | null;
  links(): LinkInfo[];
  parent(): PeerId | null;
  backup(): PeerId | null;
  children(): number;
  depth(): number;
}

type Frame = {
  id: number;
  flags: number;
  temporal: number;
  refDelta: number;
  /** Session milliseconds. */
  captureMs: number;
  /** Each fragment's whole packet, header included: this is also the GOP cache. */
  parts: (Uint8Array | undefined)[];
  got: number;
  complete: boolean;
  firstAt: number;
  replayed: boolean;
  nacks: number;
  nackAt: number;
};

type Link = {
  peer: PeerId;
  pc: RTCPeerConnection;
  ctl: PacketChannel;
  media: PacketChannel;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  open: boolean;
  closed: boolean;
  failed: boolean;
  opened: Promise<boolean>;
  seq: number;
  lastHeardAt: number;
  stalled: boolean;
  echo: { sendMs: number; at: number } | null;
  rttMs: number | null;
  child: { mode: "active" | "standby"; lastHeardAt: number; beats: number } | null;
  turn: boolean;
  candidates: string | null;
  acks: Map<number, (message: Extract<PeerMessage, { t: "sub-ack" }>) => void>;
  path: PeerId[] | null;
  /** What arrived on the media channel since the last sample: `base` is the newest sequence number before it. */
  rx: { received: number; any: boolean; base: number; highest: number; bytes: number };
};

type RepairRecord = {
  dead: PeerId;
  next: PeerId | null;
  kind: "warm" | "cold" | "wait";
  lastHeard: number;
  detected: number;
  resubscribed: number;
  firstPacket: number | null;
  usedCoordinator: boolean;
};

const STALL_MS = 150;
const UNCAPPED_UPLINK_KBPS = 20_000;
/** How long a joiner keeps asking for a parent. The package's coordinator places nobody under a peer in its first 20 s (D18). */
const FIND_PARENT_MS = 60_000;
const REORDER_MS = 10;
const TICK_MS = 10;
const FREEZE_MS = 200;

function dataChannel(dc: RTCDataChannel): PacketChannel {
  dc.binaryType = "arraybuffer";
  const channel: PacketChannel = {
    get readyState() {
      return dc.readyState;
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    send: (data) => (typeof data === "string" ? dc.send(data) : dc.send(data as Uint8Array<ArrayBuffer>)),
    close: () => dc.close(),
    onopen: null,
    onclose: null,
    onmessage: null,
  };
  dc.onopen = () => channel.onopen?.();
  dc.onclose = () => channel.onclose?.();
  dc.onmessage = (event) => channel.onmessage?.(event.data as ArrayBuffer | string);
  return channel;
}

export function createStandinPeer(options: StandinOptions): StandinPeer {
  const clock = options.clock;
  const isSource = options.role === "source";
  const program = options.program ?? { source: "synthetic" as const, bitrateKbps: 1200, fps: 30, keyIntervalFrames: 60 };
  const frameMs = 1000 / program.fps;

  let params: OverlayParams = DEFAULT_PARAMS;
  let self: PeerId | null = null;
  let grant = "";
  let role: OverlayRole = isSource ? "source" : "leaf";
  let iceServers: IceServer[] = [];
  let config: StreamConfig | null = null;
  let error: string | null = null;
  let started = false;
  let leaving = false;
  const timers: Cancel[] = [];

  /* ------------------------------ the session clock (SPEC §4.1) ------------------------------ */

  const probes: { rtt: number; offset: number }[] = [];
  let offset = 0;
  let offsetTarget = 0;
  let offsetSetAt = 0;
  let uncertaintyMs = Infinity;
  const currentOffset = (now: number): number => {
    const room = (now - offsetSetAt) / 1000;
    return offset + Math.max(-room, Math.min(room, offsetTarget - offset));
  };
  const sessionNow = (): number => {
    const now = clock.now();
    return Math.max(0, now + currentOffset(now));
  };
  const onTime = (t0: number, t1: number): void => {
    const t2 = clock.now();
    const rtt = t2 - t0;
    if (rtt < 0) return;
    probes.push({ rtt, offset: t1 + rtt / 2 - t2 });
    if (probes.length > 8) probes.shift();
    const best = probes.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    if (uncertaintyMs === Infinity) {
      offset = offsetTarget = best.offset;
    } else {
      // Move toward a better estimate by at most 1 ms a second, so playout never jumps.
      offset = currentOffset(t2);
      offsetTarget = best.offset;
    }
    offsetSetAt = t2;
    uncertaintyMs = best.rtt / 2;
  };

  /* ------------------------------ the coordinator's socket ------------------------------ */

  let socket: WebSocket | null = null;
  let connected = false;
  let welcomed: (() => void) | null = null;
  let firstAssign: Assignment[] = [];
  let needId = 0;
  const needs = new Map<number, (assignment: Assignment | null) => void>();
  let reconnectMs = 300;
  let tConnect = 0;
  let tWelcome = 0;
  let localConnect = 0;
  let localWelcome = 0;

  const caps = (): Capabilities => ({
    browser: "chromium",
    desktop: true,
    onPower: true,
    nat: "open",
    // The stand-in has no uplink probe (D19): it claims what its network allows, and an
    // unimpaired one carries far more than any fan-out needs.
    uplinkKbps: options.profile?.kbps ?? UNCAPPED_UPLINK_KBPS,
    cores: navigator.hardwareConcurrency || 1,
    decode: ["vp8"],
    dataSaver: false,
    visible: true,
  });
  const toCoordinator = (message: ClientMessage): void => {
    if (socket && connected && socket.readyState === WebSocket.OPEN) socket.send(encodeClientMessage(message));
  };
  const probeClock = (): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodeClientMessage({ t: "time", t0: clock.now() }));
  };

  async function connectCoordinator(): Promise<void> {
    const ticket = await options.nextTicket();
    const base = options.coordinatorUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const ws = new WebSocket(`${base}/overlay/v1/rooms/${encodeURIComponent(options.room)}/ws?ticket=${encodeURIComponent(ticket)}`);
    socket = ws;
    ws.onopen = () => {
      ws.send(encodeClientMessage({ t: "hello", v: PROTOCOL_VERSION, caps: caps(), ...(self ? { resume: { peer: self, grant } } : {}) }));
      // Five probes 100 ms apart on joining, then one every 30 s.
      for (let i = 0; i < 5; i++) clock.setTimeout(() => ws === socket && probeClock(), i * 100);
    };
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = decodeServerMessage(String(event.data));
      } catch {
        return;
      }
      onCoordinator(message);
    };
    ws.onclose = () => {
      if (ws !== socket) return;
      connected = false;
      for (const resolve of needs.values()) resolve(null);
      needs.clear();
      if (leaving) return;
      clock.setTimeout(() => void connectCoordinator().catch(() => undefined), reconnectMs);
      reconnectMs = Math.min(2000, reconnectMs * 2);
    };
    ws.onerror = () => undefined;
  }

  /** Loss from the parent over the last metrics interval: what `status` tells the coordinator. */
  let upLossPct = 0;

  function onCoordinator(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
        self = message.peer;
        grant = message.grant;
        role = message.role;
        params = message.params;
        iceServers = message.ice;
        if (!config && message.streams.length) config = message.streams[0];
        firstAssign = message.assign;
        connected = true;
        reconnectMs = 300;
        if (!localWelcome) localWelcome = clock.now();
        welcomed?.();
        welcomed = null;
        sendStatus();
        if (isSource && config) toCoordinator({ t: "streams", streams: [config] });
        return;
      case "time":
        onTime(message.t0, message.t1);
        return;
      case "signal":
        void onSignal(message.from, message.data);
        return;
      case "assign":
        if (message.id !== undefined) {
          needs.get(message.id)?.(message.assign[0] ?? null);
          needs.delete(message.id);
        }
        return;
      case "streams":
        if (!config && message.streams.length) config = message.streams[0];
        return;
      case "role":
        // Promoted (or demoted) by the coordinator, with a grant to show for it (SPEC §6.6). A
        // demoted relay keeps the children it has; it only takes no new ones.
        role = message.role;
        grant = message.grant;
        sendStatus();
        return;
      case "grant":
        grant = message.grant;
        return;
      case "peer-gone":
        // Advisory: repair does not wait for it, and the stand-in does not act on it.
        return;
      default:
        return;
    }
  }
  function need(want: "parent" | "backup", exclude: PeerId[]): Promise<Assignment | null> {
    if (!connected) return Promise.resolve(null);
    const id = needId++;
    return new Promise((resolve) => {
      needs.set(id, resolve);
      toCoordinator({ t: "need", id, stream: 0, stripe: 0, want, exclude: exclude.slice(0, 64) });
      clock.setTimeout(() => {
        if (needs.delete(id)) resolve(null);
      }, 3000);
    });
  }

  /* ------------------------------ links ------------------------------ */

  const links = new Map<PeerId, Link>();
  const everLinked: Link[] = [];

  function link(peer: PeerId, initiate: boolean): Link {
    const existing = links.get(peer);
    if (existing && !existing.closed) return existing;
    const pc = new RTCPeerConnection({ iceServers: options.ice === "host" ? [] : iceServers, iceTransportPolicy: options.ice === "turn" ? "relay" : "all" });
    const wrap = (dc: RTCDataChannel, kind: ChannelKind) => options.wrapChannel(dataChannel(dc), { peer, kind });
    const ctl = wrap(pc.createDataChannel("ctl", { negotiated: true, id: 0 }), "ctl");
    const media = wrap(pc.createDataChannel("media", { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 }), "media");
    let resolveOpen: (ok: boolean) => void = () => undefined;
    const l: Link = {
      peer,
      pc,
      ctl,
      media,
      polite: (self ?? "") > peer,
      makingOffer: false,
      ignoreOffer: false,
      open: false,
      closed: false,
      failed: false,
      opened: new Promise<boolean>((resolve) => (resolveOpen = resolve)),
      seq: 0,
      lastHeardAt: clock.now(),
      stalled: false,
      echo: null,
      rttMs: null,
      child: null,
      turn: false,
      candidates: null,
      acks: new Map(),
      path: null,
      rx: { received: 0, any: false, base: 0, highest: 0, bytes: 0 },
    };
    links.set(peer, l);
    everLinked.push(l);
    let channels = 0;
    const channelOpen = (): void => {
      if (++channels < 2) return;
      l.open = true;
      l.lastHeardAt = clock.now();
      if (self) ctl.send(encodePeerMessage({ t: "hello", v: PROTOCOL_VERSION, peer: self, grant }));
      void pc
        .getStats()
        .then((stats) => {
          const all = [...stats.values()] as Record<string, unknown>[];
          const transport = all.find((s) => s.type === "transport");
          const pair = all.find((s) => s.type === "candidate-pair" && (s.id === transport?.selectedCandidatePairId || s.nominated === true));
          const kind = (id: unknown) => String(all.find((s) => s.id === id)?.candidateType ?? "unknown");
          if (pair) {
            l.candidates = `${kind(pair.localCandidateId)}-${kind(pair.remoteCandidateId)}`;
            l.turn = l.candidates.includes("relay");
          }
        })
        .catch(() => undefined);
      resolveOpen(true);
    };
    ctl.onopen = channelOpen;
    media.onopen = channelOpen;
    ctl.onmessage = (data) => typeof data === "string" && onPeerMessage(l, data);
    media.onmessage = (data) => typeof data !== "string" && onPacket(l, new Uint8Array(data));
    // A parent is dead when it has been silent for `deadMs`, and for no other reason: a closing
    // tab may or may not get a goodbye out, and the measured repair must not depend on which.
    const gone = (): void => {
      if (pc.connectionState === "failed" && !l.open) l.failed = true;
      if ((pc.connectionState === "failed" || pc.connectionState === "closed") && peer !== up.parent) closeLink(l, false);
    };
    pc.onconnectionstatechange = gone;
    ctl.onclose = () => peer !== up.parent && closeLink(l, false);
    pc.onicecandidate = (event) => event.candidate && toCoordinator({ t: "signal", to: peer, data: { candidate: event.candidate.toJSON() as SignalData["candidate"] } });
    clock.setTimeout(() => {
      if (!l.open && !l.closed) {
        l.failed = true;
        resolveOpen(false);
        closeLink(l, false);
      }
    }, 8000);
    if (initiate) void offer(l);
    return l;
  }

  async function offer(l: Link): Promise<void> {
    try {
      l.makingOffer = true;
      await l.pc.setLocalDescription();
      const local = l.pc.localDescription;
      if (local) toCoordinator({ t: "signal", to: l.peer, data: { sdp: { type: local.type, sdp: local.sdp } } });
    } catch {
      // A glare the other side wins: its offer replaces ours.
    } finally {
      l.makingOffer = false;
    }
  }

  /** "Perfect negotiation" (SPEC §5.1): when both sides offer at once, the one whose id sorts later gives way. */
  async function onSignal(from: PeerId, data: SignalData): Promise<void> {
    const l = link(from, false);
    try {
      if (data.sdp) {
        const collision = data.sdp.type === "offer" && (l.makingOffer || l.pc.signalingState !== "stable");
        l.ignoreOffer = !l.polite && collision;
        if (l.ignoreOffer) return;
        await l.pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
        if (data.sdp.type === "offer") {
          await l.pc.setLocalDescription();
          const local = l.pc.localDescription;
          if (local) toCoordinator({ t: "signal", to: from, data: { sdp: { type: local.type, sdp: local.sdp } } });
        }
      } else if (data.candidate) {
        try {
          await l.pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
        } catch (e) {
          if (!l.ignoreOffer) throw e;
        }
      }
    } catch {
      // A link that cannot be negotiated times out and is counted as failed.
    }
  }

  function closeLink(l: Link, sayBye: boolean): void {
    if (l.closed) return;
    l.closed = true;
    if (sayBye && l.open) {
      try {
        l.ctl.send(encodePeerMessage({ t: "bye", reason: "leave" }));
      } catch {
        // Already gone.
      }
    }
    if (links.get(l.peer) === l) links.delete(l.peer);
    const close = (): void => {
      try {
        l.media.close();
        l.ctl.close();
        l.pc.close();
      } catch {
        // Already gone.
      }
    };
    // Give a goodbye the time to leave.
    if (sayBye) clock.setTimeout(close, 100);
    else close();
    if (up.backup === l.peer) {
      up.backup = null;
      void ensureBackup();
    }
  }

  /* ------------------------------ sending ------------------------------ */

  function sendPacket(l: Link, packet: Uint8Array, hopFlags: number, hops: number): void {
    if (!l.open || l.closed) return;
    writeHopFields(packet, { hopFlags, hops, linkSeq: l.seq++ & 0xffff, sendMs: ms16(clock.now()) });
    try {
      l.media.send(packet);
      relay.txBytes += packet.byteLength;
    } catch {
      // The channel closed under us.
    }
  }
  const echoOf = (l: Link, now: number): { echoMs: number; echoHoldMs: number } =>
    l.echo ? { echoMs: l.echo.sendMs, echoHoldMs: Math.min(0xfffe, Math.round(now - l.echo.at)) } : { echoMs: 0, echoHoldMs: ECHO_NONE };

  /* ------------------------------ frames: reassembly, the cache, forwarding ------------------------------ */

  const frames = new Map<number, Frame>();
  let latestKey = -1;
  let maxSeen = -1;
  let headComplete = -1;
  let oldestCached = 0;
  const relay = { txBytes: 0, forward: [] as number[], retransmitsSent: 0 };
  const counters = { duplicates: 0, nacksSent: 0, retransmitsReceived: 0, rendered: 0, dropped: 0, lost: 0 };
  let glass = emptyHistogram();
  let gaps = emptyHistogram();
  let events: MetricsEvent[] = [];

  const myDepth = (): number => (isSource ? 0 : up.path.length ? up.path.length : 255);
  const activeChildren = (): Link[] => [...links.values()].filter((l) => l.child?.mode === "active" && l.open);

  function forward(packet: Uint8Array, hopFlags: number, hops: number, receivedAt: number): void {
    let sent = false;
    for (const l of links.values()) {
      if (l.child?.mode !== "active") continue;
      sendPacket(l, packet, hopFlags, hops);
      sent = true;
    }
    if (sent && relay.forward.length < 4000) relay.forward.push((clock.now() - receivedAt) * 1000);
  }

  function replay(l: Link, fromFrame: number): void {
    if (fromFrame === FROM_LIVE || latestKey < 0) return;
    const start = fromFrame === FROM_LATEST_KEYFRAME || fromFrame + 1 < oldestCached ? latestKey : fromFrame + 1;
    for (let id = start; id <= maxSeen; id++) {
      const frame = frames.get(id);
      if (!frame) continue;
      for (const part of frame.parts) if (part) sendPacket(l, part, HopFlag.Replay, myDepth());
    }
  }

  function trimCache(now: number): void {
    // Keep the newest GOP whole, and whatever is younger than the cache's time limit.
    for (const [id, frame] of frames) {
      if (id >= latestKey || now - frame.firstAt < params.gopCacheMs) break;
      if (!isSource && id >= playHead) break;
      frames.delete(id);
      oldestCached = id + 1;
    }
  }

  function onMedia(l: Link, packet: Uint8Array, now: number): void {
    if (l.peer !== up.parent) return;
    const header = decodeMediaHeader(packet);
    if (!header || header.type !== PacketType.Media || header.streamId !== 0 || header.hops >= 32) return;
    if (header.frameId < oldestCached) return;
    let frame = frames.get(header.frameId);
    if (!frame) {
      frame = { id: header.frameId, flags: header.flags, temporal: header.temporal, refDelta: header.refDelta, captureMs: header.captureUs / 1000, parts: new Array<Uint8Array | undefined>(header.fragCount), got: 0, complete: false, firstAt: now, replayed: false, nacks: 0, nackAt: 0 };
      frames.set(header.frameId, frame);
      if (header.frameId > maxSeen) maxSeen = header.frameId;
    }
    if (frame.parts.length === 0) {
      // A frame known only by its absence (it was asked for whole): this is the first of it.
      frame.parts = new Array<Uint8Array | undefined>(header.fragCount);
      frame.flags = header.flags;
      frame.temporal = header.temporal;
      frame.refDelta = header.refDelta;
      frame.captureMs = header.captureUs / 1000;
    }
    if (frame.parts[header.fragIndex]) {
      counters.duplicates++;
      return;
    }
    frame.parts[header.fragIndex] = packet;
    frame.got++;
    if (header.hopFlags & HopFlag.Replay) frame.replayed = true;
    if (header.hopFlags & HopFlag.Retransmit) counters.retransmitsReceived++;
    if (upstream.firstPacketAt === 0) upstream.firstPacketAt = sessionNow();
    if (repairing && repairing.next === l.peer && repairing.firstPacket === null) firstPacketAfterRepair();
    if (waiting && waiting.firstPacket === null && !l.stalled && !(header.hopFlags & HopFlag.Retransmit)) {
      waiting.firstPacket = waiting.resubscribed = sessionNow();
      const record = waiting;
      clock.setTimeout(() => finishRepair(record), 1000);
      up.state = "active";
      beat();
    }
    forward(packet, header.hopFlags, header.hops + 1, now);
    if (frame.got === frame.parts.length) {
      frame.complete = true;
      if (header.flags & MediaFlag.Key && frame.id > latestKey) latestKey = frame.id;
      if (frame.id > headComplete) headComplete = frame.id;
      if (!frame.replayed) noteDelay(sessionNow() - frame.captureMs);
      if (playHead < 0 && header.flags & MediaFlag.Key) playHead = frame.id;
      schedulePlayout(0);
    }
  }

  function publish(flags: number, temporal: number, refDelta: number, keyDelta: number, id: number, captureMs: number, data: Uint8Array): void {
    const now = clock.now();
    const packets = packetizeFrame({ type: PacketType.Media, flags, streamId: 0, stripe: 0, spatial: 0, temporal, refDelta, keyDelta, frameId: id, captureUs: Math.round(captureMs * 1000), configId: 0 }, data);
    frames.set(id, { id, flags, temporal, refDelta, captureMs, parts: packets, got: packets.length, complete: true, firstAt: now, replayed: false, nacks: 0, nackAt: 0 });
    maxSeen = headComplete = id;
    if (flags & MediaFlag.Key) latestKey = id;
    for (const packet of packets) forward(packet, 0, 0, now);
    trimCache(now);
    started = true;
  }

  /* ------------------------------ playout ------------------------------ */

  let playHead = -1;
  let delayMs = DEFAULT_PARAMS.playoutMinMs;
  const delayWindow = [0, 0, 0];
  const decoded = new Set<number>();
  /** Every frame decoded, with whether it was also shown: a late frame is decoded to keep the chain and not shown. */
  const renderLog: [at: number, id: number, shown: boolean][] = [];
  let lastRenderAt = 0;
  let playTimer: Cancel | null = null;
  let playAt = Infinity;
  let decoder: VideoDecoder | null = null;
  const awaitingOutput = new Map<number, number>();
  const upstream = { firstPacketAt: 0, linkedAt: 0, firstFrameAt: 0, turn: false };

  function noteDelay(ms: number): void {
    if (ms > delayWindow[0]) delayWindow[0] = ms;
    const target = Math.min(params.playoutMaxMs, Math.max(params.playoutMinMs, Math.max(...delayWindow) + 15));
    if (target > delayMs) delayMs = target;
  }
  function settleDelay(): void {
    const target = Math.min(params.playoutMaxMs, Math.max(params.playoutMinMs, Math.max(...delayWindow) + 15));
    // Up at once, down by no more than 10 ms a second.
    if (target < delayMs) delayMs = Math.max(target, delayMs - 10);
    delayWindow.unshift(0);
    delayWindow.length = 3;
  }

  function schedulePlayout(inMs: number): void {
    const at = clock.now() + Math.max(0, inMs);
    if (playTimer && playAt <= at) return;
    playTimer?.();
    playAt = at;
    playTimer = clock.setTimeout(() => {
      playTimer = null;
      playAt = Infinity;
      playout();
    }, Math.max(0, inMs));
  }

  function rendered(id: number, captureMs: number): void {
    const now = sessionNow();
    counters.rendered++;
    glass[latencyBucket(Math.max(0, now - captureMs))]++;
    if (lastRenderAt) {
      const gap = now - lastRenderAt;
      gaps[latencyBucket(gap)]++;
      if (gap > FREEZE_MS && events.length < 60) events.push({ t: "freeze", stream: 0, at: lastRenderAt, ms: Math.min(3_600_000, gap) });
    }
    lastRenderAt = now;
    renderLog.push([now, id, true]);
    if (renderLog.length > 600) renderLog.splice(0, 200);
    if (!upstream.firstFrameAt) {
      upstream.firstFrameAt = now;
      started = true;
      events.push({ t: "join", start: tConnect, welcome: Math.max(tConnect, tWelcome), linked: Math.max(tConnect, upstream.linkedAt), firstPacket: Math.max(tConnect, upstream.firstPacketAt), firstFrame: now, turn: upstream.turn });
    }
  }

  /** Decodes a frame and, unless it is too late to be worth showing, shows it. */
  function show(frame: Frame, late: boolean): void {
    decoded.add(frame.id);
    if (decoded.size > 400) for (const id of decoded) if (id < frame.id - 300) decoded.delete(id);
    if (late) {
      counters.dropped++;
      renderLog.push([sessionNow(), frame.id, false]);
    }
    if (!decoder) {
      if (!late) rendered(frame.id, frame.captureMs);
      return;
    }
    let bytes = 0;
    for (const part of frame.parts) bytes += mediaPayload(part as Uint8Array).byteLength;
    const data = new Uint8Array(bytes);
    let at = 0;
    for (const part of frame.parts) {
      const payload = mediaPayload(part as Uint8Array);
      data.set(payload, at);
      at += payload.byteLength;
    }
    if (!late) awaitingOutput.set(frame.id, frame.captureMs);
    try {
      decoder.decode(new EncodedVideoChunk({ type: frame.flags & MediaFlag.Key ? "key" : "delta", timestamp: frame.id * 1000, data: program.pad ? unpadFrame(data) : data }));
    } catch (e) {
      error = `decode: ${String(e)}`;
    }
  }

  function playout(): void {
    if (playHead < 0) return;
    for (let guard = 0; guard < 500; guard++) {
      const now = sessionNow();
      const frame = frames.get(playHead);
      if (frame?.complete) {
        const due = frame.captureMs + delayMs;
        if (now < due - 0.5) return schedulePlayout(due - now);
        // Behind, with newer frames waiting (a join or a repair replayed the cache): decode to catch up, show nothing stale.
        if (frame.flags & MediaFlag.Key || decoded.has(frame.id - frame.refDelta)) show(frame, now - due > 1.5 * frameMs && (headComplete > frame.id || now - due > params.playoutMaxMs));
        else counters.dropped++;
        playHead++;
        continue;
      }
      // Not here, or not whole. Is there anything after it to play instead?
      let later: Frame | null = null;
      for (let id = playHead + 1; id <= maxSeen; id++) {
        const candidate = frames.get(id);
        if (candidate?.complete) {
          later = candidate;
          break;
        }
      }
      if (!later) return schedulePlayout(5);
      const due = (frame ? frame.captureMs : later.captureMs - (later.id - playHead) * frameMs) + delayMs;
      const patience = frame && frame.flags & MediaFlag.Discardable ? 0 : STALL_MS;
      if (now < due + patience) return schedulePlayout(Math.min(5, due + patience - now));
      counters.lost++;
      playHead++;
    }
    schedulePlayout(1);
  }

  /* ------------------------------ upstream: subscribing, backups, repair ------------------------------ */

  const up: { parent: PeerId | null; backup: PeerId | null; state: "idle" | "subscribing" | "active" | "waiting" | "repairing" | "cold-repair"; path: PeerId[] } = { parent: null, backup: null, state: "idle", path: [] };
  let subId = 0;
  let repairing: RepairRecord | null = null;
  let waiting: RepairRecord | null = null;
  let waitingSince = 0;
  let backupBusy = false;

  async function subscribe(l: Link, how: "sub" | "repair" | "standby", fromFrame: number, dead?: PeerId): Promise<boolean> {
    if (!(await l.opened) || l.closed) return false;
    const id = subId++;
    const ack = new Promise<Extract<PeerMessage, { t: "sub-ack" }> | null>((resolve) => {
      l.acks.set(id, resolve);
      clock.setTimeout(() => {
        if (l.acks.delete(id)) resolve(null);
      }, 2000);
    });
    const message: PeerMessage =
      how === "repair"
        ? { t: "repair", id, stream: 0, stripes: [0], fromFrame, dead: dead ?? "" }
        : { t: "sub", id, stream: 0, stripes: [0], mode: how === "standby" ? "standby" : "active", fromFrame, maxSpatial: 0, maxTemporal: 2 };
    try {
      l.ctl.send(encodePeerMessage(message));
    } catch {
      return false;
    }
    const answer = await ack;
    if (!answer?.ok) return false;
    if (how === "standby") return true;
    if (answer.path && self && answer.path.includes(self)) return false;
    if (answer.config && !config) config = answer.config;
    l.path = answer.path ?? null;
    l.lastHeardAt = clock.now();
    l.stalled = false;
    setPath(answer.path ?? []);
    return true;
  }

  function setPath(parentPath: PeerId[]): void {
    up.path = parentPath;
    const mine = self ? [self, ...parentPath].slice(0, 64) : [];
    for (const l of links.values()) {
      if (!l.child || !l.open) continue;
      try {
        l.ctl.send(encodePeerMessage({ t: "path", path: mine }));
      } catch {
        // Closing.
      }
    }
  }

  /** The newest frame up to which nothing is missing: where a new parent should carry on from. */
  function resumeFrom(): number {
    if (playHead < 0) return FROM_LATEST_KEYFRAME;
    let id = playHead - 1;
    while (frames.get(id + 1)?.complete) id++;
    return Math.max(0, id);
  }

  async function join(assignments: Assignment[]): Promise<void> {
    const exclude: PeerId[] = [];
    let assignment: Assignment | null = assignments[0] ?? null;
    up.state = "subscribing";
    const until = clock.now() + FIND_PARENT_MS;
    while (clock.now() < until && !leaving) {
      const candidate = assignment?.parents[0];
      if (candidate) {
        const l = link(candidate.peer, true);
        if (await l.opened) {
          if (!upstream.linkedAt) {
            upstream.linkedAt = sessionNow();
            upstream.turn = l.turn;
          }
          up.parent = candidate.peer;
          if (await subscribe(l, "sub", FROM_LATEST_KEYFRAME)) {
            up.state = "active";
            sendStatus();
            const backup = assignment?.backups[0];
            if (backup) void takeBackup(backup.peer);
            else void ensureBackup();
            return;
          }
          up.parent = null;
        }
        exclude.push(candidate.peer);
      } else await new Promise<void>((resolve) => clock.setTimeout(resolve, 500));
      assignment = await need("parent", exclude);
      // Everyone offered has been tried: start again, the tree has moved on.
      if (assignment && assignment.parents.length === 0 && exclude.length) exclude.length = 0;
    }
    if (!leaving) error = `never found a parent in ${FIND_PARENT_MS / 1000} s`;
  }

  async function takeBackup(peer: PeerId): Promise<boolean> {
    if (peer === up.parent || peer === self) return false;
    const l = link(peer, true);
    if (!(await subscribe(l, "standby", FROM_LIVE))) return false;
    up.backup = peer;
    sendStatus();
    return true;
  }

  async function ensureBackup(): Promise<void> {
    if (backupBusy || leaving || isSource || up.backup || !up.parent) return;
    backupBusy = true;
    try {
      const assignment = await need("backup", up.parent ? [up.parent] : []);
      const candidate = assignment?.backups[0];
      if (candidate) await takeBackup(candidate.peer);
    } finally {
      backupBusy = false;
      // No backup is a peer one death from a cold repair: keep asking.
      if (!up.backup && !leaving) clock.setTimeout(() => void ensureBackup(), 2000);
    }
  }

  function firstPacketAfterRepair(): void {
    const record = repairing;
    if (!record) return;
    record.firstPacket = sessionNow();
    clock.setTimeout(() => finishRepair(record), 1000);
  }

  /** One second after media flowed again: measure the freeze as SPEC §12.2 defines it, and report. */
  function finishRepair(record: RepairRecord): void {
    if (repairing === record) repairing = null;
    if (waiting === record) waiting = null;
    const end = (record.firstPacket ?? sessionNow()) + (record.firstPacket === null ? 0 : 1000);
    // The freeze is between frames shown; a frame is lost if it was never even decoded.
    let before: [number, number, boolean] | null = null;
    let beforeShown: [number, number, boolean] | null = null;
    const window: [number, number, boolean][] = [];
    for (const entry of renderLog) {
      if (entry[0] <= record.lastHeard) {
        before = entry;
        if (entry[2]) beforeShown = entry;
      } else if (entry[0] <= end) window.push(entry);
    }
    let freezeMs = 0;
    let previous = beforeShown ? beforeShown[0] : record.lastHeard;
    let shown = 0;
    for (const entry of window) {
      if (!entry[2]) continue;
      shown++;
      freezeMs = Math.max(freezeMs, entry[0] - previous);
      previous = entry[0];
    }
    if (shown === 0) freezeMs = end - previous;
    let framesLost = 0;
    if (before && window.length) {
      const seen = new Set(window.map((entry) => entry[1]));
      for (let id = before[1] + 1; id < window[window.length - 1][1]; id++) if (!seen.has(id)) framesLost++;
    }
    if (events.length < 62) {
      events.push({
        t: "repair",
        stream: 0,
        stripe: 0,
        dead: record.dead,
        next: record.next,
        kind: record.kind,
        lastHeard: record.lastHeard,
        detected: record.detected,
        resubscribed: record.resubscribed,
        firstPacket: record.firstPacket,
        freezeMs: Math.max(0, Math.min(3_600_000, freezeMs)),
        framesLost,
        usedCoordinator: record.usedCoordinator,
      });
    }
  }

  async function repair(): Promise<void> {
    const dead = up.parent;
    if (!dead || repairing || leaving) return;
    const deadLink = links.get(dead);
    const lastHeardLocal = deadLink?.lastHeardAt ?? clock.now();
    const now = clock.now();
    const record: RepairRecord = { dead, next: null, kind: "warm", lastHeard: Math.max(0, sessionNow() - (now - lastHeardLocal)), detected: sessionNow(), resubscribed: 0, firstPacket: null, usedCoordinator: false };
    // A peer that was waiting for a stalled parent and gave up reports one repair, not two.
    if (waiting) record.lastHeard = waiting.lastHeard;
    waiting = null;
    repairing = record;
    up.state = "repairing";
    up.parent = null;
    // Tell the children at once that this is a stall and not a death, so they wait (SPEC §7.4).
    beat();
    if (deadLink) closeLink(deadLink, false);
    const from = resumeFrom();
    const failed: PeerId[] = [dead];

    const backup = up.backup ? links.get(up.backup) : undefined;
    up.backup = null;
    let next: Link | null = null;
    if (backup && backup.open && !backup.closed && now - backup.lastHeardAt < params.standbyDeadMs) {
      up.parent = backup.peer;
      record.next = backup.peer;
      if (await subscribe(backup, "repair", from, dead)) next = backup;
      else failed.push(backup.peer);
    }
    while (!next && !leaving) {
      record.kind = "cold";
      up.state = "cold-repair";
      up.parent = null;
      const assignment = await need("parent", failed);
      const candidate = assignment?.parents[0];
      if (!candidate) {
        // The coordinator is unreachable or has nobody: only joining needs it, but so does this.
        await new Promise<void>((resolve) => clock.setTimeout(resolve, 250));
        continue;
      }
      record.usedCoordinator = true;
      const l = link(candidate.peer, true);
      up.parent = candidate.peer;
      record.next = candidate.peer;
      if (await subscribe(l, "sub", from)) next = l;
      else failed.push(candidate.peer);
    }
    if (!next) return;
    up.state = "active";
    record.resubscribed = sessionNow();
    beat();
    toCoordinator({ t: "report", event: "parent-dead", stream: 0, stripe: 0, peer: dead, next: next.peer });
    sendStatus();
    // Media may have arrived before the answer was read.
    if (repairing === record && record.firstPacket === null) {
      clock.setTimeout(() => {
        if (repairing === record && record.firstPacket === null) finishRepair(record);
      }, 5000);
    }
    void ensureBackup();
  }

  /* ------------------------------ what arrives on a link ------------------------------ */

  function onPeerMessage(l: Link, text: string): void {
    let message: PeerMessage;
    try {
      message = decodePeerMessage(text);
    } catch {
      return;
    }
    switch (message.t) {
      case "sub":
      case "repair": {
        const active = message.t === "repair" || message.mode === "active";
        const fanout = isSource ? params.sourceFanout : role === "leaf" ? 0 : params.maxFanout;
        let code: "full" | "no-stream" | "loop" | "leaving" | null = null;
        if (leaving) code = "leaving";
        else if (up.path.includes(l.peer)) code = "loop";
        else if (!config || (!isSource && (up.state === "idle" || up.state === "subscribing"))) code = "no-stream";
        // A repair from a child that was standing by is never refused for want of a slot (SPEC §7.5).
        else if (message.t === "sub" && active && l.child?.mode !== "active" && activeChildren().length >= fanout) code = "full";
        if (code) {
          l.ctl.send(encodePeerMessage({ t: "sub-ack", id: message.id, ok: false, code }));
          return;
        }
        l.child = { mode: active ? "active" : "standby", lastHeardAt: clock.now(), beats: 0 };
        l.ctl.send(encodePeerMessage({ t: "sub-ack", id: message.id, ok: true, config: config ?? undefined, headFrame: Math.max(0, headComplete), keyFrame: Math.max(0, latestKey), path: self ? [self, ...up.path].slice(0, 64) : [], maxTemporal: 2 }));
        if (active) replay(l, message.fromFrame);
        sendStatus();
        return;
      }
      case "sub-ack":
        l.acks.get(message.id)?.(message);
        l.acks.delete(message.id);
        return;
      case "unsub":
        l.child = null;
        return;
      case "path":
        if (l.peer !== up.parent) return;
        if (self && message.path.includes(self)) {
          // Our parent now hangs below us: a loop. Leave it.
          void repair();
          return;
        }
        setPath(message.path);
        return;
      case "bye":
        if (l.peer === up.parent) void repair();
        else closeLink(l, false);
        return;
      default:
        return;
    }
  }

  function onPacket(l: Link, packet: Uint8Array): void {
    const now = clock.now();
    const fields = packetLinkFields(packet);
    if (!fields) return;
    l.lastHeardAt = now;
    l.echo = { sendMs: fields.sendMs, at: now };
    const rx = l.rx;
    rx.received++;
    rx.bytes += packet.byteLength;
    if (!rx.any) {
      rx.any = true;
      rx.highest = fields.linkSeq;
      rx.base = fields.linkSeq - 1;
    } else if (seq16Diff(fields.linkSeq, rx.highest & 0xffff) > 0) rx.highest += seq16Diff(fields.linkSeq, rx.highest & 0xffff);
    switch (fields.type) {
      case PacketType.Media:
        onMedia(l, packet, now);
        return;
      case PacketType.Heartbeat: {
        const heard = decodeHeartbeat(packet);
        if (!heard) return;
        if (heard.echoHoldMs !== ECHO_NONE) l.rttMs = rttFromEcho(now, heard.echoMs, heard.echoHoldMs) ?? l.rttMs;
        const stalled = (heard.flags & HeartbeatFlag.Stalled) !== 0;
        if (l.peer === up.parent && up.state === "active" && stalled && !l.stalled && !repairing) {
          // The parent has lost its own parent and is repairing: wait for it (SPEC §7.4).
          up.state = "waiting";
          waitingSince = now;
          waiting = { dead: l.peer, next: l.peer, kind: "wait", lastHeard: sessionNow(), detected: sessionNow(), resubscribed: 0, firstPacket: null, usedCoordinator: false };
          l.stalled = true;
          // Pass it down: our own children should wait too.
          beat();
        }
        l.stalled = stalled;
        return;
      }
      case PacketType.Feedback:
        if (l.child) l.child.lastHeardAt = now;
        return;
      case PacketType.Nack: {
        const nack = decodeNack(packet);
        if (!nack || l.child?.mode !== "active") return;
        l.child.lastHeardAt = now;
        for (const item of nack.items) {
          const frame = frames.get(item.frameId);
          if (!frame) continue;
          const wanted = nackFragments(item);
          const parts = wanted ? wanted.map((index) => frame.parts[index]) : frame.parts;
          for (const part of parts) {
            if (!part) continue;
            sendPacket(l, part, HopFlag.Retransmit, myDepth());
            relay.retransmitsSent++;
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /* ------------------------------ timers ------------------------------ */

  function beat(): void {
    const now = clock.now();
    const stalled = !isSource && up.state !== "active";
    const every = Math.max(1, Math.round(params.standbyHeartbeatMs / params.heartbeatMs));
    for (const l of links.values()) {
      const child = l.child;
      if (!child || !l.open) continue;
      if (now - child.lastHeardAt > params.childDeadMs && now - l.lastHeardAt > params.childDeadMs) {
        l.child = null;
        toCoordinator({ t: "report", event: "child-gone", stream: 0, stripe: 0, peer: l.peer });
        continue;
      }
      if (child.mode === "standby" && child.beats++ % every !== 0) continue;
      const flags = (stalled ? HeartbeatFlag.Stalled : 0) | (child.mode === "standby" ? HeartbeatFlag.Standby : 0) | (leaving ? HeartbeatFlag.Leaving : 0);
      const packet = encodeHeartbeat({ flags, linkSeq: l.seq++ & 0xffff, sendMs: ms16(now), ...echoOf(l, now), depth: Math.min(255, myDepth()), streams: latestKey >= 0 ? [{ streamId: 0, headFrameId: Math.max(0, headComplete), keyFrameId: latestKey }] : [] });
      try {
        l.media.send(packet);
      } catch {
        // Closing.
      }
    }
  }

  let feedbackBeats = 0;
  function feedback(): void {
    const now = clock.now();
    const slow = feedbackBeats++ % Math.max(1, Math.round(params.standbyHeartbeatMs / params.feedbackMs)) === 0;
    for (const peer of [up.parent, slow ? up.backup : null]) {
      const l = peer ? links.get(peer) : undefined;
      if (!l || !l.open) continue;
      const packet = encodeFeedback({
        flags: peer === up.backup ? FeedbackFlag.Standby : 0,
        linkSeq: l.seq++ & 0xffff,
        sendMs: ms16(now),
        ...echoOf(l, now),
        highestSeq: l.rx.highest & 0xffff,
        received: Math.min(0xffff, l.rx.received),
        expected: Math.min(0xffff, Math.max(0, l.rx.highest - l.rx.base)),
        jitterTenthsMs: 0,
        queueDelayTenthsMs: 0,
        playoutDelayMs: Math.round(delayMs),
        bufferMs: 0,
        maxSpatial: 0,
        maxTemporal: 2,
      });
      try {
        l.media.send(packet);
      } catch {
        // Closing.
      }
    }
  }

  function nackTick(now: number): void {
    const parent = up.parent ? links.get(up.parent) : undefined;
    if (!parent || !parent.open || playHead < 0 || up.state !== "active") return;
    const retryMs = (parent.rttMs ?? 120) + 30;
    const items: NackItem[] = [];
    for (let id = playHead; id < maxSeen && items.length < 48; id++) {
      const frame = frames.get(id);
      if (frame?.complete) continue;
      if (!frame) {
        // None of it came. A later frame did, so it is not merely late in being sent.
        const later = frames.get(id + 1) ?? frames.get(id + 2);
        if (!later || now - later.firstAt < REORDER_MS) continue;
        const ghost: Frame = { id, flags: 0, temporal: 0, refDelta: 0, captureMs: later.captureMs - frameMs, parts: [], got: 0, complete: false, firstAt: now, replayed: false, nacks: 1, nackAt: now };
        frames.set(id, ghost);
        items.push({ streamId: 0, frameId: id, firstFrag: NACK_WHOLE_FRAME, mask: 0 });
        continue;
      }
      if (frame.nacks > params.nackRetries || now - (frame.nacks ? frame.nackAt : frame.firstAt) < (frame.nacks ? retryMs : REORDER_MS)) continue;
      // Nothing is asked for that playout no longer wants.
      if (frame.parts.length && frame.captureMs + delayMs + STALL_MS < sessionNow()) continue;
      frame.nacks++;
      frame.nackAt = now;
      if (frame.parts.length === 0) {
        items.push({ streamId: 0, frameId: id, firstFrag: NACK_WHOLE_FRAME, mask: 0 });
        continue;
      }
      const missing: number[] = [];
      for (let i = 0; i < frame.parts.length; i++) if (!frame.parts[i]) missing.push(i);
      items.push(...nackItemsFor(0, id, missing));
    }
    if (items.length === 0) return;
    counters.nacksSent++;
    try {
      parent.media.send(encodeNack({ linkSeq: parent.seq++ & 0xffff, sendMs: ms16(now), items: items.slice(0, 64) }));
    } catch {
      // Closing.
    }
  }

  function tick(): void {
    const now = clock.now();
    if (isSource || leaving) return;
    const parent = up.parent ? links.get(up.parent) : undefined;
    if (up.state === "active" || up.state === "waiting") {
      if (!parent || now - parent.lastHeardAt > params.deadMs) void repair();
      else if (up.state === "waiting" && now - waitingSince > params.stallGraceMs && waiting && waiting.firstPacket === null) void repair();
    }
    const backup = up.backup ? links.get(up.backup) : undefined;
    if (up.backup && (!backup || (backup.open && now - backup.lastHeardAt > params.standbyDeadMs))) {
      if (backup) closeLink(backup, false);
      up.backup = null;
      toCoordinator({ t: "report", event: "backup-lost", stream: 0, stripe: 0, peer: backup?.peer ?? "" });
      void ensureBackup();
    }
    nackTick(now);
    trimCache(now);
  }

  /* ------------------------------ status and metrics ------------------------------ */

  function sendStatus(): void {
    if (!self) return;
    const children = [...links.values()].filter((l) => l.child?.mode === "active").length;
    const standby = [...links.values()].filter((l) => l.child?.mode === "standby").length;
    const fanout = isSource ? params.sourceFanout : role === "leaf" ? 0 : params.maxFanout;
    const parent = up.parent ? links.get(up.parent) : undefined;
    toCoordinator({ t: "status", depth: Math.min(255, myDepth()), links: isSource ? [] : [{ stream: 0, stripe: 0, parent: up.parent, backup: up.backup }], children, standby, free: Math.max(0, fanout - children), caps: caps(), lossPct: Math.round(upLossPct * 10) / 10, rttMs: parent?.rttMs ?? null });
  }

  const samples: MetricsSample[] = [];
  let sampleSeq = 0;
  let lastSampleAt = 0;
  const quantile = (values: number[], q: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };

  function sample(): void {
    if (!self || uncertaintyMs === Infinity) return;
    const now = sessionNow();
    const intervalMs = lastSampleAt ? now - lastSampleAt : params.metricsMs;
    lastSampleAt = now;
    settleDelay();
    const children = [...links.values()].filter((l) => l.child?.mode === "active").length;
    const standby = [...links.values()].filter((l) => l.child?.mode === "standby").length;
    const parent = up.parent ? links.get(up.parent) : undefined;
    const out: MetricsSample = {
      peer: self,
      seq: sampleSeq++,
      at: now,
      intervalMs: Math.max(0, Math.min(3_600_000, intervalMs)),
      role: isSource ? "source" : children > 0 ? "relay" : "leaf",
      depth: Math.min(255, myDepth()),
      playoutDelayMs: isSource ? 0 : Math.round(delayMs),
      events,
    };
    if (!isSource) out.video = { rendered: counters.rendered, dropped: counters.dropped, lost: counters.lost, glassToGlass: glass, frameGap: gaps, maxTemporal: 2 };
    if (parent) {
      const rx = parent.rx;
      const expected = rx.highest - rx.base;
      out.up = {
        parent: parent.peer,
        rttMs: parent.rttMs === null ? null : Math.max(0, parent.rttMs),
        lossPct: (upLossPct = expected > 0 ? Math.max(0, Math.min(100, 100 * (1 - rx.received / expected))) : 0),
        queueDelayMs: 0,
        rxKbps: (rx.bytes * 8) / Math.max(1, intervalMs),
        nacksSent: counters.nacksSent,
        retransmitsReceived: counters.retransmitsReceived,
        duplicates: counters.duplicates,
        turn: parent.turn,
      };
      rx.received = 0;
      rx.bytes = 0;
      rx.base = rx.highest;
    }
    if (children > 0 || standby > 0 || isSource) {
      out.relay = {
        children: Math.min(255, children),
        standby: Math.min(255, standby),
        txKbps: (relay.txBytes * 8) / Math.max(1, intervalMs),
        forwardP50Us: quantile(relay.forward, 0.5),
        forwardP95Us: quantile(relay.forward, 0.95),
        bufferedMaxBytes: Math.max(0, ...[...links.values()].map((l) => (l.child && l.open ? l.media.bufferedAmount : 0))),
        layerDrops: 0,
        retransmitsSent: relay.retransmitsSent,
      };
    }
    relay.txBytes = 0;
    relay.forward = [];
    relay.retransmitsSent = 0;
    counters.rendered = counters.dropped = counters.lost = counters.duplicates = counters.nacksSent = counters.retransmitsReceived = 0;
    glass = emptyHistogram();
    gaps = emptyHistogram();
    events = [];
    samples.push(out);
    if (samples.length > 2000) samples.shift();
    toCoordinator({ t: "metrics", sample: out });
  }

  /* ------------------------------ the source's program ------------------------------ */

  /** L1T3: T0 T2 T1 T2, a keyframe every `keyIntervalFrames`. Each frame needs the newest frame of a lower layer. */
  function layerOf(sinceKey: number): { temporal: number; refDelta: number } {
    const phase = sinceKey % 4;
    if (sinceKey === 0) return { temporal: 0, refDelta: 0 };
    if (phase === 0) return { temporal: 0, refDelta: 4 };
    if (phase === 2) return { temporal: 1, refDelta: 2 };
    return { temporal: 2, refDelta: 1 };
  }

  /** The size an encoder at the program's bitrate would make a frame of this layer. */
  function syntheticBytes(key: boolean, temporal: number): number {
    const meanBytes = (program.bitrateKbps * 1000) / 8 / program.fps;
    const weights = { key: 6, 0: 1.4, 1: 1, 2: 0.7 };
    const perGop = weights.key + (program.keyIntervalFrames / 4 - 1) * weights[0] + (program.keyIntervalFrames / 4) * weights[1] + (program.keyIntervalFrames / 2) * weights[2];
    const unit = (meanBytes * program.keyIntervalFrames) / perGop;
    return Math.max(1, Math.round(unit * (key ? weights.key : weights[Math.min(2, temporal) as 0 | 1 | 2])));
  }

  function startSynthetic(): void {
    // Frames of the sizes an encoder at this bitrate would make, with nothing in them.
    let id = 0;
    const t0 = clock.now();
    let cancel: Cancel | null = null;
    timers.push(() => cancel?.());
    const next = (): void => {
      if (leaving) return;
      const sinceKey = id % program.keyIntervalFrames;
      const { temporal, refDelta } = layerOf(sinceKey);
      const key = sinceKey === 0;
      publish((key ? MediaFlag.Key : 0) | (temporal === 2 ? MediaFlag.Discardable : 0), temporal, refDelta, sinceKey, id, sessionNow(), new Uint8Array(syntheticBytes(key, temporal)));
      id++;
      cancel = clock.setTimeout(next, Math.max(0, t0 + id * frameMs - clock.now()));
    };
    next();
  }

  /**
   * A padded camera frame (`program.pad`): its length, the encoded frame, then zeros up to the
   * synthetic size of its layer, so the stream is as big as asked and still decodes.
   */
  function padFrame(data: Uint8Array, key: boolean, temporal: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(4 + Math.max(data.byteLength, syntheticBytes(key, temporal)));
    new DataView(out.buffer).setUint32(0, data.byteLength);
    out.set(data, 4);
    return out;
  }
  function unpadFrame(data: Uint8Array): Uint8Array {
    if (data.byteLength < 4) return data;
    const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    return data.subarray(4, 4 + Math.min(length, data.byteLength - 4));
  }

  async function startCamera(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360, frameRate: program.fps } });
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const captures = new Map<number, number>();
    let id = 0;
    let sinceKey = 0;
    let lastBase = 0;
    let lastLower = 0;
    const encoder = new VideoEncoder({
      error: (e) => (error = `encode: ${String(e)}`),
      output: (chunk, metadata) => {
        const key = chunk.type === "key";
        const temporal = key ? 0 : ((metadata as { svc?: { temporalLayerId?: number } } | undefined)?.svc?.temporalLayerId ?? 0);
        if (key) sinceKey = 0;
        // What a frame needs: the newest frame of a lower layer, or for the base layer the last base frame.
        const reference = key ? id : temporal === 0 ? lastBase : temporal === 1 ? lastBase : lastLower;
        let data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (program.pad) data = padFrame(data, key, temporal);
        const captureMs = captures.get(chunk.timestamp) ?? sessionNow();
        captures.delete(chunk.timestamp);
        publish((key ? MediaFlag.Key : 0) | (temporal === 2 ? MediaFlag.Discardable : 0), temporal, Math.min(255, id - reference), sinceKey, id, captureMs, data);
        if (temporal === 0) lastBase = id;
        if (temporal <= 1) lastLower = id;
        id++;
        sinceKey++;
      },
    });
    encoder.configure({ codec: "vp8", width: settings.width ?? 640, height: settings.height ?? 360, bitrate: program.bitrateKbps * 1000, framerate: program.fps, latencyMode: "realtime", scalabilityMode: "L1T3" });
    const Processor = (globalThis as unknown as { MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
    const reader = new Processor({ track }).readable.getReader();
    let n = 0;
    void (async () => {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        if (!leaving && encoder.encodeQueueSize < 2) {
          captures.set(frame.timestamp, sessionNow());
          encoder.encode(frame, { keyFrame: n++ % program.keyIntervalFrames === 0 });
        }
        frame.close();
      }
    })();
    timers.push(() => track.stop());
  }

  /* ------------------------------ the peer ------------------------------ */

  async function start(): Promise<void> {
    localConnect = clock.now();
    await new Promise<void>((resolve, reject) => {
      welcomed = resolve;
      // Long enough to outlast the gate's 30 s coordinator outage: a viewer who arrives while the
      // coordinator is dead keeps knocking, as a person would wait, and joins late, not never.
      clock.setTimeout(() => reject(new Error("no welcome from the coordinator within 60 s")), 60_000);
      connectCoordinator().catch(reject);
    });
    // The session clock must be known before anything is stamped with it.
    for (let i = 0; i < 100 && uncertaintyMs === Infinity; i++) await new Promise<void>((resolve) => clock.setTimeout(resolve, 20));
    if (uncertaintyMs === Infinity) throw new Error("no answer to the clock probes");
    // `connect()` was called, and `welcome` arrived, before the session clock was known.
    tConnect = Math.max(0, localConnect + offset);
    tWelcome = Math.max(tConnect, localWelcome + offset);
    timers.push(clock.setInterval(probeClock, 30000));
    timers.push(clock.setInterval(beat, params.heartbeatMs));
    timers.push(clock.setInterval(feedback, params.feedbackMs));
    timers.push(clock.setInterval(tick, TICK_MS));
    timers.push(clock.setInterval(sample, params.metricsMs));
    timers.push(clock.setInterval(sendStatus, params.statusMs));
    if (isSource) {
      config = {
        id: 0,
        kind: "video",
        configId: 0,
        codec: "vp8",
        bitrateKbps: program.bitrateKbps,
        width: 640,
        height: 360,
        fps: program.fps,
        scalability: "L1T3",
        keyIntervalFrames: program.keyIntervalFrames,
        stripes: [{ index: 0, kind: "data", temporal: [0, 1, 2] }],
        sframe: false,
      };
      toCoordinator({ t: "streams", streams: [config] });
      if (program.source === "camera") await startCamera();
      else startSynthetic();
      return;
    }
    if (options.decode && program.source === "camera") {
      decoder = new VideoDecoder({
        error: (e) => (error = `decode: ${String(e)}`),
        output: (frame) => {
          const id = Math.round(frame.timestamp / 1000);
          const captureMs = awaitingOutput.get(id);
          awaitingOutput.delete(id);
          frame.close();
          if (captureMs !== undefined) rendered(id, captureMs);
        },
      });
      decoder.configure({ codec: "vp8", optimizeForLatency: true });
    }
    void join(firstAssign);
  }

  async function leave(): Promise<void> {
    if (leaving) return;
    leaving = true;
    sample();
    for (const l of [...links.values()]) closeLink(l, true);
    try {
      toCoordinator({ t: "bye" });
      socket?.close();
    } catch {
      // Already gone.
    }
    for (const cancel of timers) cancel();
    playTimer?.();
    await new Promise<void>((resolve) => clock.setTimeout(resolve, 150));
  }

  return {
    start,
    leave,
    takeSamples: () => samples.splice(0, samples.length),
    get peer() {
      return self;
    },
    get started() {
      return started;
    },
    get error() {
      return error;
    },
    // Half the best round trip, plus however far the offset still has to slew to the best estimate (SPEC §4.1).
    sessionTime: () => (uncertaintyMs === Infinity ? null : sessionNow()),
    clockUncertaintyMs: () => (uncertaintyMs === Infinity ? Infinity : uncertaintyMs + Math.abs(offsetTarget - currentOffset(clock.now()))),
    links: () => everLinked.map((l) => ({ peer: l.peer, open: l.open, failed: l.failed, turn: l.turn, candidates: l.candidates })),
    parent: () => up.parent,
    backup: () => up.backup,
    children: () => activeChildren().length,
    depth: myDepth,
  };
}
