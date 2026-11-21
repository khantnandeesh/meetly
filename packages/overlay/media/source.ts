/**
 * The source side (SPEC §9): two tracks in, encoded frames out, every header filled. VP8 with
 * temporal layers and Opus, through WebCodecs. The encoder is never allowed a queue.
 */
import { MediaFlag, PacketType, type StreamConfig } from "../protocol";
import type { EncodedFrame } from "../types";
import { Emitter } from "./emitter";
import { DependencyTracker, temporalLayerCount } from "./layers";
import { readTrack, type EncodedVideoMetadata } from "./platform";
import type { ProgramInput, ProgramSource, ProgramSourceEvents, ProgramSourceOptions, ProgramSourceStats } from "./types";

export const VIDEO_STREAM_ID = 0;
export const AUDIO_STREAM_ID = 1;

/** The encoder may hold this many frames; the next one is skipped (§9.2). */
const MAX_ENCODER_FRAMES = 2;
/** `requestKeyframe` is honoured this often at most. */
const KEYFRAME_REQUEST_MIN_MS = 1000;
/** A change of target smaller than this is not worth reconfiguring the encoder for. */
const BITRATE_STEP = 0.03;
/** A gap this long between two blocks of the audio track is a hole in the capture, not jitter. */
const AUDIO_HOLE_US = 5000;
/** The audio timeline is steered by at most this much per window of blocks, to follow the sound card's clock. */
const AUDIO_STEER_US = 1000;
const AUDIO_STEER_WINDOW = 50;

export function videoStreamConfig(encoding: ProgramSourceOptions["encoding"], configId: number, bitrateKbps: number): StreamConfig {
  const { video } = encoding;
  const layers = temporalLayerCount(video.scalability);
  return {
    id: VIDEO_STREAM_ID,
    kind: "video",
    configId,
    codec: video.codec,
    bitrateKbps,
    width: video.width,
    height: video.height,
    fps: video.fps,
    scalability: video.scalability,
    keyIntervalFrames: video.keyIntervalFrames,
    stripes: [{ index: 0, kind: "data", temporal: [...Array(layers).keys()] }],
    sframe: false,
  };
}

export function audioStreamConfig(encoding: ProgramSourceOptions["encoding"], configId: number): StreamConfig {
  const { audio } = encoding;
  return {
    id: AUDIO_STREAM_ID,
    kind: "audio",
    configId,
    codec: audio.codec,
    bitrateKbps: audio.bitrateKbps,
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    frameUs: audio.frameUs,
    stripes: [{ index: 0, kind: "data", temporal: [0] }],
    sframe: false,
  };
}

class ProgramSourceImpl extends Emitter<ProgramSourceEvents> implements ProgramSource {
  private readonly options: ProgramSourceOptions;
  private readonly layers: number;
  private readonly audioCopies: number;

  private running = false;
  /** Bumped by every start and stop, so a loop left over from an earlier input knows to end. */
  private generation = 0;
  private readers: ReadableStreamDefaultReader<unknown>[] = [];

  private videoEncoder: VideoEncoder | null = null;
  private videoBitrateKbps: number;
  private videoConfigId = 0;
  private nextVideoId = 0;
  private tracker: DependencyTracker;
  /** Frames handed to the encoder and not yet out of it: their timestamp, and when they were captured. */
  private readonly inEncoder = new Map<number, number>();
  private sinceKey = Infinity;
  private forceKey = false;
  private lastKeyRequestAt = -Infinity;
  private lastVideoCaptureUs = -Infinity;
  private scaler: { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D } | null = null;

  private audioEncoder: AudioEncoder | null = null;
  private audioInputRate = 0;
  private nextAudioId = 0;
  /** Capture time of the first sample of the next frame out of the audio encoder. */
  private audioOutUs: number | null = null;
  /** Capture time of the next sample into it. */
  private audioInUs: number | null = null;
  private audioSteer = { count: 0, min: Infinity };
  /** Where the audio track's own timestamps say its next block starts. */
  private audioTrackUs: number | null = null;
  private previousAudio: EncodedFrame | null = null;

  private counters: ProgramSourceStats = { videoFrames: 0, keyframes: 0, videoBytes: 0, skippedBusy: 0, skippedPacing: 0, maxEncoderFrames: 0, audioFrames: 0, audioBytes: 0 };

  constructor(options: ProgramSourceOptions) {
    super();
    this.options = options;
    this.layers = temporalLayerCount(options.encoding.video.scalability);
    this.tracker = new DependencyTracker(this.layers);
    this.videoBitrateKbps = options.encoding.video.bitrateKbps;
    this.audioCopies = Math.max(1, Math.min(4, options.audioCopies ?? 2));
  }

