/**
 * The player (SPEC §10.5, §12.2; PLAN, E-media M3–M6), driven by a fake clock with fake
 * decoders, a fake track and a fake sound card. The sound card runs the real sequencer, the
 * code the AudioWorklet runs, so what is "heard" here is what a loudspeaker would play.
 *
 * What only a browser can show (real codecs, a real `<video>`, the real worklet) is in
 * ./browser/page.ts; this is every decision the player makes, step by step.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReceivedFrame } from "@meetly/overlay/types";
import { AUDIO_LEAD_US, createPlayerWith, FREEZE_US, PATH_GREW_WINDOW_MS, type PlayerImpl } from "@meetly/overlay/media/player";
import { createFakeBackends, SAMPLE_RATE, type FakeBackends } from "@meetly/overlay/media/testing/fakeBackends";
import { AUDIO_CONFIG, VIDEO_CONFIG, audioFrames, createFakeClock, createFakeSessionClock, seeded, videoFrames, type FakeClock } from "@meetly/overlay/media/testing/fakes";
import type { SessionClock } from "@meetly/overlay/runtime";

const D = 60;
/** How long after capture a frame arrives, unless a test says otherwise: the path. */
const PATH = 15;
/** The sound's way out, on top of D: the worklet's lead (the fake sound card has no output latency, and light viewers here are told so). */
const PIPE = AUDIO_LEAD_US / 1000;
/** The session clock is not the local one: the player must not mix them up. */
const SESSION_OFFSET_MS = 7_000;
/** The fake clock starts at 1 s; the source's first frame is captured 20 ms after that, in session time. */
const FIRST_CAPTURE_MS = 1000 + SESSION_OFFSET_MS + 20;

type Rendered = { frameId: number; captureUs: number; renderedUs: number; latencyMs: number; heardUs: number | null };

type Setup = {
  decode?: boolean;
  /** The sound card's output latency, in seconds. */
  outputLatency?: number;
  audio?: boolean;
  audioBlocked?: boolean;
  seconds?: number;
  /** When a frame arrives, in ms after its capture; null: it never does. */
  arrival?: (frame: ReceivedFrame) => number | number[] | null;
};

/**
 * A source that sends `seconds` of program (video at 30 fps in L1T3, audio at 50 fps) and a
 * player that receives it. `run` moves time on in 1 ms steps, delivering what has arrived.
 */
async function setup(options: Setup = {}) {
  const clock: FakeClock = createFakeClock(1000);
  const session: SessionClock = createFakeSessionClock(clock, SESSION_OFFSET_MS);
  const backends: FakeBackends = createFakeBackends(clock, { audioBlocked: options.audioBlocked ?? false });
  const player: PlayerImpl = createPlayerWith({ sessionClock: session, clock, playoutMinMs: D, playoutMaxMs: 400, decode: options.decode ?? true, lightOutputLatencyMs: options.outputLatency === undefined ? 0 : options.outputLatency * 1000 }, backends);
  const withAudio = options.audio ?? true;
  const rendered: Rendered[] = [];
  const events: string[] = [];
  player.on("rendered", (_stream, frameId, captureUs, renderedUs) => {
    const heard = backends.audios[0]?.sequencer.report().playUs ?? null;
    rendered.push({ frameId, captureUs, renderedUs, latencyMs: (renderedUs - captureUs) / 1000, heardUs: heard });
  });
  player.on("firstFrame", () => events.push("firstFrame"));
  player.on("freeze", (_stream, ms) => events.push(`freeze ${Math.round(ms)}`));
  player.on("audioBlocked", (blocked) => events.push(`audioBlocked ${blocked}`));
  player.on("error", (error) => events.push(`error ${error.message}`));
  await player.configure(withAudio ? [VIDEO_CONFIG, AUDIO_CONFIG] : [VIDEO_CONFIG]);
  if (options.outputLatency !== undefined) for (const audio of backends.audios) audio.latency = options.outputLatency;
  const seconds = options.seconds ?? 6;
  const startUs = Math.round(session.now() * 1000) + 20_000;
  const frames = [...videoFrames(Math.round(seconds * 30), { startUs }), ...(withAudio ? audioFrames(seconds * 50, { startUs }) : [])];
  const arrival = options.arrival ?? (() => PATH);
  const queue: { at: number; frame: ReceivedFrame }[] = [];
  for (const frame of frames) {
    const after = arrival(frame);
    if (after === null) continue;
    for (const ms of Array.isArray(after) ? after : [after]) queue.push({ at: frame.header.captureUs / 1000 + ms, frame });
  }
  queue.sort((a, b) => a.at - b.at);

  /** Session time, ms. */
  const now = () => session.now();
  const run = (untilSessionMs: number, each?: () => void) => {
    while (now() < untilSessionMs) {
      clock.advance(1);
      while (queue.length > 0 && (queue[0] as { at: number }).at <= now()) player.push((queue.shift() as { frame: ReceivedFrame }).frame);
      each?.();
    }
  };
  return { clock, session, backends, player, rendered, events, startMs: startUs / 1000, run, now, queue };
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};
const maxStep = (pcm: ArrayLike<number>, from = 1, to = pcm.length) => {
  let worst = 0;
  for (let i = Math.max(1, from); i < to; i++) worst = Math.max(worst, Math.abs((pcm[i] as number) - (pcm[i - 1] as number)));
  return worst;
};
/** The steepest the fake decoder's 440 Hz tone gets between two samples, with room for a cross-fade. */
const MAX_STEP = 0.5 * 2 * Math.PI * (440 / SAMPLE_RATE) * 1.25;
/** Video against what is being heard: positive is late. */
const avOffsetsMs = (rendered: Rendered[]) => rendered.filter((r) => r.heardUs !== null).map((r) => ((r.heardUs as number) - r.captureUs) / 1000);

