/**
 * Media through the integrated engine (overlay-integration's composition root): a real source
 * (createOverlaySource) and real viewers (createOverlayViewer) over the real transport, with
 * NACK, impaired by the harness's shim when the driver bundles it in (./engine-run.ts does, on
 * overlay-integration: this branch has neither the engine nor the shim, and builds this page
 * only to type-check it).
 *
 * Two programs: "av", the clap test (the composer's flash and a Web Audio click), and "busy" or
 * "noise" (./rate.ts's pictures), to see what the stream comes to at a viewer. The viewer's
 * player is reached by hooks on PlayerImpl's prototype, for measuring only: which frames it
 * showed were the flash, by their pixels; when the click was heard, from the worklet's output;
 * and every video byte it was given.
 */
import { createOverlaySource, createOverlayViewer, type MetricsSample } from "../../index";
import type { Clock } from "../../runtime";
import type { ReceivedFrame } from "../../types";
import type { AudioBackend, DecodedVideo } from "../backends";
import { PlayerImpl } from "../player";
import { createWorkerClock } from "../testing/realClock";
import { encodingFor, program, round, quantile } from "./common";
import { picture } from "./rate";

/** The harness's impairment shim, when the driver bundled it in. */
type Impair = {
  createImpairment: (pick: () => unknown, seed: number, options: { clock: Clock; self: string; counters: unknown }) => unknown;
  emptyImpairmentCounters: () => unknown;
  PROFILES: Record<string, unknown>;
};
/** Read when a peer starts, not when this module loads: the driver's entry sets it after its imports have run. */
const impairShim = (): Impair | null => (globalThis as unknown as { __impair?: Impair }).__impair ?? null;

type Hooked = PlayerImpl & { __flashes: number[] };
let player: Hooked | null = null;
const originalConfigure = PlayerImpl.prototype.configure;
/** The engine's player: the first one configured in this page. */
function hookPlayer(instance: Hooked): void {
  if (player) return;
  instance.__flashes = [];
  player = instance;
}
PlayerImpl.prototype.configure = function (this: Hooked, streams) {
  hookPlayer(this);
  return originalConfigure.call(this, streams);
};
const proto = PlayerImpl.prototype as unknown as { show: (video: unknown, decoded: DecodedVideo, ...rest: unknown[]) => void };
const originalShow = proto.show;
/** Every video frame the player was given once, with when: what the stream came to here. */
const videoIn: { at: number; bytes: number }[] = [];
const seenVideo = new Set<number>();
const originalPush = PlayerImpl.prototype.push;
PlayerImpl.prototype.push = function (this: Hooked, frame: ReceivedFrame) {
  if (frame.header.streamId === 0 && !seenVideo.has(frame.header.frameId)) {
    seenVideo.add(frame.header.frameId);
    videoIn.push({ at: performance.now(), bytes: frame.data.byteLength });
  }
  return originalPush.call(this, frame);
};
proto.show = function (this: Hooked, video, decoded, ...rest) {
  const raw = decoded.raw as VideoFrame | null;
  if (raw) {
    const copy = raw.clone();
    const rect = { x: 16, y: 16, width: 16, height: 16 };
    const bytes = new Uint8Array(copy.allocationSize({ rect }));
    const captureUs = decoded.captureUs;
    void copy
      .copyTo(bytes, { rect })
      .then(() => {
        let sum = 0;
        for (let i = 0; i < 256; i++) sum += bytes[i] as number;
        if (sum / 256 > 200) this.__flashes.push(captureUs);
      })
      .finally(() => copy.close());
  }
  return originalShow.call(this, video, decoded, ...rest);
};

const clock = createWorkerClock();
type Start = { coordinatorUrl: string; room: string; ticket: string; profile: string; seed: number; index: number; program?: "av" | "busy" | "noise"; width?: number; height?: number; bitrateKbps?: number };

