/**
 * What the player needs of a browser, behind two small interfaces: a video decoder with a track
 * to write to, and an audio decoder with a worklet to play through. `browserBackends` is the
 * real thing (WebCodecs, `MediaStreamTrackGenerator`, Web Audio); the unit tests put fakes in
 * its place, so every decision the player makes is tested under Node with a fake clock.
 */
import type { StreamConfig } from "../protocol";
import { fromBase64Url } from "../protocol";
import { PLAYOUT_PROCESSOR, audioWorkletSource, type SequencerMessage, type SequencerReport } from "./audioCore";
import { createVideoTrack } from "./platform";

/** A decoded picture. Whoever holds it last closes it. */
export type DecodedVideo = { captureUs: number; width: number; height: number; close(): void; raw: unknown };

export interface VideoBackend {
  configure(config: StreamConfig): void;
  decode(frame: { key: boolean; captureUs: number; data: Uint8Array }): void;
  /** Frames handed to the decoder and not yet out of it. */
  queueSize(): number;
  /** After an error: forget everything. The next frame must be a keyframe. */
  reset(): void;
  /** Put a decoded picture on the track. Takes ownership of it. */
  show(frame: DecodedVideo): void;
  track(): MediaStreamTrack | null;
  close(): void;
}

export type VideoBackendEvents = { frame: (frame: DecodedVideo) => void; error: (error: Error) => void };

export interface AudioBackend {
  readonly sampleRate: number;
  state(): "running" | "suspended" | "closed";
  resume(): Promise<void>;
  /** The audio context's clock, in seconds: the time of the block it renders next. */
  contextTime(): number;
  /** From a rendered sample to the loudspeaker, in seconds. */
  outputLatency(): number;
  /** Which context time is at the loudspeaker at which `performance.now()`: for a test to know when a sample was heard. */
  outputTimestamp?(): { contextTime: number; performanceTime: number } | null;
  configure(config: StreamConfig): void;
  /** Decode one frame. `play` false: decode to keep the decoder's state, and throw the sound away. */
  decode(frame: { captureUs: number; data: Uint8Array; play: boolean }): void;
  post(message: SequencerMessage): void;
  setVolume(volume: number): void;
  close(): Promise<void>;
}

export type AudioBackendEvents = {
  report: (report: SequencerReport) => void;
  state: (state: "running" | "suspended" | "closed") => void;
  error: (error: Error) => void;
  /** Only when a test asked for it: what was played. */
  tap?: (frame: number, pcm: Float32Array) => void;
};

export type Backends = {
  video(events: VideoBackendEvents): VideoBackend;
  audio(events: AudioBackendEvents, frameUs: number): Promise<AudioBackend>;
};

/* ------------------------------ video ------------------------------ */

class BrowserVideo implements VideoBackend {
  private decoder: VideoDecoder | null = null;
  private config: StreamConfig | null = null;
  private output: { track: MediaStreamTrack; writer: WritableStreamDefaultWriter<VideoFrame> } | null = null;
  private closed = false;

  constructor(private readonly events: VideoBackendEvents) {}

