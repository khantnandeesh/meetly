/**
 * The player: a viewer's whole receive side (SPEC §10). Frames go into one jitter buffer per
 * stream; what comes out is decoded and shown, or played, at its place on the capture timeline.
 *
 * One clock decides when: the *playhead*, the capture time being presented now. With sound
 * playing it is read from the audio worklet (audio is the master, §10.5); otherwise it is the
 * session clock less the delay in force. Each jitter buffer is asked what is due at the playhead.
 *
 * The delay in force is the *path* plus *D*. The path is how long frames take to get here at
 * best: capture and encode at the source, then every hop (the floor of session time at arrival
 * less `captureUs`, over the last second, for the slower of the two streams). *D* is the jitter
 * buffer's playout delay (§10.2) on top of that. SPEC §10.1 says a frame is due at
 * `captureUs + D`; taken literally, a viewer whose path is longer than *D* (any viewer a few hops
 * down) would find every frame late. §10.2's own account of glass-to-glass (encode + the hops +
 * *D* + decode) is the intent, and is what this does.
 *
 * With `decode: false` (the harness's light viewers, §13.2) nothing is decoded: a frame is
 * "rendered" when the jitter buffer hands it out, which is when a decoder would have got it.
 */
import { MediaFlag, type StreamConfig } from "../protocol";
import type { Cancel } from "../runtime";
import type { LayerCap, ReceivedFrame } from "../types";
import { AudioPlayout, GROW_WHEN_SHORT_MS, RESYNC_SLACK_MS, RESYNC_WHEN_OFF_MS, SHRINK_WHEN_LONG_MS } from "./audioPlayout";
import { browserBackends, type AudioBackend, type Backends, type DecodedVideo, type VideoBackend } from "./backends";
import { Emitter } from "./emitter";
import { createJitterBuffer, type JitterBufferImpl } from "./jitterBuffer";
import { temporalLayerCount } from "./layers";
import type { Player, PlayerEvents, PlayerOptions, PlayerStats, PlayoutFrame } from "./types";

/** How often the player looks at its clocks. */
export const TICK_MS = 5;
/**
 * Audio is handed to its decoder this long before it is to be heard: a tick, decoding, and the
 * way to the audio thread. While a frame is to be dropped the sequencer needs the frame after it
 * too, so the lead grows by one frame; that costs nothing, since the delay is then too long.
 */
export const AUDIO_LEAD_US = 15_000;
/**
 * A video frame is decoded when the sound reaches its capture time, and shown when it comes out
 * of the decoder, a few milliseconds late. This much more keeps it inside the window of §10.5
 * when a delay change moves the sound back a frame at once.
 */
export const VIDEO_BEHIND_US = 5_000;
/**
 * The path's floor is taken over this long, so that a burst of delay is ridden out by D rather
 * than followed; but when even the floor of a shorter window says frames come too late to be
 * played (the path itself grew: a repair to a parent further away), that is followed at once.
 */
export const PATH_WINDOW_MS = 1000;
export const PATH_GREW_WINDOW_MS = 200;
/** A video frame may be shown this late; later, a discardable one is dropped instead (§10.5). */
export const SHOW_LATE_US = 45_000;
/** A gap between two rendered frames longer than this is a freeze (§12.2). */
export const FREEZE_US = 200_000;
/** A decoder holding this many frames is behind: discardable frames are kept from it. */
const DECODER_BEHIND_FRAMES = 3;

/** The decoder's speed is judged this often, */
const LAYER_CHECK_MS = 500;
/** and a layer is given up after it has been too slow for this long, */
const LAYER_DOWN_AFTER_MS = 1000;
/** and asked for again after it has had this much to spare (doubling each time that fails, to a minute). */
const LAYER_UP_AFTER_MS = 5000;
const LAYER_UP_MAX_MS = 60_000;
/** A raise that is undone within this long failed. */
const LAYER_UP_FAILED_MS = 5000;

type PendingDecode = { frameId: number; decodeOnly: boolean; discardable: boolean; at: number };