function connectOptions(o: Start) {
  let first: string | null = o.ticket;
  const ticket = async () => {
    const t = first;
    first = null;
    if (t) return t;
    return (window as unknown as { __overlayTicket: () => Promise<string> }).__overlayTicket();
  };
  const base = o.coordinatorUrl.replace(/^http/, "ws").replace(/\/$/, "");
  const impair = impairShim();
  const profile = impair?.PROFILES[o.profile] ?? null;
  if (o.profile !== "clean" && !profile) throw new Error(`no impairment "${o.profile}": the shim was not bundled in`);
  const wrapChannel = impair && profile ? impair.createImpairment(() => profile, o.seed, { clock, self: String(o.index), counters: impair.emptyImpairmentCounters() }) : undefined;
  return { coordinatorUrl: `${base}/overlay/v1/rooms/${encodeURIComponent(o.room)}/ws`, ticket, ...(wrapChannel ? { wrapChannel } : {}) } as Parameters<typeof createOverlaySource>[0];
}

const samples: MetricsSample[] = [];
let me: { status(): unknown } | null = null;
const errors: string[] = [];

async function source(o: Start) {
  const encoding = encodingFor({ width: o.width ?? 640, height: o.height ?? 360, bitrateKbps: o.bitrateKbps ?? 600 });
  const peer = createOverlaySource({ ...connectOptions(o), encoding } as Parameters<typeof createOverlaySource>[0]);
  peer.on("error", (error) => errors.push(String(error)));
  peer.on("metrics", (sample) => samples.push(sample));
  await peer.connect();
  if (o.program === "busy" || o.program === "noise") {
    // A hard picture, and a quiet tone for the sound.
    const made = picture(o.program, encoding.video.width, encoding.video.height, encoding.video.fps);
    const context = new AudioContext({ sampleRate: 48000 });
    const tone = context.createOscillator();
    const gain = context.createGain();
    const out = context.createMediaStreamDestination();
    tone.frequency.value = 300;
    gain.gain.value = 0.05;
    tone.connect(gain).connect(out);
    tone.start();
    await peer.publish({ video: made.track, audio: out.stream.getAudioTracks()[0] });
    return { ok: true };
  }
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
      if (frame % fps === fps - 6 && audioContext) click(audioContext.currentTime + 6 / fps);
      if (frame % fps === 0 && frame > 0) {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, encoding.video.width, encoding.video.height);
      }
    },
  });
  audioContext = composed.composer.audioContext;
  input = composed.composer.audioInput;
  const tone = audioContext.createOscillator();
  const gain = audioContext.createGain();
  tone.frequency.value = 300;
  gain.gain.value = 0.05;
  tone.connect(gain).connect(input);
  tone.start();
  await peer.publish(composed.input);
  return { ok: true };
}

type OutputStamp = { contextTime: number; performanceTime: number };
const taps: { frame: number; pcm: Float32Array }[] = [];
const stamps: OutputStamp[] = [];
const rendered: { captureUs: number; renderedUs: number }[] = [];
const timeline: string[] = [];
let viewerClock: { now(): number; fromLocal(ms: number): number } | null = null;

async function viewer(o: Start) {
  const peer = createOverlayViewer({ ...connectOptions(o), decode: true } as Parameters<typeof createOverlayViewer>[0]);
  peer.on("error", (error) => errors.push(String(error)));
  peer.on("metrics", (sample) => samples.push(sample));
  me = peer;
  let hooked = false;
  peer.on("firstFrame", () => {
    if (hooked || !player) return;
    hooked = true;
    player.on("rendered", (_s, _id, captureUs, renderedUs) => rendered.push({ captureUs, renderedUs }));
    player.onTap = (frame, pcm) => taps.push({ frame, pcm });
    player.tap(true);
    clock.setInterval(() => {
      const d = player?.debug();
      if (d?.audio) timeline.push(`${d.audio.concealedMs}/${d.audio.late}/${d.audio.resyncs}/${Math.round(d.appliedDelayMs)}/${Math.round(d.targetDelayMs)}/${Math.round(d.pathMs ?? -1)}`);
    }, 1000);
    const audioOf = () => (player as unknown as { audio: { backend: AudioBackend | null } | null }).audio?.backend ?? null;
    clock.setInterval(() => {
      const stamp = audioOf()?.outputTimestamp?.();
      if (stamp && stamp.contextTime > 0) stamps.push(stamp);
    }, 5);
  });
  await peer.connect();
  return { ok: true };
}

