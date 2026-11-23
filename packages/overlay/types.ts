/**
 * Types that more than one module passes to another, and that are not on the wire (those are in
 * ./protocol.ts). Shared file: see docs/overlay/PLAN.md "Shared files".
 */
import type { FrameHeader, PeerId } from "./protocol";

/**
 * One encoded frame, whole. What the source's encoder produces, what a reassembler produces from
 * packets, and what the jitter buffer takes.
 */
export type EncodedFrame = {
  header: FrameHeader;
  /** The encoded bytes (SFrame ciphertext when `header.flags` has `MediaFlag.SFrame`). */
  data: Uint8Array;
};

/** A frame put back together from packets, with when its first and last packets arrived. */
export type ReceivedFrame = EncodedFrame & {
  /** This machine's `Clock`, in milliseconds. */
  firstPacketAt: number;
  completeAt: number;
  /** Who sent the packet that completed it. */
  from: PeerId;
  /** Some of it came from a replay or a retransmission rather than live. */
  recovered: boolean;
};

/** How one link is doing, as the congestion module judges it. Read by topology and by metrics. */
export type LinkEstimate = {
  /** Null before the first echo. */
  rttMs: number | null;
  /** Packets lost on the way, in percent, over the last second. */
  lossPct: number;
  /** One-way delay above its floor: a queue is building. */
  queueDelayMs: number;
  jitterMs: number;
  /** What was handed to the channel, over the last second. */
  sendKbps: number;
  /** What the other end says arrived, over the last second. */
  deliveredKbps: number;
  /** Bytes the channel is holding that have not left yet (`RTCDataChannel.bufferedAmount`). */
  bufferedBytes: number;
  /** "ok": send everything. "strained": do not add. "congested": shed (SPEC §11). */
  state: "ok" | "strained" | "congested";
};

/** The layers of a stream that a link carries at most. */
export type LayerCap = { maxSpatial: number; maxTemporal: number };