  configure(config: StreamConfig): void {
    this.config = config;
    if (!this.decoder || this.decoder.state === "closed") {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          if (this.closed) frame.close();
          else this.events.frame({ captureUs: frame.timestamp, width: frame.displayWidth, height: frame.displayHeight, close: () => frame.close(), raw: frame });
        },
        error: (error) => this.events.error(error),
      });
    }
    const decoderConfig: VideoDecoderConfig = { codec: config.codec, optimizeForLatency: true };
    if (config.width && config.height) {
      decoderConfig.codedWidth = config.width;
      decoderConfig.codedHeight = config.height;
    }
    const description = config.description ? fromBase64Url(config.description) : null;
    if (description) decoderConfig.description = description;
    this.decoder.configure(decoderConfig);
  }

  decode(frame: { key: boolean; captureUs: number; data: Uint8Array }): void {
    if (!this.decoder || this.decoder.state !== "configured") return;
    this.decoder.decode(new EncodedVideoChunk({ type: frame.key ? "key" : "delta", timestamp: frame.captureUs, data: frame.data }));
  }

  queueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  reset(): void {
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.reset();
      } catch {
        // Closed by the error that brought us here.
      }
    }
    if (this.config) this.configure(this.config);
  }

  show(frame: DecodedVideo): void {
    if (this.closed) {
      frame.close();
      return;
    }
    if (!this.output) {
      const made = createVideoTrack();
      this.output = { track: made.track, writer: made.writable.getWriter() };
    }
    // The track takes the frame and closes it.
    this.output.writer.write(frame.raw as VideoFrame).catch(() => frame.close());
  }

  track(): MediaStreamTrack | null {
    if (!this.output && !this.closed) {
      try {
        const made = createVideoTrack();
        this.output = { track: made.track, writer: made.writable.getWriter() };
      } catch (error) {
        this.events.error(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return this.output?.track ?? null;
  }

  close(): void {
    this.closed = true;
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {
        // Already closed.
      }
    }
    if (this.output) {
      void this.output.writer.close().catch(() => undefined);
      this.output.track.stop();
    }
  }
}

/* ------------------------------ audio ------------------------------ */

class BrowserAudio implements AudioBackend {
  readonly sampleRate: number;
  private decoder: AudioDecoder | null = null;
  /** What is in the decoder, in order: its capture time and whether to play it. */
  private readonly inDecoder: { captureUs: number; play: boolean }[] = [];
  private closed = false;

  constructor(
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly gain: GainNode,
    private readonly events: AudioBackendEvents,
  ) {
    this.sampleRate = context.sampleRate;
    node.port.onmessage = (event: MessageEvent<{ t: "report"; report: SequencerReport } | { t: "tap"; frame: number; pcm: Float32Array }>) => {
      if (event.data.t === "report") events.report(event.data.report);
      else events.tap?.(event.data.frame, event.data.pcm);
    };
    context.onstatechange = () => events.state(this.state());
  }

  state(): "running" | "suspended" | "closed" {
    return this.context.state === "running" ? "running" : this.context.state === "closed" ? "closed" : "suspended";
  }

  async resume(): Promise<void> {
    await this.context.resume();
  }

  contextTime(): number {
    return this.context.currentTime;
  }

  outputLatency(): number {
    const latency = (this.context.outputLatency || 0) + (this.context.baseLatency || 0);
    return Number.isFinite(latency) ? latency : 0;
  }

  outputTimestamp(): { contextTime: number; performanceTime: number } | null {
    const stamp = typeof this.context.getOutputTimestamp === "function" ? this.context.getOutputTimestamp() : null;
    return stamp && stamp.contextTime !== undefined && stamp.performanceTime !== undefined ? { contextTime: stamp.contextTime, performanceTime: stamp.performanceTime } : null;
  }

  configure(config: StreamConfig): void {
    if (!this.decoder || this.decoder.state === "closed") {
      this.decoder = new AudioDecoder({ output: (data) => this.onDecoded(data), error: (error) => this.events.error(error) });
    }
    this.inDecoder.length = 0;
    const decoderConfig: AudioDecoderConfig = { codec: config.codec, sampleRate: config.sampleRate ?? 48000, numberOfChannels: config.channels ?? 1 };
    const description = config.description ? fromBase64Url(config.description) : null;
    if (description) decoderConfig.description = description;
    this.decoder.configure(decoderConfig);
  }

  decode(frame: { captureUs: number; data: Uint8Array; play: boolean }): void {
    if (!this.decoder || this.decoder.state !== "configured") return;
    this.inDecoder.push({ captureUs: frame.captureUs, play: frame.play });
    this.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: frame.captureUs, data: frame.data }));
  }

  private onDecoded(data: AudioData): void {
    // One block out for each frame in, in order. The decoder's own timestamps count from its
    // first input and know nothing of a lost frame, so the capture time is ours, not its.
    const entry = this.inDecoder.shift();
    if (!entry || !entry.play || this.closed) {
      data.close();
      return;
    }
    const frames = data.numberOfFrames;
    const pcm = new Float32Array(frames);
    data.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
    if (data.numberOfChannels > 1) {
      const other = new Float32Array(frames);
      for (let channel = 1; channel < data.numberOfChannels; channel++) {
        data.copyTo(other, { planeIndex: channel, format: "f32-planar" });
        for (let i = 0; i < frames; i++) pcm[i] = (pcm[i] as number) + (other[i] as number);
      }
      for (let i = 0; i < frames; i++) pcm[i] = (pcm[i] as number) / data.numberOfChannels;
    }
    data.close();
    this.node.port.postMessage({ t: "pcm", us: entry.captureUs, pcm } satisfies SequencerMessage, [pcm.buffer]);
  }

  post(message: SequencerMessage): void {
    if (!this.closed) this.node.port.postMessage(message);
  }

  setVolume(volume: number): void {
    this.gain.gain.value = Math.max(0, Math.min(1, volume));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.context.onstatechange = null;
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {
        // Already closed.
      }
    }
    this.node.port.onmessage = null;
    this.node.disconnect();
    await this.context.close().catch(() => undefined);
  }
}

export const browserBackends: Backends = {
  video: (events) => new BrowserVideo(events),
  async audio(events, frameUs) {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([audioWorkletSource()], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(context, PLAYOUT_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { frameUs } });
    const gain = context.createGain();
    node.connect(gain).connect(context.destination);
    return new BrowserAudio(context, node, gain, events);
  },
};
