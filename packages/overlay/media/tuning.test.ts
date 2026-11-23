/**
 * The player under the gate's networks (SPEC §12.3; PLAN, E-media M6 "tuning under the gate
 * mix"), one hop, simulated: each frame's fragments are delayed and jittered as the harness's
 * profiles say (`PROFILES`), and lost singly or in bursts; audio is sent twice (§9.4). There is
 * no NACK here (that is the transport's, §4.6), so a video frame that loses a fragment is lost;
 * what this measures is what the media side makes of what arrives: the delay it chooses, the
 * latency that gives, how much sound it has to conceal, and how often the picture freezes.
 *
 * It prints a table (run with --test-reporter=spec to see it) and holds the numbers that are
 * media's alone to the gate: audio, latency, and that the delay rides out each profile's jitter.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROFILES } from "@meetly/overlay/harness/index";
import type { ImpairmentProfile } from "@meetly/overlay/harness/types";
import type { ReceivedFrame } from "@meetly/overlay/types";
import { createPlayerWith } from "@meetly/overlay/media/player";
import { createFakeBackends } from "@meetly/overlay/media/testing/fakeBackends";
import { AUDIO_CONFIG, VIDEO_CONFIG, audioFrames, createFakeClock, createFakeSessionClock, seeded, videoFrames } from "@meetly/overlay/media/testing/fakes";

const SECONDS = 20;
/** Fragments of a delta frame and of a keyframe at 1.2 Mbps and 30 fps (about 5 kB and 25 kB, 1,120 bytes a fragment). */
const DELTA_FRAGMENTS = 5;
const KEY_FRAGMENTS = 22;
/** From capture to the first packet leaving: encoding a video frame; for audio, its 20 ms of sound and Opus's look-ahead. */
const VIDEO_ENCODE_MS = 5;
const AUDIO_ENCODE_MS = 27;

type Result = { profile: string; delayMs: number; g2gP50: number; g2gP95: number; shownPct: number; freezes: number; concealedPct: number; resyncs: number };

async function run(profile: ImpairmentProfile, seed: number): Promise<Result> {
  const clock = createFakeClock(1000);
  const session = createFakeSessionClock(clock, 3000);
  const backends = createFakeBackends(clock);
  const player = createPlayerWith({ sessionClock: session, clock, playoutMinMs: 60, playoutMaxMs: 400, lightOutputLatencyMs: 0 }, backends);
  await player.configure([VIDEO_CONFIG, AUDIO_CONFIG]);
  // What the congestion module would say of such a link: RFC 3550 jitter of uniform 0..J is about J/3.
  player.setLinkHints({ jitterMs: profile.jitterMs / 3, rttMs: 2 * profile.delayMs, lossPct: profile.lossPct });

  const random = seeded(seed);
  let inBurst = false;
  const lost = () => {
    const burst = profile.burst;
    if (burst) {
      if (inBurst ? random() * 100 < burst.leavePct : random() * 100 < burst.enterPct) inBurst = !inBurst;
      if (inBurst) return random() * 100 < burst.lossPctInBurst;
    }
    return random() * 100 < profile.lossPct;
  };
  const startUs = Math.round(session.now() * 1000) + 20_000;
  const queue: { at: number; frame: ReceivedFrame }[] = [];
  const send = (frame: ReceivedFrame, sentMs: number, fragments: number) => {
    let at = 0;
    for (let i = 0; i < fragments; i++) {
      if (lost()) return;
      at = Math.max(at, sentMs + profile.delayMs + random() * profile.jitterMs);
    }
    queue.push({ at, frame });
  };
  const video = videoFrames(SECONDS * 30, { startUs });
  for (const frame of video) send(frame, frame.header.captureUs / 1000 + VIDEO_ENCODE_MS, frame.header.keyDelta === 0 ? KEY_FRAGMENTS : DELTA_FRAGMENTS);
  for (const frame of audioFrames(SECONDS * 50, { startUs })) {
    const sentMs = frame.header.captureUs / 1000 + AUDIO_ENCODE_MS;
    send(frame, sentMs, 1);
    send(frame, sentMs + 20, 1);
  }
  queue.sort((a, b) => a.at - b.at);

  const latency: number[] = [];
  let freezes = 0;
  player.on("rendered", (_stream, _frameId, captureUs, renderedUs) => latency.push((renderedUs - captureUs) / 1000));
  player.on("freeze", () => freezes++);
  const endMs = startUs / 1000 + SECONDS * 1000;
  while (session.now() < endMs) {
    clock.advance(1);
    while (queue.length > 0 && (queue[0] as { at: number }).at <= session.now()) player.push((queue.shift() as { frame: ReceivedFrame }).frame);
  }
  const debug = player.debug();
  await player.close();
  const sorted = [...latency].sort((a, b) => a - b);
  const q = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number);
  const audio = debug.audio!;
  return {
    profile: profile.name,
    delayMs: Math.round(debug.appliedDelayMs),
    g2gP50: q(0.5),
    g2gP95: q(0.95),
    shownPct: Math.round((1000 * latency.length) / video.length) / 10,
    freezes,
    concealedPct: Math.round((1000 * audio.concealedMs) / (audio.playedMs + audio.concealedMs)) / 10,
    resyncs: audio.resyncs,
  };
}

describe("player under the gate's networks (one hop, no NACK)", () => {
  const profiles = ["clean", "good", "home", "bad"] as const;
  const results = new Map<string, Result>();

  for (const name of profiles) {
    it(`${name}: latency under the gate, and the sound kept whole by D and the second copy`, async () => {
      const result = await run(PROFILES[name] as ImpairmentProfile, 17);
      results.set(name, result);
      assert.ok(result.g2gP95 < 500, `glass-to-glass p95 ${result.g2gP95} ms`);
      assert.equal(result.resyncs, 0, "the delay held: playout never had to start again");
      // Two copies of every audio frame: what is concealed is what lost both, which bursts make likelier.
      const limit = name === "bad" ? 3 : 0.5;
      assert.ok(result.concealedPct <= limit, `${result.concealedPct}% of the sound concealed`);
    });
  }

  it("prints the table", () => {
    const rows = [...results.values()].map((r) => `${r.profile.padEnd(6)} delay ${String(r.delayMs).padStart(4)} ms  g2g p50 ${String(r.g2gP50).padStart(4)}  p95 ${String(r.g2gP95).padStart(4)} ms  shown ${String(r.shownPct).padStart(5)}%  freezes ${String(r.freezes).padStart(3)}  concealed ${r.concealedPct}%`);
    console.log(`\n${rows.join("\n")}\n`);
    assert.equal(rows.length, profiles.length);
  });
});
