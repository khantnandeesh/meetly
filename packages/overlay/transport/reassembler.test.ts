/** PLAN T2: the reassembler. SPEC §4.2, §4.6. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HopFlag, MediaFlag, NACK_WHOLE_FRAME, PacketType, decodeMediaHeader, nackFragments, packetizeFrame, writeHopFields, type FrameHeader, type NackItem } from "@meetly/overlay";
import { createReassembler } from "@meetly/overlay/transport/index";
import { FakeClock } from "@meetly/overlay/transport/fakes";
import type { ReceivedFrame } from "@meetly/overlay/types";

/** A small seeded generator (mulberry32), so a failure can be run again. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const frameHeader = (frameId: number, over: Partial<FrameHeader> = {}): FrameHeader => ({
  type: PacketType.Media,
  flags: frameId % 60 === 0 ? MediaFlag.Key : 0,
  streamId: 0,
  stripe: 0,
  spatial: 0,
  temporal: 0,
  refDelta: frameId % 60 === 0 ? 0 : 1,
  keyDelta: frameId % 60,
  frameId,
  captureUs: frameId * 33_333,
  configId: 0,
  ...over,
});

/** The packets of one frame with `fragments` fragments, stamped with consecutive link sequence numbers from `seq`. */
function packets(frameId: number, fragments: number, seq: { n: number }, random: () => number = Math.random, over: Partial<FrameHeader> = {}, hopFlags = 0) {
  const data = new Uint8Array(fragments * 40 - 7);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(random() * 256);
  const out = packetizeFrame(frameHeader(frameId, over), data, 40);
  for (const packet of out) writeHopFields(packet, { hopFlags, hops: 1, linkSeq: seq.n++ & 0xffff, sendMs: 0 });
  return { data, packets: out };
}

const push = (reassembler: ReturnType<typeof createReassembler>, packet: Uint8Array, at: number, from = "parent") => reassembler.push(packet, decodeMediaHeader(packet)!, from, at);

const named = (items: NackItem[]) => items.map((item) => `${item.frameId}:${item.firstFrag === NACK_WHOLE_FRAME ? "all" : nackFragments(item)!.join(",")}`);