/** The least time frames of one stream have taken to get here, over a sliding window: a monotonic deque of (arrival, transit). */
class PathFloor {
  private readonly samples: { at: number; ms: number }[] = [];

  constructor(private readonly windowMs: number) {}

  add(at: number, ms: number): void {
    while (this.samples.length > 0 && (this.samples[this.samples.length - 1] as { ms: number }).ms >= ms) this.samples.pop();
    this.samples.push({ at, ms });
  }

  /** Forget what arrived before `at`: it came by a path that is no longer the one. */
  forgetBefore(at: number): void {
    while (this.samples.length > 1 && (this.samples[0] as { at: number }).at < at) this.samples.shift();
  }

  floor(now: number): number | null {
    while (this.samples.length > 1 && (this.samples[0] as { at: number }).at < now - this.windowMs) this.samples.shift();
    return this.samples.length > 0 ? (this.samples[0] as { ms: number }).ms : null;
  }
}

type VideoState = {
  config: StreamConfig;
  buffer: JitterBufferImpl;
  backend: VideoBackend | null;
  pending: Map<number, PendingDecode>;
  /** After a decoder error, or a new configuration: nothing but a keyframe will do. */
  needKey: boolean;
  rendered: number;
  dropped: number;
  lastRenderedUs: number | null;
  first: boolean;
  width: number;
  height: number;
  /** The decoder's time per frame, recent ones (from going in, or from the frame before coming out, to coming out): the statistics and the layer rule. */
  decodeMs: number[];
  lastOutputAt: number;
  path: PathFloor;
  pathRecent: PathFloor;
  sinceCheck: number[];
  topLayer: number;
  cap: number;
  slowSince: number | null;
  spareSince: number | null;
  upAfterMs: number;
  raisedAt: number;
  avOffsetMs: number;
};

type AudioState = {
  config: StreamConfig;
  buffer: JitterBufferImpl;
  backend: AudioBackend | null;
  playout: AudioPlayout | null;
  blocked: boolean;
  path: PathFloor;
  pathRecent: PathFloor;
  /** Light mode: what a sequencer would have counted. */
  lightPlayedMs: number;
  lightConcealedMs: number;
  lightLastId: number;
};

export type PlayerDebug = {
  playheadUs: number;
  audioIsClock: boolean;
  /** The delay in force, path included: session time less the playhead. */
  appliedDelayMs: number;
  /** The delay wanted: the path plus D. */
  targetDelayMs: number;
  pathMs: number | null;
  /** The jitter buffer's D. */
  playoutDelayMs: number;
  layerCap: number;
  audio: ReturnType<AudioPlayout["counters"]> | null;
  buffers: Record<number, ReturnType<JitterBufferImpl["stats"]>>;
};

export class PlayerImpl extends Emitter<PlayerEvents> implements Player {
  private video: VideoState | null = null;
  private audio: AudioState | null = null;
  private cancelTick: Cancel | null = null;
  private closed = false;
  private hints = { jitterMs: 0, rttMs: null as number | null, lossPct: 0 };
  private volume = 1;
  /** The playout delay in force when audio is not the clock. Moves toward the target as audio would: a frame a second. */
  private appliedMs: number | null = null;
  private appliedSteppedAt = -Infinity;
  private audioIsClock = false;
  private lastLayerCheck = -Infinity;
  /** Lets a test hear what is played. */
  onTap: ((frame: number, pcm: Float32Array) => void) | null = null;

  constructor(
    private readonly options: PlayerOptions,
    private readonly backends: Backends,
  ) {
    super();
  }

  private get decoding(): boolean {
    return this.options.decode !== false;
  }

  private nowUs(): number {
    return Math.round(this.options.sessionClock.now() * 1000);
  }

  private fail(where: string, error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    this.options.logger?.error("media.player", where, wrapped.message);
    this.emit("error", wrapped);
  }

  /* ------------------------------ configuration ------------------------------ */

