/** PLAN T2: the GOP cache. SPEC §5.3 (`sub`), §7.5, §4.6. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FROM_LATEST_KEYFRAME, FROM_LIVE, MediaFlag, PacketType, decodeMediaHeader, packetizeFrame, type FrameHeader } from "@meetly/overlay";
import { createGopCache } from "@meetly/overlay/topology/index";

const GOP = 8;
/** L1T3: layer 0 every fourth frame, layer 1 between them, layer 2 the odd ones. */
const temporalOf = (frameId: number) => (frameId % 4 === 0 ? 0 : frameId % 2 === 0 ? 1 : 2);

function frame(frameId: number, over: Partial<FrameHeader> = {}, fragments = 2): Uint8Array[] {
  const key = frameId % GOP === 0;
  const header: FrameHeader = {
    type: PacketType.Media,
    flags: key ? MediaFlag.Key : temporalOf(frameId) === 2 ? MediaFlag.Discardable : 0,
    streamId: 0,
    stripe: 0,
    spatial: 0,
    temporal: temporalOf(frameId),
    refDelta: key ? 0 : temporalOf(frameId) === 0 ? 4 : temporalOf(frameId) === 1 ? 2 : 1,
    keyDelta: frameId % GOP,
    frameId,
    captureUs: frameId * 33_333,
    configId: 0,
    ...over,
  };
  return packetizeFrame(header, new Uint8Array(fragments * 100 - 1).fill(frameId & 0xff), 100);
}

const ALL = { maxSpatial: 15, maxTemporal: 15 };
const ids = (packets: Uint8Array[]) => packets.map((p) => `${decodeMediaHeader(p)!.frameId}.${decodeMediaHeader(p)!.fragIndex}`);
const frameIds = (packets: Uint8Array[]) => [...new Set(packets.map((p) => decodeMediaHeader(p)!.frameId))];

function filled(from: number, to: number, options = { maxMs: 4000, maxBytes: 4 * 1024 * 1024 }) {
  const cache = createGopCache(options);
  for (let id = from; id <= to; id++) for (const packet of frame(id)) cache.add(packet, decodeMediaHeader(packet)!, id * 33);
  return cache;
}

describe("GOP cache: replay(fromFrame)", () => {
  it("FROM_LIVE replays nothing", () => {
    assert.deepEqual(filled(0, 20).replay(0, [0], FROM_LIVE, ALL), []);
  });

  it("FROM_LATEST_KEYFRAME starts at the newest keyframe, every packet, in sending order", () => {
    const cache = filled(0, 20);
    assert.deepEqual(ids(cache.replay(0, [0], FROM_LATEST_KEYFRAME, ALL)), ["16.0", "16.1", "17.0", "17.1", "18.0", "18.1", "19.0", "19.1", "20.0", "20.1"]);
  });

  it("a frame id replays every frame after it, and no more", () => {
    const cache = filled(0, 20);
    assert.deepEqual(frameIds(cache.replay(0, [0], 12, ALL)), [13, 14, 15, 16, 17, 18, 19, 20]);
    assert.deepEqual(frameIds(cache.replay(0, [0], 19, ALL)), [20]);
    assert.deepEqual(cache.replay(0, [0], 20, ALL), []);
    assert.deepEqual(cache.replay(0, [0], 99, ALL), []);
  });

  it("a frame id older than the cache reaches starts from the newest keyframe instead", () => {
    // 40 frames at 33 ms with 500 ms kept: frames 25..40 remain; the keyframes held are 32 and 40.
    const cache = filled(0, 40, { maxMs: 500, maxBytes: 4 * 1024 * 1024 });
    assert.equal(frameIds(cache.replay(0, [0], 39, ALL)).join(), "40");
    assert.deepEqual(frameIds(cache.replay(0, [0], 3, ALL)), [40]);
    // Frame 24 is just before the oldest held (25): nothing in between is gone.
    assert.deepEqual(frameIds(cache.replay(0, [0], 24, ALL))[0], 25);
    // Frame 30 is inside what is held.
    assert.deepEqual(frameIds(cache.replay(0, [0], 30, ALL))[0], 31);
  });

  it("leaves out layers above the cap, and stripes not asked for", () => {
    const cache = filled(0, 20);
    assert.deepEqual(frameIds(cache.replay(0, [0], 7, { maxSpatial: 0, maxTemporal: 0 })), [8, 12, 16, 20]);
    assert.deepEqual(frameIds(cache.replay(0, [0], 7, { maxSpatial: 0, maxTemporal: 1 })), [8, 10, 12, 14, 16, 18, 20]);
    assert.deepEqual(cache.replay(0, [1], 7, ALL), []);
    assert.deepEqual(cache.replay(1, [0], 7, ALL), []);
  });

  it("replays in frame order whatever order packets arrived in, and each packet once", () => {
    const cache = createGopCache({ maxMs: 4000, maxBytes: 1 << 20 });
    for (const id of [8, 10, 9, 11]) {
      const [a, b] = frame(id);
      cache.add(b, decodeMediaHeader(b)!, 0);
      cache.add(a, decodeMediaHeader(a)!, 0);
      cache.add(a, decodeMediaHeader(a)!, 0);
    }
    assert.deepEqual(ids(cache.replay(0, [0], FROM_LATEST_KEYFRAME, ALL)), ["8.0", "8.1", "9.0", "9.1", "10.0", "10.1", "11.0", "11.1"]);
  });

  it("replays nothing from the latest keyframe when it holds none", () => {
    assert.deepEqual(filled(1, 5).replay(0, [0], FROM_LATEST_KEYFRAME, ALL), []);
    assert.deepEqual(frameIds(filled(1, 5).replay(0, [0], 2, ALL)), [3, 4, 5]);
  });
});