describe("reassembler", () => {
  it("10,000 random frames with reordering, 5% loss and duplicates: every complete frame once, byte-identical; missing() names exactly what was lost, never before reorderMs", () => {
    const random = rng(20261121);
    const REORDER_MS = 10;
    const clock = new FakeClock(0);
    const reassembler = createReassembler({ clock, reorderMs: REORDER_MS, maxPending: 100_000, nackRetries: 0 });

    type Delivery = { at: number; packet: Uint8Array | null; frameId: number; frag: number; order: number; heartbeatSeq: number };
    const deliveries: Delivery[] = [];
    const sent = new Map<number, { data: Uint8Array; fragments: number; lost: Set<number> }>();
    const seq = { n: 65_000 }; // wraps early in the run
    let t = 0;
    let order = 0;
    const FRAMES = 10_000;
    for (let frameId = 0; frameId < FRAMES + 5; frameId++) {
      const fragments = 1 + Math.floor(random() * 8);
      const frame = packets(frameId, fragments, seq, random);
      const lost = new Set<number>();
      frame.packets.forEach((packet, frag) => {
        t += 0.3;
        const mayLose = frameId < FRAMES; // the last five arrive whole, so every earlier loss falls due
        if (mayLose && random() < 0.05) lost.add(frag);
        else {
          deliveries.push({ at: t + random() * 8, packet, frameId, frag, order: order++, heartbeatSeq: -1 });
          if (random() < 0.03) deliveries.push({ at: t + random() * 8, packet, frameId, frag, order: order++, heartbeatSeq: -1 });
        }
      });
      sent.set(frameId, { data: frame.data, fragments, lost });
      // A heartbeat now and then takes a link sequence number of its own, and may be lost too.
      if (random() < 0.1) {
        const heartbeatSeq = seq.n++ & 0xffff;
        if (random() >= 0.05) deliveries.push({ at: t + random() * 8, packet: null, frameId: -1, frag: -1, order: order++, heartbeatSeq });
      }
    }
    deliveries.sort((a, b) => a.at - b.at || a.order - b.order);

    const out = new Map<number, ReceivedFrame>();
    /** When each fragment that arrived first arrived, by "frame:frag". */
    const arrivals: { frameId: number; frag: number; at: number }[] = [];
    const asked = new Map<string, number>();
    let duplicatesSent = 0;
    const seen = new Set<string>();
    let nextAsk = 0;
    const ask = (now: number) => {
      for (const item of reassembler.missing(now, 64)) {
        const frame = sent.get(item.frameId)!;
        const frags = item.firstFrag === NACK_WHOLE_FRAME ? Array.from({ length: frame.fragments }, (_, i) => i) : nackFragments(item)!;
        if (item.firstFrag === NACK_WHOLE_FRAME) assert.equal(frame.lost.size, frame.fragments, `frame ${item.frameId} was asked for whole but was not wholly lost`);
        for (const frag of frags) {
          const key = `${item.frameId}:${frag}`;
          assert.ok(!asked.has(key), `${key} asked for twice with nackRetries 0`);
          asked.set(key, now);
        }
      }
    };
    for (const delivery of deliveries) {
      while (nextAsk <= delivery.at) {
        clock.advance(nextAsk - clock.now());
        ask(nextAsk);
        nextAsk += 5;
      }
      clock.advance(delivery.at - clock.now());
      if (!delivery.packet) {
        reassembler.noteLinkPacket("parent", delivery.heartbeatSeq);
        continue;
      }
      const key = `${delivery.frameId}:${delivery.frag}`;
      if (seen.has(key)) duplicatesSent++;
      else {
        seen.add(key);
        arrivals.push({ frameId: delivery.frameId, frag: delivery.frag, at: delivery.at });
      }
      const frame = push(reassembler, delivery.packet, delivery.at);
      if (frame) {
        assert.ok(!out.has(frame.header.frameId), `frame ${frame.header.frameId} came out twice`);
        out.set(frame.header.frameId, frame);
      }
    }
    clock.advance(100);
    ask(clock.now());

    // Every complete frame, once, byte-identical; no incomplete frame.
    let complete = 0;
    for (const [frameId, frame] of sent) {
      if (frame.lost.size > 0) {
        assert.ok(!out.has(frameId), `incomplete frame ${frameId} came out`);
        continue;
      }
      complete++;
      const got = out.get(frameId);
      assert.ok(got, `complete frame ${frameId} did not come out`);
      assert.deepEqual(got.data, frame.data);
      assert.deepEqual(got.header, frameHeader(frameId));
      assert.ok(got.completeAt >= got.firstPacketAt);
    }
    assert.equal(out.size, complete);
    assert.ok(complete > 7000 && complete < FRAMES, `${complete} complete frames`);
    assert.equal(reassembler.counters().frames, complete);
    assert.equal(reassembler.counters().duplicates + reassembler.counters().late, duplicatesSent);

    // Exactly the lost fragments were asked for.
    const lost = new Set<string>();
    for (const [frameId, frame] of sent) for (const frag of frame.lost) lost.add(`${frameId}:${frag}`);
    assert.ok(lost.size > 1500, `${lost.size} lost`);
    for (const key of asked.keys()) assert.ok(lost.has(key), `${key} was asked for but had arrived, or was only late`);
    for (const key of lost) assert.ok(asked.has(key), `${key} was lost and never asked for`);

    // None before a later packet had been here for reorderMs.
    arrivals.sort((a, b) => a.frameId - b.frameId || a.frag - b.frag);
    const earliestLater = new Float64Array(arrivals.length + 1);
    earliestLater[arrivals.length] = Infinity;
    for (let i = arrivals.length - 1; i >= 0; i--) earliestLater[i] = Math.min(earliestLater[i + 1], arrivals[i].at);
    for (const [key, at] of asked) {
      const [frameId, frag] = key.split(":").map(Number);
      let lo = 0;
      let hi = arrivals.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arrivals[mid].frameId < frameId || (arrivals[mid].frameId === frameId && arrivals[mid].frag <= frag)) lo = mid + 1;
        else hi = mid;
      }
      assert.ok(at - earliestLater[lo] >= REORDER_MS, `${key} asked for ${at - earliestLater[lo]} ms after a later packet`);
    }
  });

  it("names a fragment again after retryMs, nackRetries times, and then no more", () => {
    const clock = new FakeClock(0);
    const reassembler = createReassembler({ clock, reorderMs: 10, maxPending: 64, nackRetries: 1, retryMs: () => 30 });
    const seq = { n: 0 };
    const frame = packets(1, 4, seq).packets;
    push(reassembler, frame[0], 0);
    push(reassembler, frame[3], 0);
    assert.deepEqual(named(reassembler.missing(9, 64)), []);
    assert.deepEqual(named(reassembler.missing(10, 64)), ["1:1,2"]);
    assert.deepEqual(named(reassembler.missing(39, 64)), []);
    assert.deepEqual(named(reassembler.missing(40, 64)), ["1:1,2"]);
    assert.deepEqual(named(reassembler.missing(500, 64)), []);
    // What arrives in the meantime is no longer named.
    const other = packets(2, 3, seq).packets;
    push(reassembler, other[2], 500);
    assert.deepEqual(named(reassembler.missing(510, 64)), ["2:0,1"]);
    push(reassembler, other[0], 520);
    assert.deepEqual(named(reassembler.missing(560, 64)), ["2:1"]);
  });

  it("does not ask for frames the parent never sent (a shed layer), and does ask for one that was lost among them", () => {
    const clock = new FakeClock(0);
    const reassembler = createReassembler({ clock, reorderMs: 10, maxPending: 64, nackRetries: 0 });
    const seq = { n: 100 };
    // The parent sends only even frames, and a heartbeat after every fourth of them.
    const sentFrames = new Map<number, Uint8Array[]>();
    let t = 0;
    for (let frameId = 0; frameId < 40; frameId += 2) {
      sentFrames.set(frameId, packets(frameId, 1 + (frameId % 3), seq).packets);
      if (frameId % 8 === 6) reassembler.noteLinkPacket("parent", seq.n++);
      if (frameId === 20) continue; // lost, whole
      for (const packet of sentFrames.get(frameId)!) push(reassembler, packet, t);
      t += 33;
    }
    const asked = named(reassembler.missing(t + 100, 64));
    // Frame 20 was lost; its neighbours 19 and 21 were never sent, but that cannot be told from the wire.
    assert.deepEqual(asked, ["19:all", "20:all", "21:all"]);
    assert.equal(reassembler.counters().frames, 19);
  });

  it("asks for a whole hole when a heartbeat it did not see went missing with it (it cannot tell), but only once", () => {
    const clock = new FakeClock(0);
    const reassembler = createReassembler({ clock, reorderMs: 10, maxPending: 64, nackRetries: 0 });
    const seq = { n: 0 };
    push(reassembler, packets(0, 1, seq).packets[0], 0);
    seq.n++; // a heartbeat, lost
    push(reassembler, packets(2, 1, seq).packets[0], 33);
    assert.deepEqual(named(reassembler.missing(100, 64)), ["1:all"]);
    assert.deepEqual(named(reassembler.missing(1000, 64)), []);
  });

  it("drops and counts duplicates, late packets, parity, and packets that contradict their frame", () => {
    const clock = new FakeClock(0);
    const reassembler = createReassembler({ clock, reorderMs: 10, maxPending: 64, maxFragments: 8 });
    const seq = { n: 0 };
    const a = packets(5, 2, seq).packets;
    assert.equal(push(reassembler, a[0], 1), null);
    assert.equal(push(reassembler, a[0], 2), null);
    const frame = push(reassembler, a[1], 3, "other");
    assert.ok(frame);
    assert.equal(frame.firstPacketAt, 1);
    assert.equal(frame.completeAt, 3);
    assert.equal(frame.from, "other");
    assert.equal(frame.recovered, false);
    assert.equal(push(reassembler, a[1], 4), null);
    assert.deepEqual(reassembler.counters(), { frames: 1, duplicates: 2, expiredIncomplete: 0, late: 0, malformed: 0 });

    // Another fragment count for the same frame id.
    const b = packets(6, 2, seq).packets;
    push(reassembler, b[0], 5);
    assert.equal(push(reassembler, packets(6, 3, seq).packets[2], 5), null);
    // Too many fragments to hold.
    assert.equal(push(reassembler, packets(7, 9, seq).packets[0], 5), null);
    assert.equal(reassembler.counters().malformed, 2);
    // Parity is stage 2's.
    const parity = packets(8, 1, seq, Math.random, { type: PacketType.Parity }).packets[0];
    assert.equal(push(reassembler, parity, 5), null);

    reassembler.expireBefore(0, 7);
    assert.equal(reassembler.counters().expiredIncomplete, 1);
    assert.equal(push(reassembler, b[1], 6), null);
    assert.equal(reassembler.counters().late, 1);
    assert.deepEqual(named(reassembler.missing(1000, 64)), []);
  });

  it("marks a frame recovered when any of it came from a replay or a retransmission", () => {
    const clock = new FakeClock(0);
    const reassembler = createReassembler({ clock, reorderMs: 10, maxPending: 64 });
    const seq = { n: 0 };
    const live = packets(1, 2, seq).packets;
    const again = packets(1, 2, seq, Math.random, {}, HopFlag.Retransmit).packets;
    push(reassembler, live[0], 0);
    assert.equal(push(reassembler, again[1], 30)!.recovered, true);
    const replayed = packets(2, 1, seq, Math.random, {}, HopFlag.Replay).packets;
    assert.equal(push(reassembler, replayed[0], 31)!.recovered, true);
  });

  it("holds at most maxPending incomplete frames per stream, giving up on the oldest", () => {
    const clock = new FakeClock(0);
    const reassembler = createReassembler({ clock, reorderMs: 10, maxPending: 3 });
    const seq = { n: 0 };
    const frames = [1, 2, 3, 4].map((id) => packets(id, 2, seq).packets);
    for (const frame of frames) push(reassembler, frame[0], 0);
    assert.equal(reassembler.counters().expiredIncomplete, 1);
    assert.equal(push(reassembler, frames[0][1], 1), null); // given up on
    assert.ok(push(reassembler, frames[1][1], 1));
    // Another stream has its own count.
    const audio = packets(1, 2, seq, Math.random, { streamId: 1 }).packets;
    push(reassembler, audio[0], 2);
    assert.equal(reassembler.counters().expiredIncomplete, 1);
  });

  it("keeps streams apart, and takes at most `max` items", () => {
    const clock = new FakeClock(0);
    const reassembler = createReassembler({ clock, reorderMs: 10, maxPending: 64, nackRetries: 0 });
    const seq = { n: 0 };
    for (const streamId of [0, 1]) {
      for (const frameId of [1, 2, 3]) {
        const frame = packets(frameId, 40, seq, Math.random, { streamId }).packets;
        push(reassembler, frame[0], 0);
        push(reassembler, frame[39], 0);
      }
    }
    const first = reassembler.missing(100, 4);
    assert.equal(first.length, 4);
    assert.deepEqual(new Set(first.map((item) => item.streamId)), new Set([0]));
    assert.deepEqual(first.map((item) => item.frameId), [1, 1, 1, 2]);
    const rest = reassembler.missing(100, 64);
    assert.equal(rest.length, 6 * 3 - 4);
  });
});
