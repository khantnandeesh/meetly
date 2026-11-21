/**
 * The page media's browser runs happen in (see ./run.ts). Built with esbuild, loaded into
 * headless Chromium with a fake camera and microphone. Each scenario measures one thing PLAN.md
 * asks of E-media and returns plain numbers; ./run.ts holds them to the limits.
 */
import { MediaFlag } from "../../protocol";
import type { EncodedFrame } from "../../types";
import { createProgramSource } from "../index";
import { createLocalSessionClock, createWorkerClock } from "../testing/realClock";
import { camera, encodingFor, lagMonitor, program, quantile, round, sleep } from "./common";
import { clap, m3, m5 } from "./playback";

/* ------------------------------------------------------------------------------------------ */
/* M1: the source                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * Checks a stream's headers the way a decoder that reads nothing else would (SPEC §9.2): every
 * frame names an earlier frame of its own GOP and of a layer it may build on, and nothing
 * builds on a DISCARDABLE frame. Returns what it found wrong.
 */
function checkHeaders(frames: EncodedFrame[], layers: number): string[] {
  const problems: string[] = [];
  const byId = new Map<number, EncodedFrame>();
  let expected = frames[0]?.header.frameId ?? 0;
  for (const frame of frames) {
    const { header } = frame;
    const key = (header.flags & MediaFlag.Key) !== 0;
    const discardable = (header.flags & MediaFlag.Discardable) !== 0;
    if (header.frameId !== expected) problems.push(`frame ${header.frameId}: expected id ${expected}`);
    expected = header.frameId + 1;
    if (key) {
      if (header.refDelta !== 0 || header.keyDelta !== 0 || header.temporal !== 0 || discardable) problems.push(`keyframe ${header.frameId}: not a clean keyframe header`);
    } else {
      const ref = byId.get(header.frameId - header.refDelta);
      const gop = byId.get(header.frameId - header.keyDelta);
      if (header.refDelta < 1 || !ref) problems.push(`frame ${header.frameId}: refDelta ${header.refDelta} names no frame`);
      else {
        if ((ref.header.flags & MediaFlag.Discardable) !== 0) problems.push(`frame ${header.frameId}: builds on a discardable frame`);
        if (header.temporal === 0 ? ref.header.temporal !== 0 : ref.header.temporal >= header.temporal) problems.push(`frame ${header.frameId} (layer ${header.temporal}) builds on layer ${ref.header.temporal}`);
        if (ref.header.frameId - ref.header.keyDelta !== header.frameId - header.keyDelta) problems.push(`frame ${header.frameId}: builds on a frame of another GOP`);
      }
      if (!gop || (gop.header.flags & MediaFlag.Key) === 0) problems.push(`frame ${header.frameId}: keyDelta ${header.keyDelta} names no keyframe`);
      if (discardable !== (layers > 1 && header.temporal === layers - 1)) problems.push(`frame ${header.frameId}: DISCARDABLE is ${discardable} on layer ${header.temporal}`);
    }
    byId.set(header.frameId, frame);
  }
  return problems.slice(0, 20);
}