  async configure(streams: StreamConfig[]): Promise<void> {
    if (this.closed) return;
    for (const config of streams) {
      if (config.kind === "video") this.configureVideo(config);
      else await this.configureAudio(config);
    }
    if (!this.cancelTick && !this.closed) this.cancelTick = this.options.clock.setInterval(() => this.tick(), TICK_MS);
  }

  private makeBuffer(config: StreamConfig): JitterBufferImpl {
    const buffer = createJitterBuffer({ config, playoutMinMs: this.options.playoutMinMs, playoutMaxMs: this.options.playoutMaxMs, clock: this.options.clock });
    buffer.setLinkHints(this.hints);
    return buffer;
  }

  private configureVideo(config: StreamConfig): void {
    const existing = this.video;
    if (existing && existing.config.id === config.id && existing.config.configId === config.configId) {
      existing.config = config;
      return;
    }
    const top = temporalLayerCount(config.scalability) - 1;
    const state: VideoState = existing
      ? { ...existing, config, needKey: true, topLayer: top, cap: Math.min(existing.cap, top) }
      : {
          config,
          buffer: this.makeBuffer(config),
          backend: null,
          pending: new Map(),
          needKey: true,
          rendered: 0,
          dropped: 0,
          lastRenderedUs: null,
          first: true,
          width: config.width ?? 0,
          height: config.height ?? 0,
          decodeMs: [],
          lastOutputAt: -Infinity,
          path: new PathFloor(PATH_WINDOW_MS),
          pathRecent: new PathFloor(PATH_GREW_WINDOW_MS),
          sinceCheck: [],
          topLayer: top,
          cap: top,
          slowSince: null,
          spareSince: null,
          upAfterMs: LAYER_UP_AFTER_MS,
          raisedAt: -Infinity,
          avOffsetMs: 0,
        };
    this.video = state;
    if (!this.decoding) return;
    try {
      state.backend ??= this.backends.video({
        frame: (frame) => this.onDecodedVideo(frame),
        error: (error) => this.onVideoError(error),
      });
      state.pending.clear();
      state.backend.configure(config);
    } catch (error) {
      this.fail("video decoder", error);
    }
  }

  private async configureAudio(config: StreamConfig): Promise<void> {
    const existing = this.audio;
    if (existing && existing.config.id === config.id && existing.config.configId === config.configId) {
      existing.config = config;
      return;
    }
    const state: AudioState = existing
      ? { ...existing, config }
      : { config, buffer: this.makeBuffer(config), backend: null, playout: null, blocked: false, path: new PathFloor(PATH_WINDOW_MS), pathRecent: new PathFloor(PATH_GREW_WINDOW_MS), lightPlayedMs: 0, lightConcealedMs: 0, lightLastId: -1 };
    this.audio = state;
    if (!this.decoding) return;
    const frameUs = config.frameUs ?? 20_000;
    try {
      if (!state.backend) {
        const backend = await this.backends.audio(
          {
            report: (report) => state.playout?.onReport(report),
            state: (audioState) => this.onAudioState(audioState),
            error: (error) => this.onAudioError(error),
            tap: (frame, pcm) => this.onTap?.(frame, pcm),
          },
          frameUs,
        );
        if (this.closed) {
          await backend.close();
          return;
        }
        state.backend = backend;
        state.playout = new AudioPlayout(backend, this.options.clock, frameUs);
        backend.setVolume(this.volume);
      }
      state.backend.configure(config);
      state.playout?.restart();
      this.onAudioState(state.backend.state());
    } catch (error) {
      // No sound is not no picture: video is then timed by the session clock.
      this.fail("audio output", error);
    }
  }

  /* ------------------------------ in ------------------------------ */

  push(frame: ReceivedFrame): void {
    const id = frame.header.streamId;
    const stream = this.video && this.video.config.id === id ? this.video : this.audio && this.audio.config.id === id ? this.audio : null;
    if (!stream) return;
    // How long it took to get here. A replayed or retransmitted frame says nothing about the path.
    if (!frame.recovered) {
      const transitMs = this.options.sessionClock.now() - frame.header.captureUs / 1000;
      stream.path.add(this.options.clock.now(), transitMs);
      stream.pathRecent.add(this.options.clock.now(), transitMs);
    }
    stream.buffer.push(frame);
  }

