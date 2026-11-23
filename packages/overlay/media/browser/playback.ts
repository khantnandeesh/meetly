/**
 * Media's browser scenarios for the receive side (PLAN, E-media M3–M5): a real encoder, a stand-in
 * link (../testing/loopback.ts: packets, delay, loss, whole layers removed, a replay after a
 * parent's death) and the real player with WebCodecs decoders, a track and the AudioWorklet.
 * Until E-transport's links exist, the loopback is the network; it tells the player nothing the
 * real transport would not.
 */
import { MediaFlag, PacketType, type StreamConfig } from "../../protocol";
import type { Clock, SessionClock } from "../../runtime";
import type { EncodedFrame } from "../../types";
import { browserBackends, type AudioBackend, type Backends, type DecodedVideo, type VideoBackend } from "../backends";
import { createPlayerWith, type PlayerImpl } from "../player";
import { AUDIO_STREAM_ID, OPUS_DELAY_US, VIDEO_STREAM_ID, audioStreamConfig, createProgramSource, videoStreamConfig } from "../source";
import { DependencyTracker } from "../layers";
import { createLoopback, type Loopback } from "../testing/loopback";
import { createLocalSessionClock, createWorkerClock } from "../testing/realClock";
import type { ProgramEncoding } from "../types";
import { probeDecoders } from "../probe";
import { encodingFor, lagMonitor, program, quantile, round, sleep } from "./common";

const stats = (values: number[]) => ({ n: values.length, p50: round(quantile(values, 0.5)), p95: round(quantile(values, 0.95)), min: round(quantile(values, 0)), max: round(quantile(values, 1)) });

/** The real backends, keeping hold of the audio one so that a scenario can ask it when a sample was heard. */
function recordingBackends(): Backends & { audio_: AudioBackend[] } {
  const audio_: AudioBackend[] = [];
  return {
    audio_,
    video: browserBackends.video,
    async audio(events, frameUs) {
      const backend = await browserBackends.audio(events, frameUs);
      audio_.push(backend);
      return backend;
    },
  };
}

type Rendered = { frameId: number; captureUs: number; renderedUs: number };

/** A player wired up the way the composition root will: events counted, errors kept. */
function watch(player: PlayerImpl) {
  const rendered: Rendered[] = [];
  const errors: string[] = [];
  const freezes: { at: number; ms: number }[] = [];
  player.on("rendered", (_stream, frameId, captureUs, renderedUs) => rendered.push({ frameId, captureUs, renderedUs }));
  player.on("error", (error) => errors.push(error.message));
  player.on("freeze", (_stream, ms) => freezes.push({ at: Date.now(), ms: round(ms) as number }));
  return { rendered, errors, freezes };
}

/** Counts the frames a `<video>` element really presents. */
function presented(element: HTMLVideoElement) {
  let frames = 0;
  let on = true;
  const each = () => {
    frames++;
    if (on) element.requestVideoFrameCallback(each);
  };
  element.requestVideoFrameCallback(each);
  return { stop: () => ((on = false), { frames, width: element.videoWidth, height: element.videoHeight }) };
}

async function setupSource(encoding: ProgramEncoding, clock: Clock, sessionClock: SessionClock, input: "camera" | "composed", audio = true) {
  const source = createProgramSource({ encoding, sessionClock, clock });
  const errors: string[] = [];
  source.on("error", (error) => errors.push(error.message));
  if (input === "camera") {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { exact: encoding.video.width }, height: { exact: encoding.video.height }, frameRate: encoding.video.fps },
      audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    });
    return { source, errors, input: { video: stream.getVideoTracks()[0]!, audio: stream.getAudioTracks()[0] }, stop: () => stream.getTracks().forEach((track) => track.stop()) };
  }
  const composed = await program(encoding, clock, { audio });
  return { source, errors, input: composed.input, stop: composed.stop };
}

/* ------------------------------------------------------------------------------------------ */
/* M3: video, through a decoder, onto a track                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Source and player in one page, frames handed across through the loopback. Glass-to-glass at
 * D = 60; decode errors with layer-2 and layer-1 frames removed at random; a `<video>` element
 * showing the track.
 */
