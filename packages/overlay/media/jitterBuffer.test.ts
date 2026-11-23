/**
 * The jitter buffer against SPEC §10.1–§10.4, sentence by sentence (PLAN, E-media M2). Each
 * test's name quotes or paraphrases the sentence it holds the buffer to.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MediaFlag } from "@meetly/overlay";
import type { ReceivedFrame } from "@meetly/overlay/types";
import { createJitterBuffer, playoutDelayTarget } from "@meetly/overlay/media/jitterBuffer";
import type { JitterBuffer, PlayoutFrame } from "@meetly/overlay/media/types";
import { AUDIO_CONFIG, VIDEO_CONFIG, audioFrames, createFakeClock, seeded, videoFrames, type FakeClock } from "@meetly/overlay/media/testing/fakes";

const FRAME_MS = 1000 / 30;
const D = 60;

function setup(config = VIDEO_CONFIG, playoutMinMs = D, playoutMaxMs = 400) {
  const clock = createFakeClock();
  const buffer = createJitterBuffer({ config, playoutMinMs, playoutMaxMs, clock });
  const events: string[] = [];
  buffer.on("stall", (_stream, frameId) => events.push(`stall ${frameId}`));
  buffer.on("skip", (_stream, frameId) => events.push(`skip ${frameId}`));
  return { clock, buffer, events };
}

type Popped = PlayoutFrame & { at: number };

/** Steps the clock to `untilMs` in 1 ms steps, delivering `arrivals` at their times and popping at each step. */
function play(clock: FakeClock, buffer: JitterBuffer, untilMs: number, arrivals: { at: number; frame: ReceivedFrame }[] = []): Popped[] {
  const queue = [...arrivals].sort((a, b) => a.at - b.at);
  const out: Popped[] = [];
  while (clock.now() < untilMs) {
    clock.advance(1);
    while (queue.length > 0 && (queue[0] as { at: number }).at <= clock.now()) buffer.push((queue.shift() as { frame: ReceivedFrame }).frame);
    for (const popped of buffer.pop(clock.now() * 1000)) out.push({ ...popped, at: clock.now() });
  }
  return out;
}

/** Each frame arrives `latencyMs` after it was captured. */
const live = (frames: ReceivedFrame[], latencyMs = 5) => frames.map((frame) => ({ at: frame.header.captureUs / 1000 + latencyMs, frame }));
const ids = (popped: PlayoutFrame[]) => popped.map((p) => p.frame.header.frameId);

/** A decoder that knows only headers: it refuses a frame whose reference it was not given, in this GOP. */
function headerDecoder() {
  let gopKey = -1;
  let last = -1;
  const decoded = new Set<number>();
  return (frame: ReceivedFrame) => {
    const { header } = frame;
    assert.ok(header.frameId > last, `frame ${header.frameId} handed out after ${last}`);
    last = header.frameId;
    if ((header.flags & MediaFlag.Key) !== 0) {
      gopKey = header.frameId;
      decoded.clear();
    } else {
      assert.equal(header.frameId - header.keyDelta, gopKey, `frame ${header.frameId} is of another GOP`);
      assert.ok(decoded.has(header.frameId - header.refDelta), `frame ${header.frameId} needs ${header.frameId - header.refDelta}, which was not handed out`);
    }
    decoded.add(header.frameId);
  };
}

