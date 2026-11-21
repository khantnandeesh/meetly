/**
 * A fake of topology's node, as far as the congestion module is concerned: the send path of SPEC
 * §3.3 and nothing else. No repair, no GOP cache, no NACK, no coordinator. It exists so that the
 * estimator and the gate can be driven the way E-transport+topology's `OverlayNode` will drive
 * them (PLAN §2 rule 2: "build against interfaces, with fakes"). It sends and receives through
 * transport's `Link` interface (transport/types.ts): a fake one over a simulated pipe in unit tests
 * (./link.ts), the same fake over real data channels in the browser run.
 *
 * What it does, which is what the real node must do for this module to work:
 *
 * - every packet handed to `link.sendPacket` is told to that link's estimator (`onSent`), every
 *   packet the link raises as `packet` too (`onReceived`), and feedback and heartbeats are passed on;
 * - before the first packet of each frame, for each child: `onBuffered(link.bufferedAmount)`, then
 *   `gate.admit(header, bytes, estimator.estimate(now), now)`; the answer holds for the frame;
 * - every change of a child's cap goes to that child as a `layers` message (SPEC §11.3);
 * - a child sends FEEDBACK every `feedbackMs`, built from `takeFeedback`;
 * - a peer that receives PROBE packets answers with FEEDBACK of its own while they keep coming.
 */
import {
  MAX_MEDIA_PAYLOAD_BYTES,
  PacketType,
  decodeFeedback,
  decodeHeartbeat,
  decodeMediaHeader,
  encodeFeedback,
  encodeHeartbeat,
  encodeProbe,
  packetLinkFields,
  packetizeFrame,
  writeHopFields,
  MediaFlag,
  type MediaHeader,
  type PeerMessageOf,
} from "../../protocol";
import type { Link, SendClass } from "../../transport/types";
import type { LayerCap, LinkEstimate } from "../../types";
import { createLinkEstimator } from "../estimator";
import { createLayerGate, type GateVerdict } from "../gate";
import { probeView } from "../probe";
import type { LayerGate, LayerGateOptions, LinkEstimator, UplinkProbe } from "../types";
import { AUDIO_STREAM, VIDEO_STREAM, type SyntheticFrame } from "./program";

export type FakePeerOptions = {
  id: string;
  /** Depth: 0 is the source. Written into `hops`. */
  depth: number;
  /** *B*: the video stream's full bitrate. */
  streamKbps: number;
  temporalLayers: number;
  frameIntervalMs: number;
  heartbeatMs?: number;
  feedbackMs?: number;
  audioFrameMs?: number;
  /** This peer's clock is the caller's time plus this: no two peers need agree on the time. */
  clockOffsetMs?: number;
  createLinkEstimator?: (options: { bitrateKbps: number }) => LinkEstimator;
  createLayerGate?: (options: LayerGateOptions) => LayerGate;
};

export type CapChange = { at: number; maxTemporal: number; reason: "congestion" | "overload" | "restore" };

/** What a parent keeps for one child. */
export type ChildPort = {
  id: string;
  link: Link;
  estimator: LinkEstimator;
  /** The video stream's gate. */
  gate: LayerGate;
  /** The audio stream's: one per child and stream (SPEC §11.3). */
  audioGate: LayerGate;
  /** Per video frame: was it let through. */
  decisions: Map<number, boolean>;
  audioAgain: { packet: Uint8Array; dueAt: number }[];
  lastProbeAt: number;
  reporting: boolean;
  caps: CapChange[];
  starvedAt: number[];
  /** Video frames offered and sent, by temporal layer, and why the others were not. */
  offered: number[];
  sent: number[];
  refused: Record<Exclude<GateVerdict, "sent">, number>;
  /** The link's state at each video frame, for a test to read the timeline from. */
  states: { at: number; state: LinkEstimate["state"]; bufferedBytes: number }[];
};

export type FrameRecord = {
  frameId: number;
  temporal: number;
  key: boolean;
  refDelta: number;
  captureMs: number;
  fragCount: number;
  fragments: Set<number>;
  firstAt: number;
  /** Null until every fragment has arrived. */
  completeAt: number | null;
};