export async function m3(options: { seconds?: number; width?: number; height?: number; bitrateKbps?: number; playoutMinMs?: number; dropLayer?: number[]; delayMs?: number; jitterMs?: number; loss?: number; input?: "camera" | "composed"; audio?: boolean } = {}) {
  const seconds = options.seconds ?? 20;
  const encoding = encodingFor(options);
  const clock = createWorkerClock();
  const sessionClock = createLocalSessionClock(clock, 5_000_000);
  const withAudio = options.audio ?? false;
  const { source, errors: sourceErrors, input, stop } = await setupSource(encoding, clock, sessionClock, options.input ?? "composed", withAudio);
  const backends = recordingBackends();
  const player = createPlayerWith({ sessionClock, clock, playoutMinMs: options.playoutMinMs ?? 60, playoutMaxMs: 400 }, backends);
  const seen = watch(player);
  const loopback = createLoopback({ clock, delayMs: options.delayMs ?? 0, jitterMs: options.jitterMs ?? 0, loss: options.loss ?? 0, dropLayer: options.dropLayer ?? [0, 0.05, 0.1], seed: 3, deliver: (frame) => player.push(frame) });
  await player.configure(withAudio ? source.streams() : source.streams().filter((config) => config.kind === "video"));
  source.on("config", (config) => void player.configure([config]));
  source.on("frame", (frame) => loopback.send(frame));
  const lag = lagMonitor(clock);

  const element = document.getElementById("out") as HTMLVideoElement;
  let counter: ReturnType<typeof presented> | null = null;
  player.on("firstFrame", () => {
    const track = player.videoTrack();
    if (!track) return;
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => undefined);
    counter = presented(element);
  });

  await source.start(withAudio ? input : { video: input.video });
  await sleep(2000);
  const from = seen.rendered.length;
  const startedAt = clock.now();
  await sleep(seconds * 1000);
  const elapsed = (clock.now() - startedAt) / 1000;
  const shown = (counter as ReturnType<typeof presented> | null)?.stop() ?? null;
  const measured = seen.rendered.slice(from);
  const playerStats = player.stats();
  const debug = player.debug();
  const sourceStats = source.stats();
  await source.stop();
  stop();
  await player.close();
  element.srcObject = null;
  const eventLoopLagMs = lag.stop();
  clock.close();
  return {
    seconds: round(elapsed),
    decoders: await probeDecoders(),
    audio: withAudio,
    audioCounters: debug.audio,
    width: encoding.video.width,
    playoutMinMs: options.playoutMinMs ?? 60,
    glassToGlassMs: stats(measured.map((r) => (r.renderedUs - r.captureUs) / 1000)),
    renderedFps: round(measured.length / elapsed),
    encodedFps: round(sourceStats.videoFrames / (elapsed + 2)),
    loopback: loopback.stats(),
    player: playerStats,
    pathMs: round(debug.pathMs),
    appliedDelayMs: round(debug.appliedDelayMs),
    layerCap: debug.layerCap,
    aboveCap: debug.aboveCap,
    videoPending: debug.videoPending,
    videoReady: debug.videoReady,
    buffers: debug.buffers,
    playheadMinusNowMs: round((debug.playheadUs - sessionClock.now() * 1000) / 1000),
    capChanges: debug.capChanges,
    decodeErrors: seen.errors.filter((message) => !/audio/.test(message)),
    errors: [...seen.errors, ...sourceErrors],
    freezes: seen.freezes.map((freeze) => freeze.ms),
    element: shown,
    elementFps: shown ? round(shown.frames / elapsed) : null,
    skippedBusy: sourceStats.skippedBusy,
    eventLoopLagMs,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* M4: the clap test                                                                           */
/* ------------------------------------------------------------------------------------------ */

const CLAP_W = 640;
const CLAP_H = 360;

/**
 * A program made in advance so that a flash and a click have the same `captureUs` by
 * construction: video at 30 fps whose frame on each whole second is white, and a quiet tone at
 * 48 kHz with a loud click starting on each whole second. Encoded with WebCodecs, as the source
 * would; the capture times are the source's to give, so here they are given exactly.
 */
async function clapProgram(seconds: number): Promise<{ video: EncodedFrame[]; audio: EncodedFrame[]; videoConfig: StreamConfig; audioConfig: StreamConfig; opusDelaySamples: number | null }> {
  const encoding: ProgramEncoding = { ...encodingFor({ width: CLAP_W, height: CLAP_H, bitrateKbps: 600 }) };
  const video: EncodedFrame[] = [];
  const tracker = new DependencyTracker(3);
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const key = chunk.type === "key";
      const frameId = video.length;
      const place = tracker.next(frameId, key, (metadata as { svc?: { temporalLayerId?: number } } | undefined)?.svc?.temporalLayerId ?? 0);
      video.push({ header: { type: PacketType.Media, flags: (key ? MediaFlag.Key : 0) | (place.discardable ? MediaFlag.Discardable : 0), streamId: VIDEO_STREAM_ID, stripe: 0, spatial: 0, temporal: place.temporal, refDelta: place.refDelta, keyDelta: place.keyDelta, frameId, captureUs: chunk.timestamp, configId: 0 }, data });
    },
    error: (error) => {
      throw error;
    },
  });
  encoder.configure({ codec: "vp8", width: CLAP_W, height: CLAP_H, bitrate: 600_000, framerate: 30, latencyMode: "realtime", scalabilityMode: "L1T3" });
  const canvas = new OffscreenCanvas(CLAP_W, CLAP_H);
  const context = canvas.getContext("2d")!;
  for (let n = 0; n < seconds * 30; n++) {
    const flash = n % 30 === 0;
    context.fillStyle = flash ? "#fff" : "#333";
    context.fillRect(0, 0, CLAP_W, CLAP_H);
    if (!flash) {
      context.fillStyle = "#6a8";
      context.fillRect((n * 12) % CLAP_W, 120, 80, 120);
    }
    const frame = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / 30) });
    encoder.encode(frame, { keyFrame: n % 60 === 0 });
    frame.close();
    if (n % 10 === 9) await encoder.flush();
  }
  await encoder.flush();
  encoder.close();

  const audio: EncodedFrame[] = [];
  const audioEncoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const frameId = audio.length;
      // The source stamps an Opus frame with the time of the sound it decodes to: its first input sample less the codec's look-ahead. So does this.
      audio.push({ header: { type: PacketType.Media, flags: MediaFlag.Key, streamId: AUDIO_STREAM_ID, stripe: 0, spatial: 0, temporal: 0, refDelta: 0, keyDelta: 0, frameId, captureUs: frameId * 20_000 - OPUS_DELAY_US, configId: 0 }, data });
    },
    error: (error) => {
      throw error;
    },
  });
  audioEncoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 32_000, opus: { frameDuration: 20_000 } } as AudioEncoderConfig);
  const all = new Float32Array(seconds * 48000);
  for (let i = 0; i < all.length; i++) {
    const intoSecond = i % 48000;
    all[i] = 0.1 * Math.sin((2 * Math.PI * 300 * i) / 48000) + (intoSecond < 96 ? 0.8 * Math.sin((2 * Math.PI * 1500 * intoSecond) / 48000) : 0);
  }
  for (let at = 0; at < all.length; at += 960) {
    const block = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: Math.round((at * 1e6) / 48000), data: all.slice(at, at + 960) });
    audioEncoder.encode(block);
    block.close();
  }
  await audioEncoder.flush();
  audioEncoder.close();

  // How late an Opus round trip puts the sound: encode and decode the same thing and find the first click.
  let opusDelaySamples: number | null = null;
  {
    const decoded: Float32Array[] = [];
    const decoder = new AudioDecoder({
      output: (data) => {
        const pcm = new Float32Array(data.numberOfFrames);
        data.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
        decoded.push(pcm);
        data.close();
      },
      error: () => undefined,
    });
    decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
    for (const frame of audio.slice(0, 60)) decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: frame.header.captureUs, data: frame.data }));
    await decoder.flush();
    decoder.close();
    let index = 0;
    for (const pcm of decoded) {
      for (let i = 0; i < pcm.length; i++, index++) {
        if (index > 24000 && Math.abs(pcm[i] as number) > 0.4) {
          opusDelaySamples = index - 48000;
          break;
        }
      }
      if (opusDelaySamples !== null) break;
    }
  }
  return { video, audio, videoConfig: { ...videoStreamConfig(encoding, 0, 600), width: CLAP_W, height: CLAP_H }, audioConfig: audioStreamConfig(encoding, 0), opusDelaySamples };
}