describe("jitter buffer §10.1: in and out", () => {
  it("takes whole frames in any order and hands them out in decode order", () => {
    const { clock, buffer } = setup();
    const frames = videoFrames(12);
    for (const index of [3, 0, 2, 1, 7, 6, 5, 4, 11, 10, 9, 8]) buffer.push(frames[index] as ReceivedFrame);
    const out = play(clock, buffer, 500);
    assert.deepEqual(ids(out), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("takes duplicates, and never hands out the same frame twice", () => {
    const { clock, buffer } = setup();
    const frames = videoFrames(8);
    const arrivals = [...live(frames), ...live(frames, 7), ...live(frames, 200)];
    const out = play(clock, buffer, 600, arrivals);
    assert.deepEqual(ids(out), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(buffer.stats().framesIn, 8);
    assert.equal(buffer.stats().framesOut, 8);
  });

  it("hands out a frame when it is due, at captureUs + D, and not before", () => {
    const { clock, buffer } = setup();
    const frames = videoFrames(4);
    for (const frame of frames) buffer.push(frame);
    assert.deepEqual(buffer.pop(59_999), []);
    const first = buffer.pop(60_000);
    assert.deepEqual(ids(first), [0]);
    assert.equal((first[0] as PlayoutFrame).dueUs, 60_000);
    assert.equal((first[0] as PlayoutFrame).decodeOnly, false);
    assert.deepEqual(buffer.pop(60_000 + 33_332), []);
    assert.deepEqual(ids(buffer.pop(60_000 + 33_333)), [1]);
    clock.advance(1);
  });

  it("a keyframe is decodable; another frame only once the frame it needs has been handed out, in the same GOP", () => {
    const { clock, buffer } = setup();
    const frames = videoFrames(6);
    // Frame 2 (layer 1) needs frame 0. Without the keyframe nothing comes out.
    buffer.push(frames[2] as ReceivedFrame);
    assert.deepEqual(play(clock, buffer, 100), []);
    buffer.reset();

    // A frame whose reference belongs to a GOP that was never handed out is not decodable.
    const next = videoFrames(64);
    const { clock: clock2, buffer: buffer2 } = setup();
    buffer2.push(next[60] as ReceivedFrame);
    const orphan = { ...(next[62] as ReceivedFrame), header: { ...(next[62] as ReceivedFrame).header, keyDelta: 5 } };
    buffer2.push(orphan);
    clock2.advance(2000);
    const out = play(clock2, buffer2, 2400);
    assert.deepEqual(ids(out), [60]);
  });

  it("never hands out a frame a header-following decoder cannot decode: random loss, order and duplicates", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const random = seeded(seed);
      const { clock, buffer } = setup();
      const decode = headerDecoder();
      const frames = videoFrames(300);
      const arrivals: { at: number; frame: ReceivedFrame }[] = [];
      for (const frame of frames) {
        if (random() < 0.08) continue;
        const copies = random() < 0.1 ? 2 : 1;
        for (let copy = 0; copy < copies; copy++) arrivals.push({ at: frame.header.captureUs / 1000 + 5 + random() * 80, frame });
      }
      const out = play(clock, buffer, 10_500, arrivals);
      const seen = new Set<number>();
      for (const popped of out) {
        assert.ok(!seen.has(popped.frame.header.frameId));
        seen.add(popped.frame.header.frameId);
        assert.ok(popped.at * 1000 >= popped.dueUs, "handed out before it was due");
        decode(popped.frame);
      }
      assert.ok(out.length > 30, `seed ${seed}: only ${out.length} frames came out`);
    }
  });
});

describe("jitter buffer §10.2: the playout delay D", () => {
  it("D = clamp(min + 2.5 × jitter + (loss > 0.5 ? rtt + 20 : 0), min, max)", () => {
    assert.equal(playoutDelayTarget({ jitterMs: 0, rttMs: null, lossPct: 0 }, 60, 400), 60);
    assert.equal(playoutDelayTarget({ jitterMs: 10, rttMs: 40, lossPct: 0 }, 60, 400), 85);
    assert.equal(playoutDelayTarget({ jitterMs: 10, rttMs: 40, lossPct: 0.5 }, 60, 400), 85);
    assert.equal(playoutDelayTarget({ jitterMs: 10, rttMs: 40, lossPct: 0.6 }, 60, 400), 145);
    assert.equal(playoutDelayTarget({ jitterMs: 4, rttMs: 30, lossPct: 3 }, 60, 400), 120);
    assert.equal(playoutDelayTarget({ jitterMs: 200, rttMs: 300, lossPct: 5 }, 60, 400), 400);
    assert.equal(playoutDelayTarget({ jitterMs: -3, rttMs: 0, lossPct: 0 }, 60, 400), 60);
    // Before the link's RTT is known, a NACK is taken to cost 50 ms.
    assert.equal(playoutDelayTarget({ jitterMs: 0, rttMs: null, lossPct: 2 }, 60, 400), 130);
  });

  it("starts at playoutMinMs, and frames are due by it", () => {
    const { buffer } = setup(VIDEO_CONFIG, 80);
    assert.equal(buffer.stats().targetDelayMs, 80);
    for (const frame of videoFrames(1)) buffer.push(frame);
    assert.deepEqual(buffer.pop(79_999), []);
    assert.equal(buffer.pop(80_000).length, 1);
  });

  it("rises at once", () => {
    const { clock, buffer } = setup();
    const delays: number[] = [];
    buffer.on("delay", (ms) => delays.push(ms));
    clock.advance(1000);
    buffer.setLinkHints({ jitterMs: 20, rttMs: 30, lossPct: 1 });
    assert.equal(buffer.stats().targetDelayMs, 160);
    assert.deepEqual(delays, [160]);
  });

  it("falls by at most 10 ms a second", () => {
    const { clock, buffer } = setup();
    buffer.setLinkHints({ jitterMs: 20, rttMs: 30, lossPct: 1 });
    buffer.setLinkHints({ jitterMs: 0, rttMs: 30, lossPct: 0 });
    assert.equal(buffer.stats().targetDelayMs, 160);
    let previous = 160;
    for (let second = 1; second <= 12; second++) {
      clock.advance(1000);
      buffer.pop(clock.now() * 1000);
      const now = buffer.stats().targetDelayMs;
      assert.ok(previous - now <= 10, `fell ${previous - now} ms in a second`);
      assert.equal(now, Math.max(60, 160 - 10 * second));
      previous = now;
    }
    assert.equal(buffer.stats().targetDelayMs, 60);
  });

  it("a frame's due time moves with D", () => {
    const { clock, buffer } = setup();
    buffer.setLinkHints({ jitterMs: 16, rttMs: null, lossPct: 0 });
    for (const frame of videoFrames(1)) buffer.push(frame);
    assert.deepEqual(buffer.pop(99_999), []);
    assert.equal((buffer.pop(100_000)[0] as PlayoutFrame).dueUs, 100_000);
    clock.advance(1);
  });
});

describe("jitter buffer §10.3: when a frame is not there", () => {
  it("a missing DISCARDABLE frame is skipped, playout goes on, and it is counted lost", () => {
    const { clock, buffer, events } = setup();
    const frames = videoFrames(13).filter((frame) => frame.header.frameId !== 5);
    const out = play(clock, buffer, 600, live(frames));
    assert.deepEqual(ids(out), [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(events, []);
    assert.equal(buffer.stats().lost, 1);
    assert.equal(buffer.stats().stalls, 0);
    // Nothing was held back for it: every frame came out at its own due time.
    for (const popped of out) assert.ok(popped.at * 1000 - popped.dueUs < 1000);
  });

  it("a missing layer-1 frame: it and the layer-2 frames that need it are skipped, and playout goes on at the base rate", () => {
    const { clock, buffer, events } = setup();
    // Frame 6 is layer 1; frame 7 (layer 2) needs it; frame 8 (layer 0) does not.
    const frames = videoFrames(13).filter((frame) => frame.header.frameId !== 6);
    const out = play(clock, buffer, 600, live(frames));
    assert.deepEqual(ids(out), [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12]);
    assert.deepEqual(events, []);
    assert.equal(buffer.stats().stalls, 0);
    assert.equal(buffer.stats().lost, 2);
    const eight = out.find((p) => p.frame.header.frameId === 8) as Popped;
    assert.ok(eight.at * 1000 - eight.dueUs < 1000, "the base layer was not delayed");
  });

  it("a missing layer-2 frame never stalls, however many are missing", () => {
    const { clock, buffer, events } = setup();
    const frames = videoFrames(60).filter((frame) => frame.header.temporal !== 2 || frame.header.frameId % 3 === 0);
    const out = play(clock, buffer, 2200, live(frames));
    assert.equal(out.length, frames.length);
    assert.deepEqual(events, []);
    assert.equal(buffer.stats().stalls, 0);
  });

  it("a missing base-layer frame stalls video and announces it; if it arrives within 150 ms playout resumes", () => {
    const { clock, buffer, events } = setup();
    const frames = videoFrames(13);
    // Frame 4 (layer 0, captured at 133 ms, due at 193 ms) arrives 100 ms after its due time.
    const arrivals = live(frames).map((arrival) => (arrival.frame.header.frameId === 4 ? { ...arrival, at: 293 } : arrival));
    const out = play(clock, buffer, 700, arrivals);
    assert.deepEqual(ids(out), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(events, ["stall 4"]);
    assert.equal(buffer.stats().stalls, 1);
    assert.equal(buffer.stats().lost, 0);
    // Nothing that needs frame 4 came out before it did.
    const four = out.find((p) => p.frame.header.frameId === 4) as Popped;
    assert.equal(four.at, 293);
    for (const popped of out) if (popped.frame.header.frameId > 4) assert.ok(popped.at >= 293);
    // It came after its time: it and what was held behind it are decoded, not shown.
    assert.equal(four.decodeOnly, true);
    assert.equal((out.find((p) => p.frame.header.frameId === 6) as Popped).decodeOnly, true);
    assert.equal((out.find((p) => p.frame.header.frameId === 12) as Popped).decodeOnly, false);
  });

  it("waits for a missing base-layer frame up to 150 ms past its due time, then gives up on the GOP and resumes at the next keyframe", () => {
    const { clock, buffer, events } = setup();
    const frames = videoFrames(64).filter((frame) => frame.header.frameId !== 4);
    const out = play(clock, buffer, 2400, live(frames));
    assert.deepEqual(ids(out), [0, 1, 2, 3, 60, 61, 62, 63]);
    assert.deepEqual(events, ["stall 4", "skip 60"]);
    // Everything in between is counted lost: frames 4 to 59.
    assert.equal(buffer.stats().lost, 56);
    assert.equal(buffer.stats().stalls, 1);
    const key = out.find((p) => p.frame.header.frameId === 60) as Popped;
    assert.ok(key.at * 1000 - key.dueUs < 1000, "the keyframe came out at its own due time");
    assert.equal(key.decodeOnly, false);
  });

  it("gives up 150 ms past the missing frame's due time: one that arrives after that is not used", () => {
    const { clock, buffer, events } = setup();
    const frames = videoFrames(64);
    // Frame 4 is due at 193 ms. At 343 ms the wait is over.
    const arrivals = live(frames).map((arrival) => (arrival.frame.header.frameId === 4 ? { ...arrival, at: 350 } : arrival));
    const early = play(clock, buffer, 342, arrivals);
    assert.deepEqual(ids(early), [0, 1, 2, 3]);
    assert.equal(buffer.oldestWanted(), 4);
    const rest = play(clock, buffer, 2400, arrivals);
    assert.deepEqual(ids(rest), [60, 61, 62, 63]);
    assert.deepEqual(events, ["stall 4", "skip 60"]);
  });

  it("a stall ends early when the next keyframe is already due", () => {
    const { clock, buffer, events } = setup();
    // The last base-layer frame of the GOP is missing; the keyframe is 4 frames (133 ms) later.
    const frames = videoFrames(64).filter((frame) => frame.header.frameId !== 56);
    const out = play(clock, buffer, 2400, live(frames));
    assert.deepEqual(ids(out).slice(-6), [54, 55, 60, 61, 62, 63]);
    assert.deepEqual(events, ["stall 56", "skip 60"]);
  });

  it("missing audio never waits", () => {
    const { clock, buffer, events } = setup(AUDIO_CONFIG);
    const frames = audioFrames(20).filter((frame) => frame.header.frameId !== 7 && frame.header.frameId !== 8);
    const out = play(clock, buffer, 600, live(frames));
    assert.deepEqual(ids(out), [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    for (const popped of out) assert.ok(popped.at * 1000 - popped.dueUs < 1000, "an audio frame was held back");
    assert.deepEqual(events, []);
    assert.equal(buffer.stats().lost, 2);
    assert.equal(buffer.stats().stalls, 0);
  });

  it("an audio frame sent twice (§9.4) comes out once; one that arrives after its time is dropped", () => {
    const { clock, buffer } = setup(AUDIO_CONFIG);
    const frames = audioFrames(10);
    const arrivals = [...live(frames), ...live(frames, 25)].map((arrival) =>
      // Both copies of frame 5 arrive after it was due (160 ms).
      arrival.frame.header.frameId === 5 ? { ...arrival, at: arrival.at + 80 } : arrival,
    );
    const out = play(clock, buffer, 500, arrivals);
    assert.deepEqual(ids(out), [0, 1, 2, 3, 4, 6, 7, 8, 9]);
    assert.equal(buffer.stats().late, 2);
  });

  it("a frame that arrives after its due time is used only if a later frame needs it, and then decodeOnly", () => {
    const { clock, buffer } = setup();
    const frames = videoFrames(13);
    const arrivals = live(frames).map((arrival) => {
      // Frame 5 is discardable: nothing needs it. Frame 8 is base layer: frames 9 to 12 need it.
      if (arrival.frame.header.frameId === 5) return { ...arrival, at: arrival.at + 100 };
      if (arrival.frame.header.frameId === 8) return { ...arrival, at: 8 * FRAME_MS + D + 20 };
      return arrival;
    });
    const out = play(clock, buffer, 700, arrivals);
    assert.deepEqual(ids(out), [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal((out.find((p) => p.frame.header.frameId === 8) as Popped).decodeOnly, true);
    assert.equal((out.find((p) => p.frame.header.frameId === 10) as Popped).decodeOnly, false);
    assert.equal(buffer.stats().late, 2);
  });

  it("a viewer capped below the top layer is not told that the frames it is not sent are lost", () => {
    const { clock, buffer, events } = setup();
    const frames = videoFrames(120).filter((frame) => frame.header.temporal < 2);
    const out = play(clock, buffer, 4200, live(frames));
    assert.equal(out.length, 60);
    assert.equal(buffer.stats().lost, 0);
    assert.deepEqual(events, []);
  });

  it("joining in the middle of a GOP with no replay waits for the next keyframe", () => {
    const { clock, buffer, events } = setup();
    const frames = videoFrames(70).filter((frame) => frame.header.frameId >= 30);
    clock.advance(1000);
    const out = play(clock, buffer, 2600, live(frames));
    assert.deepEqual(ids(out), [60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
    assert.deepEqual(events, ["skip 60"]);
  });
});

describe("jitter buffer §10.4: catching up", () => {
  it("after a 1.5 s replay burst the buffer is within D of live after one pop, and the old frames are decodeOnly", () => {
    const { clock, buffer } = setup();
    // 1.5 s of media, the newest captured just now, all arriving at once.
    const frames = videoFrames(46);
    const nowMs = 45 * FRAME_MS + 5;
    clock.advance(nowMs);
    for (const frame of frames) buffer.push(frame);
    assert.ok(buffer.stats().bufferMs >= 1490);
    const out = buffer.pop(nowMs * 1000);
    assert.ok(buffer.stats().bufferMs <= D, `${buffer.stats().bufferMs} ms still held`);
    // Everything up to D behind the newest was handed out, in order, to be decoded and not shown.
    assert.deepEqual(ids(out), [...Array(45).keys()].filter((id) => id * FRAME_MS + D <= nowMs));
    const newestUs = (frames[45] as ReceivedFrame).header.captureUs;
    for (const popped of out) assert.equal(popped.decodeOnly, popped.frame.header.captureUs < newestUs - D * 1000);
    assert.ok(out.filter((p) => p.decodeOnly).length >= 43);
    // And from there it plays normally.
    const rest = play(clock, buffer, nowMs + 100);
    assert.ok(rest.length >= 1);
    for (const popped of rest) assert.equal(popped.decodeOnly, false);
  });

  it("media held beyond D because of where it is played from (setExtraDelayMs) is not a backlog: nothing is caught up on", () => {
    const { clock, buffer } = setup();
    // Played 150 ms after capture (D = 60, and 90 ms more for the sound it waits for), arriving 5 ms after.
    buffer.setExtraDelayMs(90);
    const out = play(clock, buffer, 3000, live(videoFrames(80), 5));
    assert.ok(out.length >= 70);
    for (const popped of out) {
      assert.equal(popped.decodeOnly, false, `frame ${popped.frame.header.frameId}`);
      assert.ok(popped.at * 1000 >= popped.frame.header.captureUs + 150_000);
    }
    assert.equal(buffer.delayUs(), D * 1000, "D itself is unchanged");
    assert.equal(buffer.effectiveDelayUs(), (D + 90) * 1000);
  });

  it("in steady state nothing is decodeOnly", () => {
    const { clock, buffer } = setup();
    const out = play(clock, buffer, 3000, live(videoFrames(80), 30));
    assert.equal(out.length, 80);
    for (const popped of out) assert.equal(popped.decodeOnly, false);
  });

  it("after a repair (no media for 400 ms, then a burst) the viewer sees one jump forward, not old video", () => {
    const { clock, buffer } = setup();
    const frames = videoFrames(90);
    // Frames 30 to 41 (1.0 s to 1.4 s) arrive together at 1.42 s, from the new parent's cache.
    const arrivals = live(frames).map((arrival) => (arrival.frame.header.frameId >= 30 && arrival.frame.header.frameId <= 41 ? { ...arrival, at: 1420 } : arrival));
    const out = play(clock, buffer, 3200, arrivals);
    // Of the burst, the frames whose time has passed are kept only where a later frame needs them.
    const dropped = [31, 33, 35, 37, 39];
    assert.deepEqual(ids(out), [...Array(90).keys()].filter((id) => !dropped.includes(id)));
    const burst = out.filter((p) => p.at === 1420);
    assert.deepEqual(ids(burst), [30, 32, 34, 36, 38, 40]);
    for (const popped of burst) assert.equal(popped.decodeOnly, true, `frame ${popped.frame.header.frameId} of the burst would have been shown`);
    for (const popped of out.filter((p) => p.at > 1421)) assert.equal(popped.decodeOnly, false);
    assert.equal(buffer.stats().lost, 0);
    assert.equal(buffer.stats().late, 11);
  });
});

describe("jitter buffer: the rest of its interface", () => {
  it("oldestWanted is the frame after the last one handed out; null before anything", () => {
    const { clock, buffer } = setup();
    assert.equal(buffer.oldestWanted(), null);
    play(clock, buffer, 200, live(videoFrames(30)));
    const out = buffer.stats().framesOut;
    assert.equal(buffer.oldestWanted(), out);
  });

  it("after giving up on a GOP, nothing before the next keyframe is wanted", () => {
    const { clock, buffer } = setup();
    const frames = videoFrames(64).filter((frame) => frame.header.frameId !== 4);
    play(clock, buffer, 600, live(frames));
    assert.equal(buffer.oldestWanted(), 18);
    play(clock, buffer, 2400, live(frames));
    assert.equal(buffer.oldestWanted(), 64);
  });

  it("ignores frames of another stream", () => {
    const { clock, buffer } = setup();
    for (const frame of audioFrames(5)) buffer.push(frame);
    assert.deepEqual(play(clock, buffer, 300), []);
    assert.equal(buffer.stats().framesIn, 0);
  });

  it("reset forgets everything but the delay", () => {
    const { clock, buffer } = setup();
    buffer.setLinkHints({ jitterMs: 20, rttMs: 0, lossPct: 0 });
    play(clock, buffer, 300, live(videoFrames(10)));
    buffer.reset();
    assert.equal(buffer.oldestWanted(), null);
    assert.equal(buffer.stats().bufferMs, 0);
    assert.equal(buffer.stats().targetDelayMs, 110);
    // The same frames are taken again, as a new subscription's would be.
    const out = play(clock, buffer, 600, videoFrames(3).map((frame) => ({ at: 0, frame })));
    assert.deepEqual(ids(out), [0, 1, 2]);
  });
});