function heardClicks(): number[] {
  viewerClock = (me as unknown as { sessionClock(): { now(): number; fromLocal(ms: number): number } | null }).sessionClock();
  const heardUs: number[] = [];
  let quietUntil = -Infinity;
  for (const tap of taps) {
    for (let i = 0; i < tap.pcm.length; i++) {
      const frame = tap.frame + i;
      if (Math.abs(tap.pcm[i] as number) > 0.4 && frame > quietUntil) {
        quietUntil = frame + 24000;
        const contextS = frame / 48000;
        const stamp = stamps.reduce<OutputStamp | null>((best, s) => (Math.abs(s.contextTime - contextS) < Math.abs((best?.contextTime ?? Infinity) - contextS) ? s : best), null);
        if (!stamp || !viewerClock) continue;
        heardUs.push(Math.round(viewerClock.fromLocal(stamp.performanceTime + (contextS - stamp.contextTime) * 1000) * 1000));
      }
    }
  }
  return heardUs;
}

const stat = (values: number[]) => ({ n: values.length, min: round(quantile(values, 0)), p50: round(quantile(values, 0.5)), p95: round(quantile(values, 0.95)), max: round(quantile(values, 1)) });

function results(lastS: number) {
  viewerClock = (me as unknown as { sessionClock(): { now(): number; fromLocal(ms: number): number } | null }).sessionClock();
  const fromUs = ((viewerClock?.now() ?? 0) - lastS * 1000) * 1000;
  const heard = heardClicks();
  const flashes = new Set(player?.__flashes ?? []);
  // A flash is a run of white frames only once a second: the first of each.
  const firsts = [...flashes].sort((a, b) => a - b).filter((us, i, all) => i === 0 || us - (all[i - 1] as number) > 500_000);
  const pairs = rendered
    .filter((r) => firsts.includes(r.captureUs) && r.captureUs >= fromUs)
    .map((flash) => {
      const click = heard.find((us) => Math.abs(us - flash.renderedUs) < 400_000) ?? null;
      return click === null ? null : round((click - flash.renderedUs) / 1000);
    });
  const g2g = rendered.filter((r) => r.captureUs >= fromUs).map((r) => (r.renderedUs - r.captureUs) / 1000);
  // The video stream as it came here, over every two-second window of the last part of the run.
  const fromLocal = performance.now() - lastS * 1000;
  const arrived = videoIn.filter((v) => v.at >= fromLocal);
  let worstBytes = 0;
  let windowBytes = 0;
  let start = 0;
  for (let end = 0; end < arrived.length; end++) {
    windowBytes += arrived[end]!.bytes;
    while (arrived[end]!.at - arrived[start]!.at >= 2000) windowBytes -= arrived[start++]!.bytes;
    worstBytes = Math.max(worstBytes, windowBytes);
  }
  const rx = samples.filter((s) => s.up && s.at >= (viewerClock?.now() ?? 0) - lastS * 1000).map((s) => s.up!.rxKbps);
  const debug = player?.debug();
  const sum = (pick: (s: MetricsSample) => number | undefined) => samples.reduce((total, s) => total + (pick(s) ?? 0), 0);
  return {
    flashes: firsts.length,
    clicks: heard.length,
    skewMs: stat(pairs.filter((p): p is number => p !== null)),
    unpaired: pairs.filter((p) => p === null).length,
    glassToGlassMs: stat(g2g),
    rendered: g2g.length,
    videoKbps: { mean: round((arrived.reduce((t, v) => t + v.bytes, 0) * 8) / (lastS * 1000)), worst2s: round((worstBytes * 8) / 2000) },
    rxKbps: stat(rx),
    delay: debug ? { applied: round(debug.appliedDelayMs), path: round(debug.pathMs), D: round(debug.playoutDelayMs) } : null,
    audio: debug?.audio ?? null,
    video: player?.stats().video ?? null,
    nacksSent: sum((s) => s.up?.nacksSent),
    retransmitsReceived: sum((s) => s.up?.retransmitsReceived),
    depth: samples[samples.length - 1]?.depth ?? null,
    role: samples[samples.length - 1]?.role ?? null,
    timeline: timeline.join(" "),
    taps: taps.length,
    stamps: stamps.length,
    maxAbs: round(taps.reduce((m, t) => t.pcm.reduce((a, x) => Math.max(a, Math.abs(x)), m), 0), 3),
    status: me?.status() ?? null,
    errors,
  };
}

(window as unknown as { __av: unknown }).__av = { source, viewer, results };
