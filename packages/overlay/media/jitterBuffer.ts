/**
 * The jitter buffer: the contract between the network and a decoder (SPEC §10.1–§10.4). Pure:
 * frames go in, in any order; `pop` says what to decode now. One per stream.
 *
 * It reads nothing but a frame's header. What can be decoded is `refDelta` and `keyDelta` alone.
 */
import { MediaFlag } from "../protocol";
import type { ReceivedFrame } from "../types";
import { Emitter } from "./emitter";
import { expectedTemporalLayer } from "./layers";
import type { JitterBuffer, JitterBufferEvents, JitterBufferOptions, JitterBufferStats, PlayoutFrame } from "./types";

/** A missing base-layer frame is waited for this long past its due time (§10.3). */
export const STALL_WAIT_US = 150_000;
/** Media this far beyond *D* ahead of the playout point starts a catch-up (§10.4). */
export const CATCH_UP_SLACK_US = 100_000;
/** *D* falls no faster than this (§10.2). */
export const DELAY_FALL_MS_PER_S = 10;
/** What a NACK round trip is taken to cost before the link's RTT has been measured. */
export const UNKNOWN_RTT_MS = 50;
/** More frames than this waiting is a stream nobody is popping: the oldest go. */
const MAX_BUFFERED_FRAMES = 2048;
/** How far back `refDelta` can reach (one byte). */
const MAX_REF_DELTA = 255;

/** The playout delay the link's numbers ask for (§10.2), before the rule about how fast it may fall. */
export function playoutDelayTarget(hints: { jitterMs: number; rttMs: number | null; lossPct: number }, playoutMinMs: number, playoutMaxMs: number): number {
  const jitter = Number.isFinite(hints.jitterMs) ? Math.max(0, hints.jitterMs) : 0;
  const nack = hints.lossPct > 0.5 ? (hints.rttMs ?? UNKNOWN_RTT_MS) + 20 : 0;
  return Math.min(Math.max(playoutMinMs + 2.5 * jitter + nack, playoutMinMs), Math.max(playoutMinMs, playoutMaxMs));
}

type Entry = {
  frame: ReceivedFrame;
  /** It arrived after its time, or its time passed while it could not be decoded: decode, do not show. */
  late: boolean;
};

export class JitterBufferImpl extends Emitter<JitterBufferEvents> implements JitterBuffer {
  private readonly streamId: number;
  private readonly audio: boolean;
  private readonly frameUs: number;
  private readonly scalability: string | undefined;

  /** Frames waiting, all newer than `lastOutId`. */
  private readonly entries = new Map<number, Entry>();
  /** Their ids, ascending. */
  private ids: number[] = [];

  private lastOutId = -1;
  private lastOutCaptureUs: number | null = null;
  /** The keyframe of the GOP being handed out, and which of its frames have been. */
  private gopKeyId = -1;
  private handed = new Set<number>();
  /** A GOP given up on: its frames are dropped as they arrive. */
  private deadGopKeyId: number | null = null;
  /** The frame playout is waiting for. */
  private stallRoot: number | null = null;
  /** The next keyframe handed out is a jump: say so. */
  private skipPending = false;
  /** Frames newer than `lastOutId` already counted as lost or late, so that passing them does not count them again. */
  private accounted = new Set<number>();

  private newestCaptureUs: number | null = null;
  private maxSeenId = -1;
  private lastPopUs: number | null = null;
  /** The temporal layers of the last frames in, to know what this viewer is being sent. */
  private recentLayers: number[] = [];

  private hints = { jitterMs: 0, rttMs: null as number | null, lossPct: 0 };
  /** Held on top of D: see `setExtraDelayMs`. */
  private extraMs = 0;
  private delayMs: number;
  private delayAt: number;
  private announcedDelayMs: number;

  private framesIn = 0;
  private framesOut = 0;
  private late = 0;
  private lost = 0;
  private stalls = 0;

