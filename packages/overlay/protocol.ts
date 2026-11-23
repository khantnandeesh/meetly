/**
 * The overlay's wire protocol: every type that crosses a link, and its encoder and decoder.
 *
 * docs/overlay/SPEC.md §4–§6 is the prose for this file; if the two disagree, fix both in one
 * change. Every module in this package depends on this file and on nothing else of each other's
 * internals, so a change here is a change to everyone's work: see docs/overlay/PLAN.md "Shared
 * files" for who may edit it and how.
 *
 * Three kinds of traffic:
 *
 * 1. Packets on a link's unreliable channel (media, parity, heartbeat, feedback, nack, probe).
 *    Binary, big-endian. Their decoders return null for anything malformed, of another protocol
 *    version, or of an unknown type: this is the hot path, the input is untrusted, and an
 *    unreliable channel has no use for an exception.
 * 2. Peer messages on a link's reliable channel (`PeerMessage`). JSON text.
 * 3. Messages to and from the coordinator's WebSocket (`ClientMessage`, `ServerMessage`). JSON
 *    text.
 *
 * JSON decoders throw `ProtocolError` on anything that is not exactly a known message. Unknown
 * fields are dropped, not kept, so a newer peer's additions cannot ride through an older one.
 *
 * Nothing here touches the DOM, WebRTC or Node: it runs in a browser, a Worker, Node and a
 * Durable Object. The only platform API used is WebCrypto (`crypto.subtle`), for grants and
 * tickets.
 */

/* ------------------------------------------------------------------------------------------ */
/* Versions and limits                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** Carried in the high nibble of every packet's first byte and in `hello`. 1..15. */
export const PROTOCOL_VERSION = 1;

/** Bytes of header in front of a media or parity packet's payload. */
export const MEDIA_HEADER_BYTES = 30;
/** The header's first bytes that no relay changes. With SFrame they are authenticated (AAD). */
export const MEDIA_E2E_HEADER_BYTES = 24;
/**
 * The most one packet may be, header included. Chosen to fit an IPv6 minimum-MTU path (1280)
 * under IP, UDP, DTLS and SCTP overhead with room for a TURN ChannelData header, so no packet is
 * fragmented below us.
 */
export const MAX_PACKET_BYTES = 1150;
export const MAX_MEDIA_PAYLOAD_BYTES = MAX_PACKET_BYTES - MEDIA_HEADER_BYTES;
/** `fragCount` is a u16. */
export const MAX_FRAGMENTS = 0xffff;
export const MAX_FRAME_BYTES = MAX_FRAGMENTS * MAX_MEDIA_PAYLOAD_BYTES;
/** `captureUs` is 48 bits: microseconds on the session clock (8.9 years). */
export const MAX_CAPTURE_US = 2 ** 48 - 1;
export const MAX_HEARTBEAT_STREAMS = 16;
export const MAX_NACK_ITEMS = 64;
/** In a NACK item: the whole frame is missing, so its fragment count is not known. */
export const NACK_WHOLE_FRAME = 0xffff;