describe("player: video against the sound (§10.5)", () => {
  it("shows each frame when the sound being played reaches its capture time: never more than 15 ms early or 45 ms late", async () => {
    const t = await setup({ seconds: 6 });
    t.run(t.startMs + 6000);
    const offsets = avOffsetsMs(t.rendered.slice(10));
    assert.ok(offsets.length > 150, `${offsets.length} frames rendered with sound`);
    assert.ok(Math.min(...offsets) >= -15, `${Math.min(...offsets)} ms early`);
    assert.ok(Math.max(...offsets) <= 45, `${Math.max(...offsets)} ms late`);
    const stats = t.player.stats();
    assert.ok(stats.audio && Math.abs(stats.audio.avOffsetMs) <= 15, `avOffsetMs ${stats.audio?.avOffsetMs}`);
    assert.equal(stats.audio?.concealedMs, 0);
    assert.equal(t.player.debug().audioIsClock, true);
    assert.deepEqual(t.events, ["firstFrame"]);
    await t.player.close();
  });

  it("a sound card with 40 ms of output latency: frames reach the worklet in time, and video is timed by what is heard", async () => {
    const t = await setup({ seconds: 6, outputLatency: 0.04 });
    t.run(t.startMs + 6000);
    const audio = t.player.debug().audio!;
    assert.equal(audio.concealedMs, 0);
    assert.equal(audio.late, 0);
    // What is heard is what the worklet rendered 40 ms ago.
    const offsets = avOffsetsMs(t.rendered.slice(10)).map((ms) => ms - 40);
    assert.ok(Math.min(...offsets) >= -15 && Math.max(...offsets) <= 45, `offsets ${Math.min(...offsets)}..${Math.max(...offsets)} ms`);
    await t.player.close();
  });

  it("glass to glass is the path, then D, then the sound's way out (§10.2): about path + D + 15 ms", async () => {
    const t = await setup({ seconds: 5 });
    t.run(t.startMs + 5000);
    const latency = t.rendered.slice(10).map((r) => r.latencyMs);
    assert.ok(Math.abs((t.player.debug().pathMs as number) - PATH) <= 1, `path ${t.player.debug().pathMs}`);
    assert.ok(quantile(latency, 0.5) >= PATH + D + PIPE - 3 && quantile(latency, 0.95) <= PATH + D + PIPE + 10, `p50 ${quantile(latency, 0.5)}, p95 ${quantile(latency, 0.95)}`);
    assert.equal(t.player.stats().video?.dropped, 0);
    assert.equal(t.player.stats().video?.lost, 0);
    await t.player.close();
  });

  it("with no audio stream, video is timed by the session clock with the same delay", async () => {
    const t = await setup({ audio: false, seconds: 4 });
    t.run(t.startMs + 4000);
    const latency = t.rendered.slice(5).map((r) => r.latencyMs);
    assert.ok(t.rendered.length >= 110, `${t.rendered.length} rendered`);
    assert.ok(quantile(latency, 0.5) >= PATH + D && quantile(latency, 0.95) <= PATH + D + 15, `p50 ${quantile(latency, 0.5)}, p95 ${quantile(latency, 0.95)}`);
    assert.equal(t.player.debug().audioIsClock, false);
    await t.player.close();
  });

  it("with sound blocked by the autoplay rule: says so, times video by the session clock, and takes over when resumed, without a freeze", async () => {
    const t = await setup({ audioBlocked: true, seconds: 6 });
    t.run(t.startMs + 2000);
    assert.ok(t.events.includes("audioBlocked true"), t.events.join(", "));
    assert.equal(t.player.debug().audioIsClock, false);
    const before = t.rendered.length;
    assert.ok(before >= 50, `${before} rendered while blocked`);
    await t.player.resumeAudio();
    t.run(t.startMs + 6000);
    assert.ok(t.events.includes("audioBlocked false"), t.events.join(", "));
    assert.equal(t.player.debug().audioIsClock, true);
    assert.ok(!t.events.some((event) => event.startsWith("freeze")), t.events.join(", "));
    const offsets = avOffsetsMs(t.rendered.slice(before + 30));
    assert.ok(Math.min(...offsets) >= -15 && Math.max(...offsets) <= 45, `offsets ${Math.min(...offsets)}..${Math.max(...offsets)} ms`);
    await t.player.close();
  });
});

