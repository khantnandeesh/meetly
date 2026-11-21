/**
 * A stand-in for the link between a source and a viewer, until E-transport's exists: each frame
 * is cut into packets (`packetizeFrame`), each packet is delayed and may be dropped, and what
 * arrives whole is handed on as a `ReceivedFrame`. No NACK: a frame that loses a packet is lost,
 * unless a second copy of it (audio, SPEC §9.4) gets through.
 *
 * Test support. It knows nothing the real transport will not also tell the player.
 */
import { decodeMediaHeader, mediaPayload, packetizeFrame } from "../../protocol";
import type { Clock } from "../../runtime";
import type { EncodedFrame, ReceivedFrame } from "../../types";

export type LoopbackOptions = {
  clock: Clock;
  /** One-way delay of every packet, in milliseconds. */
  delayMs?: number;
  /** Extra delay, uniform in 0..jitterMs, per packet: this is what reorders. */
  jitterMs?: number;
  /** Chance that a packet is lost, 0..1. */
  loss?: number;
  /** Chance that a whole video frame of temporal layer *n* is removed before sending (index = layer). */
  dropLayer?: number[];
  /** The same seed loses the same packets. */
  seed?: number;
  deliver: (frame: ReceivedFrame) => void;
};

export type Loopback = {
  send(frame: EncodedFrame): void;
  /** Nothing passes while blocked: a parent that died. */
  setBlocked(blocked: boolean): void;
  /** Change the impairment while running. */
  set(options: Partial<Pick<LoopbackOptions, "delayMs" | "jitterMs" | "loss" | "dropLayer">>): void;
  stats(): { framesSent: number; framesRemoved: number; packetsSent: number; packetsLost: number; framesDelivered: number };
};

type Partial_ = { parts: (Uint8Array | undefined)[]; have: number; firstAt: number };

export function createLoopback(options: LoopbackOptions): Loopback {
  const { clock } = options;
  const settings = { delayMs: options.delayMs ?? 0, jitterMs: options.jitterMs ?? 0, loss: options.loss ?? 0, dropLayer: options.dropLayer ?? [] };
  let state = (options.seed ?? 1) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let blocked = false;
  const counters = { framesSent: 0, framesRemoved: 0, packetsSent: 0, packetsLost: 0, framesDelivered: 0 };
  /** Per stream: frames being put together, and the ids already delivered (to drop duplicates). */
  const partial = new Map<string, Partial_>();
  const delivered = new Map<number, Set<number>>();

  const receive = (packet: Uint8Array) => {
    const header = decodeMediaHeader(packet);
    if (!header) return;
    let done = delivered.get(header.streamId);
    if (!done) delivered.set(header.streamId, (done = new Set()));
    if (done.has(header.frameId)) return;
    const key = `${header.streamId}:${header.frameId}`;
    let entry = partial.get(key);
    if (!entry) partial.set(key, (entry = { parts: new Array<Uint8Array | undefined>(header.fragCount), have: 0, firstAt: clock.now() }));
    if (entry.parts[header.fragIndex]) return;
    entry.parts[header.fragIndex] = mediaPayload(packet);
    if (++entry.have < header.fragCount) return;

    partial.delete(key);
    done.add(header.frameId);
    if (done.size > 4096) for (const id of done) if (id < header.frameId - 2048) done.delete(id);
    if (partial.size > 512) for (const [k, p] of partial) if (clock.now() - p.firstAt > 5000) partial.delete(k);
    const data = new Uint8Array(entry.parts.reduce((sum, part) => sum + (part as Uint8Array).byteLength, 0));
    let offset = 0;
    for (const part of entry.parts as Uint8Array[]) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    const { fragIndex: _i, fragCount: _c, hopFlags: _f, hops: _h, linkSeq: _s, sendMs: _m, ...frameHeader } = header;
    counters.framesDelivered++;
    options.deliver({ header: frameHeader, data, firstPacketAt: entry.firstAt, completeAt: clock.now(), from: "p-loopback", recovered: false });
  };

  return {
    send(frame) {
      counters.framesSent++;
      if (blocked) return;
      const removeChance = frame.header.streamId === 0 ? (settings.dropLayer[frame.header.temporal] ?? 0) : 0;
      if (removeChance > 0 && (frame.header.flags & 1) === 0 && random() < removeChance) {
        counters.framesRemoved++;
        return;
      }
      for (const packet of packetizeFrame(frame.header, frame.data)) {
        counters.packetsSent++;
        if (settings.loss > 0 && random() < settings.loss) {
          counters.packetsLost++;
          continue;
        }
        const delay = settings.delayMs + (settings.jitterMs > 0 ? random() * settings.jitterMs : 0);
        if (delay <= 0) receive(packet);
        else clock.setTimeout(() => receive(packet), delay);
      }
    },
    setBlocked(value) {
      blocked = value;
    },
    set(changes) {
      Object.assign(settings, changes);
    },
    stats: () => ({ ...counters }),
  };
}