export const PacketType = {
  /** A fragment of one encoded frame. */
  Media: 0,
  /** A parity symbol over media packets of a stripe (stage 2; the payload's scheme is not fixed yet). */
  Parity: 1,
  /** Parent to child: I am alive, and this is how far I have got. */
  Heartbeat: 2,
  /** Child to parent: what arrived, and how. */
  Feedback: 3,
  /** Child to parent: send these fragments again. */
  Nack: 4,
  /** Padding, to measure a link without media. */
  Probe: 5,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

/** `MediaHeader.flags`: end to end, set by the source, never changed by a relay. */
export const MediaFlag = {
  /** The frame is a keyframe: decodable with nothing before it. */
  Key: 0x01,
  /** The payload is SFrame ciphertext (stage 2). */
  SFrame: 0x02,
  /** No other frame depends on this one, so it can be dropped without breaking decode. */
  Discardable: 0x04,
  /** The stream's last frame: nothing follows until a new `StreamConfig`. */
  EndOfStream: 0x08,
} as const;

/** `MediaHeader.hopFlags`: set by whoever sent this copy of the packet over this link. */
export const HopFlag = {
  /** Sent from the GOP cache to catch a subscriber up, not as it arrived. */
  Replay: 0x01,
  /** Sent again in answer to a NACK. */
  Retransmit: 0x02,
} as const;

export const HeartbeatFlag = {
  /** I have lost my own parent and am repairing. Wait for me (`stallGraceMs`) before leaving. */
  Stalled: 0x01,
  /** I am about to leave. Move now. */
  Leaving: 0x02,
  /** I have no free slot: do not send me new subscribers. */
  Full: 0x04,
  /** This link is a standby one: nothing but heartbeats flows on it. */
  Standby: 0x08,
} as const;

export const FeedbackFlag = {
  /** This link is a standby one. */
  Standby: 0x01,
  /** My playout is stalling for want of data from you. */
  Starved: 0x02,
} as const;

/* ------------------------------------------------------------------------------------------ */
/* Small helpers                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** A JSON message was not one this protocol version knows. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const view = (buf: Uint8Array) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const u8ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xff;
const u16ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xffff;
const u32ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

function need(ok: boolean, what: string): asserts ok {
  if (!ok) throw new RangeError(`overlay protocol: ${what} out of range`);
}

/** The packet's type, or null if it is too short or of another protocol version. */
export function peekPacketType(buf: Uint8Array): PacketType | null {
  if (buf.byteLength < 1 || buf[0] >> 4 !== PROTOCOL_VERSION) return null;
  const type = buf[0] & 0x0f;
  return type <= PacketType.Probe ? (type as PacketType) : null;
}

/**
 * How far `a` is ahead of `b` among 16-bit sequence numbers that wrap: positive when `a` is
 * newer, in -32768..32767. For `linkSeq`, `sendMs` and `echoMs`.
 */
export function seq16Diff(a: number, b: number): number {
  return (((a - b) & 0xffff) ^ 0x8000) - 0x8000;
}

/** The low 16 bits of a millisecond clock, as `sendMs` carries it. */
export const ms16 = (ms: number): number => Math.floor(ms) & 0xffff;

/**
 * A round-trip time in milliseconds from an echo: `now` is this side's clock when the packet
 * carrying the echo arrived, `echoMs` the `sendMs` of ours that the peer last saw, `echoHoldMs`
 * how long the peer held it. Null when the peer has nothing of ours to echo yet (`echoHoldMs`
 * 0xffff). Only good for round trips under about 30 seconds.
 */
export function rttFromEcho(now: number, echoMs: number, echoHoldMs: number): number | null {
  if (echoHoldMs === ECHO_NONE) return null;
  const rtt = ((ms16(now) - echoMs - echoHoldMs) & 0xffff) >>> 0;
  return rtt > 0x7fff ? null : rtt;
}
/** `echoHoldMs` when there is nothing to echo. */
export const ECHO_NONE = 0xffff;

/* ------------------------------------------------------------------------------------------ */
/* Media and parity packets                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * The header of a media (or parity) packet. 30 bytes, big-endian:
 *
 * ```
 *  off  size  field
 *  ---  ----  end-to-end section: written by the source, identical on every hop -------------
 *    0     1  version (high 4 bits) | packet type (low 4 bits)
 *    1     1  flags                     MediaFlag bits
 *    2     1  streamId
 *    3     1  stripe
 *    4     1  spatial layer (high 4 bits) | temporal layer (low 4 bits)
 *    5     1  refDelta                  frameId minus the frame this one needs; 0 = none
 *    6     2  keyDelta                  frameId minus its GOP's keyframe; 0 on a keyframe
 *    8     4  frameId
 *   12     2  fragIndex
 *   14     2  fragCount                 1..65535
 *   16     6  captureUs                 microseconds on the session clock
 *   22     1  configId                  which StreamConfig this frame was encoded under
 *   23     1  reserved, 0
 *  ---  ----  hop section: rewritten by each sender for each receiver ------------------------
 *   24     1  hopFlags                  HopFlag bits
 *   25     1  hops                      0 from the source, +1 at each relay
 *   26     2  linkSeq                   per link and direction, over every packet type
 *   28     2  sendMs                    low 16 bits of the sender's millisecond clock
 * ```
 */
export type MediaHeader = {
  /** `PacketType.Media` or `PacketType.Parity`. */
  type: typeof PacketType.Media | typeof PacketType.Parity;
  flags: number;
  /** Which of the session's streams (`StreamConfig.id`). */
  streamId: number;
  /** Which stripe of the stream this packet travels on (`StripeConfig.index`). */
  stripe: number;
  /** 0..15. */
  spatial: number;
  /** 0..15. 0 is the base layer. */
  temporal: number;
  /**
   * The one frame this frame needs decoded first is `frameId - refDelta`. 0 on a keyframe, and
   * on audio. A receiver can order and drop frames from this alone, without reading the payload,
   * which SFrame will make unreadable.
   */
  refDelta: number;
  /** The keyframe that starts this frame's GOP is `frameId - keyDelta`. */
  keyDelta: number;
  /** Counts the stream's frames from 0, one per encoded frame, over all its layers and stripes. */
  frameId: number;
  fragIndex: number;
  fragCount: number;
  /**
   * When the frame was captured, in microseconds on the session clock (SPEC §4.1). It is the
   * frame's presentation time, shared by audio and video, and what latency is measured from.
   */
  captureUs: number;
  configId: number;
  hopFlags: number;
  hops: number;
  linkSeq: number;
  sendMs: number;
};

/** What a sender sets on each copy of a packet it sends. */
export type HopFields = Pick<MediaHeader, "hopFlags" | "hops" | "linkSeq" | "sendMs">;

/** Writes `header` at the start of `out` (which must have room for it). Throws RangeError on a field out of range. */
export function encodeMediaHeader(header: MediaHeader, out: Uint8Array): void {
  need(out.byteLength >= MEDIA_HEADER_BYTES, "buffer");
  need(header.type === PacketType.Media || header.type === PacketType.Parity, "type");
  need(u8ok(header.flags) && u8ok(header.streamId) && u8ok(header.stripe), "flags, streamId or stripe");
  need(Number.isInteger(header.spatial) && header.spatial >= 0 && header.spatial <= 15, "spatial");
  need(Number.isInteger(header.temporal) && header.temporal >= 0 && header.temporal <= 15, "temporal");
  need(u8ok(header.refDelta) && u16ok(header.keyDelta) && u32ok(header.frameId), "refDelta, keyDelta or frameId");
  need(u16ok(header.fragCount) && header.fragCount >= 1, "fragCount");
  need(u16ok(header.fragIndex) && header.fragIndex < header.fragCount, "fragIndex");
  need(Number.isInteger(header.captureUs) && header.captureUs >= 0 && header.captureUs <= MAX_CAPTURE_US, "captureUs");
  need(u8ok(header.configId), "configId");
  const dv = view(out);
  dv.setUint8(0, (PROTOCOL_VERSION << 4) | header.type);
  dv.setUint8(1, header.flags);
  dv.setUint8(2, header.streamId);
  dv.setUint8(3, header.stripe);
  dv.setUint8(4, (header.spatial << 4) | header.temporal);
  dv.setUint8(5, header.refDelta);
  dv.setUint16(6, header.keyDelta);
  dv.setUint32(8, header.frameId);
  dv.setUint16(12, header.fragIndex);
  dv.setUint16(14, header.fragCount);
  dv.setUint16(16, Math.floor(header.captureUs / 0x100000000));
  dv.setUint32(18, header.captureUs >>> 0);
  dv.setUint8(22, header.configId);
  dv.setUint8(23, 0);
  writeHopFields(out, header);
}

/**
 * Sets the hop section of an encoded media packet, in place. A relay forwards a packet by
 * calling this on the bytes it received and sending them: `RTCDataChannel.send` copies its
 * argument, so one buffer serves every child in turn.
 */
export function writeHopFields(packet: Uint8Array, hop: HopFields): void {
  need(packet.byteLength >= MEDIA_HEADER_BYTES, "buffer");
  need(u8ok(hop.hopFlags) && u8ok(hop.hops) && u16ok(hop.linkSeq) && u16ok(hop.sendMs), "hop fields");
  const dv = view(packet);
  dv.setUint8(24, hop.hopFlags);
  dv.setUint8(25, hop.hops);
  dv.setUint16(26, hop.linkSeq);
  dv.setUint16(28, hop.sendMs);
}

/** The header of a media or parity packet, or null if `packet` is not a well-formed one. */
export function decodeMediaHeader(packet: Uint8Array): MediaHeader | null {
  if (packet.byteLength < MEDIA_HEADER_BYTES || packet.byteLength > MAX_PACKET_BYTES) return null;
  const type = peekPacketType(packet);
  if (type !== PacketType.Media && type !== PacketType.Parity) return null;
  const dv = view(packet);
  const fragIndex = dv.getUint16(12);
  const fragCount = dv.getUint16(14);
  if (fragCount === 0 || fragIndex >= fragCount) return null;
  const layer = dv.getUint8(4);
  return {
    type,
    flags: dv.getUint8(1),
    streamId: dv.getUint8(2),
    stripe: dv.getUint8(3),
    spatial: layer >> 4,
    temporal: layer & 0x0f,
    refDelta: dv.getUint8(5),
    keyDelta: dv.getUint16(6),
    frameId: dv.getUint32(8),
    fragIndex,
    fragCount,
    captureUs: dv.getUint16(16) * 0x100000000 + dv.getUint32(18),
    configId: dv.getUint8(22),
    hopFlags: dv.getUint8(24),
    hops: dv.getUint8(25),
    linkSeq: dv.getUint16(26),
    sendMs: dv.getUint16(28),
  };
}

/** A media packet's payload: a view onto `packet`, not a copy. */
export function mediaPayload(packet: Uint8Array): Uint8Array {
  return packet.subarray(MEDIA_HEADER_BYTES);
}

/** What `packetizeFrame` needs to know about a frame: its header less the per-fragment and per-hop fields. */
export type FrameHeader = Omit<MediaHeader, "fragIndex" | "fragCount" | keyof HopFields>;

/**
 * One encoded frame as the packets that carry it, each at most `MAX_PACKET_BYTES`. The hop
 * section is zero; the sender fills it with `writeHopFields` as it sends. An empty frame is one
 * packet with no payload.
 */
export function packetizeFrame(frame: FrameHeader, data: Uint8Array, maxPayload: number = MAX_MEDIA_PAYLOAD_BYTES): Uint8Array[] {
  need(Number.isInteger(maxPayload) && maxPayload >= 1 && maxPayload <= MAX_MEDIA_PAYLOAD_BYTES, "maxPayload");
  const fragCount = Math.max(1, Math.ceil(data.byteLength / maxPayload));
  need(fragCount <= MAX_FRAGMENTS, "frame size");
  const packets: Uint8Array[] = [];
  for (let fragIndex = 0; fragIndex < fragCount; fragIndex++) {
    const part = data.subarray(fragIndex * maxPayload, (fragIndex + 1) * maxPayload);
    const packet = new Uint8Array(MEDIA_HEADER_BYTES + part.byteLength);
    encodeMediaHeader({ ...frame, fragIndex, fragCount, hopFlags: 0, hops: 0, linkSeq: 0, sendMs: 0 }, packet);
    packet.set(part, MEDIA_HEADER_BYTES);
    packets.push(packet);
  }
  return packets;
}

/* ------------------------------------------------------------------------------------------ */
/* Heartbeat                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** Where a sender has got to in one stream. */
export type StreamHead = {
  streamId: number;
  /** The newest frame it has forwarded whole. */
  headFrameId: number;
  /** The newest keyframe in its GOP cache: where a replay "from the latest keyframe" starts. */
  keyFrameId: number;
};

/**
 * Parent to child, every `heartbeatMs` on an active link and every `standbyHeartbeatMs` on a
 * standby one. Any packet from the parent proves it alive; a heartbeat also says where it is.
 *
 * ```
 *    0  1  version | type            6  2  echoMs
 *    1  1  flags (HeartbeatFlag)     8  2  echoHoldMs (0xffff: nothing to echo)
 *    2  2  linkSeq                  10  1  depth (0 = the source, 255 = not known)
 *    4  2  sendMs                   11  1  n, then n × { streamId u8, headFrameId u32, keyFrameId u32 }
 * ```
 */
export type Heartbeat = {
  flags: number;
  linkSeq: number;
  sendMs: number;
  /** The `sendMs` of the last packet received from the peer on this link. */
  echoMs: number;
  /** Milliseconds between receiving that packet and sending this one, or `ECHO_NONE`. */
  echoHoldMs: number;
  depth: number;
  streams: StreamHead[];
};

const HEARTBEAT_FIXED_BYTES = 12;
const STREAM_HEAD_BYTES = 9;

export function encodeHeartbeat(hb: Heartbeat): Uint8Array {
  need(u8ok(hb.flags) && u8ok(hb.depth), "flags or depth");
  need(u16ok(hb.linkSeq) && u16ok(hb.sendMs) && u16ok(hb.echoMs) && u16ok(hb.echoHoldMs), "sequence or time");
  need(hb.streams.length <= MAX_HEARTBEAT_STREAMS, "stream count");
  const out = new Uint8Array(HEARTBEAT_FIXED_BYTES + hb.streams.length * STREAM_HEAD_BYTES);
  const dv = view(out);
  dv.setUint8(0, (PROTOCOL_VERSION << 4) | PacketType.Heartbeat);
  dv.setUint8(1, hb.flags);
  dv.setUint16(2, hb.linkSeq);
  dv.setUint16(4, hb.sendMs);
  dv.setUint16(6, hb.echoMs);
  dv.setUint16(8, hb.echoHoldMs);
  dv.setUint8(10, hb.depth);
  dv.setUint8(11, hb.streams.length);
  hb.streams.forEach((s, i) => {
    need(u8ok(s.streamId) && u32ok(s.headFrameId) && u32ok(s.keyFrameId), "stream head");
    const at = HEARTBEAT_FIXED_BYTES + i * STREAM_HEAD_BYTES;
    dv.setUint8(at, s.streamId);
    dv.setUint32(at + 1, s.headFrameId);
    dv.setUint32(at + 5, s.keyFrameId);
  });
  return out;
}

export function decodeHeartbeat(packet: Uint8Array): Heartbeat | null {
  if (peekPacketType(packet) !== PacketType.Heartbeat || packet.byteLength < HEARTBEAT_FIXED_BYTES) return null;
  const dv = view(packet);
  const n = dv.getUint8(11);
  if (n > MAX_HEARTBEAT_STREAMS || packet.byteLength !== HEARTBEAT_FIXED_BYTES + n * STREAM_HEAD_BYTES) return null;
  const streams: StreamHead[] = [];
  for (let i = 0; i < n; i++) {
    const at = HEARTBEAT_FIXED_BYTES + i * STREAM_HEAD_BYTES;
    streams.push({ streamId: dv.getUint8(at), headFrameId: dv.getUint32(at + 1), keyFrameId: dv.getUint32(at + 5) });
  }
  return {
    flags: dv.getUint8(1),
    linkSeq: dv.getUint16(2),
    sendMs: dv.getUint16(4),
    echoMs: dv.getUint16(6),
    echoHoldMs: dv.getUint16(8),
    depth: dv.getUint8(10),
    streams,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Feedback                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Child to parent, every `feedbackMs`: what the last interval looked like from the receiving
 * end. It is also how a parent knows a child is still there.
 *
 * ```
 *    0  1  version | type           12  2  received       packets that arrived this interval
 *    1  1  flags (FeedbackFlag)     14  2  expected       packets that should have
 *    2  2  linkSeq                  16  2  jitter         interarrival jitter, 0.1 ms units
 *    4  2  sendMs                   18  2  queueDelay     one-way delay above its floor, 0.1 ms
 *    6  2  echoMs                   20  2  playoutDelayMs the receiver's playout delay target
 *    8  2  echoHoldMs               22  2  bufferMs       media held ahead of playout
 *   10  2  highestSeq               24  1  max spatial (high 4 bits) | max temporal (low 4 bits)
 *                                   25  1  reserved, 0
 * ```
 */
export type Feedback = {
  flags: number;
  linkSeq: number;
  sendMs: number;
  echoMs: number;
  echoHoldMs: number;
  /** The highest `linkSeq` received from the parent so far. */
  highestSeq: number;
  received: number;
  expected: number;
  /** Interarrival jitter (RFC 3550 §6.4.1) in tenths of a millisecond. */
  jitterTenthsMs: number;
  /**
   * How much longer packets are taking than the quickest seen in the last ten seconds, in tenths
   * of a millisecond: a queue is building somewhere between the two.
   */
  queueDelayTenthsMs: number;
  playoutDelayMs: number;
  bufferMs: number;
  /** The most the child wants: it may want less than it is sent (small picture, slow decoder). */
  maxSpatial: number;
  maxTemporal: number;
};

export const FEEDBACK_BYTES = 26;

export function encodeFeedback(fb: Feedback): Uint8Array {
  need(u8ok(fb.flags), "flags");
  for (const key of FEEDBACK_U16) need(u16ok(fb[key]), key);
  need(Number.isInteger(fb.maxSpatial) && fb.maxSpatial >= 0 && fb.maxSpatial <= 15, "maxSpatial");
  need(Number.isInteger(fb.maxTemporal) && fb.maxTemporal >= 0 && fb.maxTemporal <= 15, "maxTemporal");
  const out = new Uint8Array(FEEDBACK_BYTES);
  const dv = view(out);
  dv.setUint8(0, (PROTOCOL_VERSION << 4) | PacketType.Feedback);
  dv.setUint8(1, fb.flags);
  FEEDBACK_U16.forEach((key, i) => dv.setUint16(2 + i * 2, fb[key]));
  dv.setUint8(24, (fb.maxSpatial << 4) | fb.maxTemporal);
  return out;
}

/** The u16 fields of a feedback packet, in wire order from offset 2. */
const FEEDBACK_U16 = [
  "linkSeq",
  "sendMs",
  "echoMs",
  "echoHoldMs",
  "highestSeq",
  "received",
  "expected",
  "jitterTenthsMs",
  "queueDelayTenthsMs",
  "playoutDelayMs",
  "bufferMs",
] as const;

export function decodeFeedback(packet: Uint8Array): Feedback | null {
  if (peekPacketType(packet) !== PacketType.Feedback || packet.byteLength !== FEEDBACK_BYTES) return null;
  const dv = view(packet);
  const u16 = (i: number) => dv.getUint16(2 + i * 2);
  const layers = dv.getUint8(24);
  return {
    flags: dv.getUint8(1),
    linkSeq: u16(0),
    sendMs: u16(1),
    echoMs: u16(2),
    echoHoldMs: u16(3),
    highestSeq: u16(4),
    received: u16(5),
    expected: u16(6),
    jitterTenthsMs: u16(7),
    queueDelayTenthsMs: u16(8),
    playoutDelayMs: u16(9),
    bufferMs: u16(10),
    maxSpatial: layers >> 4,
    maxTemporal: layers & 0x0f,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Nack                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * Fragments of one frame to send again: `firstFrag`, and each fragment `firstFrag + 1 + i` whose
 * bit `i` is set in `mask`. `firstFrag` of `NACK_WHOLE_FRAME` asks for the whole frame.
 */
export type NackItem = { streamId: number; frameId: number; firstFrag: number; mask: number };

/**
 * Child to parent: fragments that did not arrive, while there is still time to use them.
 *
 * ```
 *    0  1  version | type      2  2  linkSeq     6  n × { streamId u8, frameId u32, firstFrag u16, mask u16 }
 *    1  1  n                   4  2  sendMs
 * ```
 */
export type Nack = { linkSeq: number; sendMs: number; items: NackItem[] };

const NACK_FIXED_BYTES = 6;
const NACK_ITEM_BYTES = 9;

export function encodeNack(nack: Nack): Uint8Array {
  need(u16ok(nack.linkSeq) && u16ok(nack.sendMs), "sequence or time");
  need(nack.items.length >= 1 && nack.items.length <= MAX_NACK_ITEMS, "item count");
  const out = new Uint8Array(NACK_FIXED_BYTES + nack.items.length * NACK_ITEM_BYTES);
  const dv = view(out);
  dv.setUint8(0, (PROTOCOL_VERSION << 4) | PacketType.Nack);
  dv.setUint8(1, nack.items.length);
  dv.setUint16(2, nack.linkSeq);
  dv.setUint16(4, nack.sendMs);
  nack.items.forEach((item, i) => {
    need(u8ok(item.streamId) && u32ok(item.frameId) && u16ok(item.firstFrag) && u16ok(item.mask), "nack item");
    const at = NACK_FIXED_BYTES + i * NACK_ITEM_BYTES;
    dv.setUint8(at, item.streamId);
    dv.setUint32(at + 1, item.frameId);
    dv.setUint16(at + 5, item.firstFrag);
    dv.setUint16(at + 7, item.mask);
  });
  return out;
}

export function decodeNack(packet: Uint8Array): Nack | null {
  if (peekPacketType(packet) !== PacketType.Nack || packet.byteLength < NACK_FIXED_BYTES) return null;
  const dv = view(packet);
  const n = dv.getUint8(1);
  if (n < 1 || n > MAX_NACK_ITEMS || packet.byteLength !== NACK_FIXED_BYTES + n * NACK_ITEM_BYTES) return null;
  const items: NackItem[] = [];
  for (let i = 0; i < n; i++) {
    const at = NACK_FIXED_BYTES + i * NACK_ITEM_BYTES;
    items.push({ streamId: dv.getUint8(at), frameId: dv.getUint32(at + 1), firstFrag: dv.getUint16(at + 5), mask: dv.getUint16(at + 7) });
  }
  return { linkSeq: dv.getUint16(2), sendMs: dv.getUint16(4), items };
}

/** The fragment indexes one NACK item asks for, or null for the whole frame. */
export function nackFragments(item: NackItem): number[] | null {
  if (item.firstFrag === NACK_WHOLE_FRAME) return null;
  const out = [item.firstFrag];
  for (let i = 0; i < 16; i++) if (item.mask & (1 << i)) out.push(item.firstFrag + 1 + i);
  return out;
}

/** NACK items for one frame's missing fragment indexes, which must be in ascending order. */
export function nackItemsFor(streamId: number, frameId: number, missing: readonly number[]): NackItem[] {
  const items: NackItem[] = [];
  let current: NackItem | null = null;
  for (const frag of missing) {
    if (current && frag - current.firstFrag >= 1 && frag - current.firstFrag <= 16) {
      current.mask |= 1 << (frag - current.firstFrag - 1);
    } else {
      current = { streamId, frameId, firstFrag: frag, mask: 0 };
      items.push(current);
    }
  }
  return items;
}

/* ------------------------------------------------------------------------------------------ */
/* Probe                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * Padding sent to load a link: `version | type`, a zero byte, `linkSeq`, `sendMs`, then filler.
 * It counts toward feedback like any other packet.
 */
export type Probe = { linkSeq: number; sendMs: number; size: number };

export const PROBE_HEADER_BYTES = 6;

export function encodeProbe(probe: Probe): Uint8Array {
  need(u16ok(probe.linkSeq) && u16ok(probe.sendMs), "sequence or time");
  need(Number.isInteger(probe.size) && probe.size >= PROBE_HEADER_BYTES && probe.size <= MAX_PACKET_BYTES, "size");
  const out = new Uint8Array(probe.size);
  const dv = view(out);
  dv.setUint8(0, (PROTOCOL_VERSION << 4) | PacketType.Probe);
  dv.setUint16(2, probe.linkSeq);
  dv.setUint16(4, probe.sendMs);
  return out;
}

export function decodeProbe(packet: Uint8Array): Probe | null {
  if (peekPacketType(packet) !== PacketType.Probe || packet.byteLength < PROBE_HEADER_BYTES || packet.byteLength > MAX_PACKET_BYTES) return null;
  const dv = view(packet);
  return { linkSeq: dv.getUint16(2), sendMs: dv.getUint16(4), size: packet.byteLength };
}

/** `linkSeq` and `sendMs` of any packet on the unreliable channel, or null if it is not one. */
export function packetLinkFields(packet: Uint8Array): { type: PacketType; linkSeq: number; sendMs: number } | null {
  const type = peekPacketType(packet);
  if (type === null) return null;
  const at = type === PacketType.Media || type === PacketType.Parity ? 26 : 2;
  if (packet.byteLength < at + 4) return null;
  const dv = view(packet);
  return { type, linkSeq: dv.getUint16(at), sendMs: dv.getUint16(at + 2) };
}

/* ------------------------------------------------------------------------------------------ */
/* JSON messages: a small schema language                                                      */
/* ------------------------------------------------------------------------------------------ */

type Schema<T> = { parse(value: unknown, path: string): T; optional?: boolean };
type Optional<T> = Schema<T> & { optional: true };
type Infer<S> = S extends Schema<infer T> ? T : never;
type Shape = Record<string, Schema<unknown>>;
type Flat<T> = { [K in keyof T]: T[K] };
type ObjectOf<S extends Shape> = Flat<
  { [K in keyof S as S[K] extends Optional<unknown> ? never : K]: Infer<S[K]> } & {
    [K in keyof S as S[K] extends Optional<unknown> ? K : never]?: Infer<S[K]>;
  }
>;

const bad = (path: string, want: string): never => {
  throw new ProtocolError(`${path || "message"}: expected ${want}`);
};

const str = (max: number, min = 0): Schema<string> => ({
  parse: (v, p) => (typeof v === "string" && v.length >= min && v.length <= max ? v : bad(p, `a string of ${min} to ${max} characters`)),
});
const num = (min: number, max: number): Schema<number> => ({
  parse: (v, p) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : bad(p, `a number from ${min} to ${max}`)),
});
const int = (min: number, max: number): Schema<number> => ({
  parse: (v, p) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : bad(p, `a whole number from ${min} to ${max}`)),
});
const bool: Schema<boolean> = { parse: (v, p) => (typeof v === "boolean" ? v : bad(p, "true or false")) };
const oneOf = <const T extends string>(...values: T[]): Schema<T> => ({
  parse: (v, p) => (typeof v === "string" && (values as string[]).includes(v) ? (v as T) : bad(p, `one of ${values.join(", ")}`)),
});
const nullable = <T>(inner: Schema<T>): Schema<T | null> => ({ parse: (v, p) => (v === null ? null : inner.parse(v, p)) });
const optional = <T>(inner: Schema<T>): Optional<T> => ({ parse: inner.parse, optional: true });
const list = <T>(of: Schema<T>, max: number): Schema<T[]> => ({
  parse: (v, p) => (Array.isArray(v) && v.length <= max ? v.map((item, i) => of.parse(item, `${p}[${i}]`)) : bad(p, `a list of at most ${max}`)),
});
const object = <S extends Shape>(shape: S): Schema<ObjectOf<S>> => ({
  parse(v, p) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return bad(p, "an object");
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const value = (v as Record<string, unknown>)[key];
      if (value === undefined) {
        if (!shape[key].optional) bad(p ? `${p}.${key}` : key, "a value");
        continue;
      }
      out[key] = shape[key].parse(value, p ? `${p}.${key}` : key);
    }
    return out as ObjectOf<S>;
  },
});

/** Messages told apart by their `t` field. */
type Tagged<M extends Record<string, Shape>> = { [K in keyof M]: Flat<{ t: K } & ObjectOf<M[K]>> }[keyof M];

function tagged<M extends Record<string, Shape>>(kinds: M): Schema<Tagged<M>> {
  const parsers = new Map(Object.entries(kinds).map(([t, shape]) => [t, object(shape)]));
  return {
    parse(v, p) {
      const t = typeof v === "object" && v !== null ? (v as { t?: unknown }).t : undefined;
      const parser = typeof t === "string" ? parsers.get(t) : undefined;
      if (!parser) return bad(p ? `${p}.t` : "t", `a known message type (got ${JSON.stringify(t) ?? "nothing"})`);
      return { t, ...(parser.parse(v, p) as object) } as Tagged<M>;
    },
  };
}

function decodeJson<T>(schema: Schema<T>, text: string): T {
  if (typeof text !== "string" || text.length > MAX_JSON_MESSAGE_CHARS) throw new ProtocolError("message: too long, or not text");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("message: not JSON");
  }
  return schema.parse(value, "");
}

