/**
 * What media's own tests stand on: a clock that only moves when told to, a session clock on top
 * of it, and frames with honest L1T3 headers. Test support, not part of the engine.
 */
import { MediaFlag, PacketType, type FrameHeader, type StreamConfig } from "../../protocol";
import type { Cancel, Clock, SessionClock } from "../../runtime";
import type { ReceivedFrame } from "../../types";
import { DependencyTracker, temporalLayerCount } from "../layers";

export type FakeClock = Clock & {
  /** Move time forward, running every timer that comes due, in order. */
  advance(ms: number): void;
  pending(): number;
};

export function createFakeClock(start = 0): FakeClock {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; every: number | null; callback: () => void }>();
  const add = (callback: () => void, ms: number, every: number | null): Cancel => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, ms), every, callback });
    return () => {
      timers.delete(id);
    };
  };
  return {
    now: () => now,
    setTimeout: (callback, ms) => add(callback, ms, null),
    setInterval: (callback, ms) => add(callback, ms, Math.max(0.001, ms)),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let dueId = -1;
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (timer.at < dueAt || (timer.at === dueAt && id < dueId))) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId < 0) break;
        const timer = timers.get(dueId)!;
        now = Math.max(now, timer.at);
        if (timer.every === null) timers.delete(dueId);
        else timer.at += timer.every;
        timer.callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

/** A session clock that is the local clock plus a fixed offset. */
export function createFakeSessionClock(clock: Clock, offsetMs = 0): SessionClock {
  return { now: () => clock.now() + offsetMs, fromLocal: (localMs) => localMs + offsetMs, uncertaintyMs: 0 };
}

export const VIDEO_CONFIG: StreamConfig = {
  id: 0,
  kind: "video",
  configId: 0,
  codec: "vp8",
  bitrateKbps: 1200,
  width: 1280,
  height: 720,
  fps: 30,
  scalability: "L1T3",
  keyIntervalFrames: 60,
  stripes: [{ index: 0, kind: "data", temporal: [0, 1, 2] }],
  sframe: false,
};

export const AUDIO_CONFIG: StreamConfig = {
  id: 1,
  kind: "audio",
  configId: 0,
  codec: "opus",
  bitrateKbps: 32,
  sampleRate: 48000,
  channels: 1,
  frameUs: 20000,
  stripes: [{ index: 0, kind: "data", temporal: [0] }],
  sframe: false,
};

export function received(header: FrameHeader, data: Uint8Array = new Uint8Array(0), at = 0): ReceivedFrame {
  return { header, data, firstPacketAt: at, completeAt: at, from: "p-test", recovered: false };
}

/**
 * The headers of a video stream as the source writes them: `count` frames from id 0, a keyframe
 * every `keyInterval`, frame *n* captured at `startUs + n × frameUs`.
 */
export function videoFrames(count: number, options: { config?: StreamConfig; startUs?: number; frameUs?: number } = {}): ReceivedFrame[] {
  const config = options.config ?? VIDEO_CONFIG;
  const frameUs = options.frameUs ?? Math.round(1_000_000 / (config.fps ?? 30));
  const layers = temporalLayerCount(config.scalability);
  const period = 1 << (layers - 1);
  const keyInterval = config.keyIntervalFrames ?? 60;
  const tracker = new DependencyTracker(layers);
  const frames: ReceivedFrame[] = [];
  for (let id = 0; id < count; id++) {
    const key = id % keyInterval === 0;
    const position = (id % keyInterval) % period;
    let temporal = 0;
    if (position !== 0) {
      temporal = layers - 1;
      for (let step = position; step % 2 === 0; step >>= 1) temporal--;
    }
    const dep = tracker.next(id, key, temporal);
    frames.push(
      received({
        type: PacketType.Media,
        flags: (key ? MediaFlag.Key : 0) | (dep.discardable ? MediaFlag.Discardable : 0),
        streamId: config.id,
        stripe: 0,
        spatial: 0,
        temporal: dep.temporal,
        refDelta: dep.refDelta,
        keyDelta: dep.keyDelta,
        frameId: id,
        captureUs: (options.startUs ?? 0) + id * frameUs,
        configId: config.configId,
      }),
    );
  }
  return frames;
}

export function audioFrames(count: number, options: { config?: StreamConfig; startUs?: number } = {}): ReceivedFrame[] {
  const config = options.config ?? AUDIO_CONFIG;
  const frameUs = config.frameUs ?? 20000;
  const frames: ReceivedFrame[] = [];
  for (let id = 0; id < count; id++) {
    frames.push(
      received({
        type: PacketType.Media,
        flags: MediaFlag.Key,
        streamId: config.id,
        stripe: 0,
        spatial: 0,
        temporal: 0,
        refDelta: 0,
        keyDelta: 0,
        frameId: id,
        captureUs: (options.startUs ?? 0) + id * frameUs,
        configId: config.configId,
      }),
    );
  }
  return frames;
}

/** A seeded generator (mulberry32), so a test that draws at random draws the same every run. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
