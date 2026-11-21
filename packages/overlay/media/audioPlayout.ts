/**
 * Audio playout, the part on the main thread (SPEC §10.5): it starts the sequencer so that a
 * frame captured at *t* is heard at *t* + *D*, reads back from the sequencer's reports where
 * playout really is (the master clock video is timed by), and moves the delay toward its
 * target one frame a second [D26].
 */
import type { Clock } from "../runtime";
import type { SequencerReport } from "./audioCore";
import type { AudioBackend } from "./backends";

/** The delay is moved when it is this far from its target: more by a repeat, less by a drop. */
export const GROW_WHEN_SHORT_MS = 10;
export const SHRINK_WHEN_LONG_MS = 20;
/**
 * A delay further off than this is not adapted to, a frame a second: playout starts again in the
 * right place. Too long a delay only costs latency, so it is borne up to `RESYNC_WHEN_OFF_MS`
 * over the target. Too short a one loses frames once it leaves less than `RESYNC_SLACK_MS` beyond
 * the path (after a repair to a parent further away, say), so that is not borne at all.
 */
export const RESYNC_WHEN_OFF_MS = 250;
export const RESYNC_SLACK_MS = 25;
/** One change a second. */
export const ADJUST_INTERVAL_MS = 1000;
/** A report older than this says nothing about now. */
const REPORT_STALE_MS = 500;
/**
 * How many readings of the two clocks' difference are kept, to find its true value: 160 ms at a
 * reading a tick. Enough to catch the context's clock just after each of its steps (it moves a
 * block, or a sound card's buffer, at a time), and short, because when the context's thread
 * stalls its clock loses that time for good (an underrun), and a reading from before is then a
 * lie that would show the picture early by the length of the stall for as long as it is kept.
 */
const CLOCK_WINDOW = 32;

export type AudioPlayoutCounters = { playedMs: number; concealedMs: number; late: number; drops: number; repeats: number; resyncs: number };

export class AudioPlayout {
  private started = false;
  /** Capture time of the first frame given to the decoder since the last (re)start. */
  private firstUs: number | null = null;
  private report: SequencerReport | null = null;
  /** The last report whatever happened since: its counters are totals. */
  private totals: SequencerReport | null = null;
  private reportAt = -Infinity;
  private lastAdjustAt = -Infinity;
  private startedAt = -Infinity;
  private resyncs = 0;
  /** The delay is long enough that a frame is to be dropped. */
  private wantDrop = false;
  /** Recent readings of (context time − local time), seconds: the largest is the true offset. */
  private readonly offsets: number[] = [];
  private offsetAt = 0;

  constructor(
    private readonly backend: AudioBackend,
    private readonly clock: Clock,
    private readonly frameUs: number,
  ) {}

  onReport(report: SequencerReport): void {
    this.totals = report;
    this.report = report;
    this.reportAt = this.clock.now();
  }

  /** The context's clock read against ours. It only moves a block at a time, so the latest reading is early by up to a block: the largest recent one is right. */
  private sampleClocks(): number {
    const offset = this.backend.contextTime() - this.clock.now() / 1000;
    this.offsets[this.offsetAt++ % CLOCK_WINDOW] = offset;
    let best = -Infinity;
    for (const value of this.offsets) if (value > best) best = value;
    return best;
  }

  /** Forget where playout was: the next frame decoded starts it again. After a pause, or a jump too big to adapt to. */
  restart(): void {
    if (this.started) this.backend.post({ t: "stop" });
    this.started = false;
    this.wantDrop = false;
    this.firstUs = null;
    this.report = null;
    this.offsets.length = 0;
    this.offsetAt = 0;
  }

  /** A frame from the jitter buffer. `play` false: for the decoder's state only. */
  decode(captureUs: number, data: Uint8Array, play: boolean): void {
    if (play && this.firstUs === null) this.firstUs = captureUs;
    this.backend.decode({ captureUs, data, play });
  }

  /**
   * The capture time being heard now, or null while audio is not the clock (not started, not
   * running, or silent about itself for too long).
   */
  playheadUs(): number | null {
    if (!this.started || !this.report || this.report.playUs === null || this.backend.state() !== "running") return null;
    if (this.clock.now() - this.reportAt > REPORT_STALE_MS || this.offsets.length === 0) return null;
    let offset = -Infinity;
    for (const value of this.offsets) if (value > offset) offset = value;
    const contextNow = this.clock.now() / 1000 + offset;
    const sinceReport = contextNow - this.report.frame / this.backend.sampleRate;
    return this.report.playUs + (sinceReport - this.backend.outputLatency()) * 1e6;
  }

  /**
   * Call often. `nowUs` is session time; `targetMs` the delay wanted, capture to loudspeaker;
   * `leastMs` the shortest that does not lose frames (the path, and a little).
   */
  tick(nowUs: number, targetMs: number, leastMs = 0): void {
    if (this.backend.state() !== "running") return;
    const offset = this.sampleClocks();
    const now = this.clock.now();
    if (!this.started) {
      if (this.firstUs === null) return;
      // The first frame is to be heard at its capture time plus D. In the context's frames:
      const contextNow = now / 1000 + offset;
      const atS = contextNow + (this.firstUs + targetMs * 1000 - nowUs) / 1e6 - this.backend.outputLatency();
      this.backend.post({ t: "start", us: this.firstUs, atFrame: Math.round(atS * this.backend.sampleRate) });
      this.started = true;
      this.startedAt = now;
      this.lastAdjustAt = now;
      this.report = null;
      return;
    }
    const playheadUs = this.playheadUs();
    if (playheadUs === null || this.report === null) return;
    const delayMs = (nowUs - playheadUs) / 1000;
    const error = delayMs - targetMs;
    this.wantDrop = error >= SHRINK_WHEN_LONG_MS;
    if ((error > RESYNC_WHEN_OFF_MS || (delayMs < leastMs && error < 0)) && now - this.startedAt > 2 * REPORT_STALE_MS) {
      this.resyncs++;
      this.restart();
      return;
    }
    if (this.report.pending !== 0 || now - this.lastAdjustAt < ADJUST_INTERVAL_MS) return;
    if (error >= SHRINK_WHEN_LONG_MS) {
      this.backend.post({ t: "adjust", dir: -1 });
      this.lastAdjustAt = now;
    } else if (error <= -GROW_WHEN_SHORT_MS) {
      this.backend.post({ t: "adjust", dir: 1 });
      this.lastAdjustAt = now;
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  /** How far ahead of what is heard the worklet renders: the sound card's output latency, in microseconds. */
  renderAheadUs(): number {
    return Math.max(0, this.backend.outputLatency()) * 1e6;
  }

  /** A frame is to be dropped: the sequencer needs the one after it in good time. */
  wantsDrop(): boolean {
    return this.started && this.wantDrop;
  }

  counters(): AudioPlayoutCounters {
    const report = this.totals;
    const perMs = this.backend.sampleRate / 1000;
    return {
      playedMs: report ? report.played / perMs : 0,
      concealedMs: report ? report.concealed / perMs : 0,
      late: report ? report.late : 0,
      drops: report ? report.drops : 0,
      repeats: report ? report.repeats : 0,
      resyncs: this.resyncs,
    };
  }

  /** One frame, in milliseconds. */
  get frameMs(): number {
    return this.frameUs / 1000;
  }
}
