/**
 * Links: one `RTCPeerConnection` per neighbour, with a reliable `ctl` channel for `PeerMessage`s
 * and an unreliable `media` channel for packets. SPEC §3.2, §5.
 *
 * - Either side may start, and both may at once: "perfect negotiation", in which the side whose
 *   `PeerId` sorts later gives way (D7).
 * - The first message on `ctl` is `hello` with the sender's grant. A link is "open" only when
 *   both channels are open and the other side's `hello` has been verified; until then nothing
 *   it sends is passed on.
 * - Sending never blocks and never queues stale media in the browser: when the channel is backed
 *   up, packets wait here by class (control, audio, video, replay) and video is shed first.
 *
 * Nothing here touches the DOM beyond the connection and its channels (D2).
 *
 * Owner: E-transport+topology.
 */
import {
  PROTOCOL_VERSION,
  PacketType,
  ProtocolError,
  decodePeerMessage,
  encodePeerMessage,
  ms16,
  peekPacketType,
  type PeerId,
  type PeerMessage,
  type SignalData,
} from "../protocol";
import type { Cancel } from "../runtime";
import { Emitter } from "./emitter";
import type { Link, LinkCloseReason, LinkCounters, LinkEvents, LinkManager, LinkManagerEvents, LinkState, PacketChannel, SendClass, TransportOptions } from "./types";

/** The data channels every link has. Negotiated out of band (`negotiated: true`), so no `datachannel` event is needed. */
export const CHANNELS = {
  /** Reliable and ordered: `PeerMessage` as JSON text. */
  ctl: { id: 0, label: "ctl", ordered: true },
  /** Unordered, no retransmission: every binary packet type. */
  media: { id: 1, label: "media", ordered: false, maxRetransmits: 0 },
} as const;

/** No valid `hello` this long after `ctl` opened: "auth-failed" (SPEC §5.2). */
export const HELLO_TIMEOUT_MS = 5000;
/** Not open this long after it was started: "timeout". */
export const CONNECT_TIMEOUT_MS = 15_000;
/** This many messages in a row that do not parse close the link (SPEC §5.3). */
export const MAX_BAD_MESSAGES = 3;
/** More malformed packets than this in one second close the link (SPEC §14). */
export const MAX_BAD_PACKETS_PER_S = 100;

/** Above this much in the channel's own buffer, packets wait in the link's queue instead, where their class decides the order. */
const DEFAULT_HIGH_WATER_BYTES = 64 * 1024;
/** The most video and replay the queue holds; beyond it they are shed. */
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;
/** The most control or audio packets the queue holds; beyond it the oldest go. */
const MAX_URGENT_QUEUE = 256;
const DRAIN_MS = 4;
const MAX_HELD_MESSAGES = 64;

const CLASSES: readonly SendClass[] = ["control", "audio", "video", "replay"];

/** `RTCDataChannel` as a `PacketChannel`: the one place the DOM type is touched. */
function adaptChannel(dc: RTCDataChannel): PacketChannel {
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
  dc.onmessage = (event: MessageEvent) => channel.onmessage?.(event.data as ArrayBuffer | string);
  return channel;
}

/**
 * [D83] A link's connection, its two channels and an offer for it, made before the peer at the
 * other end is known: a joiner sends the offer in `hello`, and the coordinator gives it to the
 * parent it places the joiner under. Nothing is gathered until the link takes it, with the ICE
 * servers from `welcome` (`setConfiguration`, then `setLocalDescription` of this same offer).
 */
export class PreparedOffer {
  private taken = false;
  /** @internal */
  constructor(
    readonly sdp: string,
    /** @internal */ readonly pc: RTCPeerConnection,
    /** @internal */ readonly ctl: RTCDataChannel,
    /** @internal */ readonly media: RTCDataChannel,
    /** @internal */ readonly offer: RTCSessionDescriptionInit,
  ) {}

  /** @internal The link that uses it. Once. */
  take(): void {
    if (this.taken) throw new Error("overlay transport: a prepared offer is used once");
    this.taken = true;
  }

  get used(): boolean {
    return this.taken;
  }

  /** Not used after all (no parent in `welcome`, or a coordinator that did not pass it on). */
  close(): void {
    if (this.taken) return;
    this.taken = true;
    try {
      this.pc.close();
    } catch {
      // Already closed.
    }
  }
}

