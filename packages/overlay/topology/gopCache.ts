/**
 * The GOP cache: recent packets of each stream, exactly as they arrived. It is what makes a join
 * quick and a repair lossless ("send me everything after frame X"), and what a NACK is answered
 * from. SPEC §5.3 (`sub`), §7.5, §4.6.
 *
 * Limits. The spec keeps "from the newest keyframe on, and the GOP before it, up to `gopCacheMs`
 * and `gopCacheBytes`". With a keyframe every 2 s and 4 s kept those are the same thing for
 * video, and for audio (every frame a keyframe) only the time limit means anything, so the cache
 * holds by time and bytes alone.
 *
 * Owner: E-transport+topology.
 */
import { FROM_LATEST_KEYFRAME, FROM_LIVE, MediaFlag, type MediaHeader, type StreamHead } from "../protocol";
import type { GopCache, GopCacheOptions } from "./types";

type CachedFrame = {
  id: number;
  /** When its first packet was added. */
  at: number;
  key: boolean;
  stripe: number;
  spatial: number;
  temporal: number;
  fragCount: number;
  /** By fragment index. */
  packets: (Uint8Array | undefined)[];
  got: number;
  bytes: number;
};

type CachedStream = {
  frames: Map<number, CachedFrame>;
  /** The ids in `frames`, ascending. */
  order: number[];
  /** The newest frame held whole, or -1. */
  head: number;
  /** The newest keyframe held (whole or not), or -1. */
  key: number;
  /** Frames below this were trimmed away, and are not taken back. */
  floor: number;
};

export function createGopCache(options: GopCacheOptions): GopCache & {
  /** As `add`, and says whether the packet was new to the cache. */
  addNew(packet: Uint8Array, header: MediaHeader, now: number): boolean;
} {
  const streams = new Map<number, CachedStream>();
  let bytes = 0;

  const dropOldest = (s: CachedStream) => {
    const frame = s.frames.get(s.order[0])!;
    s.order.shift();
    s.frames.delete(frame.id);
    bytes -= frame.bytes;
    s.floor = frame.id + 1;
    if (frame.id === s.key) s.key = -1;
    if (frame.id === s.head) s.head = -1;
  };

  const trim = (now: number) => {
    for (const s of streams.values()) {
      while (s.order.length > 0 && now - s.frames.get(s.order[0])!.at > options.maxMs) dropOldest(s);
    }
    while (bytes > options.maxBytes) {
      // The oldest frame of any stream goes first.
      let oldest: CachedStream | null = null;
      let oldestAt = Infinity;
      for (const s of streams.values()) {
        if (s.order.length === 0) continue;
        const at = s.frames.get(s.order[0])!.at;
        if (at < oldestAt) {
          oldestAt = at;
          oldest = s;
        }
      }
      if (!oldest) break;
      dropOldest(oldest);
    }
  };

  const addNew = (packet: Uint8Array, header: MediaHeader, now: number): boolean => {
    if (options.maxMs <= 0 || options.maxBytes < packet.byteLength) return false;
    let s = streams.get(header.streamId);
    if (!s) streams.set(header.streamId, (s = { frames: new Map(), order: [], head: -1, key: -1, floor: 0 }));
    let frame = s.frames.get(header.frameId);
    if (!frame) {
      if (header.frameId < s.floor) return false;
      frame = {
        id: header.frameId,
        at: now,
        key: (header.flags & MediaFlag.Key) !== 0,
        stripe: header.stripe,
        spatial: header.spatial,
        temporal: header.temporal,
        fragCount: header.fragCount,
        packets: new Array<Uint8Array | undefined>(Math.min(header.fragCount, 64)),
        got: 0,
        bytes: 0,
      };
      s.frames.set(frame.id, frame);
      const order = s.order;
      if (order.length === 0 || order[order.length - 1] < frame.id) order.push(frame.id);
      else {
        let at = order.length - 1;
        while (at > 0 && order[at - 1] > frame.id) at--;
        order.splice(at, 0, frame.id);
      }
      if (frame.key && frame.id > s.key) s.key = frame.id;
    }
    if (header.fragCount !== frame.fragCount || frame.packets[header.fragIndex] !== undefined) return false;
    frame.packets[header.fragIndex] = packet.slice();
    frame.got++;
    frame.bytes += packet.byteLength;
    bytes += packet.byteLength;
    if (frame.got === frame.fragCount && frame.id > s.head) s.head = frame.id;
    trim(now);
    return true;
  };

  return {
    add(packet, header, now) {
      addNew(packet, header, now);
    },
    addNew,

    replay(streamId, stripes, fromFrame, cap) {
      const s = streams.get(streamId);
      if (!s || s.order.length === 0 || fromFrame === FROM_LIVE) return [];
      let after: number;
      if (fromFrame === FROM_LATEST_KEYFRAME) {
        if (s.key < 0) return [];
        after = s.key - 1;
      } else {
        // The cache "reaches" X if nothing after X has been trimmed away: X or its successor is
        // still held, or the GOP X belongs to is held from its keyframe.
        const oldest = s.order[0];
        let oldestKey = -1;
        for (const id of s.order) {
          if (s.frames.get(id)!.key) {
            oldestKey = id;
            break;
          }
        }
        const reaches = fromFrame >= oldest - 1 || (oldestKey >= 0 && fromFrame >= oldestKey);
        if (reaches) after = fromFrame;
        else if (s.key >= 0) after = s.key - 1;
        else return [];
      }
      const out: Uint8Array[] = [];
      for (const id of s.order) {
        if (id <= after) continue;
        const frame = s.frames.get(id)!;
        if (frame.temporal > cap.maxTemporal || frame.spatial > cap.maxSpatial || !stripes.includes(frame.stripe)) continue;
        for (const packet of frame.packets) if (packet) out.push(packet);
      }
      return out;
    },

    fragments(streamId, frameId, fragments) {
      const frame = streams.get(streamId)?.frames.get(frameId);
      if (!frame) return [];
      const out: Uint8Array[] = [];
      if (fragments === null) {
        for (const packet of frame.packets) if (packet) out.push(packet);
      } else {
        for (const index of fragments) {
          const packet = frame.packets[index];
          if (packet) out.push(packet);
        }
      }
      return out;
    },

    head(streamId): StreamHead | null {
      const s = streams.get(streamId);
      if (!s || s.head < 0) return null;
      return { streamId, headFrameId: s.head, keyFrameId: s.key >= 0 ? s.key : s.head };
    },

    trim,
    bytes: () => bytes,
  };
}