type OutputStamp = { contextTime: number; performanceTime: number };

/**
 * When each click was heard: the first loud sample of each burst in what the worklet played,
 * placed in time by the audio context's output timestamp nearest to it. Also the runs of exact
 * silence in what was played.
 */
function heardClicks(taps: { frame: number; pcm: Float32Array }[], stamps: OutputStamp[], sessionClock: SessionClock) {
  const heardUs: number[] = [];
  let quietUntil = -Infinity;
  const pcmRuns: number[] = [];
  let zeroRun = 0;
  for (const tap of taps) {
    for (let i = 0; i < tap.pcm.length; i++) {
      const sample = tap.pcm[i] as number;
      const frame = tap.frame + i;
      if (Math.abs(sample) < 1e-6) zeroRun++;
      else {
        if (zeroRun > 0) pcmRuns.push(zeroRun);
        zeroRun = 0;
      }
      if (Math.abs(sample) > 0.4 && frame > quietUntil) {
        quietUntil = frame + 24000;
        const contextS = frame / 48000;
        const stamp = stamps.reduce<OutputStamp | null>((best, s) => (Math.abs(s.contextTime - contextS) < Math.abs((best?.contextTime ?? Infinity) - contextS) ? s : best), null);
        if (!stamp) continue;
        const localMs = stamp.performanceTime + (contextS - stamp.contextTime) * 1000;
        heardUs.push(Math.round(sessionClock.fromLocal(localMs) * 1000));
      }
    }
  }
  return { heardUs, pcmRuns };
}