export async function m1(options: { seconds?: number; width?: number; height?: number; bitrateKbps?: number; input?: "camera" | "composed"; decode?: boolean } = {}) {
  const seconds = options.seconds ?? 60;
  const encoding = encodingFor(options);
  const clock = createWorkerClock();
  const sessionClock = createLocalSessionClock(clock, 5_000_000);
  const source = createProgramSource({ encoding, sessionClock, clock });
  let input: { video: MediaStreamTrack; audio?: MediaStreamTrack };
  let stopInput: () => void;
  if (options.input === "camera") {
    const stream = await camera(encoding);
    input = { video: stream.getVideoTracks()[0]!, audio: stream.getAudioTracks()[0] };
    stopInput = () => stream.getTracks().forEach((track) => track.stop());
  } else {
    const composed = await program(encoding, clock);
    input = composed.input;
    stopInput = composed.stop;
  }
  const lag = lagMonitor(clock);

  const video: EncodedFrame[] = [];
  const audioIds: number[] = [];
  const audioCaptures: number[] = [];
  const captureToFrameMs: number[] = [];
  const arrival: number[] = [];
  const errors: string[] = [];
  let audioBytes = 0;
  let audioAnnounced = 0;
  const configs: unknown[] = [];
  source.on("config", (config) => configs.push(config));
  source.on("error", (error) => errors.push(error.message));
  source.on("frame", (frame) => {
    const nowUs = sessionClock.now() * 1000;
    if (frame.header.streamId === 0) {
      video.push(frame);
      captureToFrameMs.push((nowUs - frame.header.captureUs) / 1000);
      arrival.push(nowUs / 1000);
    } else {
      audioAnnounced++;
      if (audioIds[audioIds.length - 1] !== frame.header.frameId && !audioIds.includes(frame.header.frameId, Math.max(0, audioIds.length - 4))) {
        audioIds.push(frame.header.frameId);
        audioCaptures.push(frame.header.captureUs);
        audioBytes += frame.data.byteLength;
      }
    }
  });

  // A real decoder is fed everything, to know the stream is one a decoder accepts.
  let decoded = 0;
  const decodeErrors: string[] = [];
  const decoder = new VideoDecoder({ output: (frame) => (decoded++, frame.close()), error: (error) => decodeErrors.push(error.message) });
  decoder.configure({ codec: encoding.video.codec, optimizeForLatency: true });
  source.on("frame", (frame) => {
    if (frame.header.streamId !== 0 || decoder.state !== "configured" || options.decode === false) return;
    decoder.decode(new EncodedVideoChunk({ type: (frame.header.flags & MediaFlag.Key) !== 0 ? "key" : "delta", timestamp: frame.header.captureUs, data: frame.data }));
  });

  await source.start(input);
  // The first second is the encoder finding its rate; measure after it.
  await sleep(1000);
  const from = video.length;
  const fromAudio = audioIds.length;
  const startedAt = clock.now();
  await sleep(seconds * 1000);
  const elapsed = (clock.now() - startedAt) / 1000;
  const measured = video.slice(from);
  const stats = source.stats();
  await source.stop();
  await decoder.flush().catch(() => undefined);
  decoder.close();
  stopInput();
  const eventLoopLagMs = lag.stop();
  clock.close();

  const bytes = measured.reduce((sum, frame) => sum + frame.data.byteLength, 0);
  const keyIds = video.filter((frame) => (frame.header.flags & MediaFlag.Key) !== 0).map((frame) => frame.header.frameId);
  const keyGaps = keyIds.slice(1).map((id, index) => id - (keyIds[index] as number));
  const layerCounts = [0, 0, 0];
  for (const frame of measured) layerCounts[frame.header.temporal] = (layerCounts[frame.header.temporal] ?? 0) + 1;
  const layerBytes = [0, 0, 0];
  for (const frame of measured) layerBytes[frame.header.temporal] = (layerBytes[frame.header.temporal] ?? 0) + frame.data.byteLength;
  const gaps = arrival.slice(from + 1).map((at, index) => at - (arrival[from + index] as number));
  const audioSteps = audioCaptures.slice(1).map((us, index) => us - (audioCaptures[index] as number));
  const measuredAudio = audioIds.length - fromAudio;

  return {
    seconds: round(elapsed),
    targetKbps: encoding.video.bitrateKbps,
    videoKbps: round((bytes * 8) / elapsed / 1000),
    videoFps: round(measured.length / elapsed),
    layerFps: layerCounts.map((count) => round(count / elapsed)),
    layerKbps: layerBytes.map((count) => round((count * 8) / elapsed / 1000)),
    frames: video.length,
    keyframes: keyIds.length,
    keyGapMin: keyGaps.length ? Math.min(...keyGaps) : null,
    keyGapMax: keyGaps.length ? Math.max(...keyGaps) : null,
    headerProblems: checkHeaders(video, 3),
    captureToFrameMs: { p50: round(quantile(captureToFrameMs.slice(from), 0.5)), p95: round(quantile(captureToFrameMs.slice(from), 0.95)), max: round(quantile(captureToFrameMs.slice(from), 1)) },
    frameGapMs: { p50: round(quantile(gaps, 0.5)), p95: round(quantile(gaps, 0.95)), max: round(quantile(gaps, 1)) },
    captureToFrameKeyMs: { p50: round(quantile(captureToFrameMs.filter((_, index) => index >= from && (video[index]!.header.flags & MediaFlag.Key) !== 0), 0.5)), max: round(quantile(captureToFrameMs.filter((_, index) => index >= from && (video[index]!.header.flags & MediaFlag.Key) !== 0), 1)) },
    slow: captureToFrameMs.map((ms, index) => [index, Math.round(ms)]).filter(([index, ms]) => (index as number) >= from && (ms as number) > 30).slice(0, 60).join(" "),
    eventLoopLagMs,
    input: options.input ?? "composed",
    maxEncoderFrames: stats.maxEncoderFrames,
    skippedBusy: stats.skippedBusy,
    skippedPacing: stats.skippedPacing,
    decoded,
    decodeErrors,
    audioFrames: audioIds.length,
    audioAnnounced,
    audioKbps: round((audioBytes * 8) / (elapsed + 1) / 1000),
    audioFps: round(measuredAudio / elapsed),
    audioStepUs: { min: audioSteps.length ? Math.min(...audioSteps) : null, max: audioSteps.length ? Math.max(...audioSteps) : null },
    configs,
    errors,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* M1, the hard way: are the headers true?                                                     */
/* ------------------------------------------------------------------------------------------ */

async function decodeAll(codec: string, frames: EncodedFrame[]): Promise<{ hashes: Map<number, number>; errors: string[] }> {
  const hashes = new Map<number, number>();
  const errors: string[] = [];
  const idOf = new Map<number, number>();
  let buffer = new Uint8Array(0);
  const pending: Promise<void>[] = [];
  const decoder = new VideoDecoder({
    output: (frame) => {
      const id = idOf.get(frame.timestamp) as number;
      pending.push(
        (async () => {
          const size = frame.allocationSize();
          if (buffer.byteLength < size) buffer = new Uint8Array(size);
          const mine = new Uint8Array(size);
          await frame.copyTo(mine);
          frame.close();
          let hash = 2166136261;
          for (let i = 0; i < size; i += 3) hash = Math.imul(hash ^ (mine[i] as number), 16777619);
          hashes.set(id, hash >>> 0);
        })(),
      );
    },
    error: (error) => errors.push(error.message),
  });
  decoder.configure({ codec });
  for (const frame of frames) {
    idOf.set(frame.header.captureUs, frame.header.frameId);
    decoder.decode(new EncodedVideoChunk({ type: (frame.header.flags & MediaFlag.Key) !== 0 ? "key" : "delta", timestamp: frame.header.captureUs, data: frame.data }));
  }
  await decoder.flush().catch((error: Error) => errors.push(`flush: ${error.message}`));
  await Promise.all(pending);
  decoder.close();
  return { hashes, errors };
}

/** What is left of a stream when `remove` frames are taken out, and with them every frame the headers say needed one. */
function survivors(frames: EncodedFrame[], remove: (frame: EncodedFrame) => boolean): EncodedFrame[] {
  const kept = new Set<number>();
  const out: EncodedFrame[] = [];
  for (const frame of frames) {
    const { header } = frame;
    const key = (header.flags & MediaFlag.Key) !== 0;
    if (!key && (remove(frame) || !kept.has(header.frameId - header.refDelta) || !kept.has(header.frameId - header.keyDelta))) continue;
    kept.add(header.frameId);
    out.push(frame);
  }
  return out;
}

/**
 * Encodes a few seconds, then decodes the stream whole and again with frames removed as the
 * headers allow. If a frame decodes to different pixels when something the headers call
 * unneeded is missing, the headers are not telling the truth about what it needs.
 */
export async function deps(options: { seconds?: number; width?: number; height?: number; bitrateKbps?: number; scalability?: string } = {}) {
  const encoding = encodingFor({ width: 640, height: 360, bitrateKbps: 600, ...options });
  const clock = createWorkerClock();
  const sessionClock = createLocalSessionClock(clock);
  const source = createProgramSource({ encoding, sessionClock, clock });
  const stream = await camera(encoding, false);
  const frames: EncodedFrame[] = [];
  source.on("frame", (frame) => frames.push(frame));
  await source.start({ video: stream.getVideoTracks()[0]! });
  await sleep((options.seconds ?? 6) * 1000);
  await source.stop();
  for (const track of stream.getTracks()) track.stop();
  // Start at a keyframe.
  const first = frames.findIndex((frame) => (frame.header.flags & MediaFlag.Key) !== 0);
  const all = frames.slice(first);

  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const reference = await decodeAll(encoding.video.codec, all);
  const policies: [string, (frame: EncodedFrame) => boolean][] = [
    ["no layer 2", (frame) => frame.header.temporal >= 2],
    ["base layer only", (frame) => frame.header.temporal >= 1],
    ["10% of layer 2 removed", (frame) => frame.header.temporal === 2 && random() < 0.1],
    ["20% of layer 1 removed", (frame) => frame.header.temporal === 1 && random() < 0.2],
    ["5% of layer 1 and 10% of layer 2 removed", (frame) => (frame.header.temporal === 1 && random() < 0.05) || (frame.header.temporal === 2 && random() < 0.1)],
  ];
  const results = [];
  for (const [name, remove] of policies) {
    const subset = survivors(all, remove);
    const got = await decodeAll(encoding.video.codec, subset);
    const different = subset.filter((frame) => got.hashes.get(frame.header.frameId) !== reference.hashes.get(frame.header.frameId)).map((frame) => frame.header.frameId);
    results.push({ policy: name, kept: subset.length, of: all.length, decoded: got.hashes.size, differentPixels: different.length, firstDifferent: different.slice(0, 8), errors: got.errors });
  }
  // The control: take out one base-layer frame and keep what needed it. The check must notice.
  const victim = all.find((frame) => frame.header.temporal === 0 && frame.header.keyDelta >= 8)?.header.frameId ?? -1;
  const broken = all.filter((frame) => frame.header.frameId !== victim);
  const brokenResult = await decodeAll(encoding.video.codec, broken);
  const controlDifferent = broken.filter((frame) => brokenResult.hashes.get(frame.header.frameId) !== reference.hashes.get(frame.header.frameId)).length;
  return {
    controlDifferent,
    scalability: encoding.video.scalability,
    frames: all.length,
    referenceDecoded: reference.hashes.size,
    pattern: all.slice(0, 16).map((frame) => `${frame.header.frameId - (all[0] as EncodedFrame).header.frameId}:T${frame.header.temporal}<-${frame.header.refDelta}`),
    headerProblems: checkHeaders(all, 3),
    results,
  };
}

const scenarios = { m1, deps, m3, clap, m5 };
export type Scenarios = typeof scenarios;
(globalThis as unknown as { mediaTest: typeof scenarios }).mediaTest = scenarios;