/** The most characters one JSON message may be. An SDP offer with many candidates is about 4,000. */
export const MAX_JSON_MESSAGE_CHARS = 64 * 1024;

/* ------------------------------------------------------------------------------------------ */
/* Shared shapes                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** A peer in one session, minted by the coordinator. The source has one too. */
export type PeerId = string;
const peerId = str(32, 1);
const streamId = int(0, 255);
const stripeIndex = int(0, 255);
const frameId = int(0, 0xffffffff);
const token = str(4096, 1);

/** `fromFrame` in `sub`: start at the newest keyframe the parent holds. What a joiner asks for. */
export const FROM_LATEST_KEYFRAME = -1;
/** `fromFrame` in `sub`: replay nothing, start with whatever comes next. */
export const FROM_LIVE = -2;

/** One WebRTC signalling step: a description, a candidate, or `candidate: null` for "no more". */
const signalData = object({
  sdp: optional(object({ type: oneOf("offer", "answer", "pranswer", "rollback"), sdp: str(32 * 1024) })),
  candidate: optional(
    nullable(
      object({
        candidate: str(1024),
        sdpMid: optional(nullable(str(64))),
        sdpMLineIndex: optional(nullable(int(0, 255))),
        usernameFragment: optional(nullable(str(256))),
      }),
    ),
  ),
});
export type SignalData = Infer<typeof signalData>;