/** A `layers` message this peer heard from its parent, and when (the caller's time). */
export type LayersHeard = { at: number; message: PeerMessageOf<"layers"> };

export class FakePeer {
  readonly id: string;
  readonly children = new Map<string, ChildPort>();
  /** Frames received for this peer's own playout, by stream and frame id. */
  readonly frames = new Map<number, Map<number, FrameRecord>>([
    [VIDEO_STREAM, new Map()],
    [AUDIO_STREAM, new Map()],
  ]);
  duplicates = 0;
  /** The link to the parent, once `setParent` has been called. */
  up: { link: Link; estimator: LinkEstimator } | null = null;
  probe: UplinkProbe | null = null;
  wanted: LayerCap = { maxSpatial: 0, maxTemporal: 15 };
  /** Every `layers` message from the parent: what it says it is sending this peer, and why. */
  readonly layersHeard: LayersHeard[] = [];

  /** What to add to the caller's time to get this peer's clock. */
  readonly clockOffsetMs: number;
  private readonly offset: number;
  private readonly heartbeatMs: number;
  private readonly feedbackMs: number;
  private readonly audioFrameMs: number;
  private lastHeartbeat = -Infinity;
  private lastFeedback = -Infinity;

  constructor(private readonly options: FakePeerOptions) {
    this.id = options.id;
    this.offset = options.clockOffsetMs ?? 0;
    this.clockOffsetMs = this.offset;
    this.heartbeatMs = options.heartbeatMs ?? 50;
    this.feedbackMs = options.feedbackMs ?? 100;
    this.audioFrameMs = options.audioFrameMs ?? 20;
  }

  private estimator(): LinkEstimator {
    return (this.options.createLinkEstimator ?? createLinkEstimator)({ bitrateKbps: this.options.streamKbps });
  }

  /** The link's `receivedAt` is this peer's clock; the methods below take the caller's. */
  setParent(link: Link): void {
    this.up = { link, estimator: this.estimator() };
    link.on("packet", (packet, receivedAt) => this.fromParent(packet, receivedAt - this.offset));
    link.on("message", (message) => {
      if (message.t === "layers") this.layersHeard.push({ at: this.lastAt, message });
    });
  }

  addChild(id: string, link: Link, at: number): ChildPort {
    const gate = (this.options.createLayerGate ?? createLayerGate)({
      bitrateKbps: this.options.streamKbps,
      temporalLayers: this.options.temporalLayers,
      frameIntervalMs: this.options.frameIntervalMs,
      kind: "video",
    });
    const audioGate = (this.options.createLayerGate ?? createLayerGate)({ bitrateKbps: 32, temporalLayers: 1, frameIntervalMs: this.audioFrameMs, kind: "audio" });
    const port: ChildPort = {
      id,
      link,
      estimator: this.estimator(),
      gate,
      audioGate,
      decisions: new Map(),
      audioAgain: [],
      lastProbeAt: -Infinity,
      reporting: false,
      caps: [{ at, maxTemporal: gate.cap.maxTemporal, reason: "restore" }],
      starvedAt: [],
      offered: new Array<number>(this.options.temporalLayers).fill(0),
      sent: new Array<number>(this.options.temporalLayers).fill(0),
      refused: { "above-cap": 0, stale: 0, starved: 0, undecodable: 0 },
      states: [],
    };
    // Every change of cap is told to the child (SPEC §11.3), and starved is told as congestion.
    const tell = (cap: LayerCap, reason: "congestion" | "overload" | "restore"): void =>
      link.sendMessage({ t: "layers", stream: VIDEO_STREAM, maxSpatial: cap.maxSpatial, maxTemporal: cap.maxTemporal, reason });
    gate.on("change", (cap, reason) => {
      port.caps.push({ at: this.lastAt, maxTemporal: cap.maxTemporal, reason });
      tell(cap, reason);
    });
    gate.on("starved", () => {
      port.starvedAt.push(this.lastAt);
      tell(gate.cap, "congestion");
    });
    link.on("packet", (packet, receivedAt) => this.fromChild(id, packet, receivedAt - this.offset));
    this.children.set(id, port);
    return port;
  }