  streams(): StreamConfig[] {
    return [videoStreamConfig(this.options.encoding, this.videoConfigId, this.videoBitrateKbps), audioStreamConfig(this.options.encoding, 0)];
  }

  stats(): ProgramSourceStats {
    return { ...this.counters };
  }

  private nowUs(): number {
    return Math.round(this.options.sessionClock.now() * 1000);
  }

  private fail(where: string, error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    this.options.logger?.error("media.source", where, wrapped.message);
    this.emit("error", wrapped);
  }

  /* ------------------------------ start and stop ------------------------------ */

  async start(input: ProgramInput): Promise<void> {
    await this.stopInput();
    this.running = true;
    const generation = ++this.generation;

    const [video, audio] = this.streams() as [StreamConfig, StreamConfig];
    const support = await VideoEncoder.isConfigSupported(this.videoEncoderConfig());
    if (!support.supported) throw new Error(`this browser cannot encode ${video.codec} ${video.scalability ?? ""}`);
    if (generation !== this.generation) return;

    this.configureVideoEncoder();
    this.emit("config", video);
    this.forceKey = true;
    void this.videoLoop(input.video, generation);

    if (input.audio) {
      this.emit("config", audio);
      void this.audioLoop(input.audio, generation);
    }
  }

  async stop(): Promise<void> {
    await this.stopInput();
  }

