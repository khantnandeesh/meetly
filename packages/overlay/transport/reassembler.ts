/**
 * Frames from packets, for this peer's own playout, and the list of what to ask for again.
 * SPEC §4.2, §4.6. Forwarding does not pass through here.
 *
 * Telling "lost" from "never sent". Frame ids count every frame of a stream, but a parent that
 * is shedding a layer for this child (SPEC §11.3) does not send every frame, so a hole in the
 * frame ids is not by itself a loss. `linkSeq` is: it counts every packet the parent sent on this
 * link. Fragments of one frame are sent one after another, so from any one live fragment the
 * reassembler knows the `linkSeq` the frame started and ended at. A hole in the frame ids between
 * two frames whose link sequences are adjacent (once the heartbeats and retransmissions known to
 * have been sent in between are counted) was never sent, and is not asked for.
 *
 * Owner: E-transport+topology.
 */
import { HopFlag, MEDIA_HEADER_BYTES, NACK_WHOLE_FRAME, PacketType, nackItemsFor, seq16Diff, type MediaHeader, type NackItem, type PeerId } from "../protocol";
import type { ReceivedFrame } from "../types";
import type { Reassembler, ReassemblerOptions } from "./types";

/** Frames a stream is remembered for behind its newest: older packets are dropped as late. */
const WINDOW_FRAMES = 1024;
/** A hole of more frames than this is not asked for: a NACK is for isolated loss. */
const MAX_WHOLE_FRAME_GAP = 16;
/** A hole in `linkSeq` longer than this is not examined: it is not one shed layer. */
const MAX_EXPLAINED_SPAN = 4096;

const DEFAULT_MAX_FRAGMENTS = 4096;
const DEFAULT_RETRY_MS = 100;

type FrameRecord = {
  id: number;
  /** Arrival of its first packet. */
  firstAt: number;
  from: PeerId;
  fragCount: number;
  /** The `linkSeq` its fragment 0 had (or would have had), from a live fragment; -1 if only retransmissions were seen. */
  seq0: number;
  /** The hole in front of this frame was found to be frames never sent. */
  gapExplained: boolean;
  /** Null once the frame is complete. */
  pending: {
    header: MediaHeader;
    parts: (Uint8Array | undefined)[];
    got: number;
    bytes: number;
    arrivedAt: Float64Array;
    asks: Uint8Array;
    askedAt: Float64Array;
    recovered: boolean;
  } | null;
};

type StreamState = {
  frames: Map<number, FrameRecord>;
  /** The ids in `frames`, ascending. */
  order: number[];
  /** Frames below this are over: their packets are dropped. */
  floor: number;
  pendingCount: number;
  /** Whole frames asked for: how often, and when last. */
  wholeAsks: Map<number, { asks: number; at: number }>;
  /**
   * Every frame below this id is settled: whole or out of asks, with the hole in front of it
   * filled, explained, or out of asks too. `missing` never names anything there again, so it
   * starts from here rather than from the oldest frame remembered.
   */
  settledBelow: number;
};

/**
 * Which of a sender's link sequence numbers have arrived, any packet of any type or stream: one
 * bit per number. Each arrival clears the number half the space ahead, so a bit is never stale
 * by a whole wrap.
 */
type SenderState = { seen: Uint8Array };