  /** The caller's time of the call in progress: what `change` and `starved` are stamped with. */
  private lastAt = 0;

  /* ------------------------------ sending ------------------------------ */

  /** The node's part of a hop: `hops` and the hop flags. The link sets `linkSeq` and `sendMs`. */
  private sendMedia(port: ChildPort, packet: Uint8Array, sendClass: SendClass, at: number): void {
    writeHopFields(packet, { hopFlags: 0, hops: this.options.depth, linkSeq: 0, sendMs: 0 });
    this.send(port, packet, sendClass, at);
  }

  /** One packet through transport's `Link`, and its estimator told. */
  private send(link: { link: Link; estimator: LinkEstimator }, packet: Uint8Array, sendClass: SendClass, at: number): void {
    if (link.link.sendPacket(packet, sendClass)) link.estimator.onSent(packet.byteLength, at + this.offset);
  }

  /** The gate's answer for a video frame, asked once, at the frame's first packet. */
  private admitted(port: ChildPort, header: MediaHeader, frameBytes: number, at: number): boolean {
    const known = port.decisions.get(header.frameId);
    if (known !== undefined) return known;
    const now = at + this.offset;
    port.estimator.onBuffered(port.link.bufferedAmount, now);
    const estimate = port.estimator.estimate(now);
    const admit = port.gate.admit(header, frameBytes, estimate, now);
    port.decisions.set(header.frameId, admit);
    if (port.decisions.size > 512) for (const old of port.decisions.keys()) if (port.decisions.size > 256) port.decisions.delete(old);
    port.states.push({ at, state: estimate.state, bufferedBytes: estimate.bufferedBytes });
    port.offered[header.temporal]++;
    if (admit) port.sent[header.temporal]++;
    else {
      const why = (port.gate as Partial<{ lastVerdict: GateVerdict }>).lastVerdict;
      if (why !== undefined && why !== "sent") port.refused[why]++;
    }
    return admit;
  }

  /** One packet to every child that is to have it. The same buffer serves them all in turn (SPEC §4.2). */
  private fanOut(packet: Uint8Array, header: MediaHeader, frameBytes: number, at: number): void {
    for (const port of this.children.values()) {
      if (header.streamId === AUDIO_STREAM) {
        // Rule 1, and [D25]: audio always goes, and goes twice on every hop.
        if (!port.audioGate.admit(header, frameBytes, port.estimator.estimate(at + this.offset), at + this.offset)) throw new Error("the gate refused audio");
        this.sendMedia(port, packet, "audio", at);
        port.audioAgain.push({ packet: packet.slice(), dueAt: at + this.audioFrameMs });
      } else if (this.admitted(port, header, frameBytes, at)) {
        this.sendMedia(port, packet, "video", at);
      }
    }
  }

  /** The source only: a frame from the encoder. */
  publish(frame: SyntheticFrame, at: number): void {
    this.lastAt = at;
    for (const packet of packetizeFrame(frame.header, frame.data)) {
      const header = decodeMediaHeader(packet);
      if (header) this.fanOut(packet, header, frame.data.byteLength, at);
    }
  }

  /* ------------------------------ receiving ------------------------------ */

  fromParent(packet: Uint8Array, at: number): void {
    this.lastAt = at;
    const up = this.up;
    const fields = packetLinkFields(packet);
    if (!up || !fields) return;
    const now = at + this.offset;
    up.estimator.onReceived(fields.linkSeq, fields.sendMs, packet.byteLength, now);
    if (fields.type === PacketType.Heartbeat) {
      const heartbeat = decodeHeartbeat(packet);
      if (heartbeat) up.estimator.onHeartbeat(heartbeat, now);
    } else if (fields.type === PacketType.Feedback) {
      const feedback = decodeFeedback(packet);
      if (feedback) up.estimator.onFeedback(feedback, now);
    } else if (fields.type === PacketType.Media) {
      const header = decodeMediaHeader(packet);
      if (!header || header.hops >= 32) return;
      if (!this.record(header, at)) return;
      // Forwarding does not wait for the frame (SPEC §3.3). A relay does not know a frame's size
      // at its first packet: the fragment count is what it has.
      this.fanOut(packet, header, header.fragCount * MAX_MEDIA_PAYLOAD_BYTES, at);
    }
  }