  constructor(private readonly options: JitterBufferOptions) {
    super();
    const { config } = options;
    this.streamId = config.id;
    this.audio = config.kind === "audio";
    this.frameUs = this.audio ? (config.frameUs ?? 20_000) : Math.round(1_000_000 / (config.fps ?? 30));
    this.scalability = config.scalability;
    this.delayMs = options.playoutMinMs;
    this.delayAt = options.clock.now();
    this.announcedDelayMs = Math.round(this.delayMs);
  }

  /* ------------------------------ the delay ------------------------------ */

  setLinkHints(hints: { jitterMs: number; rttMs: number | null; lossPct: number }): void {
    this.hints = { jitterMs: hints.jitterMs, rttMs: hints.rttMs, lossPct: hints.lossPct };
    this.updateDelay();
  }

  /** *D* rises at once and falls by at most 10 ms a second. */
  private updateDelay(): number {
    const now = this.options.clock.now();
    const target = playoutDelayTarget(this.hints, this.options.playoutMinMs, this.options.playoutMaxMs);
    const elapsed = Math.max(0, now - this.delayAt);
    this.delayAt = now;
    this.delayMs = target >= this.delayMs ? target : Math.max(target, this.delayMs - (DELAY_FALL_MS_PER_S * elapsed) / 1000);
    const rounded = Math.round(this.delayMs);
    if (rounded !== this.announcedDelayMs) {
      this.announcedDelayMs = rounded;
      this.emit("delay", rounded);
    }
    return Math.round(this.delayMs * 1000);
  }

  /* ------------------------------ in ------------------------------ */

  push(frame: ReceivedFrame): void {
    const { header } = frame;
    if (header.streamId !== this.streamId) return;
    const id = header.frameId;
    // A duplicate, or older than what has already been handed out: nothing can use it.
    if (id <= this.lastOutId) {
      if (!this.handed.has(id)) this.late++;
      return;
    }
    if (this.entries.has(id) || this.accounted.has(id)) return;
    this.maxSeenId = Math.max(this.maxSeenId, id);
    this.framesIn++;
    this.recentLayers.push(header.temporal);
    if (this.recentLayers.length > 16) this.recentLayers.shift();
    if (this.newestCaptureUs === null || header.captureUs > this.newestCaptureUs) this.newestCaptureUs = header.captureUs;

    const key = this.isKey(frame);
    if (!key && this.deadGopKeyId !== null && id - header.keyDelta === this.deadGopKeyId) {
      this.countLost(id);
      return;
    }
    const delayUs = this.effectiveDelayUs();
    const late = this.lastPopUs !== null && header.captureUs + delayUs <= this.lastPopUs;
    if (late) {
      this.late++;
      // After its time, a frame is used only if a later frame needs it (§10.3). Nothing needs
      // an audio frame or a discardable one.
      if (this.audio || (header.flags & MediaFlag.Discardable) !== 0) {
        this.accounted.add(id);
        return;
      }
    }
    this.entries.set(id, { frame, late });
    this.insertId(id);
    if (this.ids.length > MAX_BUFFERED_FRAMES) {
      this.drop(this.ids[0] as number);
    }
  }