/** A prepared offer, or null where there is no WebRTC or it fails: the join then goes as before. */
export async function prepareOffer(peerConnection?: (config: RTCConfiguration) => RTCPeerConnection): Promise<PreparedOffer | null> {
  let pc: RTCPeerConnection | null = null;
  try {
    pc = peerConnection ? peerConnection({ iceServers: [] }) : new RTCPeerConnection({ iceServers: [] });
    const made = pc;
    const channel = (kind: "ctl" | "media") => {
      const { label, ...init } = CHANNELS[kind];
      return made.createDataChannel(label, { negotiated: true, ...init });
    };
    const ctl = channel("ctl");
    const media = channel("media");
    const offer = await pc.createOffer();
    if (offer.type !== "offer" || !offer.sdp) throw new Error("no offer");
    return new PreparedOffer(offer.sdp, pc, ctl, media, { type: offer.type, sdp: offer.sdp });
  } catch {
    try {
      pc?.close();
    } catch {
      // Already closed.
    }
    return null;
  }
}

class LinkImpl implements Link {
  readonly peer: PeerId;
  state: LinkState = "connecting";
  turn = false;

  private readonly events = new Emitter<LinkEvents>((error) => this.options.logger?.error("link", "a listener threw", error));
  private readonly pc: RTCPeerConnection;
  private readonly ctl: PacketChannel;
  private readonly media: PacketChannel;
  /** The side that gives way when both offer at once: the later `PeerId`. */
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private signalling: Promise<void> = Promise.resolve();

  private hello: "none" | "verifying" | "ok" = "none";
  private held: PeerMessage[] = [];
  private outbox: PeerMessage[] = [];
  private badMessages = 0;
  private badPackets = 0;
  private badPacketsSince = 0;

  private linkSeq = 0;
  private readonly queues: Record<SendClass, Uint8Array[]> = { control: [], audio: [], video: [], replay: [] };
  private queuedBytes = 0;
  private queuedBulkBytes = 0;
  private drainTimer: Cancel | null = null;
  private helloTimer: Cancel | null = null;
  private connectTimer: Cancel | null = null;
  private readonly highWater: number;
  private readonly maxQueue: number;