describe("player: the delay adapts without a glitch ([D26])", () => {
  it("D rising: playout follows one frame a second by repeating, never concealing, never stepping; video follows it", async () => {
    const t = await setup({ seconds: 12 });
    t.run(t.startMs + 2000);
    const audio = t.backends.audios[0]!;
    const fromSample = audio.output.length;
    // The link turns jittery: D = 60 + 2.5 × 20 = 110 ms, at once.
    t.player.setLinkHints({ jitterMs: 20, rttMs: 30, lossPct: 0 });
    // Frames now arrive with that jitter.
    const random = seeded(7);
    for (const entry of t.queue) entry.at += random() * 20;
    t.queue.sort((a, b) => a.at - b.at);
    assert.equal(t.player.debug().playoutDelayMs, 110);
    const delays: number[] = [];
    t.run(t.startMs + 9000, () => {
      if (Math.round(t.now()) % 250 === 0) delays.push(t.player.debug().appliedDelayMs);
    });
    const counters = t.player.debug().audio!;
    // 50 ms more, 20 ms at a time: two or three repeats, at most one a second.
    assert.ok(counters.repeats >= 2 && counters.repeats <= 3, `${counters.repeats} repeats`);
    assert.equal(counters.drops, 0);
    assert.equal(counters.concealedMs, 0, "nothing concealed");
    assert.equal(counters.late, 0);
    const applied = t.player.debug().appliedDelayMs;
    assert.ok(Math.abs(applied - (PATH + 110 + PIPE)) <= 12, `delay now ${applied} ms`);
    for (let i = 4; i < delays.length; i++) assert.ok((delays[i] as number) - (delays[i - 4] as number) <= 21, `rose ${(delays[i] as number) - (delays[i - 4] as number)} ms in a second`);
    assert.ok(maxStep(audio.output, fromSample) <= MAX_STEP, `a step of ${maxStep(audio.output, fromSample)}`);
    const offsets = avOffsetsMs(t.rendered.filter((r) => r.captureUs / 1000 > t.startMs + 2000));
    assert.ok(Math.min(...offsets) >= -15 && Math.max(...offsets) <= 45, `offsets ${Math.min(...offsets)}..${Math.max(...offsets)} ms`);
    assert.ok(!t.events.some((event) => event.startsWith("freeze")), t.events.join(", "));
    await t.player.close();
  });

  it("D falling: no faster than 10 ms a second, by dropping one frame a second, without a step", async () => {
    const t = await setup({ seconds: 14 });
    t.player.setLinkHints({ jitterMs: 20, rttMs: 30, lossPct: 0 });
    t.run(t.startMs + 5000);
    assert.ok(Math.abs(t.player.debug().appliedDelayMs - (PATH + 110 + PIPE)) <= 12, `delay ${t.player.debug().appliedDelayMs}`);
    const audio = t.backends.audios[0]!;
    const fromSample = audio.output.length;
    const repeatsBefore = t.player.debug().audio!.repeats;
    t.player.setLinkHints({ jitterMs: 0, rttMs: 30, lossPct: 0 });
    const samples: { at: number; applied: number; target: number }[] = [];
    t.run(t.startMs + 13_000, () => {
      if (Math.round(t.now()) % 500 === 0) samples.push({ at: t.now(), applied: t.player.debug().appliedDelayMs, target: t.player.debug().playoutDelayMs });
    });
    // The target falls 10 ms a second: from 110 to 60 takes 5 s.
    for (let i = 2; i < samples.length; i++) assert.ok((samples[i - 2] as { target: number }).target - (samples[i] as { target: number }).target <= 10.5, "target fell faster than 10 ms/s");
    const counters = t.player.debug().audio!;
    assert.ok(counters.drops >= 2, `${counters.drops} drops`);
    assert.equal(counters.repeats, repeatsBefore);
    assert.equal(counters.concealedMs, 0);
    assert.ok(t.player.debug().appliedDelayMs <= PATH + D + PIPE + 20, `delay now ${t.player.debug().appliedDelayMs}`);
    assert.ok(maxStep(audio.output, fromSample) <= MAX_STEP, `a step of ${maxStep(audio.output, fromSample)}`);
    await t.player.close();
  });

  it("a path that grows a little (a new parent 30 ms further away) is followed a frame a second, losing nothing", async () => {
    const t = await setup({ seconds: 8, arrival: (frame) => (frame.header.captureUs / 1000 - FIRST_CAPTURE_MS < 2000 ? PATH : PATH + 30) });
    t.run(t.startMs + 8000);
    const audio = t.player.debug().audio!;
    assert.equal(audio.resyncs, 0);
    assert.equal(audio.concealedMs, 0);
    assert.ok(audio.repeats >= 1 && audio.repeats <= 2, `${audio.repeats} repeats`);
    assert.ok(Math.abs(t.player.debug().appliedDelayMs - (PATH + 30 + D + PIPE)) <= 12, `delay ${t.player.debug().appliedDelayMs}`);
    assert.ok(!t.events.some((event) => event.startsWith("freeze")), t.events.join(", "));
    await t.player.close();
  });

  it("a path that grows a lot (a repair far down the tree) is not crept up on: playout starts again where it should be, once", async () => {
    const t = await setup({ seconds: 8, arrival: (frame) => (frame.header.captureUs / 1000 - FIRST_CAPTURE_MS < 2000 ? PATH : PATH + 100) });
    t.run(t.startMs + 8000);
    const audio = t.player.debug().audio!;
    assert.equal(audio.resyncs, 1);
    // The sound stops for about as long as the path grew, and no longer.
    assert.ok(audio.concealedMs >= 80 && audio.concealedMs <= 100 + PATH_GREW_WINDOW_MS + 100, `concealed ${audio.concealedMs} ms`);
    assert.ok(Math.abs(t.player.debug().appliedDelayMs - (PATH + 100 + D + PIPE)) <= 21, `delay ${t.player.debug().appliedDelayMs}`);
    const after = t.rendered.filter((r) => r.renderedUs / 1000 > t.startMs + 3500);
    const offsets = avOffsetsMs(after);
    assert.ok(Math.min(...offsets) >= -15 && Math.max(...offsets) <= 45, `offsets ${Math.min(...offsets)}..${Math.max(...offsets)} ms`);
    assert.ok(after.length >= 120, `${after.length} rendered after`);
    await t.player.close();
  });

  it("a light viewer's delay moves the same way, a frame a second", async () => {
    const t = await setup({ decode: false, seconds: 8 });
    t.run(t.startMs + 1000);
    t.player.setLinkHints({ jitterMs: 20, rttMs: 30, lossPct: 0 });
    const delays: number[] = [];
    t.run(t.startMs + 6000, () => {
      if (Math.round(t.now()) % 1000 === 0) delays.push(t.player.debug().appliedDelayMs);
    });
    for (let i = 1; i < delays.length; i++) assert.ok((delays[i] as number) - (delays[i - 1] as number) <= 20.5, delays.join(" "));
    assert.ok(Math.abs((delays[delays.length - 1] as number) - (PATH + 110 + PIPE)) <= 12, delays.join(" "));
    await t.player.close();
  });
});