  private insertId(id: number): void {
    const ids = this.ids;
    if (ids.length === 0 || id > (ids[ids.length - 1] as number)) {
      ids.push(id);
      return;
    }
    let low = 0;
    let high = ids.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((ids[mid] as number) < id) low = mid + 1;
      else high = mid;
    }
    ids.splice(low, 0, id);
  }

  private isKey(frame: ReceivedFrame): boolean {
    return this.audio || (frame.header.flags & MediaFlag.Key) !== 0;
  }

  /* ------------------------------ out ------------------------------ */

  /**
   * What stands between `frame` and a decoder. "ready": nothing. "never": something it needs is
   * gone for good. A number: the id of the missing frame it is, in the end, waiting for.
   */
  private blocker(frame: ReceivedFrame): "ready" | "never" | number {
    if (this.isKey(frame)) return "ready";
    let { header } = frame;
    for (let depth = 0; depth < 64; depth++) {
      const keyId = header.frameId - header.keyDelta;
      if (keyId !== this.gopKeyId) {
        // A GOP whose keyframe has not been handed out. It can still come only if it is ahead.
        if (keyId <= this.lastOutId) return "never";
        const key = this.entries.get(keyId);
        return key ? "never" : keyId;
      }
      if (header.refDelta < 1) return "never";
      const ref = header.frameId - header.refDelta;
      if (this.handed.has(ref)) return depth === 0 ? "ready" : "never";
      if (ref <= this.lastOutId) return "never";
      const entry = this.entries.get(ref);
      if (!entry) return ref;
      // What it needs is here, but is itself waiting: follow the chain to what is missing.
      header = entry.frame.header;
    }
    return "never";
  }

  pop(nowUs: number): PlayoutFrame[] {
    const delayUs = this.updateDelay() + Math.round(this.extraMs * 1000);
    this.lastPopUs = nowUs;
    const out: PlayoutFrame[] = [];
    if (this.ids.length === 0) return out;
    // The common case, many times a second: nothing is due yet.
    if ((this.entries.get(this.ids[0] as number) as Entry).frame.header.captureUs + delayUs > nowUs) return out;

    // §10.4: more than D + 100 ms between the newest frame and the playout point means old
    // media is waiting (a replay, or the end of a stall). It is decoded but not shown.
    const newest = this.newestCaptureUs as number;
    const playoutPointUs = this.lastOutCaptureUs ?? (this.entries.get(this.ids[0] as number) as Entry).frame.header.captureUs;
    const catchingUp = newest - playoutPointUs > delayUs + CATCH_UP_SLACK_US;
    const showFromUs = newest - delayUs;

    let waiting = false;
    for (const id of [...this.ids]) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      const { frame } = entry;
      const dueUs = frame.header.captureUs + delayUs;
      if (dueUs > nowUs) break;

      const blocker = this.blocker(frame);
      if (blocker === "ready") {
        const decodeOnly = entry.late || (catchingUp && frame.header.captureUs < showFromUs);
        this.handOut(frame);
        out.push({ frame, dueUs, decodeOnly });
        continue;
      }
      if (blocker === "never") {
        this.drop(id);
        continue;
      }
      // Its time has come and it cannot be decoded yet. If what it waits for does arrive, this
      // frame is decoded for the sake of those after it, not shown.
      entry.late = true;
      // A discardable frame is skipped, and playout goes on. Behind a stall, everything waits.
      if (waiting || (frame.header.flags & MediaFlag.Discardable) !== 0) continue;

      // A frame others build on is waiting for a missing one: video stalls (§10.3).
      const rootDueUs = frame.header.captureUs - (id - blocker) * this.frameUs + delayUs;
      if (nowUs < rootDueUs + STALL_WAIT_US) {
        if (this.stallRoot !== blocker) {
          this.stallRoot = blocker;
          this.stalls++;
          this.emit("stall", this.streamId, blocker);
        }
        waiting = true;
        continue;
      }
      this.giveUp(id - frame.header.keyDelta);
    }
    return out;
  }

  private handOut(frame: ReceivedFrame): void {
    const { header } = frame;
    const id = header.frameId;
    const key = this.isKey(frame);
    // Everything passed over is lost: what waited and was never decodable, and what never came
    // (unless it is of a layer this viewer is not being sent).
    if (this.lastOutId >= 0) {
      const sent = this.recentLayers.reduce((max, layer) => Math.max(max, layer), 0);
      const from = Math.max(this.lastOutId + 1, id - 4096);
      for (let missed = from; missed < id; missed++) {
        if (this.accounted.has(missed)) continue;
        if (this.entries.has(missed)) {
          this.remove(missed);
          this.lost++;
        } else if (!this.audio) {
          const layer = this.gopKeyId >= 0 ? expectedTemporalLayer(this.scalability, missed - this.gopKeyId) : null;
          if (layer === null || layer <= sent) this.lost++;
        } else {
          this.lost++;
        }
      }
    } else {
      for (const waiting of [...this.ids]) {
        if (waiting >= id) break;
        this.remove(waiting);
      }
    }
    this.remove(id);
    for (const counted of this.accounted) if (counted <= id) this.accounted.delete(counted);

    if (key && !this.audio) {
      if (this.skipPending || this.stallRoot !== null) this.emit("skip", this.streamId, id);
      this.gopKeyId = id;
      this.handed = new Set();
      this.deadGopKeyId = null;
      this.skipPending = false;
    }
    if (this.stallRoot !== null && id >= this.stallRoot) this.stallRoot = null;
    this.handed.add(id);
    if (this.handed.size > 2 * MAX_REF_DELTA) {
      for (const old of this.handed) if (old < id - MAX_REF_DELTA) this.handed.delete(old);
    }
    this.lastOutId = id;
    this.lastOutCaptureUs = header.captureUs;
    this.framesOut++;
  }

  /** Stop waiting: nothing of this GOP will be handed out again. Playout resumes at the next keyframe. */
  private giveUp(gopKeyId: number): void {
    this.deadGopKeyId = gopKeyId;
    this.skipPending = true;
    this.stallRoot = null;
    for (const id of [...this.ids]) {
      const entry = this.entries.get(id);
      if (!entry || this.isKey(entry.frame)) continue;
      if (id - entry.frame.header.keyDelta === gopKeyId) this.drop(id);
    }
  }

  private countLost(id: number): void {
    this.lost++;
    this.accounted.add(id);
  }

  /** A frame that was here and will never be handed out. */
  private drop(id: number): void {
    this.remove(id);
    this.countLost(id);
  }

  private remove(id: number): void {
    if (!this.entries.delete(id)) return;
    const index = this.ids.indexOf(id);
    if (index >= 0) this.ids.splice(index, 1);
  }

  /* ------------------------------ the rest ------------------------------ */

  /** *D* as it stands, in microseconds: what `pop` adds to a capture time. */
  delayUs(): number {
    return Math.round(this.delayMs * 1000);
  }

  /**
   * Media this stream holds beyond D because of where it is played from, not because of the
   * link: a player whose clock is another stream's, or whose sound card adds latency, hands
   * frames out later than `captureUs` + D. Telling the buffer keeps §10.4's catch-up from taking
   * that for a backlog. Due times do not change: they are asked for at the playhead plus
   * `effectiveDelayUs`.
   */
  setExtraDelayMs(ms: number): void {
    this.extraMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  }

  /** D and the extra, in microseconds: what a frame's capture time is compared with. */
  effectiveDelayUs(): number {
    return Math.round((this.delayMs + this.extraMs) * 1000);
  }

  oldestWanted(): number | null {
    if (this.maxSeenId < 0) return null;
    if (this.deadGopKeyId !== null) {
      // Nothing before the next keyframe is wanted.
      for (const id of this.ids) {
        const entry = this.entries.get(id);
        if (entry && this.isKey(entry.frame)) return id;
      }
      return this.maxSeenId + 1;
    }
    return this.lastOutId + 1;
  }

  stats(): JitterBufferStats {
    // Media held ahead of playout: from the playout point (now less D) to the newest frame.
    let bufferUs = 0;
    if (this.ids.length > 0 && this.newestCaptureUs !== null) {
      const oldest = (this.entries.get(this.ids[0] as number) as Entry).frame.header.captureUs;
      const playoutPointUs = this.lastPopUs === null ? oldest : Math.max(oldest - this.frameUs, this.lastPopUs - this.effectiveDelayUs());
      bufferUs = this.newestCaptureUs - playoutPointUs;
    }
    return {
      targetDelayMs: Math.round(this.delayMs),
      bufferMs: Math.max(0, bufferUs / 1000),
      framesIn: this.framesIn,
      framesOut: this.framesOut,
      late: this.late,
      lost: this.lost,
      stalls: this.stalls,
    };
  }

  reset(): void {
    this.entries.clear();
    this.ids = [];
    this.lastOutId = -1;
    this.lastOutCaptureUs = null;
    this.gopKeyId = -1;
    this.handed = new Set();
    this.deadGopKeyId = null;
    this.stallRoot = null;
    this.skipPending = false;
    this.accounted.clear();
    this.newestCaptureUs = null;
    this.maxSeenId = -1;
    this.lastPopUs = null;
    this.recentLayers = [];
  }
}

export function createJitterBuffer(options: JitterBufferOptions): JitterBufferImpl {
  return new JitterBufferImpl(options);
}
