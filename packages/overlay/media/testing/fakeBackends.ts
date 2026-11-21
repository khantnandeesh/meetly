/**
 * Stand-ins for a browser's decoders, track and sound card, driven by a fake clock, so that the
 * player's decisions can be tested under Node. The audio one runs the real `Sequencer` (the
 * code the AudioWorklet runs) on a simulated audio thread and keeps everything it "played".
 */
import type { StreamConfig } from "../../protocol";
import type { Clock } from "../../runtime";
import { audioWorkletModule, type SequencerLike, type SequencerMessage } from "../audioCore";
import type { AudioBackend, AudioBackendEvents, Backends, DecodedVideo, VideoBackend, VideoBackendEvents } from "../backends";

export const SAMPLE_RATE = 48000;
const QUANTUM = 128;

/** The sound a fake decoder makes of a frame captured at `captureUs`: a 440 Hz tone, continuous across frames, quiet for 60 ms of every second. */
export function tone(captureUs: number, frameUs = 20000): Float32Array {
  const length = Math.round((SAMPLE_RATE * frameUs) / 1e6);
  const pcm = new Float32Array(length);
  const slot = Math.round(captureUs / frameUs) % 50;
  const amplitude = slot >= 30 && slot < 33 ? 0.005 : 0.5;
  const first = Math.round((captureUs * SAMPLE_RATE) / 1e6);
  for (let i = 0; i < length; i++) pcm[i] = amplitude * Math.sin((2 * Math.PI * 440 * (first + i)) / SAMPLE_RATE);
  return pcm;
}

export class FakeVideoBackend implements VideoBackend {
  /** How long a frame takes to decode. The decoder works on one frame at a time. */
  decodeMs = 4;
  configured: StreamConfig[] = [];
  decoded: number[] = [];
  shown: { captureUs: number; at: number }[] = [];
  closedFrames = 0;
  resets = 0;
  /** Set to make the next decode fail. */
  failNext = false;
  private busyUntil = 0;
  private inFlight = 0;
  private generation = 0;

  constructor(
    private readonly clock: Clock,
    private readonly events: VideoBackendEvents,
  ) {}

  configure(config: StreamConfig): void {
    this.configured.push(config);
  }

  decode(frame: { key: boolean; captureUs: number; data: Uint8Array }): void {
    if (this.failNext) {
      this.failNext = false;
      this.clock.setTimeout(() => this.events.error(new Error("fake decode error")), 0);
      return;
    }
    const start = Math.max(this.clock.now(), this.busyUntil);
    this.busyUntil = start + this.decodeMs;
    this.inFlight++;
    const generation = this.generation;
    this.clock.setTimeout(() => {
      if (generation !== this.generation) return;
      this.inFlight--;
      this.decoded.push(frame.captureUs);
      const picture: DecodedVideo = { captureUs: frame.captureUs, width: 1280, height: 720, close: () => this.closedFrames++, raw: null };
      this.events.frame(picture);
    }, this.busyUntil - this.clock.now());
  }

  queueSize(): number {
    return this.inFlight;
  }

  reset(): void {
    this.resets++;
    this.generation++;
    this.inFlight = 0;
    this.busyUntil = 0;
  }

  show(frame: DecodedVideo): void {
    this.shown.push({ captureUs: frame.captureUs, at: this.clock.now() });
  }

  track(): MediaStreamTrack | null {
    return null;
  }

  close(): void {
    this.generation++;
  }
}

export class FakeAudioBackend implements AudioBackend {
  readonly sampleRate = SAMPLE_RATE;
  readonly sequencer: SequencerLike;
  /** Everything "played", from context frame `frameBase`. */
  readonly output: number[] = [];
  /** The audio context's clock is not ours: its frame count starts somewhere of its own, and the player must not care. */
  readonly frameBase = 600_000;
  latency = 0;
  decoded: number[] = [];
  volume = 1;
  private current: "running" | "suspended" | "closed";
  private frame = this.frameBase;
  private quanta = 0;
  private cancel: (() => void) | null = null;
  private renderedUntil = 0;

  constructor(
    private readonly clock: Clock,
    private readonly events: AudioBackendEvents,
    frameUs: number,
    blocked: boolean,
  ) {
    this.sequencer = new (audioWorkletModule().Sequencer)(SAMPLE_RATE, frameUs);
    this.current = blocked ? "suspended" : "running";
    if (!blocked) this.run();
  }

  /** The audio thread: a block of 128 samples whenever our clock says one is due. */
  private run(): void {
    this.renderedUntil = this.clock.now();
    this.cancel = this.clock.setInterval(() => {
      const blockMs = (QUANTUM * 1000) / SAMPLE_RATE;
      while (this.renderedUntil + blockMs <= this.clock.now() + 1e-9) {
        this.renderedUntil += blockMs;
        const block = new Float32Array(QUANTUM);
        this.sequencer.render(block, this.frame);
        for (const sample of block) this.output.push(sample);
        this.frame += QUANTUM;
        if (++this.quanta % 4 === 0) this.events.report(this.sequencer.report());
      }
    }, 1);
  }

  state(): "running" | "suspended" | "closed" {
    return this.current;
  }

  async resume(): Promise<void> {
    if (this.current !== "suspended") return;
    this.current = "running";
    this.run();
    this.events.state("running");
  }

  contextTime(): number {
    return this.frame / SAMPLE_RATE;
  }

  outputLatency(): number {
    return this.latency;
  }

  configure(_config: StreamConfig): void {}

  decode(frame: { captureUs: number; data: Uint8Array; play: boolean }): void {
    this.clock.setTimeout(() => {
      this.decoded.push(frame.captureUs);
      if (frame.play) this.sequencer.push(frame.captureUs, tone(frame.captureUs));
    }, 1);
  }

  post(message: SequencerMessage): void {
    if (message.t === "pcm") this.sequencer.push(message.us, message.pcm);
    else if (message.t === "start") this.sequencer.start(message.us, message.atFrame);
    else if (message.t === "adjust") this.sequencer.adjust(message.dir);
    else if (message.t === "stop") this.sequencer.stop();
  }

  setVolume(volume: number): void {
    this.volume = volume;
  }

  async close(): Promise<void> {
    this.cancel?.();
    this.current = "closed";
  }
}

export type FakeBackends = Backends & { videos: FakeVideoBackend[]; audios: FakeAudioBackend[] };

export function createFakeBackends(clock: Clock, options: { audioBlocked?: boolean } = {}): FakeBackends {
  const videos: FakeVideoBackend[] = [];
  const audios: FakeAudioBackend[] = [];
  return {
    videos,
    audios,
    video(events) {
      const backend = new FakeVideoBackend(clock, events);
      videos.push(backend);
      return backend;
    },
    async audio(events, frameUs) {
      const backend = new FakeAudioBackend(clock, events, frameUs, options.audioBlocked ?? false);
      audios.push(backend);
      return backend;
    },
  };
}