describe("player: light viewers (§13.2, [D29]; PLAN M5)", () => {
  it("renders a frame when it would have been handed to the decoder, at its due time, through the real jitter buffer", async () => {
    const t = await setup({ decode: false, seconds: 4 });
    t.run(t.startMs + 4000);
    assert.equal(t.backends.videos.length, 0, "no decoder");
    assert.equal(t.backends.audios.length, 0, "no sound card");
    assert.ok(t.rendered.length >= 110, `${t.rendered.length} rendered`);
    const latency = t.rendered.map((r) => r.latencyMs);
    assert.ok(Math.min(...latency) >= PATH + D + PIPE && Math.max(...latency) <= PATH + D + PIPE + 6, `${Math.min(...latency)}..${Math.max(...latency)} ms`);
    const stats = t.player.stats();
    assert.ok(stats.audio && stats.audio.playedMs >= 3800, `played ${stats.audio?.playedMs} ms`);
    assert.deepEqual(t.events, ["firstFrame"]);
    await t.player.close();
  });

  it("light and decoding viewers of the same stream agree on latency to within 15 ms at p50", async () => {
    const light = await setup({ decode: false, seconds: 5 });
    const full = await setup({ decode: true, seconds: 5 });
    light.run(light.startMs + 5000);
    full.run(full.startMs + 5000);
    const p50 = (t: { rendered: Rendered[] }) => quantile(t.rendered.slice(10).map((r) => r.latencyMs), 0.5);
    assert.ok(Math.abs(p50(light) - p50(full)) <= 15, `light ${p50(light)}, decoding ${p50(full)}`);
    await light.player.close();
    await full.player.close();
  });

  it("a light viewer counts audio it would have concealed", async () => {
    const t = await setup({ decode: false, seconds: 3, arrival: (frame) => (frame.header.streamId === 1 && frame.header.frameId % 10 === 5 ? null : 15) });
    t.run(t.startMs + 3000);
    const stats = t.player.stats().audio!;
    assert.ok(stats.concealedMs >= 260 && stats.concealedMs <= 300, `concealed ${stats.concealedMs} ms`);
    await t.player.close();
  });
});