  private readonly count: LinkCounters = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, bytesReceived: 0, packetsShed: 0 };
  /** Messages and packets dropped because they did not parse, or came before `hello`. */
  dropped = 0;

  constructor(
    peer: PeerId,
    private readonly options: TransportOptions,
    private readonly onClosed: (link: LinkImpl) => void,
    prepared?: PreparedOffer,
  ) {
    this.peer = peer;
    this.polite = options.self > peer;
    this.highWater = options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
    this.maxQueue = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    const config: RTCConfiguration = { iceServers: options.ice.map((server) => ({ urls: server.urls, username: server.username, credential: server.credential })) };
    if (prepared) {
      prepared.take();
      this.pc = prepared.pc;
      try {
        // Before anything is gathered: the offer was made without them.
        this.pc.setConfiguration(config);
      } catch (error) {
        options.logger?.warn("link", `ICE servers for the prepared link to ${peer} not set`, error);
      }
    } else this.pc = options.peerConnection ? options.peerConnection(config) : new RTCPeerConnection(config);
    const wrap = (kind: "ctl" | "media"): PacketChannel => {
      const { label, ...init } = CHANNELS[kind];
      const channel = adaptChannel(prepared ? prepared[kind] : this.pc.createDataChannel(label, { negotiated: true, ...init }));
      return options.wrapChannel ? options.wrapChannel(channel, { peer, kind }) : channel;
    };
    this.ctl = wrap("ctl");
    this.media = wrap("media");

    this.ctl.onopen = () => this.onCtlOpen();
    this.media.onopen = () => this.maybeOpen();
    this.ctl.onclose = () => this.close("channel-closed");
    this.media.onclose = () => this.close("channel-closed");
    this.ctl.onmessage = (data) => this.onCtlMessage(data);
    this.media.onmessage = (data) => this.onMediaMessage(data);

    this.pc.onicecandidate = (event) => {
      if (this.state === "closed") return;
      options.signaler.send(peer, { candidate: event.candidate ? (event.candidate.toJSON() as SignalData["candidate"]) : null });
    };
    this.pc.onnegotiationneeded = () => void this.offer();
    this.pc.oniceconnectionstatechange = () => {
      const ice = this.pc.iceConnectionState;
      if (ice === "failed") this.close("ice-failed");
      else if (ice === "connected" || ice === "completed") void this.readRoute();
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "failed") this.close("ice-failed");
      else if (this.pc.connectionState === "closed") this.close("channel-closed");
    };
    this.connectTimer = options.clock.setTimeout(() => {
      if (this.state === "connecting") this.close("timeout");
    }, CONNECT_TIMEOUT_MS);
    if (prepared) {
      // [D83] The other side has this offer already, from the coordinator: it is only applied
      // here, which starts gathering, and its answer comes as any other.
      this.makingOffer = true;
      this.signalling = this.signalling
        .then(() => this.pc.setLocalDescription(prepared.offer))
        .catch((error: unknown) => {
          this.options.logger?.warn("link", `the prepared offer to ${peer} failed`, error);
          this.close("local");
        })
        .finally(() => {
          this.makingOffer = false;
        });
    }
    // A channel made by a test double may be open already.
    if (this.ctl.readyState === "open") this.onCtlOpen();
  }

  on<K extends keyof LinkEvents>(event: K, listener: (...args: LinkEvents[K]) => void) {
    return this.events.on(event, listener);
  }

  get bufferedAmount(): number {
    return this.state === "open" ? this.media.bufferedAmount + this.queuedBytes : this.queuedBytes;
  }

  counters(): LinkCounters {
    return { ...this.count };
  }

  /* ------------------------------ signalling ------------------------------ */

  private async offer(): Promise<void> {
    // Fired while an offer from the other side is being answered: that answer settles it. Or
    // while this side's own is being made, or a prepared one applied (D83).
    if (this.state === "closed" || this.makingOffer || this.pc.signalingState !== "stable") return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const local = this.pc.localDescription;
      if (local && this.stateNotClosed()) this.options.signaler.send(this.peer, { sdp: { type: local.type, sdp: local.sdp } });
    } catch (error) {
      this.options.logger?.warn("link", `offer to ${this.peer} failed`, error);
    } finally {
      this.makingOffer = false;
    }
  }

  private stateNotClosed(): boolean {
    return this.state !== "closed";
  }

  /** Signalling from the other side. Handled one at a time, in order. */
  signal(data: SignalData): void {
    this.signalling = this.signalling
      .then(async () => {
        if (this.state === "closed") return;
        if (data.sdp) {
          const collision = data.sdp.type === "offer" && (this.makingOffer || this.pc.signalingState !== "stable");
          this.ignoreOffer = !this.polite && collision;
          if (this.ignoreOffer) return;
          // On the polite side this rolls its own offer back.
          await this.pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === "offer") {
            await this.pc.setLocalDescription();
            const local = this.pc.localDescription;
            if (local && this.stateNotClosed()) this.options.signaler.send(this.peer, { sdp: { type: local.type, sdp: local.sdp } });
          }
        } else if (data.candidate) {
          try {
            await this.pc.addIceCandidate(data.candidate);
          } catch (error) {
            // A candidate for an offer this side ignored is expected to fail.
            if (!this.ignoreOffer) throw error;
          }
        }
      })
      .catch((error: unknown) => {
        this.options.logger?.warn("link", `signalling with ${this.peer} failed`, error);
      });
  }

  /** Whether the route chosen goes through TURN. Asked once ICE has connected. */
  private async readRoute(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((report: Record<string, unknown>) => byId.set(report.id as string, report));
      for (const report of byId.values()) {
        if (report.type !== "candidate-pair" || report.state !== "succeeded" || !(report.nominated || report.selected)) continue;
        const local = byId.get(report.localCandidateId as string);
        const remote = byId.get(report.remoteCandidateId as string);
        this.turn = local?.candidateType === "relay" || remote?.candidateType === "relay";
        return;
      }
    } catch {
      // No statistics: leave it as not through TURN.
    }
  }

  /* ------------------------------ hello ------------------------------ */

  private onCtlOpen(): void {
    if (this.state !== "connecting" || this.helloTimer) return;
    try {
      this.ctl.send(encodePeerMessage({ t: "hello", v: PROTOCOL_VERSION, peer: this.options.self, grant: this.options.grant() }));
    } catch (error) {
      this.options.logger?.warn("link", `hello to ${this.peer} failed`, error);
    }
    this.helloTimer = this.options.clock.setTimeout(() => {
      if (this.hello !== "ok") this.close("auth-failed");
    }, HELLO_TIMEOUT_MS);
    this.maybeOpen();
  }

  private maybeOpen(): void {
    if (this.state !== "connecting" || this.hello !== "ok" || this.ctl.readyState !== "open" || this.media.readyState !== "open") return;
    this.state = "open";
    this.connectTimer?.();
    this.connectTimer = null;
    this.helloTimer?.();
    for (const message of this.outbox.splice(0)) this.sendMessage(message);
    this.events.emit("state", "open");
    for (const message of this.held.splice(0)) this.deliver(message);
  }

  private onCtlMessage(data: ArrayBuffer | string): void {
    if (this.state === "closed") return;
    let message: PeerMessage;
    try {
      if (typeof data !== "string") throw new ProtocolError("binary on ctl");
      message = decodePeerMessage(data);
    } catch {
      this.dropped++;
      if (++this.badMessages >= MAX_BAD_MESSAGES) this.close(this.hello === "ok" ? "local" : "auth-failed");
      return;
    }
    this.badMessages = 0;
    if (this.hello === "none") {
      // Until a valid hello, everything else is dropped (SPEC §5.2).
      if (message.t !== "hello") {
        this.dropped++;
        return;
      }
      if (message.v !== PROTOCOL_VERSION || message.peer !== this.peer) {
        this.close("auth-failed");
        return;
      }
      this.hello = "verifying";
      this.options.verifyPeer(message.peer, message.grant).then(
        (ok) => {
          if (this.state === "closed") return;
          if (!ok) return this.close("auth-failed");
          this.hello = "ok";
          this.maybeOpen();
        },
        () => this.close("auth-failed"),
      );
      return;
    }
    if (message.t === "hello") return;
    if (this.state !== "open") {
      // Sent after a hello that is still being checked, or before the media channel opened: kept, in order.
      if (this.held.length < MAX_HELD_MESSAGES) this.held.push(message);
      else this.dropped++;
      return;
    }
    this.deliver(message);
  }

  private deliver(message: PeerMessage): void {
    if (this.state !== "open") return;
    this.events.emit("message", message);
    if (message.t === "bye") this.close("remote-bye");
  }

  /* ------------------------------ receiving ------------------------------ */

  private onMediaMessage(data: ArrayBuffer | string): void {
    if (this.state !== "open" || typeof data === "string") {
      this.dropped++;
      return;
    }
    const packet = new Uint8Array(data);
    const now = this.options.clock.now();
    if (peekPacketType(packet) === null) {
      this.noteBadPacket(now);
      return;
    }
    this.count.packetsReceived++;
    this.count.bytesReceived += packet.byteLength;
    this.events.emit("packet", packet, now);
  }

  /** A packet that did not decode: counted, and past `MAX_BAD_PACKETS_PER_S` the link is closed. Also called by the node. */
  noteBadPacket(now: number): void {
    this.dropped++;
    if (now - this.badPacketsSince >= 1000) {
      this.badPacketsSince = now;
      this.badPackets = 0;
    }
    if (++this.badPackets > MAX_BAD_PACKETS_PER_S) this.close("local");
  }

  /* ------------------------------ sending ------------------------------ */

  sendMessage(message: PeerMessage): void {
    if (this.state === "closed") return;
    if (this.state !== "open") {
      this.outbox.push(message);
      return;
    }
    try {
      this.ctl.send(encodePeerMessage(message));
    } catch (error) {
      this.options.logger?.warn("link", `message to ${this.peer} not sent`, error);
    }
  }

  sendPacket(packet: Uint8Array, sendClass: SendClass): boolean {
    if (this.state !== "open" || packet.byteLength < 6) {
      this.count.packetsShed++;
      return false;
    }
    if (this.queuedBytes === 0 && this.media.bufferedAmount <= this.highWater) return this.hand(packet);
    // The channel is backed up. Wait in line by class; a copy, because the caller reuses its buffer.
    const queue = this.queues[sendClass];
    if (sendClass === "video" || sendClass === "replay") {
      if (this.queuedBulkBytes + packet.byteLength > this.maxQueue) {
        this.count.packetsShed++;
        return false;
      }
      this.queuedBulkBytes += packet.byteLength;
    } else if (queue.length >= MAX_URGENT_QUEUE) {
      this.queuedBytes -= queue.shift()!.byteLength;
      this.count.packetsShed++;
    }
    queue.push(packet.slice());
    this.queuedBytes += packet.byteLength;
    this.drainTimer ??= this.options.clock.setInterval(() => this.drain(), DRAIN_MS);
    this.drain();
    return true;
  }

  /** Stamps `linkSeq` and `sendMs` and gives the packet to the channel. */
  private hand(packet: Uint8Array): boolean {
    const type = packet[0] & 0x0f;
    const at = type === PacketType.Media || type === PacketType.Parity ? 26 : 2;
    if (packet.byteLength < at + 4) {
      this.count.packetsShed++;
      return false;
    }
    const seq = this.linkSeq;
    const sendMs = ms16(this.options.clock.now());
    packet[at] = seq >> 8;
    packet[at + 1] = seq & 0xff;
    packet[at + 2] = sendMs >> 8;
    packet[at + 3] = sendMs & 0xff;
    try {
      this.media.send(packet);
    } catch {
      this.count.packetsShed++;
      return false;
    }
    this.linkSeq = (seq + 1) & 0xffff;
    this.count.packetsSent++;
    this.count.bytesSent += packet.byteLength;
    return true;
  }

  private drain(): void {
    if (this.state !== "open") return;
    for (const sendClass of CLASSES) {
      const queue = this.queues[sendClass];
      while (queue.length > 0) {
        if (this.media.bufferedAmount > this.highWater) return;
        const packet = queue.shift()!;
        this.queuedBytes -= packet.byteLength;
        if (sendClass === "video" || sendClass === "replay") this.queuedBulkBytes -= packet.byteLength;
        this.hand(packet);
      }
    }
    this.drainTimer?.();
    this.drainTimer = null;
  }

  /* ------------------------------ closing ------------------------------ */

  close(reason: LinkCloseReason = "local"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.connectTimer?.();
    this.helloTimer?.();
    this.drainTimer?.();
    this.connectTimer = this.helloTimer = this.drainTimer = null;
    for (const sendClass of CLASSES) this.queues[sendClass].length = 0;
    this.queuedBytes = this.queuedBulkBytes = 0;
    this.outbox.length = 0;
    this.held.length = 0;
    this.ctl.onclose = this.media.onclose = null;
    this.ctl.onmessage = this.media.onmessage = null;
    this.pc.onicecandidate = this.pc.onnegotiationneeded = this.pc.oniceconnectionstatechange = this.pc.onconnectionstatechange = null;
    try {
      this.ctl.close();
      this.media.close();
      this.pc.close();
    } catch {
      // Already gone.
    }
    this.onClosed(this);
    this.events.emit("state", "closed", reason);
  }
}

