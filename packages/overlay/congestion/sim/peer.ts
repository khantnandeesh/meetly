/**
 * A fake of topology's node, as far as the congestion module is concerned: the send path of SPEC
 * §3.3 and nothing else. No repair, no GOP cache, no NACK, no coordinator. It exists so that the
 * estimator and the gate can be driven the way E-transport+topology's `OverlayNode` will drive
 * them (PLAN §2 rule 2: "build against interfaces, with fakes"), over a simulated pipe in unit
 * tests and over real data channels in the browser run.
 *
 * What it does, which is what the real node must do for this module to work:
 *
 * - every packet handed to a channel is told to that link's estimator (`onSent`), every packet
 *   that arrives too (`onReceived`), and feedback and heartbeats are passed on;
 * - before the first packet of each frame, for each child: `onBuffered(bufferedAmount)`, then
 *   `gate.admit(header, bytes, estimator.estimate(now), now)`; the answer holds for the frame;
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
  ms16,
  packetLinkFields,
  packetizeFrame,
  writeHopFields,
  MediaFlag,
  type MediaHeader,
} from "../../protocol";
import type { LayerCap, LinkEstimate } from "../../types";
import { createLinkEstimator } from "../estimator";
import { createLayerGate, type GateVerdict } from "../gate";
import { probeView } from "../probe";
import type { LayerGate, LayerGateOptions, LinkEstimator, UplinkProbe } from "../types";
import { AUDIO_STREAM, VIDEO_STREAM, type SyntheticFrame } from "./program";
import type { Pipe } from "./world";

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
  pipe: Pipe;
  estimator: LinkEstimator;
  /** The video stream's gate. */
  gate: LayerGate;
  /** The audio stream's: one per child and stream (SPEC §11.3). */
  audioGate: LayerGate;
  linkSeq: number;
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

const setLinkFields = (packet: Uint8Array, linkSeq: number, sendMs: number): void => {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  view.setUint16(2, linkSeq);
  view.setUint16(4, sendMs);
};

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
  up: { pipe: Pipe; estimator: LinkEstimator; linkSeq: number } | null = null;
  probe: UplinkProbe | null = null;
  wanted: LayerCap = { maxSpatial: 0, maxTemporal: 15 };

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

  setParent(pipe: Pipe): void {
    this.up = { pipe, estimator: this.estimator(), linkSeq: 0 };
  }

  addChild(id: string, pipe: Pipe, at: number): ChildPort {
    const gate = (this.options.createLayerGate ?? createLayerGate)({
      bitrateKbps: this.options.streamKbps,
      temporalLayers: this.options.temporalLayers,
      frameIntervalMs: this.options.frameIntervalMs,
      kind: "video",
    });
    const audioGate = (this.options.createLayerGate ?? createLayerGate)({ bitrateKbps: 32, temporalLayers: 1, frameIntervalMs: this.audioFrameMs, kind: "audio" });
    const port: ChildPort = {
      id,
      pipe,
      estimator: this.estimator(),
      gate,
      audioGate,
      linkSeq: 0,
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
    gate.on("change", (cap, reason) => port.caps.push({ at: this.lastAt, maxTemporal: cap.maxTemporal, reason }));
    gate.on("starved", () => port.starvedAt.push(this.lastAt));
    this.children.set(id, port);
    return port;
  }

  /** The caller's time of the call in progress: what `change` and `starved` are stamped with. */
  private lastAt = 0;

  /* ------------------------------ sending ------------------------------ */

  private sendMedia(port: ChildPort, packet: Uint8Array, at: number): void {
    const now = at + this.offset;
    writeHopFields(packet, { hopFlags: 0, hops: this.options.depth, linkSeq: port.linkSeq, sendMs: ms16(now) });
    port.linkSeq = (port.linkSeq + 1) & 0xffff;
    port.pipe.send(packet);
    port.estimator.onSent(packet.byteLength, now);
  }

  private sendOther(link: { pipe: Pipe; estimator: LinkEstimator; linkSeq: number }, packet: Uint8Array, at: number): void {
    const now = at + this.offset;
    setLinkFields(packet, link.linkSeq, ms16(now));
    link.linkSeq = (link.linkSeq + 1) & 0xffff;
    link.pipe.send(packet);
    link.estimator.onSent(packet.byteLength, now);
  }

  /** The gate's answer for a video frame, asked once, at the frame's first packet. */
  private admitted(port: ChildPort, header: MediaHeader, frameBytes: number, at: number): boolean {
    const known = port.decisions.get(header.frameId);
    if (known !== undefined) return known;
    const now = at + this.offset;
    port.estimator.onBuffered(port.pipe.bufferedAmount, now);
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
        this.sendMedia(port, packet, at);
        port.audioAgain.push({ packet: packet.slice(), dueAt: at + this.audioFrameMs });
      } else if (this.admitted(port, header, frameBytes, at)) {
        this.sendMedia(port, packet, at);
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
      while (port.audioAgain.length > 0 && port.audioAgain[0].dueAt <= at) this.sendMedia(port, port.audioAgain.shift()!.packet, at);
    }

    if (at - this.lastHeartbeat >= this.heartbeatMs) {
      this.lastHeartbeat = at;
      for (const port of this.children.values()) {
        this.sendOther(port, encodeHeartbeat({ flags: 0, linkSeq: 0, sendMs: 0, ...port.estimator.echo(now), depth: this.options.depth, streams: [] }), at);
      }
    }

    if (at - this.lastFeedback >= this.feedbackMs) {
      this.lastFeedback = at;
      if (this.up) this.sendOther(this.up, this.feedbackPacket(this.up, now), at);
      // A child that is probing needs to hear how its probe fared (SPEC §11.6): feedback goes
      // down the link too, for as long as probe packets keep coming.
      for (const port of this.children.values()) {
        const probing = at - port.lastProbeAt < 1000;
        if (probing && !port.reporting)
          port.estimator.takeFeedback(now); // start the count afresh
        else if (probing) this.sendOther(port, this.feedbackPacket(port, now), at);
        port.reporting = probing;
      }
    }

    if (this.probe && this.up) {
      this.up.estimator.onBuffered(this.up.pipe.bufferedAmount, now);
      for (const size of this.probe.next(probeView(this.up.estimator, now), now)) this.sendOther(this.up, encodeProbe({ linkSeq: 0, sendMs: 0, size }), at);
    }
  }
}