/**
 * What a peer says about itself when it joins. The coordinator decides from this, and from what
 * it then observes, who may relay (SPEC §8). It is a claim, not a proof.
 */
const capabilities = object({
  browser: oneOf("chromium", "firefox", "safari", "other"),
  desktop: bool,
  /** On mains power, or a machine with no battery. Null where the browser will not say. */
  onPower: nullable(bool),
  /**
   * "open": a public address. "cone": the same mapped address for every destination, so others
   * can reach it. "symmetric": a different one per destination. "relay": only TURN worked.
   */
  nat: oneOf("open", "cone", "symmetric", "relay", "unknown"),
  /** Measured or estimated spare uplink, or null before any measurement. */
  uplinkKbps: nullable(num(0, 10_000_000)),
  cores: int(1, 1024),
  /** WebCodecs codec strings this peer can decode. */
  decode: list(str(64), 16),
  /** The person asked to use less data: never a relay. */
  dataSaver: bool,
  /** The tab is in view. A hidden tab's timers are throttled, so it is not a relay. */
  visible: bool,
});
export type Capabilities = Infer<typeof capabilities>;

const stripeConfig = object({
  index: stripeIndex,
  /** "data" carries frames; "parity" carries symbols computed over the data stripes (stage 2). */
  kind: oneOf("data", "parity"),
  /** The temporal layers this stripe carries. Empty for parity. */
  temporal: list(int(0, 15), 16),
});
export type StripeConfig = Infer<typeof stripeConfig>;