/**
 * The clap test (PLAN M4): flash and click at the same `captureUs`, played through the real
 * player; when the flash was rendered (the `rendered` event) against when the click was heard
 * (the worklet's output, placed in time by the audio context's own output timestamp). Each audio
 * frame is sent twice (§9.4); some frames lose both copies, to be concealed.
 */
export async function clap(options: { seconds?: number; delayMs?: number; jitterMs?: number; playoutMinMs?: number; lostAudioEvery?: number } = {}) {
  const seconds = options.seconds ?? 12;
  const made = await clapProgram(seconds + 1);
  const clock = createWorkerClock();
  const sessionClock = createLocalSessionClock(clock, 5_000_000);
  const backends = recordingBackends();
  const player = createPlayerWith({ sessionClock, clock, playoutMinMs: options.playoutMinMs ?? 60, playoutMaxMs: 400 }, backends);
  const seen = watch(player);
  const loopback: Loopback = createLoopback({ clock, delayMs: options.delayMs ?? 10, jitterMs: options.jitterMs ?? 0, seed: 5, deliver: (frame) => player.push(frame) });
  await player.configure([made.videoConfig, made.audioConfig]);
  const audioBackend = backends.audio_[0];
  const taps: { frame: number; pcm: Float32Array }[] = [];
  player.onTap = (frame, pcm) => taps.push({ frame, pcm });
  player.tap(true);
  const stamps: { contextTime: number; performanceTime: number }[] = [];

  // Send in real time: each frame 10 ms after its capture (an encoder's time), audio twice.
  const baseUs = Math.round(sessionClock.now() * 1000) + 200_000;
  const lostEvery = options.lostAudioEvery ?? 0;
  type Send = { atMs: number; frame: EncodedFrame };
  const sends: Send[] = [];
  const shift = (frame: EncodedFrame): EncodedFrame => ({ header: { ...frame.header, captureUs: frame.header.captureUs + baseUs }, data: frame.data });
  for (const frame of made.video) sends.push({ atMs: (frame.header.captureUs + baseUs) / 1000 + 10, frame: shift(frame) });
  let lostAudio = 0;
  for (const frame of made.audio) {
    const at = (frame.header.captureUs + baseUs) / 1000 + 25;
    if (lostEvery > 0 && frame.header.frameId % lostEvery === lostEvery - 1) {
      lostAudio++;
      continue;
    }
    sends.push({ atMs: at, frame: shift(frame) });
    sends.push({ atMs: at + 20, frame: shift(frame) });
  }
  sends.sort((a, b) => a.atMs - b.atMs);
  let next = 0;
  const cancel = clock.setInterval(() => {
    const now = sessionClock.now();
    while (next < sends.length && (sends[next] as Send).atMs <= now) loopback.send((sends[next++] as Send).frame);
    const stamp = audioBackend?.outputTimestamp?.();
    if (stamp && stamp.contextTime > 0) stamps.push(stamp);
  }, 2);
  const lag = lagMonitor(clock);
  // The sound's counters every half second: when anything was concealed.
  const timeline: string[] = [];
  const sample = clock.setInterval(() => {
    const debug = player.debug();
    const audio = debug.audio;
    if (audio) timeline.push(`${Math.round(sessionClock.now() - baseUs / 1000)}:${audio.concealedMs}/${audio.late}/${audio.resyncs}/${round(debug.appliedDelayMs)}/${round(debug.pathMs)}`);
  }, 500);
  await sleep(seconds * 1000 + 400);
  sample();
  cancel();
  const debug = player.debug();
  const playerStats = player.stats();
  player.tap(false);
  await sleep(150);
  await player.close();
  const eventLoopLagMs = lag.stop();
  clock.close();

  const { heardUs, pcmRuns } = heardClicks(taps, stamps, sessionClock);
  // The flashes, by capture time: every whole second after the start.
  const flashes = seen.rendered.filter((r) => (r.captureUs - baseUs) % 1_000_000 === 0);
  const pairs = flashes.map((flash) => {
    const heard = heardUs.find((us) => Math.abs(us - flash.renderedUs) < 400_000) ?? null;
    return { second: (flash.captureUs - baseUs) / 1e6, renderedMs: round((flash.renderedUs - flash.captureUs) / 1000), heardMs: heard === null ? null : round((heard - flash.captureUs) / 1000), clickMinusFlashMs: heard === null ? null : round((heard - flash.renderedUs) / 1000) };
  });
  const shortSilences = pcmRuns.filter((run) => run >= 48 && run < 1920);
  return {
    seconds,
    pairs,
    skewMs: stats(pairs.filter((p) => p.clickMinusFlashMs !== null).map((p) => p.clickMinusFlashMs as number)),
    flashes: flashes.length,
    clicks: heardUs.length,
    opusDelayMs: made.opusDelaySamples === null ? null : round(made.opusDelaySamples / 48),
    lostAudioFrames: lostAudio,
    audio: debug.audio,
    concealedMs: playerStats.audio?.concealedMs ?? null,
    playedMs: playerStats.audio?.playedMs ?? null,
    avOffsetMs: playerStats.audio?.avOffsetMs ?? null,
    rawSilencesUnder40Ms: shortSilences.length,
    outputLatencyMs: round(((audioBackend?.outputLatency() ?? 0) * 1000) as number),
    stamps: stamps.length,
    timeline: timeline.join(" "),
    errors: seen.errors,
    eventLoopLagMs,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* M5: light viewers, and catching up after a repair                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * One source, two viewers of the same frames through the same loopback: one decoding, one light
 * (`decode: false`). Their latency must agree. Then the parent "dies": nothing for `holdMs`, after
 * which a backup replays what was missed at once and live resumes. Both must be back at their
 * normal latency within 300 ms of the death.
 */
export async function m5(options: { seconds?: number; width?: number; height?: number; delayMs?: number; jitterMs?: number; loss?: number; holdMs?: number; input?: "camera" | "composed" } = {}) {
  const seconds = options.seconds ?? 12;
  const holdMs = options.holdMs ?? 200;
  const encoding = encodingFor(options);
  const clock = createWorkerClock();
  const sessionClock = createLocalSessionClock(clock, 5_000_000);
  const { source, errors: sourceErrors, input, stop } = await setupSource(encoding, clock, sessionClock, options.input ?? "composed");
  const full = createPlayerWith({ sessionClock, clock, playoutMinMs: 60, playoutMaxMs: 400 }, recordingBackends());
  const light = createPlayerWith({ sessionClock, clock, playoutMinMs: 60, playoutMaxMs: 400, decode: false }, browserBackends);
  const fullSeen = watch(full);
  const lightSeen = watch(light);
  const loopback = createLoopback({
    clock,
    delayMs: options.delayMs ?? 20,
    jitterMs: options.jitterMs ?? 4,
    loss: options.loss ?? 0,
    seed: 9,
    deliver: (frame) => {
      full.push(frame);
      light.push(frame);
    },
  });
  const streams = source.streams();
  await full.configure(streams);
  await light.configure(streams);
  for (const player of [full, light]) player.setLinkHints({ jitterMs: (options.jitterMs ?? 4) / 2, rttMs: 2 * (options.delayMs ?? 20), lossPct: (options.loss ?? 0) * 100 });
  source.on("frame", (frame) => loopback.send(frame));
  const lag = lagMonitor(clock);
  await source.start(input);
  await sleep(seconds * 500);
  const killUs = Math.round(sessionClock.now() * 1000);
  loopback.hold(true);
  await sleep(holdMs);
  loopback.hold(false);
  await sleep(seconds * 500);
  const fullDebug = full.debug();
  const lightDebug = light.debug();
  await source.stop();
  stop();
  await full.close();
  await light.close();
  const eventLoopLagMs = lag.stop();
  clock.close();

  const latency = (rendered: Rendered[]) => rendered.map((r) => ({ at: r.renderedUs, captureUs: r.captureUs, ms: (r.renderedUs - r.captureUs) / 1000 }));
  const summarize = (rendered: Rendered[]) => {
    const all = latency(rendered);
    const before = all.filter((r) => r.at > killUs - 4_000_000 && r.at < killUs).map((r) => r.ms);
    const normal = quantile(before, 0.5) ?? 0;
    // What was captured after the death came by the replay and the new parent.
    const after = all.filter((r) => r.captureUs >= killUs);
    // The longest gap between two rendered frames around the death.
    let freezeMs = 0;
    for (let i = 1; i < all.length; i++) {
      const gap = ((all[i] as { at: number }).at - (all[i - 1] as { at: number }).at) / 1000;
      if ((all[i] as { at: number }).at >= killUs && (all[i - 1] as { at: number }).at <= killUs + 1_000_000) freezeMs = Math.max(freezeMs, gap);
    }
    // Back to normal: from the death to the first frame captured after it from which on every frame is within 20 ms of the normal latency.
    let lastAbnormal = -1;
    after.forEach((r, index) => {
      if (r.ms > normal + 20) lastAbnormal = index;
    });
    const firstNormal = after[lastAbnormal + 1];
    return {
      p50Ms: round(normal),
      steady: stats(before),
      freezeMs: round(freezeMs),
      normalAfterKillMs: firstNormal ? round((firstNormal.at - killUs) / 1000) : null,
      lateFramesAfterKill: lastAbnormal + 1,
    };
  };
  return {
    seconds,
    holdMs,
    decoding: summarize(fullSeen.rendered),
    light: summarize(lightSeen.rendered),
    fullDelayMs: { path: round(fullDebug.pathMs), applied: round(fullDebug.appliedDelayMs) },
    lightDelayMs: { path: round(lightDebug.pathMs), applied: round(lightDebug.appliedDelayMs) },
    fullAudio: fullDebug.audio,
    loopback: loopback.stats(),
    errors: [...fullSeen.errors, ...lightSeen.errors, ...sourceErrors],
    eventLoopLagMs,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* A/V sync from end to end: through the real source                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * The clap test through the real source: the composer flashes the picture white once a second
 * and a click is scheduled in its Web Audio mix for the same moment. The source stamps both; the
 * page finds the flash among the source's frames (decoded, by brightness) and the click in its
 * Opus frames (decoded), so the source's own skew is known; then the player plays both. What is
 * measured is the click as heard against the flash as rendered, and how much of that the source
 * put there.
 */
export async function av(options: { seconds?: number; width?: number; height?: number; bitrateKbps?: number; delayMs?: number } = {}) {
  const seconds = options.seconds ?? 10;
  const encoding = encodingFor({ width: 640, height: 360, bitrateKbps: 600, ...options });
  const clock = createWorkerClock();
  const sessionClock = createLocalSessionClock(clock, 5_000_000);
  const fps = encoding.video.fps;
  let audioContext: AudioContext | null = null;
  let input: AudioNode | null = null;
  const click = (at: number) => {
    if (!audioContext || !input) return;
    const buffer = audioContext.createBuffer(1, 96, 48000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < 96; i++) data[i] = 0.8 * Math.sin((2 * Math.PI * 1500 * i) / 48000);
    const node = audioContext.createBufferSource();
    node.buffer = buffer;
    node.connect(input);
    node.start(at);
  };
  const composed = await program(encoding, clock, {
    audio: false,
    overlay: (context, frame) => {
      // Six frames ahead, the click is put in the mix for when the flash will be drawn.
      if (frame % fps === fps - 6 && audioContext) click(audioContext.currentTime + 6 / fps);
      if (frame % fps === 0 && frame > 0) {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, encoding.video.width, encoding.video.height);
      }
    },
  });
  audioContext = composed.composer.audioContext;
  input = composed.composer.audioInput;
  // A quiet tone under it all, so that the sound never stops.
  const tone = audioContext.createOscillator();
  const toneGain = audioContext.createGain();
  tone.frequency.value = 300;
  toneGain.gain.value = 0.05;
  tone.connect(toneGain).connect(input);
  tone.start();

  const source = createProgramSource({ encoding, sessionClock, clock });
  const backends = recordingBackends();
  const player = createPlayerWith({ sessionClock, clock, playoutMinMs: 60, playoutMaxMs: 400 }, backends);
  const seen = watch(player);
  const loopback = createLoopback({ clock, delayMs: options.delayMs ?? 10, seed: 11, deliver: (frame) => player.push(frame) });
  await player.configure(source.streams());
  const audioBackend = backends.audio_[0];
  const taps: { frame: number; pcm: Float32Array }[] = [];
  player.onTap = (frame, pcm) => taps.push({ frame, pcm });
  player.tap(true);
  const stamps: OutputStamp[] = [];

  // At the source: which frames are the flash, and where in the sound the clicks are.
  const flashCaptureUs: number[] = [];
  const videoDecoder = new VideoDecoder({
    output: (frame) => {
      // A corner of the textured band at the top: never white but in the flash.
      const rect = { x: 16, y: 16, width: 16, height: 16 };
      const size = frame.allocationSize({ rect });
      const bytes = new Uint8Array(size);
      const captureUs = frame.timestamp;
      void frame
        .copyTo(bytes, { rect })
        .then(() => {
          let sum = 0;
          for (let i = 0; i < 256; i++) sum += bytes[i] as number;
          if (sum / 256 > 200) flashCaptureUs.push(captureUs);
        })
        .finally(() => frame.close());
    },
    error: () => undefined,
  });
  videoDecoder.configure({ codec: encoding.video.codec });
  const clickCaptureUs: number[] = [];
  const inAudioDecoder: number[] = [];
  let lastClick = -Infinity;
  const audioDecoder = new AudioDecoder({
    output: (data) => {
      const captureUs = inAudioDecoder.shift() ?? 0;
      const pcm = new Float32Array(data.numberOfFrames);
      data.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
      data.close();
      for (let i = 0; i < pcm.length; i++) {
        const us = captureUs + Math.round((i * 1e6) / 48000);
        if (Math.abs(pcm[i] as number) > 0.4 && us > lastClick + 500_000) {
          lastClick = us;
          clickCaptureUs.push(us);
        }
      }
    },
    error: () => undefined,
  });
  audioDecoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
  let lastAudioId = -1;
  source.on("config", (config) => void player.configure([config]));
  source.on("frame", (frame) => {
    loopback.send(frame);
    const { header } = frame;
    if (header.streamId === VIDEO_STREAM_ID) {
      videoDecoder.decode(new EncodedVideoChunk({ type: (header.flags & MediaFlag.Key) !== 0 ? "key" : "delta", timestamp: header.captureUs, data: frame.data }));
    } else if (header.frameId > lastAudioId) {
      lastAudioId = header.frameId;
      inAudioDecoder.push(header.captureUs);
      audioDecoder.decode(new EncodedAudioChunk({ type: "key", timestamp: header.captureUs, data: frame.data }));
    }
  });
  const sampleStamps = clock.setInterval(() => {
    const stamp = audioBackend?.outputTimestamp?.();
    if (stamp && stamp.contextTime > 0) stamps.push(stamp);
  }, 5);
  const lag = lagMonitor(clock);
  await source.start(composed.input);
  await sleep(seconds * 1000);
  sampleStamps();
  const debug = player.debug();
  player.tap(false);
  await sleep(150);
  await source.stop();
  composed.stop();
  tone.stop();
  await player.close();
  await videoDecoder.flush().catch(() => undefined);
  videoDecoder.close();
  await audioDecoder.flush().catch(() => undefined);
  audioDecoder.close();
  const eventLoopLagMs = lag.stop();
  clock.close();

  const { heardUs } = heardClicks(taps, stamps, sessionClock);
  const flashes = new Set(flashCaptureUs);
  const pairs = seen.rendered
    .filter((r) => flashes.has(r.captureUs))
    .map((flash) => {
      const atSource = clickCaptureUs.find((us) => Math.abs(us - flash.captureUs) < 400_000) ?? null;
      const heard = heardUs.find((us) => Math.abs(us - flash.renderedUs) < 400_000) ?? null;
      return {
        sourceSkewMs: atSource === null ? null : round((atSource - flash.captureUs) / 1000),
        clickMinusFlashMs: heard === null ? null : round((heard - flash.renderedUs) / 1000),
      };
    });
  const complete = pairs.filter((p) => p.sourceSkewMs !== null && p.clickMinusFlashMs !== null);
  return {
    seconds,
    flashesAtSource: flashCaptureUs.length,
    rendered: seen.rendered.length,
    freezes: seen.freezes.map((f) => f.ms),
    videoStats: player.stats().video,
    layerCap: debug.layerCap,
    capChanges: debug.capChanges,
    aboveCap: debug.aboveCap,
    videoPending: debug.videoPending,
    videoReady: debug.videoReady,
    buffers: debug.buffers,
    playheadMinusNowMs: round((debug.playheadUs - sessionClock.now() * 1000) / 1000),
    nearestRendered: flashCaptureUs.map((us) => Math.min(...seen.rendered.map((r) => Math.abs(r.captureUs - us)))),
    flashIds: flashCaptureUs.map((us) => seen.rendered.find((r) => Math.abs(r.captureUs - us) < 40_000)?.frameId ?? null),
    clicksAtSource: clickCaptureUs.length,
    clicksHeard: heardUs.length,
    pairs,
    sourceSkewMs: stats(complete.map((p) => p.sourceSkewMs as number)),
    endToEndMs: stats(complete.map((p) => p.clickMinusFlashMs as number)),
    playerMs: stats(complete.map((p) => (p.clickMinusFlashMs as number) - (p.sourceSkewMs as number))),
    audio: debug.audio,
    appliedDelayMs: round(debug.appliedDelayMs),
    errors: seen.errors,
    eventLoopLagMs,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* M6: a decoder that cannot keep up                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * The real decoder, made slow: what it decodes is let out no faster than one frame every
 * `slowMs`, as a decoder that takes that long a frame would let it out. (A browser offers no way
 * to slow its own decoder; this is the same to the player, which only sees frames go in and
 * come out.)
 */
function slowedBackends(control: { slowMs: number }): Backends {
  return {
    audio: browserBackends.audio,
    video(events) {
      /** When each frame went in, in order; and decoded frames waiting for the time a slow decoder would have let them out. */
      const inAt: number[] = [];
      const held: { frame: DecodedVideo; at: number }[] = [];
      let lastOutAt = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const release = () => {
        timer = null;
        const now = performance.now();
        while (held.length > 0 && now >= (held[0] as { at: number }).at) events.frame((held.shift() as { frame: DecodedVideo }).frame);
        if (held.length > 0) timer = setTimeout(release, Math.max(0, (held[0] as { at: number }).at - now));
      };
      const real: VideoBackend = browserBackends.video({
        frame: (frame) => {
          const wentIn = inAt.shift() ?? performance.now();
          // A decoder that takes slowMs a frame, one frame at a time.
          const at = control.slowMs > 0 ? Math.max(wentIn, lastOutAt) + control.slowMs : performance.now();
          lastOutAt = at;
          held.push({ frame, at });
          if (!timer) release();
        },
        error: events.error,
      });
      return {
        configure: (config) => real.configure(config),
        decode: (frame) => {
          inAt.push(performance.now());
          real.decode(frame);
        },
        queueSize: () => real.queueSize() + held.length,
        reset: () => {
          inAt.length = 0;
          for (const { frame } of held.splice(0)) frame.close();
          real.reset();
        },
        show: (frame) => real.show(frame),
        track: () => real.track(),
        close: () => {
          if (timer) clearTimeout(timer);
          for (const { frame } of held.splice(0)) frame.close();
          real.close();
        },
      };
    },
  };
}

/**
 * PLAN M6: "a viewer whose decode time exceeds the frame interval asks for a lower layer within
 * 2 s and recovers". The decoder takes `slowMs` a frame (more than 33 ms at 30 fps) from
 * `slowFromS` to `slowToS`; the parent, the loopback here, honours what the player asks for
 * (`wantedLayers`) by not sending the layers above it.
 */
export async function m6(options: { seconds?: number; slowMs?: number; slowFromS?: number; slowToS?: number; width?: number; height?: number; bitrateKbps?: number } = {}) {
  const seconds = options.seconds ?? 30;
  const slowFromS = options.slowFromS ?? 4;
  const slowToS = options.slowToS ?? 12;
  const encoding = encodingFor({ width: 640, height: 360, bitrateKbps: 600, ...options });
  const clock = createWorkerClock();
  const sessionClock = createLocalSessionClock(clock, 5_000_000);
  const { source, errors: sourceErrors, input, stop } = await setupSource(encoding, clock, sessionClock, "camera", false);
  const control = { slowMs: 0 };
  const player = createPlayerWith({ sessionClock, clock, playoutMinMs: 60, playoutMaxMs: 400 }, slowedBackends(control));
  const seen = watch(player);
  const loopback = createLoopback({ clock, delayMs: 10, seed: 13, deliver: (frame) => player.push(frame) });
  await player.configure(source.streams().filter((config) => config.kind === "video"));
  source.on("frame", (frame) => loopback.send(frame));
  const caps: { atS: number; cap: number }[] = [];
  let startedAt = 0;
  const follow = clock.setInterval(() => {
    // The parent hears what the viewer wants with its next feedback (§4.5, every 100 ms).
    const cap = player.wantedLayers(VIDEO_STREAM_ID).maxTemporal;
    loopback.set({ dropLayer: [0, cap < 1 ? 1 : 0, cap < 2 ? 1 : 0] });
    const atS = (clock.now() - startedAt) / 1000;
    if (caps.length === 0 || (caps[caps.length - 1] as { cap: number }).cap !== cap) caps.push({ atS: round(atS, 2) as number, cap });
    control.slowMs = atS >= slowFromS && atS < slowToS ? (options.slowMs ?? 45) : 0;
  }, 100);
  startedAt = clock.now();
  await source.start({ video: input.video });
  await sleep(seconds * 1000);
  follow();
  const fps = (fromS: number, toS: number) => round(seen.rendered.filter((r) => r.renderedUs / 1000 - sessionClock.fromLocal(startedAt) >= fromS * 1000 && r.renderedUs / 1000 - sessionClock.fromLocal(startedAt) < toS * 1000).length / (toS - fromS));
  const stats = player.stats();
  await source.stop();
  stop();
  await player.close();
  clock.close();
  const down = caps.find((c) => c.atS >= slowFromS && c.cap < 2) ?? null;
  const backUp = caps.find((c) => c.atS >= slowToS && c.cap === 2) ?? null;
  return {
    seconds,
    slowMs: options.slowMs ?? 45,
    slowFromS,
    slowToS,
    caps,
    downAfterMs: down ? round((down.atS - slowFromS) * 1000) : null,
    lowestCap: Math.min(...caps.map((c) => c.cap)),
    backUpAfterMs: backUp ? round((backUp.atS - slowToS) * 1000) : null,
    fpsBefore: fps(1, slowFromS),
    fpsSlow: fps(slowFromS + 2.5, slowToS),
    fpsAfter: fps(Math.min(seconds - 1, slowToS + 8), seconds),
    decodeMsP95: stats.video?.decodeMsP95 ?? null,
    freezes: seen.freezes.map((f) => f.ms),
    errors: [...seen.errors, ...sourceErrors],
  };
}
