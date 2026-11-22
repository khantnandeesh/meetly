/**
 * The source's rate control (./rateControl.ts) against a model of Chromium's VP8 encoder: it
 * spends what it is asked for times an overshoot, but never less than a floor per frame that
 * grows with the picture's area (its coarsest quantiser), and a keyframe costs several frames.
 * The measured shapes are in the module's comment. The acceptance: any two-second window of what
 * comes out within +15% of the bitrate, whatever the picture.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KEY_ALLOWANCE_MS, RATE_WINDOW_ALLOWANCE, SCALE_LEVELS, VideoRateController } from "@meetly/overlay/media/rateControl";
import { expectedTemporalLayer } from "@meetly/overlay/media/layers";

const FPS = 30;
const TARGET_KBPS = 1200;

/** A picture's cost: the encoder's overshoot of what it is asked, and its floor per frame at full size (bytes). */
type Picture = { overshoot: number; floorBytes: number; keyTimes: number };
// An easy picture: the encoder keeps to its target, keyframes included.
const EASY: Picture = { overshoot: 0.85, floorBytes: 500, keyTimes: 5 };
// Busy: 60% over whatever it is asked, as the harness's pattern.
const BUSY: Picture = { overshoot: 1.6, floorBytes: 2000, keyTimes: 3 };
// Fine detail and noise: at the coarsest quantiser already, so the floor is what it costs.
// (Measured: fine detail's keyframes about five of its frames, noise's about one.)
const FINE: Picture = { overshoot: 1.5, floorBytes: 20_000, keyTimes: 5 };
const NOISE: Picture = { overshoot: 1, floorBytes: 260_000, keyTimes: 1.1 };

function simulate(pictures: { untilS: number; picture: Picture }[]) {
  const rate = new VideoRateController(TARGET_KBPS, 3);
  const out: { at: number; bytes: number; key: boolean; level: number }[] = [];
  let sinceKey = Infinity;
  let lastKeyAt = -Infinity;
  let level = 0;
  let factor = 1;
  let offered = 0;
  const endS = pictures[pictures.length - 1]!.untilS;
  for (let n = 0; n < endS * FPS; n++) {
    const now = (n * 1000) / FPS;
    const picture = pictures.find((p) => now < p.untilS * 1000)!.picture;
    const steer = rate.tick(now);
    if (steer.level !== level) {
      level = steer.level;
      sinceKey = Infinity; // a new size starts with a keyframe
    }
    factor = steer.factor;
    const key = sinceKey >= 60 || now - lastKeyAt >= 2000;
    const temporal = key ? 0 : (expectedTemporalLayer("L1T3", sinceKey) ?? 0);
    offered++;
    const untilKeyMs = Math.min((60 - sinceKey) * (1000 / FPS), lastKeyAt + 2000 - now);
    if (rate.offer(now, key, temporal, untilKeyMs) === "skip") continue;
    if (key) {
      sinceKey = 0;
      lastKeyAt = now;
    }
    sinceKey++;
    const area = (SCALE_LEVELS[level] as number) ** 2;
    const asked = (TARGET_KBPS * factor * 1000) / 8 / FPS;
    const layerShare = [1.6, 1, 0.7][temporal] as number;
    let bytes = Math.max(picture.floorBytes * area, asked * picture.overshoot) * (key ? picture.keyTimes : layerShare);
    bytes = Math.round(bytes);
    rate.encoded(now + 5, bytes, key, temporal);
    out.push({ at: now + 5, bytes, key, level });
  }
  return { out, offered, rate };
}

/** The most bytes in any two-second window, against two seconds of the bitrate. */
function worstWindow(out: { at: number; bytes: number }[], fromMs: number, toMs: number): number {
  let worst = 0;
  let start = 0;
  let sum = 0;
  const kept = out.filter((o) => o.at >= fromMs && o.at < toMs);
  for (let end = 0; end < kept.length; end++) {
    sum += (kept[end] as { bytes: number }).bytes;
    while ((kept[end] as { at: number }).at - (kept[start] as { at: number }).at >= 2000) sum -= (kept[start++] as { bytes: number }).bytes;
    worst = Math.max(worst, sum);
  }
  return worst / ((TARGET_KBPS * 1000 * 2) / 8);
}

const fps = (out: { at: number }[], fromS: number, toS: number) => out.filter((o) => o.at >= fromS * 1000 && o.at < toS * 1000).length / (toS - fromS);