/** One stream of the session, as its source encodes it. */
const streamConfig = object({
  id: streamId,
  kind: oneOf("video", "audio"),
  /** Changes whenever anything a decoder is configured with does. Frames carry it. */
  configId: int(0, 255),
  /** A WebCodecs codec string: "vp8", "opus". */
  codec: str(64, 1),
  /** What the encoder is asked for, all layers together. */
  bitrateKbps: num(1, 1_000_000),
  width: optional(int(1, 16384)),
  height: optional(int(1, 16384)),
  fps: optional(num(1, 240)),
  sampleRate: optional(int(8000, 192000)),
  channels: optional(int(1, 8)),
  /** Microseconds of audio in each frame. */
  frameUs: optional(int(2500, 120000)),
  /** A WebCodecs scalability mode: "L1T1", "L1T2", "L1T3". */
  scalability: optional(str(16, 1)),
  /** A keyframe at least this often, in frames. */
  keyIntervalFrames: optional(int(1, 65535)),
  /** How the stream is split over trees. Stage 1: one data stripe carrying every layer. */
  stripes: list(stripeConfig, 16),
  /** Payloads are SFrame ciphertext (stage 2). */
  sframe: bool,
  /** Codec-specific decoder configuration (`VideoDecoderConfig.description`), base64url. */
  description: optional(str(8192)),
  /** [D66] The source's authentication of this configuration (media/sframe.ts): "s." or "g.", then base64url. */
  sig: optional(str(256)),
});
export type StreamConfig = Infer<typeof streamConfig>;

/** Someone a peer might connect to, as the coordinator or a neighbour describes them. */
const peerHint = object({
  peer: peerId,
  /** Hops from the source. The source is 0. */
  depth: int(0, 255),
  /** Slots it has free for active children. */
  free: int(0, 255),
  /** A coarse place, for guessing who is near before measuring (a Cloudflare colo, a region). */
  region: optional(str(16)),
});
export type PeerHint = Infer<typeof peerHint>;

/** Where one stripe of one stream should come from: candidates in the coordinator's order of preference. */
const assignment = object({
  stream: streamId,
  stripe: stripeIndex,
  parents: list(peerHint, 8),
  backups: list(peerHint, 8),
});
export type Assignment = Infer<typeof assignment>;

/**
 * The timings and limits every peer in a session runs with. Sent in `welcome`, so they can be
 * tuned per session (and per test) without a release. `DEFAULT_PARAMS` holds stage 1's values.
 */
const params = object({
  heartbeatMs: int(10, 5000),
  /** Silence from an active parent for this long means it is dead. */
  deadMs: int(50, 30000),
  standbyHeartbeatMs: int(50, 10000),
  standbyDeadMs: int(200, 60000),
  feedbackMs: int(20, 5000),
  /** A parent heard nothing from a child for this long: it is gone. */
  childDeadMs: int(200, 60000),
  /** How long to wait for a parent that says it is repairing, before repairing oneself. */
  stallGraceMs: int(0, 30000),
  statusMs: int(500, 120000),
  metricsMs: int(500, 120000),
  /** The most active children one relay takes. */
  maxFanout: int(1, 64),
  /** The most active children the source takes. */
  sourceFanout: int(1, 64),
  playoutMinMs: int(0, 5000),
  playoutMaxMs: int(0, 10000),
  /** How much media a relay keeps for replay, at most. */
  gopCacheMs: int(0, 60000),
  gopCacheBytes: int(0, 256 * 1024 * 1024),
  /** How many times one fragment may be asked for again. */
  nackRetries: int(0, 8),
  /** A voluntary change of parent no more often than this. */
  rebalanceMinMs: int(0, 3_600_000),
  /** SPEC §8.1, D18: nobody relays before this long in the session. 20 s when absent. */
  probationMs: optional(int(0, 3_600_000)),
  /** SPEC §8.1, D49: the most children the source takes while it is the only relay, if its probe shows the uplink. 6 when absent. */
  sourceAloneFanout: optional(int(1, 64)),
});
export type OverlayParams = Infer<typeof params>;

/** Stage 1's values. The first three are the proof's (50 ms heartbeats, dead at 200 ms). */
export const DEFAULT_PARAMS: OverlayParams = {
  heartbeatMs: 50,
  deadMs: 200,
  standbyHeartbeatMs: 250,
  standbyDeadMs: 1000,
  feedbackMs: 100,
  childDeadMs: 1000,
  stallGraceMs: 600,
  statusMs: 5000,
  metricsMs: 2000,
  maxFanout: 6,
  sourceFanout: 3,
  playoutMinMs: 60,
  playoutMaxMs: 400,
  gopCacheMs: 4000,
  gopCacheBytes: 4 * 1024 * 1024,
  nackRetries: 1,
  rebalanceMinMs: 30000,
  probationMs: 20000,
};