  setLinkHints(hints: { jitterMs: number; rttMs: number | null; lossPct: number }): void {
    this.hints = { ...hints };
    this.video?.buffer.setLinkHints(hints);
    this.audio?.buffer.setLinkHints(hints);
  }

  /* ------------------------------ the clock ------------------------------ */

  /** The jitter buffer's D. Audio's and video's are told the same link, so they agree. */
  private playoutDelayMs(): number {
    const buffer = this.audio?.buffer ?? this.video?.buffer;
    return buffer ? buffer.delayUs() / 1000 : this.options.playoutMinMs;
  }

  /** How long the slower stream's frames take to get here at best; null before any has. */
  private pathMs(): number | null {
    const now = this.options.clock.now();
    const slower = (floor: (stream: VideoState | AudioState) => number | null) => {
      const video = this.video ? floor(this.video) : null;
      const audio = this.audio ? floor(this.audio) : null;
      if (video === null) return audio;
      return audio === null ? video : Math.max(audio, video);
    };
    const path = slower((stream) => stream.path.floor(now));
    const recent = slower((stream) => stream.pathRecent.floor(now));
    // Everything lately has come too late to be played: the path is longer now, and what came
    // before by the shorter one is no guide to it.
    if (path !== null && recent !== null && this.appliedMs !== null && recent > path && recent + RESYNC_SLACK_MS > this.appliedMs) {
      this.video?.path.forgetBefore(now - PATH_GREW_WINDOW_MS);
      this.audio?.path.forgetBefore(now - PATH_GREW_WINDOW_MS);
      return slower((stream) => stream.path.floor(now));
    }
    return path;
  }

  /** The shortest delay that does not lose frames that come by the path. */
  private leastDelayMs(): number {
    return Math.max(0, this.pathMs() ?? 0) + RESYNC_SLACK_MS;
  }

  /** The delay wanted between capture and playout: the path, then D. */
  private targetDelayMs(): number {
    return Math.max(0, this.pathMs() ?? 0) + this.playoutDelayMs();
  }

  /**
   * The capture time being presented at session time `nowUs`. From the audio worklet when sound
   * is playing; otherwise the session clock less the delay in force.
   */
  private playheadUs(nowUs: number): number {
    const fromAudio = this.audio?.playout?.playheadUs() ?? null;
    if (fromAudio !== null) {
      this.audioIsClock = true;
      // Remember the delay audio is really at, so that losing it does not move the picture.
      this.appliedMs = (nowUs - fromAudio) / 1000;
      return fromAudio;
    }
    this.audioIsClock = false;
    const target = this.targetDelayMs();
    const now = this.options.clock.now();
    if (this.appliedMs === null || !this.audio || this.pathMs() === null) {
      // No sound to keep in step with: the delay is simply the target (§10.2).
      // Until a frame has come, the path is not known: nothing is latched yet.
      if (this.pathMs() === null) return nowUs - Math.round(target * 1000);
      this.appliedMs = target;
    } else if ((this.appliedMs < this.leastDelayMs() && this.appliedMs < target) || this.appliedMs - target > RESYNC_WHEN_OFF_MS) {
      // As the audio would: too far off to adapt to a frame a second, so start again in the right place.
      this.appliedMs = target;
    } else if (now - this.appliedSteppedAt >= 1000) {
      // Sound that is not decoded here (a light viewer), or not allowed to play yet: move as
      // the audio would, one frame a second (§10.5).
      const frameMs = (this.audio.config.frameUs ?? 20_000) / 1000;
      if (target - this.appliedMs > GROW_WHEN_SHORT_MS) {
        this.appliedMs += frameMs;
        this.appliedSteppedAt = now;
      } else if (this.appliedMs - target >= SHRINK_WHEN_LONG_MS) {
        this.appliedMs -= frameMs;
        this.appliedSteppedAt = now;
      }
    }
    return nowUs - Math.round(this.appliedMs * 1000);
  }