export function createReassembler(options: ReassemblerOptions): Reassembler {
  const reorderMs = options.reorderMs;
  const maxPending = Math.max(1, options.maxPending);
  const nackRetries = options.nackRetries ?? 1;
  const retryMs = options.retryMs ?? (() => DEFAULT_RETRY_MS);
  const maxFragments = options.maxFragments ?? DEFAULT_MAX_FRAGMENTS;
  const streams = new Map<number, StreamState>();
  const senders = new Map<PeerId, SenderState>();
  const counters = { frames: 0, duplicates: 0, expiredIncomplete: 0, late: 0, malformed: 0 };

  const stream = (id: number): StreamState => {
    let s = streams.get(id);
    if (!s) streams.set(id, (s = { frames: new Map(), order: [], floor: 0, pendingCount: 0, wholeAsks: new Map(), settledBelow: 0 }));
    return s;
  };

  const insertOrdered = (order: number[], id: number) => {
    if (order.length === 0 || order[order.length - 1] < id) {
      order.push(id);
      return;
    }
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (order[mid] < id) lo = mid + 1;
      else hi = mid;
    }
    order.splice(lo, 0, id);
  };

  /** Forgets everything of `s` below `floor`. */
  const raiseFloor = (s: StreamState, floor: number) => {
    if (floor <= s.floor) return;
    s.floor = floor;
    let drop = 0;
    while (drop < s.order.length && s.order[drop] < floor) {
      const record = s.frames.get(s.order[drop])!;
      if (record.pending) {
        counters.expiredIncomplete++;
        s.pendingCount--;
      }
      s.frames.delete(record.id);
      drop++;
    }
    if (drop > 0) s.order.splice(0, drop);
    if (s.wholeAsks.size > 0) for (const id of s.wholeAsks.keys()) if (id < floor) s.wholeAsks.delete(id);
  };

  const noteArrival = (from: PeerId, linkSeq: number) => {
    let sender = senders.get(from);
    if (!sender) senders.set(from, (sender = { seen: new Uint8Array(8192) }));
    const seq = linkSeq & 0xffff;
    sender.seen[seq >> 3] |= 1 << (seq & 7);
    const stale = (seq + 32768) & 0xffff;
    sender.seen[stale >> 3] &= ~(1 << (stale & 7));
  };

  /** Whether every packet `from` sent strictly between two link sequence numbers has arrived. */
  const allArrivedBetween = (from: PeerId, after: number, before: number): boolean => {
    const sender = senders.get(from);
    if (!sender) return false;
    for (let seq = (after + 1) & 0xffff; seq !== (before & 0xffff); seq = (seq + 1) & 0xffff) if (!(sender.seen[seq >> 3] & (1 << (seq & 7)))) return false;
    return true;
  };

  /**
   * Whether the hole in frame ids between `prev` and `next` is frames the sender never sent on
   * this link: nothing is missing from its link sequence between the two.
   */
  const neverSent = (prev: FrameRecord, next: FrameRecord): boolean => {
    if (next.gapExplained) return true;
    if (prev.from !== next.from || prev.seq0 < 0 || next.seq0 < 0) return false;
    const prevEnd = (prev.seq0 + prev.fragCount - 1) & 0xffff;
    const between = seq16Diff(next.seq0, prevEnd) - 1;
    if (between < 0 || between > MAX_EXPLAINED_SPAN) return false;
    // Every packet sent in between arrived (audio, heartbeats, another stream's): so nothing of
    // the missing frames was sent.
    if (!allArrivedBetween(prev.from, prevEnd, next.seq0)) return false;
    next.gapExplained = true;
    return true;
  };

  const askable = (asks: number, askedAt: number, now: number) => asks === 0 || (asks <= nackRetries && now - askedAt >= retryMs());
  const spent = (asks: number) => asks > nackRetries;

  /** Index of the first id in `order` at or above `id`. */
  const lowerBound = (order: number[], id: number) => {
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (order[mid] < id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  /** Whether `missing` can never name anything of `record`, or of the hole in front of it, again. */
  const settled = (s: StreamState, prev: FrameRecord | null, record: FrameRecord): boolean => {
    const pending = record.pending;
    if (pending) for (let frag = 0; frag < record.fragCount; frag++) if (pending.arrivedAt[frag] !== pending.arrivedAt[frag] && !spent(pending.asks[frag])) return false;
    if (!prev || record.gapExplained) return true;
    const hole = record.id - prev.id - 1;
    if (hole === 0 || hole > MAX_WHOLE_FRAME_GAP) return true;
    for (let id = prev.id + 1; id < record.id; id++) if (!spent(s.wholeAsks.get(id)?.asks ?? 0)) return false;
    return true;
  };

  return {
    push(packet, header, from, receivedAt) {
      if (header.type !== PacketType.Media) return null;
      const retransmit = (header.hopFlags & HopFlag.Retransmit) !== 0;
      noteArrival(from, header.linkSeq);
      const s = stream(header.streamId);
      const id = header.frameId;
      if (id < s.floor) {
        counters.late++;
        return null;
      }
      let record = s.frames.get(id);
      if (!record) {
        if (header.fragCount > maxFragments) {
          counters.malformed++;
          return null;
        }
        record = {
          id,
          firstAt: receivedAt,
          from,
          fragCount: header.fragCount,
          seq0: -1,
          gapExplained: false,
          pending: {
            header,
            parts: new Array<Uint8Array | undefined>(header.fragCount),
            got: 0,
            bytes: 0,
            arrivedAt: new Float64Array(header.fragCount).fill(NaN),
            asks: new Uint8Array(header.fragCount),
            askedAt: new Float64Array(header.fragCount),
            recovered: false,
          },
        };
        s.frames.set(id, record);
        insertOrdered(s.order, id);
        // A frame that fills a hole may itself have holes to ask for.
        if (id < s.settledBelow) s.settledBelow = id;
        s.pendingCount++;
        s.wholeAsks.delete(id);
        const newest = s.order[s.order.length - 1];
        if (newest - WINDOW_FRAMES > s.floor) raiseFloor(s, newest - WINDOW_FRAMES);
        while (s.pendingCount > maxPending) {
          // Give up on the oldest incomplete frame, and with it on everything before it.
          const oldest = s.order.find((frameId) => s.frames.get(frameId)!.pending !== null)!;
          if (oldest === id) break;
          raiseFloor(s, oldest + 1);
        }
      }
      if (!retransmit && record.seq0 < 0) {
        record.seq0 = (header.linkSeq - header.fragIndex) & 0xffff;
        record.from = from;
      }
      const pending = record.pending;
      if (!pending) {
        counters.duplicates++;
        return null;
      }
      if (header.fragCount !== record.fragCount) {
        counters.malformed++;
        return null;
      }
      if (pending.parts[header.fragIndex] !== undefined) {
        counters.duplicates++;
        return null;
      }
      const payload = packet.slice(MEDIA_HEADER_BYTES);
      pending.parts[header.fragIndex] = payload;
      pending.arrivedAt[header.fragIndex] = receivedAt;
      pending.got++;
      pending.bytes += payload.byteLength;
      if (header.hopFlags & (HopFlag.Replay | HopFlag.Retransmit)) pending.recovered = true;
      if (pending.got < record.fragCount) return null;

      let data: Uint8Array;
      if (record.fragCount === 1) data = payload;
      else {
        data = new Uint8Array(pending.bytes);
        let at = 0;
        for (const part of pending.parts) {
          data.set(part!, at);
          at += part!.byteLength;
        }
      }
      const first = pending.header;
      record.pending = null;
      s.pendingCount--;
      counters.frames++;
      const frame: ReceivedFrame = {
        header: {
          type: first.type,
          flags: first.flags,
          streamId: first.streamId,
          stripe: first.stripe,
          spatial: first.spatial,
          temporal: first.temporal,
          refDelta: first.refDelta,
          keyDelta: first.keyDelta,
          frameId: first.frameId,
          captureUs: first.captureUs,
          configId: first.configId,
        },
        data,
        firstPacketAt: record.firstAt,
        completeAt: receivedAt,
        from,
        recovered: pending.recovered,
      };
      return frame;
    },

    noteLinkPacket(from, linkSeq) {
      noteArrival(from, linkSeq);
    },

    neverSent(streamId, frameId) {
      const s = streams.get(streamId);
      if (!s || s.frames.has(frameId)) return false;
      const at = lowerBound(s.order, frameId);
      if (at === 0 || at >= s.order.length) return false;
      return neverSent(s.frames.get(s.order[at - 1])!, s.frames.get(s.order[at])!);
    },

    missing(now, max) {
      const items: NackItem[] = [];
      for (const [streamId, s] of streams) {
        const order = s.order;
        const n = order.length;
        const start = lowerBound(order, s.settledBelow);
        if (start >= n) continue;
        // laterAt[i - start]: the earliest arrival of any packet of a frame after order[i].
        const laterAt = new Float64Array(n - start);
        let earliest = Infinity;
        for (let i = n - 1; i >= start; i--) {
          laterAt[i - start] = earliest;
          const at = s.frames.get(order[i])!.firstAt;
          if (at < earliest) earliest = at;
        }
        let prev: FrameRecord | null = start > 0 ? s.frames.get(order[start - 1])! : null;
        let settling = true;
        for (let i = start; i < n && items.length < max; i++) {
          const record = s.frames.get(order[i])!;
          const before = prev;
          // Whole frames missing in front of this one: due once this frame, or a later one, has been here for reorderMs.
          if (prev && record.id - prev.id > 1 && record.id - prev.id - 1 <= MAX_WHOLE_FRAME_GAP) {
            const seenLaterAt = Math.min(record.firstAt, laterAt[i - start]);
            if (now - seenLaterAt >= reorderMs && !neverSent(prev, record)) {
              for (let id = prev.id + 1; id < record.id && items.length < max; id++) {
                const asked = s.wholeAsks.get(id);
                if (asked && !askable(asked.asks, asked.at, now)) continue;
                s.wholeAsks.set(id, { asks: (asked?.asks ?? 0) + 1, at: now });
                items.push({ streamId, frameId: id, firstFrag: NACK_WHOLE_FRAME, mask: 0 });
              }
            }
          }
          prev = record;
          const pending = record.pending;
          if (!pending || items.length >= max) {
            if (settling && (settling = settled(s, before, record))) s.settledBelow = record.id + 1;
            continue;
          }
          // Fragments missing inside this frame: due once a later fragment, or a later frame, has been here for reorderMs.
          let ask: number[] | null = null;
          let later = laterAt[i - start];
          for (let frag = record.fragCount - 1; frag >= 0; frag--) {
            const at = pending.arrivedAt[frag];
            if (at === at) {
              if (at < later) later = at;
            } else if (now - later >= reorderMs && askable(pending.asks[frag], pending.askedAt[frag], now)) {
              (ask ??= []).push(frag);
            }
          }
          if (!ask) {
            if (settling && (settling = settled(s, before, record))) s.settledBelow = record.id + 1;
            continue;
          }
          ask.reverse();
          const frameItems = nackItemsFor(streamId, record.id, ask).slice(0, max - items.length);
          for (const item of frameItems) {
            items.push(item);
            for (const frag of [item.firstFrag, ...Array.from({ length: 16 }, (_, bit) => (item.mask & (1 << bit) ? item.firstFrag + 1 + bit : -1))]) {
              if (frag < 0) continue;
              pending.asks[frag]++;
              pending.askedAt[frag] = now;
            }
          }
          if (settling && (settling = settled(s, before, record))) s.settledBelow = record.id + 1;
        }
        if (items.length >= max) break;
      }
      return items;
    },

    expireBefore(streamId, frameId) {
      raiseFloor(stream(streamId), frameId);
    },

    counters: () => ({ ...counters }),
  };
}