describe("GOP cache: fragments, head and limits", () => {
  it("answers a NACK with the fragments asked for, or the whole frame, or nothing once they are gone", () => {
    const cache = createGopCache({ maxMs: 4000, maxBytes: 1 << 20 });
    for (const packet of frame(3, {}, 5)) cache.add(packet, decodeMediaHeader(packet)!, 0);
    assert.deepEqual(ids(cache.fragments(0, 3, [1, 4])), ["3.1", "3.4"]);
    assert.deepEqual(ids(cache.fragments(0, 3, null)), ["3.0", "3.1", "3.2", "3.3", "3.4"]);
    assert.deepEqual(cache.fragments(0, 3, [7]), []);
    assert.deepEqual(cache.fragments(0, 4, null), []);
    assert.deepEqual(cache.fragments(9, 3, null), []);
  });

  it("keeps a copy: the caller's buffer may be reused", () => {
    const cache = createGopCache({ maxMs: 4000, maxBytes: 1 << 20 });
    const [packet] = frame(8, {}, 1);
    const original = packet.slice();
    cache.add(packet, decodeMediaHeader(packet)!, 0);
    packet.fill(0xee);
    assert.deepEqual(cache.fragments(0, 8, null)[0], original);
  });

  it("head: the newest frame held whole, and the newest keyframe", () => {
    const cache = filled(0, 18);
    assert.deepEqual(cache.head(0), { streamId: 0, headFrameId: 18, keyFrameId: 16 });
    const [first] = frame(19);
    cache.add(first, decodeMediaHeader(first)!, 700);
    assert.equal(cache.head(0)!.headFrameId, 18);
    assert.equal(cache.head(1), null);
  });

  it("holds no more than maxMs of media", () => {
    const cache = filled(0, 300, { maxMs: 4000, maxBytes: 64 * 1024 * 1024 });
    const held = frameIds(cache.replay(0, [0], 0, ALL));
    assert.equal(held.at(-1), 300);
    // Frame 300 was added at 9,900 ms: nothing older than 5,900 ms (frame 179) remains.
    assert.equal(cache.fragments(0, 178, null).length, 0);
    assert.equal(cache.fragments(0, 179, null).length, 2);
    cache.trim(300 * 33 + 4000 - 1);
    assert.deepEqual(frameIds(cache.replay(0, [0], 299, ALL)), [300]);
    assert.equal(cache.fragments(0, 299, null).length, 0);
    cache.trim(1e9);
    assert.equal(cache.bytes(), 0);
    assert.equal(cache.head(0), null);
  });

  it("holds no more than maxBytes, dropping the oldest of any stream first", () => {
    const cache = createGopCache({ maxMs: 60_000, maxBytes: 10_000 });
    let worst = 0;
    for (let id = 0; id < 200; id++) {
      for (const packet of [...frame(id), ...frame(id, { streamId: 1, flags: MediaFlag.Key, temporal: 0, refDelta: 0, keyDelta: 0 }, 1)]) {
        cache.add(packet, decodeMediaHeader(packet)!, id * 20);
        worst = Math.max(worst, cache.bytes());
      }
    }
    assert.ok(worst <= 10_000, `${worst} bytes held`);
    assert.ok(cache.bytes() > 9_000);
    assert.equal(cache.head(0)!.headFrameId, 199);
    assert.equal(cache.head(1)!.headFrameId, 199);
    // What was trimmed is not taken back.
    const [old] = frame(2);
    cache.add(old, decodeMediaHeader(old)!, 4000);
    assert.deepEqual(cache.fragments(0, 2, null), []);
  });

  it("keeps nothing when told to keep nothing", () => {
    const cache = createGopCache({ maxMs: 0, maxBytes: 0 });
    for (const packet of frame(0)) cache.add(packet, decodeMediaHeader(packet)!, 0);
    assert.equal(cache.bytes(), 0);
    assert.equal(cache.head(0), null);
  });
});