describe("source rate control: the stream holds its bitrate whatever the picture", () => {
  for (const [name, picture] of [
    ["easy (the encoder keeps to its target)", EASY],
    ["busy (it overshoots by 60%)", BUSY],
    ["fine detail (fivefold, with a floor)", FINE],
    ["noise (260 kB a frame at full size, whatever it is asked)", NOISE],
  ] as const) {
    it(`${name}: every two-second window within +15%`, () => {
      const { out } = simulate([{ untilS: 40, picture }]);
      // From the second window on: the first frame of a new picture is the one nothing could
      // have predicted (a noise keyframe at full size is 470 kB, more than two seconds' worth).
      const worst = worstWindow(out, 2000, 40_000);
      assert.ok(worst <= RATE_WINDOW_ALLOWANCE, `a window at ${Math.round(worst * 100)}% of the bitrate`);
      // And frames keep coming, a keyframe at least every two seconds.
      const keys = out.filter((o) => o.key).map((o) => o.at);
      for (let i = 1; i < keys.length; i++) assert.ok((keys[i] as number) - (keys[i - 1] as number) <= 2100, `keyframes ${keys[i - 1]} and ${keys[i]} ms`);
      assert.ok(fps(out, 30, 40) >= 5, `${fps(out, 30, 40)} fps at the end`);
      // Keyframes inside the allowance once the picture is learnt, but for the first of a try at a bigger size.
      const allowance = (TARGET_KBPS * KEY_ALLOWANCE_MS) / 8;
      let previousLevel = 0;
      for (const frame of out) {
        const probe = frame.level < previousLevel;
        previousLevel = frame.level;
        if (frame.key && frame.at >= 5000 && !probe) assert.ok(frame.bytes <= allowance, `a keyframe of ${Math.round((frame.bytes * 8) / TARGET_KBPS)} ms of the bitrate at ${Math.round(frame.at)} ms`);
      }
    });
  }

  it("easy pictures are left alone: every frame, full size, the encoder asked for the bitrate", () => {
    const { out, offered, rate } = simulate([{ untilS: 20, picture: EASY }]);
    assert.ok(out.length >= offered - 5, `${offered - out.length} of ${offered} skipped`);
    assert.equal(rate.stats().level, 0);
    assert.ok(rate.stats().factor >= 0.95, `factor ${rate.stats().factor}`);
  });

  it("an overshooting encoder is asked for less before any frame is skipped or the picture made smaller", () => {
    const { out, rate } = simulate([{ untilS: 30, picture: BUSY }]);
    assert.equal(rate.stats().level, 0, "full size");
    assert.ok(rate.stats().factor < 0.75 && rate.stats().factor > 0.5, `factor ${rate.stats().factor}`);
    assert.ok(fps(out, 10, 30) >= 29, `${fps(out, 10, 30)} fps`);
  });

  it("an ordinary program's keyframes (here 255 ms of the bitrate) cost it neither its size nor its bitrate", () => {
    const HEAVY_KEYS: Picture = { overshoot: 0.85, floorBytes: 500, keyTimes: 9 };
    const { rate } = simulate([{ untilS: 30, picture: HEAVY_KEYS }]);
    assert.equal(rate.stats().level, 0);
    assert.ok(rate.stats().factor >= 0.95, `factor ${rate.stats().factor}`);
  });

  it("noise is made smaller until it fits at a frame rate worth watching", () => {
    const { out, rate } = simulate([{ untilS: 40, picture: NOISE }]);
    assert.equal(rate.stats().level, SCALE_LEVELS.length - 1);
    assert.ok(fps(out, 30, 40) >= 5, `${fps(out, 30, 40)} fps`);
  });

  it("when the picture gets easy again, the full size comes back", () => {
    const { out } = simulate([
      { untilS: 20, picture: FINE },
      { untilS: 140, picture: EASY },
    ]);
    const last = out[out.length - 1]!;
    assert.equal(last.level, 0, "back to full size");
    assert.ok(worstWindow(out, 2000, 140_000) <= RATE_WINDOW_ALLOWANCE);
    assert.ok(fps(out, 130, 140) >= 29);
  });

  it("a lower bitrate (congestion, the audience's hint) is held to as well", () => {
    const rate = new VideoRateController(TARGET_KBPS, 3);
    rate.setTarget(600);
    assert.equal(rate.windowCapBytes(), (600 * 1000 * 2 * RATE_WINDOW_ALLOWANCE) / 8);
  });
});