describe("player: repair and catch-up (§10.3, §10.4; PLAN M5)", () => {
  for (const decode of [true, false]) {
    it(`${decode ? "decoding" : "light"}: a parent silent for 400 ms, then a replay burst: one freeze, then latency normal again at once, and nothing old shown`, async () => {
      const killMs = 2000;
      const resumeMs = 2400;
      const t = await setup({
        decode,
        seconds: 6,
        arrival: (frame) => {
          const relative = frame.header.captureUs / 1000 - FIRST_CAPTURE_MS;
          if (relative + 15 < killMs) return 15;
          // Captured while the parent was gone, or just before: it comes in the replay, all at once.
          if (relative < resumeMs) return resumeMs - relative + 1;
          return 15;
        },
      });
      t.run(t.startMs + 6000);
      const afterResume = t.rendered.filter((r) => r.renderedUs / 1000 >= t.startMs + resumeMs);
      // The first frame shown after the gap is a current one.
      const first = afterResume[0]!;
      assert.ok(first.latencyMs <= PATH + D + PIPE + 45, `first frame after the gap is ${first.latencyMs} ms old`);
      // And latency is normal again within 300 ms of the parent's death (proof: 173–245 ms after the kill).
      const late = afterResume.filter((r) => r.latencyMs > PATH + D + PIPE + 30);
      assert.deepEqual(late.map((r) => `${r.frameId}: ${r.latencyMs} ms`), [], "frames shown late after the repair");
      const freezes = t.events.filter((event) => event.startsWith("freeze"));
      assert.equal(freezes.length, 1, t.events.join(", "));
      const ms = Number(freezes[0]!.split(" ")[1]);
      // What was captured in the last D of the gap arrives in time to be shown: the freeze is the gap less that, give or take a frame.
      assert.ok(ms >= 400 - D - PATH - PIPE && ms <= 400 + 2 * 34, `freeze of ${ms} ms`);
      // Frames are never shown out of order.
      for (let i = 1; i < t.rendered.length; i++) assert.ok((t.rendered[i] as Rendered).frameId > (t.rendered[i - 1] as Rendered).frameId);
      if (decode) {
        const audio = t.player.debug().audio!;
        assert.ok(audio.concealedMs >= 340 && audio.concealedMs <= 440, `concealed ${audio.concealedMs} ms`);
        assert.equal(audio.resyncs, 0);
      }
      await t.player.close();
    });
  }
});