  /** False for a duplicate. */
  private record(header: MediaHeader, at: number): boolean {
    const stream = this.frames.get(header.streamId);
    if (!stream) return false;
    let frame = stream.get(header.frameId);
    if (!frame) {
      frame = {
        frameId: header.frameId,
        temporal: header.temporal,
        key: (header.flags & MediaFlag.Key) !== 0,
        refDelta: header.refDelta,
        captureMs: header.captureUs / 1000,
        fragCount: header.fragCount,
        fragments: new Set(),
        firstAt: at,
        completeAt: null,
      };
      stream.set(header.frameId, frame);
    }
    if (frame.fragments.has(header.fragIndex)) {
      this.duplicates++;
      return false;
    }
    frame.fragments.add(header.fragIndex);
    if (frame.fragments.size === frame.fragCount) frame.completeAt = at;
    return true;
  }

  fromChild(id: string, packet: Uint8Array, at: number): void {
    this.lastAt = at;
    const port = this.children.get(id);
    const fields = packetLinkFields(packet);
    if (!port || !fields) return;
    const now = at + this.offset;
    port.estimator.onReceived(fields.linkSeq, fields.sendMs, packet.byteLength, now);
    if (fields.type === PacketType.Feedback) {
      const feedback = decodeFeedback(packet);
      if (!feedback) return;
      port.estimator.onFeedback(feedback, now);
      port.gate.setWanted({ maxSpatial: feedback.maxSpatial, maxTemporal: feedback.maxTemporal });
    } else if (fields.type === PacketType.Probe) {
      port.lastProbeAt = at;
    }
  }

  /* ------------------------------ timers ------------------------------ */

  private feedbackPacket(link: { estimator: LinkEstimator }, now: number): Uint8Array {
    return encodeFeedback({
      ...link.estimator.takeFeedback(now),
      flags: 0,
      linkSeq: 0,
      sendMs: 0,
      playoutDelayMs: 0,
      bufferMs: 0,
      maxSpatial: Math.min(15, this.wanted.maxSpatial),
      maxTemporal: Math.min(15, this.wanted.maxTemporal),
    });
  }

  /** Call often (every few milliseconds). Everything that is due is done. */
  tick(at: number): void {
    this.lastAt = at;
    const now = at + this.offset;

    for (const port of this.children.values()) {
      while (port.audioAgain.length > 0 && port.audioAgain[0].dueAt <= at) this.sendMedia(port, port.audioAgain.shift()!.packet, "audio", at);
    }

    if (at - this.lastHeartbeat >= this.heartbeatMs) {
      this.lastHeartbeat = at;
      for (const port of this.children.values()) {
        this.send(port, encodeHeartbeat({ flags: 0, linkSeq: 0, sendMs: 0, ...port.estimator.echo(now), depth: this.options.depth, streams: [] }), "control", at);
      }
    }

    if (at - this.lastFeedback >= this.feedbackMs) {
      this.lastFeedback = at;
      if (this.up) this.send(this.up, this.feedbackPacket(this.up, now), "control", at);
      // A child that is probing needs to hear how its probe fared (SPEC §11.6): feedback goes
      // down the link too, for as long as probe packets keep coming.
      for (const port of this.children.values()) {
        const probing = at - port.lastProbeAt < 1000;
        if (probing && !port.reporting)
          port.estimator.takeFeedback(now); // start the count afresh
        else if (probing) this.send(port, this.feedbackPacket(port, now), "control", at);
        port.reporting = probing;
      }
    }

    if (this.probe && this.up) {
      this.up.estimator.onBuffered(this.up.link.bufferedAmount, now);
      for (const size of this.probe.next(probeView(this.up.estimator, now), now)) this.send(this.up, encodeProbe({ linkSeq: 0, sendMs: 0, size }), "replay", at);
    }
  }
}