export function createLinkManager(options: TransportOptions): LinkManager {
  const events = new Emitter<LinkManagerEvents>((error) => options.logger?.error("links", "a listener threw", error));
  const links = new Map<PeerId, LinkImpl>();

  const make = (peer: PeerId, prepared?: PreparedOffer): LinkImpl => {
    const link = new LinkImpl(
      peer,
      options,
      (closed) => {
        if (links.get(peer) === closed) links.delete(peer);
      },
      prepared,
    );
    links.set(peer, link);
    return link;
  };
  // [D83] Made at once, before any signal can come: the other side's answer may be on its way.
  if (options.prepared && options.prepared.peer !== options.self && !options.prepared.offer.used) make(options.prepared.peer, options.prepared.offer);

  options.signaler.onSignal((from, data) => {
    if (from === options.self) return;
    let link = links.get(from);
    if (!link) {
      // Only an offer starts a link: a stray candidate for one that is gone does not.
      if (data.sdp?.type !== "offer") return;
      link = make(from);
      events.emit("incoming", link);
    }
    link.signal(data);
  });

  return {
    on: (event, listener) => events.on(event, listener),
    connect(peer) {
      if (peer === options.self) throw new RangeError("overlay transport: a peer does not link to itself");
      return links.get(peer) ?? make(peer);
    },
    get: (peer) => links.get(peer),
    links: () => [...links.values()],
    closeAll() {
      for (const link of [...links.values()]) link.close("local");
    },
  };
}