describe("player: what this viewer can use (PLAN M6)", () => {
  it("a decoder slower than the frame interval asks for a lower layer within 2 s, and asks for it back once it keeps up", async () => {
    let cap = 2;
    const t = await setup({ seconds: 20, arrival: (frame) => (frame.header.streamId === 0 && frame.header.temporal > cap ? null : 15) });
    // A parent that honours what the viewer asks for: what is above the cap is not sent.
    const sent = () => {
      cap = t.player.wantedLayers(0).maxTemporal;
    };
    t.run(t.startMs + 2000, sent);
    assert.equal(t.player.wantedLayers(0).maxTemporal, 2);
    const video = t.backends.videos[0]!;
    video.decodeMs = 45;
    const slowAt = t.now();
    let downAt: number | null = null;
    t.run(t.startMs + 6000, () => {
      sent();
      if (downAt === null && cap < 2) downAt = t.now();
    });
    assert.ok(downAt !== null && downAt - slowAt <= 2000, `asked for less after ${downAt === null ? "never" : downAt - slowAt} ms`);
    assert.equal(t.player.wantedLayers(0).maxTemporal, 1, "15 fps is decodable at 45 ms a frame");
    video.decodeMs = 4;
    t.run(t.startMs + 16_000, sent);
    assert.equal(t.player.wantedLayers(0).maxTemporal, 2, "recovered");
    assert.ok(!t.events.some((event) => event.startsWith("error")), t.events.join(", "));
    await t.player.close();
  });

  it("wantedLayers of a stream it does not have is nothing", async () => {
    const t = await setup({ seconds: 1 });
    assert.deepEqual(t.player.wantedLayers(9), { maxSpatial: 0, maxTemporal: 0 });
    assert.deepEqual(t.player.wantedLayers(0), { maxSpatial: 0, maxTemporal: 2 });
    await t.player.close();
  });
});

describe("player: the rest", () => {
  it("a decoder error resets the decoder, which then waits for a keyframe, and playout goes on", async () => {
    const t = await setup({ seconds: 6 });
    t.run(t.startMs + 1000);
    t.backends.videos[0]!.failNext = true;
    t.run(t.startMs + 6000);
    assert.ok(t.events.some((event) => event.startsWith("error")), t.events.join(", "));
    assert.equal(t.backends.videos[0]!.resets, 1);
    // Rendering resumed at the next keyframe (frame 60, at 2 s).
    assert.ok(t.rendered.some((r) => r.frameId === 60), "the next keyframe was shown");
    assert.ok(t.rendered.filter((r) => r.frameId > 60).length >= 100);
    await t.player.close();
  });

  it("each audio frame sent twice (§9.4) is played once; a lost first copy is made good by the second", async () => {
    const t = await setup({
      seconds: 4,
      arrival: (frame) => {
        if (frame.header.streamId !== 1) return 15;
        // The first copy of every seventh frame is lost; every copy goes 20 ms after the first.
        return frame.header.frameId % 7 === 3 ? [35] : [15, 35];
      },
    });
    t.run(t.startMs + 4000);
    const counters = t.player.debug().audio!;
    assert.equal(counters.concealedMs, 0);
    assert.equal(counters.late, 0);
    assert.ok(Math.abs(counters.playedMs - (t.now() - t.startMs - D)) <= 40, `played ${counters.playedMs} ms`);
    await t.player.close();
  });

  it("closing stops everything and is idempotent", async () => {
    const t = await setup({ seconds: 2 });
    t.run(t.startMs + 1000);
    await t.player.close();
    await t.player.close();
    const before = t.rendered.length;
    t.run(t.startMs + 2000);
    assert.equal(t.rendered.length, before);
    assert.ok(FREEZE_US === 200_000);
  });
});