const iceServer = object({
  urls: list(str(512, 1), 8),
  username: optional(str(512)),
  credential: optional(str(512)),
});
export type IceServer = Infer<typeof iceServer>;

/** What a peer is in the overlay. A "leaf" forwards nothing. */
const overlayRole = oneOf("source", "relay", "leaf");
export type OverlayRole = Infer<typeof overlayRole>;

/* ------------------------------------------------------------------------------------------ */
/* Peer messages (a link's reliable channel)                                                   */
/* ------------------------------------------------------------------------------------------ */

const peerMessage = tagged({
  /**
   * The first message each side sends on a new link: who I am, with the coordinator's signature
   * to prove it. Anything else before a valid `hello` closes the link.
   */
  hello: { v: int(1, 15), peer: peerId, grant: token },
  /**
   * Send me these stripes of this stream. "active": send media, starting after `fromFrame` (a
   * frame id, `FROM_LATEST_KEYFRAME` or `FROM_LIVE`), replaying from your cache what I missed.
   * "standby": send only heartbeats, and keep a place for me.
   */
  sub: {
    id: int(0, 0xffffffff),
    stream: streamId,
    stripes: list(stripeIndex, 16),
    mode: oneOf("active", "standby"),
    fromFrame: int(FROM_LIVE, 0xffffffff),
    maxSpatial: int(0, 15),
    maxTemporal: int(0, 15),
  },
  /**
   * My parent `dead` is gone: you are my parent now. Like an active `sub`, but from a standby
   * child it is never refused for want of a slot (SPEC §7.5): the parent sheds layers instead.
   */
  repair: { id: int(0, 0xffffffff), stream: streamId, stripes: list(stripeIndex, 16), fromFrame: int(FROM_LIVE, 0xffffffff), dead: peerId },
  /** The answer to `sub` or `repair` with the same `id`. */
  "sub-ack": {
    id: int(0, 0xffffffff),
    ok: bool,
    /** Why not, when `ok` is false. "loop": you are one of my ancestors. */
    code: optional(oneOf("full", "no-stream", "loop", "denied", "leaving")),
    config: optional(streamConfig),
    headFrame: optional(frameId),
    keyFrame: optional(frameId),
    /** Me, my parent, its parent, … the source. A child refuses a parent whose path it is on. */
    path: optional(list(peerId, 64)),
    /** The highest temporal layer I will send you for now. */
    maxTemporal: optional(int(0, 15)),
  },
  unsub: { stream: streamId, stripes: list(stripeIndex, 16) },
  /**
   * A change to what flows on this link. From the child: send me no more than this. From the
   * parent: I am sending you no more than this, and why.
   */
  layers: {
    stream: streamId,
    maxSpatial: int(0, 15),
    maxTemporal: int(0, 15),
    reason: oneOf("congestion", "cpu", "viewport", "overload", "restore"),
  },
  /** Parent to children: my path to the source changed. They pass it on with themselves in front. */
  path: { path: list(peerId, 64) },
  /** Peers you could connect to instead of me, or as well as me. */
  peers: { peers: list(peerHint, 16) },
  /**
   * Signalling for `to`, carried over the overlay for when the coordinator cannot be reached.
   * Forwarded while `ttl` is above 0, toward `to` if it is a neighbour (stage 3).
   */
  sig: { to: peerId, from: peerId, ttl: int(0, 8), data: signalData },
  /** A stream's configuration changed (a new `configId`), ahead of the frames that use it. */
  config: { stream: streamConfig },
  /** I need a keyframe on this stream. Passed up toward the source, which limits how often (stage 2). */
  keyreq: { stream: streamId },
  /** I am closing this link. `alt`: where to go instead. */
  bye: { reason: oneOf("leave", "rebalance", "overload", "kicked", "end"), alt: optional(list(peerHint, 8)) },
});
export type PeerMessage = Infer<typeof peerMessage>;
export type PeerMessageOf<T extends PeerMessage["t"]> = Extract<PeerMessage, { t: T }>;

export const encodePeerMessage = (message: PeerMessage): string => JSON.stringify(message);
export const decodePeerMessage = (text: string): PeerMessage => decodeJson(peerMessage, text);

/* ------------------------------------------------------------------------------------------ */
/* Metrics                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Upper edges, in milliseconds, of the buckets every latency histogram in the overlay uses:
 * 10 ms wide to 500, 50 ms wide to 2,000, then 500 ms wide to 10,000, and one more bucket for
 * anything longer. Fixed, so histograms from any number of peers add up bucket by bucket.
 */
export const LATENCY_BUCKET_EDGES_MS: readonly number[] = [
  ...Array.from({ length: 50 }, (_, i) => (i + 1) * 10),
  ...Array.from({ length: 30 }, (_, i) => 550 + i * 50),
  ...Array.from({ length: 16 }, (_, i) => 2500 + i * 500),
];
export const LATENCY_BUCKETS = LATENCY_BUCKET_EDGES_MS.length + 1;

/** The bucket a duration falls in: the first whose upper edge is at or above it. */
export function latencyBucket(ms: number): number {
  let lo = 0;
  let hi = LATENCY_BUCKET_EDGES_MS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (LATENCY_BUCKET_EDGES_MS[mid] >= ms) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export const emptyHistogram = (): number[] => new Array<number>(LATENCY_BUCKETS).fill(0);

/** Adds `from` into `into`, bucket by bucket. */
export function mergeHistogram(into: number[], from: readonly number[]): number[] {
  for (let i = 0; i < LATENCY_BUCKETS; i++) into[i] += from[i] ?? 0;
  return into;
}

/**
 * The value at quantile `q` (0..1) of a histogram, as its bucket's upper edge: an overestimate
 * by at most the bucket's width, never an underestimate. Null when the histogram is empty;
 * Infinity when the quantile falls in the last, open bucket.
 */
export function histogramQuantile(counts: readonly number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i];
    if (seen >= rank) return LATENCY_BUCKET_EDGES_MS[i] ?? Infinity;
  }
  return Infinity;
}

const histogram = list(int(0, 0xffffffff), LATENCY_BUCKETS);
/** A time on the session clock, in milliseconds. */
const sessionMs = num(0, 2 ** 48);
const durationMs = num(0, 3_600_000);

/** Something that happened once, with the times the go/no-go gate is measured from (SPEC §12). */
const metricsEvent = tagged({
  /** Joining: from asking the coordinator to the first frame on screen. */
  join: {
    /** `connect()` was called. */
    start: sessionMs,
    /** `welcome` arrived. */
    welcome: sessionMs,
    /** The first parent link opened. */
    linked: sessionMs,
    firstPacket: sessionMs,
    /** The first frame was rendered. Join time is `firstFrame - start`. */
    firstFrame: sessionMs,
    /** The link to the first parent goes through TURN. */
    turn: bool,
  },
  /** A parent was lost and replaced. */
  repair: {
    stream: streamId,
    stripe: stripeIndex,
    dead: peerId,
    next: nullable(peerId),
    /** "warm": the standby backup took over. "cold": a new link had to be made. "wait": the parent recovered. */
    kind: oneOf("warm", "cold", "wait"),
    /** The last packet from the lost parent arrived. */
    lastHeard: sessionMs,
    detected: sessionMs,
    resubscribed: sessionMs,
    firstPacket: nullable(sessionMs),
    /**
     * The longest gap between two rendered frames across the repair, in milliseconds. This is
     * "repair time" in the gate: it includes the one frame interval that is always there.
     */
    freezeMs: durationMs,
    framesLost: int(0, 0xffffffff),
    /** The coordinator was asked for something before media flowed again. */
    usedCoordinator: bool,
    /**
     * [D61] Where the freeze went; absent from a peer that does not say. `staleMs`: how long before
     * `lastHeard` the last decodable frame had come (the freeze had begun before the parent went).
     * `firstDecodable`: the first frame to become decodable after `lastHeard`; `firstKey`: it was a
     * keyframe (the GOP in between was given up). `laterGapMs`: the longest gap after that frame,
     * within the repair's window. `replayPackets`, `replayBytes`: what the new parent sent marked
     * Replay; `replayMs`: from `firstPacket` to the last of them.
     */
    staleMs: optional(durationMs),
    firstDecodable: optional(nullable(sessionMs)),
    firstKey: optional(bool),
    laterGapMs: optional(durationMs),
    replayPackets: optional(int(0, 0xffffffff)),
    replayBytes: optional(int(0, 0xffffffff)),
    replayMs: optional(durationMs),
  },
  /** A voluntary change of parent. */
  /**
   * `reason`: "move", the coordinator asked (`assign` "move"); "rebalance", the node's own cost
   * rule (SPEC §7.6); "starved", its parent could not carry the stream (§11.3 rule 7). Absent from
   * a peer that does not say.
   */
  switch: { stream: streamId, stripe: stripeIndex, from: peerId, to: peerId, at: sessionMs, freezeMs: durationMs, reason: optional(oneOf("move", "rebalance", "starved")) },
  /** The layers flowing on a link changed. */
  layer: { stream: streamId, peer: peerId, at: sessionMs, maxTemporal: int(0, 15), reason: oneOf("congestion", "cpu", "viewport", "overload", "restore") },
  /** Rendering stopped for longer than the freeze threshold (SPEC §12), for any reason. */
  freeze: { stream: streamId, at: sessionMs, ms: durationMs },
  /**
   * [D69] The parent said nothing for `ms` (at least 150) from `at`, and then spoke again: a stall
   * that was not a death. `depth`: the parent's. `media`: how long before `at` its last media had come.
   */
  silence: { peer: peerId, at: sessionMs, ms: durationMs, depth: int(0, 255), media: durationMs },
  error: { at: sessionMs, where: str(64), message: str(512) },
});
export type MetricsEvent = Infer<typeof metricsEvent>;

