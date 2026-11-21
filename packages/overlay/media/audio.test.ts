/**
 * The audio sequencer (SPEC §10.5): the code the AudioWorklet runs, here run by hand. PLAN,
 * E-media M4: a lost frame is concealed and counted, never a gap of raw silence under 40 ms;
 * with duplicates nothing is played twice; the delay changes a frame at a time, without a click.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audioWorkletModule, audioWorkletSource, type SequencerLike } from "@meetly/overlay/media/audioCore";
import { SAMPLE_RATE, tone } from "@meetly/overlay/media/testing/fakeBackends";

const FRAME_US = 20000;
const FRAME = 960;
/** The steepest a 440 Hz tone of amplitude 0.5 gets between two samples, with room for a cross-fade. */
const MAX_STEP = 0.5 * 2 * Math.PI * (440 / SAMPLE_RATE) * 1.25;

function sequencer(): SequencerLike {
  return new (audioWorkletModule().Sequencer)(SAMPLE_RATE, FRAME_US);
}

/** Renders `frames` frames of 20 ms from context frame `from`, 128 samples at a time; `feed` is called before each block. */
function render(seq: SequencerLike, from: number, samples: number, feed?: (frame: number) => void): Float32Array {
  const out = new Float32Array(samples);
  for (let at = 0; at < samples; at += 128) {
    feed?.(from + at);
    const block = new Float32Array(Math.min(128, samples - at));
    seq.render(block, from + at);
    out.set(block, at);
  }
  return out;
}

const maxStep = (pcm: Float32Array, from = 1, to = pcm.length) => {
  let worst = 0;
  for (let i = Math.max(1, from); i < to; i++) worst = Math.max(worst, Math.abs((pcm[i] as number) - (pcm[i - 1] as number)));
  return worst;
};
const energy = (pcm: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (pcm[i] as number) ** 2;
  return sum / (to - from);
};