  /* ------------------------------ the tick ------------------------------ */

  private tick(): void {
    if (this.closed) return;
    const nowUs = this.nowUs();
    const audio = this.audio;
    if (audio?.playout && !audio.blocked) audio.playout.tick(nowUs, this.targetDelayMs(), this.leastDelayMs());
    const playheadUs = this.playheadUs(nowUs);

    if (audio) {
      // "Due" in a jitter buffer is captureUs + D on the session clock; asked at playhead + D,
      // that is the playhead reaching captureUs, whatever delay playout is really at.
      const lead = this.decoding ? AUDIO_LEAD_US + (audio.playout?.wantsDrop() ? (audio.config.frameUs ?? 20_000) : 0) : 0;
      const frames = audio.buffer.pop(playheadUs + audio.buffer.delayUs() + lead);
      if (frames.length > 0) this.playAudio(audio, frames);
    }
    const video = this.video;
    if (video) {
      const behind = this.decoding && this.audioIsClock ? VIDEO_BEHIND_US : 0;
      const frames = video.buffer.pop(playheadUs - behind + video.buffer.delayUs());
      for (const frame of frames) this.decodeVideo(video, frame, nowUs);
      const now = this.options.clock.now();
      if (now - this.lastLayerCheck >= LAYER_CHECK_MS) {
        this.lastLayerCheck = now;
        this.checkLayers(video, now);
      }
    }
  }

  /* ------------------------------ audio ------------------------------ */

  private playAudio(audio: AudioState, frames: PlayoutFrame[]): void {
    const frameMs = (audio.config.frameUs ?? 20_000) / 1000;
    for (const { frame, decodeOnly } of frames) {
      if (!this.decoding) {
        // A light viewer: count what a sequencer would have played and concealed.
        const id = frame.header.frameId;
        if (!decodeOnly) {
          if (audio.lightLastId >= 0 && id > audio.lightLastId + 1) audio.lightConcealedMs += (id - audio.lightLastId - 1) * frameMs;
          audio.lightPlayedMs += frameMs;
        }
        audio.lightLastId = id;
        continue;
      }
      // Not allowed to play yet: nothing is decoded, and playout starts fresh when it is.
      if (!audio.playout || audio.blocked) continue;
      audio.playout.decode(frame.header.captureUs, frame.data, !decodeOnly);
    }
  }

  private onAudioState(state: "running" | "suspended" | "closed"): void {
    const audio = this.audio;
    if (!audio || this.closed) return;
    const blocked = state !== "running";
    if (blocked === audio.blocked) return;
    audio.blocked = blocked;
    // Either way, where playout was no longer means anything.
    audio.playout?.restart();
    this.emit("audioBlocked", blocked);
  }

  private onAudioError(error: Error): void {
    this.fail("audio decoder", error);
    const audio = this.audio;
    if (!audio?.backend) return;
    try {
      audio.backend.configure(audio.config);
      audio.playout?.restart();
    } catch (again) {
      this.fail("audio decoder", again);
    }
  }

  async resumeAudio(): Promise<void> {
    const backend = this.audio?.backend;
    if (!backend) return;
    await backend.resume();
    this.onAudioState(backend.state());
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.audio?.backend?.setVolume(this.volume);
  }

  /* ------------------------------ video ------------------------------ */