/**
 * What one peer measured over one interval (`metricsMs`). Counters are for the interval, not
 * running totals, so samples add up. Sent to the coordinator and read by the harness.
 */
const metricsSample = object({
  peer: peerId,
  /** Counts this peer's samples from 0, so a missing one shows. */
  seq: int(0, 0xffffffff),
  at: sessionMs,
  intervalMs: durationMs,
  role: overlayRole,
  depth: int(0, 255),
  video: optional(
    object({
      rendered: int(0, 0xffffffff),
      /** Arrived whole but were never shown: late, or skipped to catch up. */
      dropped: int(0, 0xffffffff),
      /** Never arrived whole. */
      lost: int(0, 0xffffffff),
      /** Capture to render, per rendered frame (`LATENCY_BUCKET_EDGES_MS`). The gate's latency. */
      glassToGlass: histogram,
      /** Gaps between rendered frames. */
      frameGap: histogram,
      maxTemporal: int(0, 15),
      /**
       * [D46] Frames shown while a replay was played forward ([D45]): old by design, and already
       * in the freeze and repair measures, so not in `glassToGlass`. Their count, and their age
       * (capture to render) as a histogram.
       */
      catchUp: optional(object({ frames: int(0, 0xffffffff), age: histogram })),
    }),
  ),
  audio: optional(
    object({
      playedMs: durationMs,
      /** Audio that had to be made up because the real audio was not there in time. */
      concealedMs: durationMs,
      underruns: int(0, 0xffffffff),
      /** Capture to the loudspeaker, per audio frame. */
      glassToGlass: histogram,
      /** Video ahead of audio (positive) or behind it, at the moment of sampling. */
      avOffsetMs: num(-10000, 10000),
    }),
  ),
  playoutDelayMs: durationMs,
  /** The link to the active parent of stream 0, stripe 0. Absent on the source. */
  up: optional(
    object({
      parent: peerId,
      rttMs: nullable(durationMs),
      lossPct: num(0, 100),
      queueDelayMs: durationMs,
      rxKbps: num(0, 10_000_000),
      nacksSent: int(0, 0xffffffff),
      retransmitsReceived: int(0, 0xffffffff),
      duplicates: int(0, 0xffffffff),
      turn: bool,
    }),
  ),
  /** What this peer does for others. Absent on a leaf. */
  relay: optional(
    object({
      children: int(0, 255),
      standby: int(0, 255),
      txKbps: num(0, 10_000_000),
      /** Receipt of a packet to handing it to the last child's channel, in microseconds. */
      forwardP50Us: num(0, 60_000_000),
      forwardP95Us: num(0, 60_000_000),
      /** The most any child's channel had queued. */
      bufferedMaxBytes: int(0, 0xffffffff),
      layerDrops: int(0, 0xffffffff),
      retransmitsSent: int(0, 0xffffffff),
      /**
       * [D69] How late the node's own 10 ms tick ran at worst (its page's main thread held up: a
       * long task, garbage collection), and, on the source, the longest gap between two video
       * frames it published (the encoder's or the rate control's). Absent from a peer that does not say.
       */
      tickLateMaxMs: optional(durationMs),
      publishGapMaxMs: optional(durationMs),
    }),
  ),
  events: list(metricsEvent, 64),
});
export type MetricsSample = Infer<typeof metricsSample>;

export const encodeMetricsSample = (sample: MetricsSample): string => JSON.stringify(sample);
export const decodeMetricsSample = (text: string): MetricsSample => decodeJson(metricsSample, text);

/* ------------------------------------------------------------------------------------------ */
/* Coordinator messages (WebSocket)                                                            */
/* ------------------------------------------------------------------------------------------ */

const clientMessage = tagged({
  /** The first message on the socket. `resume`: I was `peer` a moment ago; keep my place. */
  hello: { v: int(1, 15), caps: capabilities, resume: optional(object({ peer: peerId, grant: token })) },
  /** A clock probe: `t0` is this peer's own clock. Answered at once (SPEC §4.1). */
  time: { t0: num(0, 2 ** 53) },
  /** Signalling for another peer. Delivered as `signal` with `from`. */
  signal: { to: peerId, data: signalData },
  /** I need someone to connect to. Answered with `assign` carrying the same `id`. */
  need: { id: int(0, 0xffffffff), stream: streamId, stripe: stripeIndex, want: oneOf("parent", "backup"), exclude: list(peerId, 64) },
  /** Where I am in the trees, every `statusMs` and whenever it changes. The tree map is built from these. */
  status: {
    depth: int(0, 255),
    links: list(object({ stream: streamId, stripe: stripeIndex, parent: nullable(peerId), backup: nullable(peerId) }), 64),
    children: int(0, 255),
    standby: int(0, 255),
    free: int(0, 255),
    caps: capabilities,
    /** Share of packets from the parent lost over the last ten seconds, in percent. */
    lossPct: num(0, 100),
    rttMs: nullable(durationMs),
  },
  /** Something happened in the overlay that the coordinator should know, after the fact. */
  report: {
    event: oneOf("parent-dead", "parent-switch", "backup-lost", "link-failed", "child-gone", "parent-bad"),
    stream: streamId,
    stripe: stripeIndex,
    /** Who it is about. */
    peer: peerId,
    /** Who took their place, if anyone. */
    next: optional(nullable(peerId)),
  },
  metrics: { sample: metricsSample },
  /** The source says what it is sending. Refused from anyone else. */
  streams: { streams: list(streamConfig, 16) },
  bye: {},
});
export type ClientMessage = Infer<typeof clientMessage>;
export type ClientMessageOf<T extends ClientMessage["t"]> = Extract<ClientMessage, { t: T }>;

export const encodeClientMessage = (message: ClientMessage): string => JSON.stringify(message);
export const decodeClientMessage = (text: string): ClientMessage => decodeJson(clientMessage, text);