describe("audio sequencer §10.5", () => {
  it("is self-contained: its source can be loaded as a worklet module", () => {
    const source = audioWorkletSource();
    assert.match(source, /registerProcessor/);
    // Evaluated with nothing in scope but globals, it must still define everything it uses.
    const made = new Function(`return ${source.slice(0, -1)}`)() as ReturnType<typeof audioWorkletModule>;
    assert.equal(typeof made.Sequencer, "function");
  });

  it("is silent until started, and plays each frame at its place on the capture timeline", () => {
    const seq = sequencer();
    for (let n = 0; n < 10; n++) seq.push(1_000_000 + n * FRAME_US, tone(1_000_000 + n * FRAME_US));
    assert.equal(energy(render(seq, 0, 1024), 0, 1024), 0);
    assert.equal(seq.report().playUs, null);
    // Capture time 1.0 s plays at context frame 2000.
    seq.start(1_000_000, 2000);
    const out = render(seq, 1024, 4 * FRAME + 976);
    assert.equal(energy(out, 0, 976), 0, "nothing before its time");
    // After the 5 ms fade-in the output is the tone, sample for sample.
    const expected = tone(1_000_000 + FRAME_US);
    for (let i = 0; i < FRAME; i++) assert.equal(out[976 + FRAME + i], expected[i]);
    const report = seq.report();
    assert.equal(report.frame, 1024 + out.length);
    assert.equal(report.playUs, 1_000_000 + ((report.frame - 2000) * 1e6) / SAMPLE_RATE);
    assert.equal(report.played, 4 * FRAME);
    assert.equal(report.concealed, 0);
  });

  it("a start time already past begins with the slot that is playing now, still in the right place", () => {
    const seq = sequencer();
    render(seq, 0, 128 * 40);
    for (let n = 0; n < 10; n++) seq.push(n * FRAME_US, tone(n * FRAME_US));
    seq.start(0, 1000);
    render(seq, 128 * 40, 128 * 10);
    const report = seq.report();
    assert.equal(report.playUs, ((report.frame - 1000) * 1e6) / SAMPLE_RATE);
  });

  it("a missing frame is concealed and counted: the last frame once more, fading; never raw silence for a single loss", () => {
    const seq = sequencer();
    for (let n = 0; n < 10; n++) if (n !== 4) seq.push(n * FRAME_US, tone(n * FRAME_US));
    seq.start(0, 0);
    const out = render(seq, 0, 10 * FRAME);
    assert.equal(seq.report().concealed, FRAME);
    assert.equal(seq.report().played, 9 * FRAME);
    // The concealed 20 ms carries sound, less of it toward the end, and joins what came before without a step.
    const first = energy(out, 4 * FRAME, 4 * FRAME + 240);
    const lastQuarter = energy(out, 5 * FRAME - 240, 5 * FRAME);
    assert.ok(first > 0.05, `concealment starts at energy ${first}`);
    assert.ok(lastQuarter < first / 10, "and fades");
    assert.ok(maxStep(out, 2 * FRAME, 10 * FRAME) <= MAX_STEP, `a step of ${maxStep(out, 2 * FRAME, 10 * FRAME)}`);
  });

  it("a longer loss: one concealed frame, then silence, then a fade back in; all of it counted", () => {
    const seq = sequencer();
    for (let n = 0; n < 12; n++) if (n < 4 || n > 7) seq.push(n * FRAME_US, tone(n * FRAME_US));
    seq.start(0, 0);
    const out = render(seq, 0, 12 * FRAME);
    assert.equal(seq.report().concealed, 4 * FRAME);
    assert.ok(energy(out, 4 * FRAME, 5 * FRAME) > 0.01);
    assert.equal(energy(out, 5 * FRAME, 8 * FRAME), 0);
    assert.ok(energy(out, 8 * FRAME + 480, 9 * FRAME) > 0.1);
    assert.ok(maxStep(out, 2 * FRAME, 12 * FRAME) <= MAX_STEP, `a step of ${maxStep(out, 2 * FRAME, 12 * FRAME)}`);
  });

  it("missing audio never waits: a frame that turns up after its turn is dropped, and playout stays where it was", () => {
    const seq = sequencer();
    for (let n = 0; n < 4; n++) seq.push(n * FRAME_US, tone(n * FRAME_US));
    seq.start(0, 0);
    render(seq, 0, 5 * FRAME + 128, (frame) => {
      if (frame === 4 * FRAME + 128) seq.push(4 * FRAME_US, tone(4 * FRAME_US)); // 2.7 ms after its turn began
      if (frame === 4 * FRAME) seq.push(5 * FRAME_US, tone(5 * FRAME_US));
    });
    const report = seq.report();
    assert.equal(report.concealed, FRAME);
    assert.equal(report.playUs, ((report.frame - 0) * 1e6) / SAMPLE_RATE, "the timeline did not slip");
    render(seq, 5 * FRAME + 128, FRAME);
    assert.equal(seq.report().late, 1);
  });

  it("with duplicates nothing is played twice", () => {
    const seq = sequencer();
    for (let n = 0; n < 10; n++) {
      seq.push(n * FRAME_US, tone(n * FRAME_US));
      if (n > 0) seq.push((n - 1) * FRAME_US, tone((n - 1) * FRAME_US));
    }
    seq.start(0, 0);
    const out = render(seq, 0, 10 * FRAME);
    const report = seq.report();
    assert.equal(report.played, 10 * FRAME);
    assert.equal(report.late, 0);
    assert.equal(report.concealed, 0);
    const expected = tone(5 * FRAME_US);
    for (let i = 0; i < FRAME; i += 7) assert.equal(out[5 * FRAME + i], expected[i]);
  });

  it("a frame is dropped to play 20 ms less delayed: two frames cross-faded into the time of one, without a step", () => {
    const seq = sequencer();
    seq.start(0, 0);
    let pushed = 0;
    let asked = false;
    const out = render(seq, 0, 150 * FRAME, (frame) => {
      // Decoded audio arrives two frames ahead of its turn.
      while (pushed * FRAME < frame + 3 * FRAME) seq.push(pushed * FRAME_US, tone(pushed++ * FRAME_US));
      // (The feed is called every 128 samples; the request lands mid-frame.)
      if (!asked && frame >= 60 * FRAME + 64) {
        asked = true;
        seq.adjust(-1);
      }
    });
    const report = seq.report();
    assert.equal(report.drops, 1);
    assert.equal(report.pending, 0);
    // The timeline is now one frame further on than the context's frames alone would put it.
    assert.equal(report.playUs, (report.frame * 1e6) / SAMPLE_RATE + FRAME_US);
    assert.equal(report.concealed, 0);
    assert.ok(maxStep(out, FRAME) <= MAX_STEP, `a step of ${maxStep(out, FRAME)}`);
  });

  it("a frame is repeated to play 20 ms more delayed, without a step", () => {
    const seq = sequencer();
    seq.start(0, 0);
    let pushed = 0;
    let asked = false;
    const out = render(seq, 0, 150 * FRAME, (frame) => {
      while (pushed * FRAME < frame + 3 * FRAME) seq.push(pushed * FRAME_US, tone(pushed++ * FRAME_US));
      if (!asked && frame >= 60 * FRAME + 64) {
        asked = true;
        seq.adjust(1);
      }
    });
    const report = seq.report();
    assert.equal(report.repeats, 1);
    assert.equal(report.playUs, (report.frame * 1e6) / SAMPLE_RATE - FRAME_US);
    assert.equal(report.concealed, 0);
    assert.equal(report.late, 0);
    assert.ok(maxStep(out, FRAME) <= MAX_STEP, `a step of ${maxStep(out, FRAME)}`);
  });

  it("the change is made at the quietest frame of the second [D26]", () => {
    for (const dir of [-1, 1] as const) {
      const seq = sequencer();
      seq.start(0, 0);
      let pushed = 0;
      let changedAt = -1;
      let asked = false;
      render(seq, 0, 200 * FRAME, (frame) => {
        while (pushed * FRAME < frame + 3 * FRAME) seq.push(pushed * FRAME_US, tone(pushed++ * FRAME_US));
        // Asked for just after the tone's quiet 60 ms (slots 30 to 32 of each second) has gone by.
        if (!asked && frame >= 85 * FRAME + 64) {
          asked = true;
          seq.adjust(dir);
        }
        const report = seq.report();
        if (changedAt < 0 && report.drops + report.repeats === 1) changedAt = Math.round((report.playUs as number) / FRAME_US) % 50;
      });
      // It waited for the next quiet stretch rather than cut into the tone.
      assert.ok(changedAt >= 30 && changedAt <= 34, `dir ${dir}: changed at slot ${changedAt} of the second`);
    }
  });

  it("at most one change a second, and when there is no quiet frame the second's last frame has to do", () => {
    const seq = sequencer();
    seq.start(0, 0);
    let pushed = 0;
    const changes: number[] = [];
    let seen = 0;
    // A tone with no quiet part.
    const steady = (us: number) => tone(us).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * (Math.round((us * SAMPLE_RATE) / 1e6) + i)) / SAMPLE_RATE));
    const out = render(seq, 0, 400 * FRAME, (frame) => {
      // Decoded audio keeps three frames ahead of what is playing, however far the drops have moved that on.
      const playingUs = seq.report().playUs ?? 0;
      while (pushed * FRAME_US < playingUs + 3 * FRAME_US) seq.push(pushed * FRAME_US, steady(pushed++ * FRAME_US));
      if (frame % (10 * FRAME) === 0 && frame >= 60 * FRAME) seq.adjust(-1);
      const report = seq.report();
      if (report.drops > seen) {
        seen = report.drops;
        changes.push(frame / SAMPLE_RATE);
      }
    });
    assert.ok(changes.length >= 4 && changes.length <= 7, `${changes.length} changes in 6.8 s`);
    for (let i = 1; i < changes.length; i++) assert.ok((changes[i] as number) - (changes[i - 1] as number) >= 0.99, `changes ${changes[i - 1]} and ${changes[i]} s`);
    // Made in the loud part of the sound, each change is still a cross-fade: no step.
    assert.ok(maxStep(out, FRAME) <= MAX_STEP, `a step of ${maxStep(out, FRAME)}`);
    assert.equal(seq.report().concealed, 0);
  });

  it("stop empties it; start begins again", () => {
    const seq = sequencer();
    for (let n = 0; n < 5; n++) seq.push(n * FRAME_US, tone(n * FRAME_US));
    seq.start(0, 0);
    render(seq, 0, 2 * FRAME);
    seq.stop();
    assert.equal(energy(render(seq, 2 * FRAME, FRAME), 0, FRAME), 0);
    assert.equal(seq.report().playUs, null);
    for (let n = 0; n < 5; n++) seq.push(5_000_000 + n * FRAME_US, tone(5_000_000 + n * FRAME_US));
    seq.start(5_000_000, 4 * FRAME);
    const out = render(seq, 3 * FRAME, 4 * FRAME);
    assert.ok(energy(out, 2 * FRAME, 3 * FRAME) > 0.1);
  });
});