  private decodeVideo(video: VideoState, playout: PlayoutFrame, nowUs: number): void {
    const { frame, decodeOnly } = playout;
    const { header } = frame;
    if (!this.decoding) {
      if (!decodeOnly) this.rendered(video, header.frameId, header.captureUs, nowUs);
      return;
    }
    const backend = video.backend;
    if (!backend) return;
    const key = (header.flags & MediaFlag.Key) !== 0;
    const discardable = (header.flags & MediaFlag.Discardable) !== 0;
    if (video.needKey && !key) {
      video.dropped++;
      return;
    }
    // Above what this viewer asked for (a parent may not have caught up yet): only frames of the
    // same layer or above build on it, so it is not decoded, and nothing that needed it is.
    if (header.temporal > video.cap) return;
    // A decoder that is behind is spared what nothing depends on.
    if (discardable && backend.queueSize() >= DECODER_BEHIND_FRAMES) {
      video.dropped++;
      return;
    }
    video.needKey = false;
    video.pending.set(header.captureUs, { frameId: header.frameId, decodeOnly, discardable, at: this.options.clock.now() });
    try {
      backend.decode({ key, captureUs: header.captureUs, data: frame.data });
    } catch (error) {
      video.pending.delete(header.captureUs);
      this.onVideoError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onDecodedVideo(decoded: DecodedVideo): void {
    const video = this.video;
    if (!video || this.closed) {
      decoded.close();
      return;
    }
    const pending = video.pending.get(decoded.captureUs);
    for (const captureUs of video.pending.keys()) if (captureUs <= decoded.captureUs) video.pending.delete(captureUs);
    if (!pending) {
      decoded.close();
      return;
    }
    // The decoder's time for this frame: from when it went in, or from when the one before it came out if it had to wait for that.
    const now = this.options.clock.now();
    const took = now - Math.max(pending.at, video.lastOutputAt);
    video.lastOutputAt = now;
    video.decodeMs.push(took);
    if (video.decodeMs.length > 120) video.decodeMs.shift();
    video.sinceCheck.push(took);
    video.width = decoded.width;
    video.height = decoded.height;
    if (pending.decodeOnly) {
      decoded.close();
      return;
    }
    // Shown when the playhead reaches its capture time. It was handed to the decoder then, so
    // by now it is late by the time decoding took; past 45 ms a frame nothing needs is dropped.
    const nowUs = this.nowUs();
    const lateUs = this.playheadUs(nowUs) - decoded.captureUs;
    if (lateUs > SHOW_LATE_US && pending.discardable) {
      video.dropped++;
      decoded.close();
      return;
    }
    if (this.audioIsClock) video.avOffsetMs += 0.1 * (lateUs / 1000 - video.avOffsetMs);
    try {
      video.backend?.show(decoded);
    } catch (error) {
      decoded.close();
      this.fail("video track", error);
      return;
    }
    this.rendered(video, pending.frameId, decoded.captureUs, nowUs);
  }

  private onVideoError(error: Error): void {
    this.fail("video decoder", error);
    const video = this.video;
    if (!video?.backend) return;
    video.pending.clear();
    video.needKey = true;
    try {
      video.backend.reset();
    } catch (again) {
      this.fail("video decoder", again);
    }
  }

  private rendered(video: VideoState, frameId: number, captureUs: number, renderedUs: number): void {
    video.rendered++;
    const previous = video.lastRenderedUs;
    video.lastRenderedUs = renderedUs;
    if (video.first) {
      video.first = false;
      this.emit("firstFrame");
    } else if (previous !== null && renderedUs - previous > FREEZE_US) {
      this.emit("freeze", video.config.id, (renderedUs - previous) / 1000);
    }
    this.emit("rendered", video.config.id, frameId, captureUs, renderedUs);
  }

  /**
   * What this viewer's decoder can keep up with (PLAN M6). A frame that spends longer in the
   * decoder than the interval between frames means frames are piling up: ask for one temporal
   * layer less. With plenty to spare for long enough, ask for it back.
   */
  private checkLayers(video: VideoState, now: number): void {
    const times = video.sinceCheck;
    video.sinceCheck = [];
    if (!this.decoding || times.length === 0) return;
    const mean = times.reduce((sum, ms) => sum + ms, 0) / times.length;
    const interval = (cap: number) => (1000 / (video.config.fps ?? 30)) * 2 ** (video.topLayer - cap);
    if (mean > interval(video.cap)) {
      video.spareSince = null;
      video.slowSince ??= now;
      if (video.cap > 0 && now - video.slowSince >= LAYER_DOWN_AFTER_MS) {
        // Giving back a layer soon after asking for it: wait twice as long before asking again.
        video.upAfterMs = now - video.raisedAt < LAYER_UP_FAILED_MS ? Math.min(LAYER_UP_MAX_MS, video.upAfterMs * 2) : LAYER_UP_AFTER_MS;
        video.cap--;
        video.slowSince = null;
      }
      return;
    }
    video.slowSince = null;
    if (video.cap < video.topLayer && mean < 0.5 * interval(video.cap + 1)) {
      video.spareSince ??= now;
      if (now - video.spareSince >= video.upAfterMs) {
        video.cap++;
        video.raisedAt = now;
        video.spareSince = null;
      }
    } else {
      video.spareSince = null;
    }
  }

  /* ------------------------------ the rest ------------------------------ */

  videoTrack(): MediaStreamTrack | null {
    return this.video?.backend?.track() ?? null;
  }

  wantedLayers(streamId: number): LayerCap {
    const video = this.video;
    if (!video || video.config.id !== streamId) return { maxSpatial: 0, maxTemporal: 0 };
    return { maxSpatial: 0, maxTemporal: video.cap };
  }

  oldestWanted(streamId: number): number | null {
    if (this.video && this.video.config.id === streamId) return this.video.buffer.oldestWanted();
    if (this.audio && this.audio.config.id === streamId) return this.audio.buffer.oldestWanted();
    return null;
  }

  stats(): PlayerStats {
    const video = this.video;
    const audio = this.audio;
    let videoStats: PlayerStats["video"] = null;
    if (video) {
      const sorted = [...video.decodeMs].sort((a, b) => a - b);
      const p95 = sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] as number) : 0;
      videoStats = { rendered: video.rendered, dropped: video.dropped, lost: video.buffer.stats().lost, decodeMsP95: p95, width: video.width, height: video.height };
    }
    let audioStats: PlayerStats["audio"] = null;
    if (audio) {
      const counters = audio.playout?.counters();
      audioStats = counters
        ? { playedMs: counters.playedMs, concealedMs: counters.concealedMs, underruns: counters.late, avOffsetMs: video?.avOffsetMs ?? 0 }
        : { playedMs: audio.lightPlayedMs, concealedMs: audio.lightConcealedMs, underruns: 0, avOffsetMs: 0 };
    }
    // The playout delay is D, what this viewer adds to its path (§4.5 `playoutDelayMs`), as it stands.
    const pathMs = this.pathMs() ?? 0;
    const appliedMs = this.appliedMs ?? this.targetDelayMs();
    return { video: videoStats, audio: audioStats, playoutDelayMs: Math.max(0, Math.round(appliedMs - pathMs)) };
  }