const serverMessage = tagged({
  /** You are in. Everything a peer needs to start. */
  welcome: {
    v: int(1, 15),
    peer: peerId,
    room: str(64, 1),
    role: overlayRole,
    /** Proves to other peers that you are `peer` in `room` with `role` (see `Grant`). */
    grant: token,
    /** The key grants are signed with: Ed25519, raw public key, base64url. */
    key: object({ kid: str(32, 1), pub: str(64, 1) }),
    /** The coordinator's clock, in milliseconds since the Unix epoch, at session clock 0. */
    epochMs: num(0, 2 ** 53),
    ice: list(iceServer, 8),
    params,
    streams: list(streamConfig, 16),
    assign: list(assignment, 64),
  },
  /** The answer to `time`: `t0` as sent, `t1` the session clock when it arrived. */
  time: { t0: num(0, 2 ** 53), t1: sessionMs },
  signal: { from: peerId, data: signalData },
  /**
   * Connect to these. `id` when it answers a `need`. Three reasons are offers: "join" (you have nowhere to
   * connect), "need" (you asked), "rebalance" (advice; the peer's own rule decides, SPEC §7.6). "move" is not
   * an offer: change to the first of these parents that will have you, make-before-break, whatever
   * your own cost rule says, and stay where you are only if none will. It is how the coordinator
   * keeps relays near the source (coordinator/README.md, "Keeping the tree short").
   */
  assign: { id: optional(int(0, 0xffffffff)), reason: oneOf("join", "need", "rebalance", "move"), assign: list(assignment, 64) },
  /**
   * You are now a relay, or no longer one. Comes with the grant that says so. `fanout`: the most
   * active children you may take (a provisional relay, SPEC §8.1 [D38], takes 2; a full relay
   * its verdict's, [D50]); the node never takes more than it, nor than `maxFanout`.
   */
  role: { role: overlayRole, grant: token, fanout: optional(int(1, 64)) },
  /** A grant to replace the one you hold, before it expires. */
  grant: { grant: token },
  streams: { streams: list(streamConfig, 16) },
  /** To the source: the audience as a whole would do better at this bitrate. */
  hint: { stream: streamId, bitrateKbps: num(1, 1_000_000) },
  /** `peer` has left or been removed. Close any link to it. Advisory: repair does not wait for this. */
  "peer-gone": { peer: peerId },
  /** You are removed. */
  kick: { reason: str(256) },
  /** The session is over for everyone. */
  end: { reason: oneOf("ended", "limit", "paused", "source-left") },
  error: { code: oneOf("bad-message", "denied", "full", "not-found", "rate", "version", "internal"), message: str(256), id: optional(int(0, 0xffffffff)) },
});
export type ServerMessage = Infer<typeof serverMessage>;
export type ServerMessageOf<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

export const encodeServerMessage = (message: ServerMessage): string => JSON.stringify(message);
export const decodeServerMessage = (text: string): ServerMessage => decodeJson(serverMessage, text);

/* ------------------------------------------------------------------------------------------ */
/* Grants and tickets                                                                          */
/* ------------------------------------------------------------------------------------------ */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64[b2 & 63];
  }
  return out;
}

/** The bytes `text` stands for, or null if it is not base64url (unpadded). */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    const value = B64.indexOf(text[i]);
    if (value < 0) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * What the coordinator vouches for about one peer, signed with the session's Ed25519 key. A peer
 * shows its grant in `hello` on every link; the other side checks it with the public key from
 * its own `welcome`, without asking anyone.
 *
 * `scope` is what the holder may do: "view", "relay", and "publish:<streamId>" for the source.
 * Stage 2's moderation (mute, stage, key rotation) adds scopes; it does not change this shape.
 */
const grant = object({
  v: int(1, 15),
  room: str(64, 1),
  peer: peerId,
  role: overlayRole,
  scope: list(str(32, 1), 16),
  /** Seconds since the Unix epoch. */
  iat: int(0, 2 ** 40),
  exp: int(0, 2 ** 40),
  /** Which of the session's keys signed it: a removal rotates the key (stage 2). */
  kid: str(32, 1),
});
export type Grant = Infer<typeof grant>;

/**
 * What Meetly's server vouches for when it sends someone to the coordinator: it has run its own
 * checks (the webinar gate, the pass cookie) and this is who they are. Signed with a secret the
 * two servers share (HMAC-SHA-256); browsers carry it but cannot read meaning into or out of it.
 */
const ticket = object({
  v: int(1, 15),
  room: str(64, 1),
  /** Meetly's identity for the person, as the stage provider has it. */
  identity: str(128, 1),
  name: str(128),
  role: oneOf("source", "viewer"),
  exp: int(0, 2 ** 40),
  /** Makes each ticket different, so one cannot be used twice. */
  nonce: str(32, 8),
});
export type Ticket = Infer<typeof ticket>;

const ED25519 = "Ed25519";

/** A new signing key pair for a session's grants. */
export async function generateGrantKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
}

/** A grant public key as `welcome.key.pub` carries it. */
export async function exportGrantPublicKey(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export async function importGrantPublicKey(pub: string): Promise<CryptoKey> {
  const raw = fromBase64Url(pub);
  if (!raw || raw.byteLength !== 32) throw new ProtocolError("key: not an Ed25519 public key");
  return crypto.subtle.importKey("raw", raw, ED25519, true, ["verify"]);
}

/** `<base64url of the grant's JSON>.<base64url of its signature>`. */
export async function signGrant(payload: Grant, privateKey: CryptoKey): Promise<string> {
  const body = toBase64Url(utf8.encode(JSON.stringify(grant.parse(payload, "grant"))));
  const signature = await crypto.subtle.sign(ED25519, privateKey, utf8.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

function splitToken(text: string): { body: string; payload: unknown; signature: Uint8Array<ArrayBuffer> } | null {
  const parts = typeof text === "string" ? text.split(".") : [];
  if (parts.length !== 2) return null;
  const raw = fromBase64Url(parts[0]);
  const signature = fromBase64Url(parts[1]);
  if (!raw || !signature) return null;
  try {
    return { body: parts[0], payload: JSON.parse(fromUtf8.decode(raw)), signature };
  } catch {
    return null;
  }
}

export type GrantCheck = {
  /** The session the grant must be for. */
  room: string;
  /** Milliseconds since the Unix epoch. */
  now: number;
  /** The peer the grant must name, when the caller already knows who it expects. */
  peer?: PeerId;
  /** Seconds a grant may be past `exp`, or before `iat`, to allow for clocks that disagree. */
  leewayS?: number;
};

/**
 * The grant inside `text`, or null if it is malformed, not signed by `publicKey`, for another
 * room or peer, or out of date.
 */
export async function verifyGrant(text: string, publicKey: CryptoKey, check: GrantCheck): Promise<Grant | null> {
  const parts = splitToken(text);
  if (!parts) return null;
  let payload: Grant;
  try {
    payload = grant.parse(parts.payload, "grant");
  } catch {
    return null;
  }
  const leeway = check.leewayS ?? 30;
  const nowS = check.now / 1000;
  if (payload.room !== check.room || (check.peer !== undefined && payload.peer !== check.peer)) return null;
  if (nowS > payload.exp + leeway || nowS < payload.iat - leeway) return null;
  const ok = await crypto.subtle.verify(ED25519, publicKey, parts.signature, utf8.encode(parts.body));
  return ok ? payload : null;
}

/** The grant inside `text` without checking its signature: for display and logs only. */
export function readGrantUnverified(text: string): Grant | null {
  try {
    const parts = splitToken(text);
    return parts ? grant.parse(parts.payload, "grant") : null;
  } catch {
    return null;
  }
}

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", utf8.encode(`meetly-overlay-ticket:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/** `<base64url of the ticket's JSON>.<base64url of its HMAC>`. For Meetly's server. */
export async function signTicket(payload: Ticket, secret: string): Promise<string> {
  if (!secret) throw new ProtocolError("ticket: no secret");
  const body = toBase64Url(utf8.encode(JSON.stringify(ticket.parse(payload, "ticket"))));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), utf8.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * The ticket inside `text`, or null if it is malformed, not made with `secret`, for another
 * room, or expired. For the coordinator, which must also refuse a `nonce` it has seen.
 */
export async function verifyTicket(text: string, secret: string, check: { room: string; now: number }): Promise<Ticket | null> {
  const parts = splitToken(text);
  if (!parts || !secret) return null;
  let payload: Ticket;
  try {
    payload = ticket.parse(parts.payload, "ticket");
  } catch {
    return null;
  }
  if (payload.room !== check.room || check.now / 1000 > payload.exp) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), parts.signature, utf8.encode(parts.body));
  return ok ? payload : null;
}