  private async stopInput(): Promise<void> {
    this.running = false;
    this.generation++;
    const readers = this.readers;
    this.readers = [];
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => undefined)));
    for (const encoder of [this.videoEncoder, this.audioEncoder]) {
      if (encoder && encoder.state !== "closed") {
        try {
          encoder.close();
        } catch {
          // Already closed by an error.
        }
      }
    }
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.inEncoder.clear();
    this.audioOutUs = null;
    this.audioInUs = null;
    this.audioTrackUs = null;
    this.previousAudio = null;
    this.audioSteer = { count: 0, min: Infinity };
  }

  /* ------------------------------ video ------------------------------ */

  private videoEncoderConfig(): VideoEncoderConfig {
    const { video } = this.options.encoding;
    return {
      codec: video.codec,
      width: video.width,
      height: video.height,
      bitrate: Math.round(this.videoBitrateKbps * 1000),
      framerate: video.fps,
      latencyMode: "realtime",
      scalabilityMode: video.scalability,
    };
  }

  private configureVideoEncoder(): void {
    if (!this.videoEncoder || this.videoEncoder.state === "closed") {
      this.videoEncoder = new VideoEncoder({
        output: (chunk, metadata) => this.onVideoChunk(chunk, metadata as EncodedVideoMetadata | undefined),
        error: (error) => this.fail("video encoder", error),
      });
    }
    this.videoEncoder.configure(this.videoEncoderConfig());
  }

  setVideoBitrate(kbps: number): void {
    const wanted = Math.max(50, Math.min(this.options.encoding.video.bitrateKbps, kbps));
    if (Math.abs(wanted - this.videoBitrateKbps) < BITRATE_STEP * this.videoBitrateKbps) return;
    this.videoBitrateKbps = wanted;
    if (!this.running || !this.videoEncoder || this.videoEncoder.state !== "configured") return;
    try {
      // Only the rate changes: nothing a decoder is configured with, so the configId stays.
      this.videoEncoder.configure(this.videoEncoderConfig());
      this.emit("config", videoStreamConfig(this.options.encoding, this.videoConfigId, this.videoBitrateKbps));
    } catch (error) {
      this.fail("video bitrate", error);
    }
  }

  requestKeyframe(): void {
    const now = this.options.clock.now();
    if (now - this.lastKeyRequestAt < KEYFRAME_REQUEST_MIN_MS) return;
    this.lastKeyRequestAt = now;
    this.forceKey = true;
  }

  private async videoLoop(track: MediaStreamTrack, generation: number): Promise<void> {
    const { video } = this.options.encoding;
    const frameUs = 1_000_000 / video.fps;
    let reader: ReadableStreamDefaultReader<VideoFrame>;
    try {
      reader = readTrack<VideoFrame>(track, 1).getReader();
    } catch (error) {
      this.fail("video track", error);
      return;
    }
    this.readers.push(reader);
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        if (generation !== this.generation) {
          frame.close();
          break;
        }
        // The capture time: when the frame is read, on the session clock (§9.2).
        const captureUs = this.nowUs();
        try {
          this.encodeVideo(frame, captureUs, frameUs);
        } catch (error) {
          this.fail("video encode", error);
        } finally {
          frame.close();
        }
      }
    } catch (error) {
      if (generation === this.generation) this.fail("video capture", error);
    }
  }

  private encodeVideo(frame: VideoFrame, captureUs: number, frameUs: number): void {
    const encoder = this.videoEncoder;
    if (!encoder || encoder.state !== "configured") return;
    // A camera faster than the stream: keep to the stream's rate.
    if (captureUs - this.lastVideoCaptureUs < 0.7 * frameUs) {
      this.counters.skippedPacing++;
      return;
    }
    // Never a queue: with two frames waiting, this one is skipped.
    if (this.inEncoder.size >= MAX_ENCODER_FRAMES || this.inEncoder.has(frame.timestamp)) {
      this.counters.skippedBusy++;
      return;
    }
    this.lastVideoCaptureUs = captureUs;
    const keyFrame = this.forceKey || this.sinceKey >= this.options.encoding.video.keyIntervalFrames;
    if (keyFrame) {
      this.forceKey = false;
      this.sinceKey = 0;
    }
    this.sinceKey++;
    const { width, height } = this.options.encoding.video;
    const fitted = frame.displayWidth === width && frame.displayHeight === height ? null : this.scale(frame, width, height);
    this.inEncoder.set(frame.timestamp, captureUs);
    this.counters.maxEncoderFrames = Math.max(this.counters.maxEncoderFrames, this.inEncoder.size);
    try {
      encoder.encode(fitted ?? frame, { keyFrame });
    } finally {
      fitted?.close();
    }
  }

  /** The program is one size. A track of another size is fitted to it, letterboxed. */
  private scale(frame: VideoFrame, width: number, height: number): VideoFrame {
    if (!this.scaler || this.scaler.canvas.width !== width || this.scaler.canvas.height !== height) {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("no 2D canvas to scale the program with");
      this.scaler = { canvas, context };
    }
    const { canvas, context } = this.scaler;
    const ratio = Math.min(width / frame.displayWidth, height / frame.displayHeight);
    const w = Math.round(frame.displayWidth * ratio);
    const h = Math.round(frame.displayHeight * ratio);
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    context.drawImage(frame, (width - w) >> 1, (height - h) >> 1, w, h);
    return new VideoFrame(canvas, { timestamp: frame.timestamp });
  }

  private onVideoChunk(chunk: EncodedVideoChunk, metadata: EncodedVideoMetadata | undefined): void {
    let captureUs = this.inEncoder.get(chunk.timestamp);
    // Whatever went in before this frame is out, or was dropped by the encoder.
    for (const timestamp of this.inEncoder.keys()) if (timestamp <= chunk.timestamp) this.inEncoder.delete(timestamp);
    if (captureUs === undefined) captureUs = this.nowUs();

    const key = chunk.type === "key";
    const frameId = this.nextVideoId++;
    const place = this.tracker.next(frameId, key, metadata?.svc?.temporalLayerId ?? 0);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.counters.videoFrames++;
    this.counters.videoBytes += data.byteLength;
    if (key) this.counters.keyframes++;
    this.emit("frame", {
      header: {
        type: PacketType.Media,
        flags: (key ? MediaFlag.Key : 0) | (place.discardable ? MediaFlag.Discardable : 0),
        streamId: VIDEO_STREAM_ID,
        stripe: 0,
        spatial: 0,
        temporal: place.temporal,
        refDelta: place.refDelta,
        keyDelta: place.keyDelta,
        frameId,
        captureUs,
        configId: this.videoConfigId,
      },
      data,
    });
  }

  /* ------------------------------ audio ------------------------------ */

  private configureAudioEncoder(sampleRate: number): void {
    const { audio } = this.options.encoding;
    if (!this.audioEncoder || this.audioEncoder.state === "closed") {
      this.audioEncoder = new AudioEncoder({
        output: (chunk) => this.onAudioChunk(chunk),
        error: (error) => this.fail("audio encoder", error),
      });
    }
    const config: AudioEncoderConfig & { opus?: { frameDuration: number } } = {
      codec: audio.codec,
      sampleRate,
      numberOfChannels: audio.channels,
      bitrate: audio.bitrateKbps * 1000,
    };
    if (audio.codec === "opus") config.opus = { frameDuration: audio.frameUs };
    this.audioEncoder.configure(config);
    this.audioInputRate = sampleRate;
    this.audioOutUs = null;
    this.audioInUs = null;
    this.audioTrackUs = null;
  }

  private async audioLoop(track: MediaStreamTrack, generation: number): Promise<void> {
    let reader: ReadableStreamDefaultReader<AudioData>;
    try {
      reader = readTrack<AudioData>(track).getReader();
    } catch (error) {
      this.fail("audio track", error);
      return;
    }
    this.readers.push(reader);
    try {
      for (;;) {
        const { value: data, done } = await reader.read();
        if (done || !data) break;
        if (generation !== this.generation) {
          data.close();
          break;
        }
        const arrivedUs = this.nowUs();
        try {
          this.encodeAudio(data, arrivedUs);
        } catch (error) {
          this.fail("audio encode", error);
        } finally {
          data.close();
        }
      }
    } catch (error) {
      if (generation === this.generation) this.fail("audio capture", error);
    }
  }

  private encodeAudio(data: AudioData, arrivedUs: number): void {
    if (!this.audioEncoder || this.audioInputRate !== data.sampleRate) this.configureAudioEncoder(data.sampleRate);
    const encoder = this.audioEncoder;
    if (!encoder || encoder.state !== "configured") return;

    const frames = data.numberOfFrames;
    const durationUs = (frames * 1_000_000) / data.sampleRate;
    // A block is read when its last sample has been captured: its first was `durationUs` earlier.
    const startedUs = arrivedUs - durationUs;
    // The track's own timestamps say whether capture skipped: a hole moves the timeline on.
    const holeUs = this.audioTrackUs === null ? 0 : data.timestamp - this.audioTrackUs;
    this.audioTrackUs = data.timestamp + durationUs;
    if (this.audioInUs === null) {
      this.audioInUs = startedUs;
      this.audioOutUs = startedUs;
    } else if (holeUs > AUDIO_HOLE_US) {
      this.audioInUs += holeUs;
      if (this.audioOutUs !== null) this.audioOutUs += holeUs;
      this.audioSteer = { count: 0, min: Infinity };
    } else {
      // Blocks are read late, never early: the least lateness over a window is how far the
      // sound card's clock has drifted from the session's. Follow it slowly.
      this.audioSteer.min = Math.min(this.audioSteer.min, startedUs - this.audioInUs);
      if (++this.audioSteer.count >= AUDIO_STEER_WINDOW) {
        const steerUs = Math.max(-AUDIO_STEER_US, Math.min(AUDIO_STEER_US, this.audioSteer.min));
        this.audioInUs += steerUs;
        if (this.audioOutUs !== null) this.audioOutUs += steerUs;
        this.audioSteer = { count: 0, min: Infinity };
      }
    }

    const channels = this.options.encoding.audio.channels;
    const pcm = new Float32Array(frames * channels);
    const plane = new Float32Array(frames);
    for (let channel = 0; channel < data.numberOfChannels; channel++) {
      data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      if (channels === 1) {
        // Mix down to the one channel the program has.
        const gain = 1 / data.numberOfChannels;
        for (let i = 0; i < frames; i++) pcm[i] = (pcm[i] as number) + (plane[i] as number) * gain;
      } else if (channel < channels) {
        pcm.set(plane, channel * frames);
      }
    }
    const block = new AudioData({
      format: "f32-planar",
      sampleRate: data.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round(this.audioInUs),
      data: pcm,
    });
    this.audioInUs += durationUs;
    try {
      encoder.encode(block);
    } finally {
      block.close();
    }
  }

  private onAudioChunk(chunk: EncodedAudioChunk): void {
    const { audio } = this.options.encoding;
    // The encoder numbers its output from its first input; so do we, on the session clock.
    const captureUs = Math.round(this.audioOutUs ?? this.nowUs());
    this.audioOutUs = (this.audioOutUs ?? captureUs) + (chunk.duration ?? audio.frameUs);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const frame: EncodedFrame = {
      header: {
        type: PacketType.Media,
        flags: MediaFlag.Key,
        streamId: AUDIO_STREAM_ID,
        stripe: 0,
        spatial: 0,
        temporal: 0,
        refDelta: 0,
        keyDelta: 0,
        frameId: this.nextAudioId++,
        captureUs,
        configId: 0,
      },
      data,
    };
    this.counters.audioFrames++;
    this.counters.audioBytes += data.byteLength;
    this.emit("frame", frame);
    // §9.4: each audio frame is sent twice, the second copy one frame after the first.
    if (this.audioCopies > 1 && this.previousAudio) for (let copy = 1; copy < this.audioCopies; copy++) this.emit("frame", this.previousAudio);
    this.previousAudio = frame;
  }
}

export function createProgramSource(options: ProgramSourceOptions): ProgramSource {
  return new ProgramSourceImpl(options);
}