  /** More than `stats()` says, for tests and for looking at a run. Not part of the contract. */
  debug(): PlayerDebug {
    const nowUs = this.nowUs();
    const buffers: PlayerDebug["buffers"] = {};
    if (this.video) buffers[this.video.config.id] = this.video.buffer.stats();
    if (this.audio) buffers[this.audio.config.id] = this.audio.buffer.stats();
    return {
      playheadUs: this.playheadUs(nowUs),
      audioIsClock: this.audioIsClock,
      appliedDelayMs: this.appliedMs ?? this.targetDelayMs(),
      targetDelayMs: this.targetDelayMs(),
      pathMs: this.pathMs(),
      playoutDelayMs: this.playoutDelayMs(),
      layerCap: this.video?.cap ?? 0,
      audio: this.audio?.playout?.counters() ?? null,
      buffers,
    };
  }

  /** For a test to listen to what is played. */
  tap(on: boolean): void {
    this.audio?.backend?.post({ t: "tap", on });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelTick?.();
    this.cancelTick = null;
    this.video?.backend?.close();
    await this.audio?.backend?.close();
  }
}

export function createPlayerWith(options: PlayerOptions, backends: Backends): PlayerImpl {
  return new PlayerImpl(options, backends);
}

export function createPlayer(options: PlayerOptions): Player {
  return new PlayerImpl(options, browserBackends);
}
