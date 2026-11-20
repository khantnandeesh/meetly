/**
 * Noise suppression that runs in this browser: RNNoise, a small recurrent network that turns
 * down whatever is not a voice (fans, typing, traffic), running in an AudioWorklet.
 *
 * Nothing here knows about a media provider. Each adapter plugs it in its own way: LiveKit as a
 * track processor (a track goes in, a track comes out: `NoiseFilter`), RealtimeKit as an audio
 * middleware (it hands over its AudioContext and wants a node back: `createNoiseNode`).
 *
 * The code and the model are @sapphi-red/web-noise-suppressor (MIT), which wraps
 * shiguredo/rnnoise-wasm (Apache-2.0) and xiph/rnnoise (BSD-3-Clause). The worklet and the wasm
 * are copied out of node_modules into public/effects by scripts/copy-effects.mjs and served by
 * this app; they are fetched the first time noise suppression runs and not before.
 */

const BASE = "/effects";
/** RNNoise was trained on, and only works at, this rate. */
export const NOISE_SAMPLE_RATE = 48_000;

export function noiseFilterSupported(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof MediaStreamAudioDestinationNode !== "undefined"
  );
}

export type NoiseNode = AudioWorkletNode & { destroy(): void };

let binary: Promise<ArrayBuffer> | null = null;
const worklets = new WeakMap<BaseAudioContext, Promise<void>>();

/** A node that removes background noise from what passes through it. `context` must run at 48 kHz. */
export async function createNoiseNode(context: AudioContext): Promise<NoiseNode> {
  if (context.sampleRate !== NOISE_SAMPLE_RATE) {
    throw new Error(`Noise suppression needs 48 kHz audio; this is ${context.sampleRate} Hz.`);
  }
  const { RnnoiseWorkletNode, loadRnnoise } = await import("@sapphi-red/web-noise-suppressor");
  if (!binary) {
    const loading = loadRnnoise({ url: `${BASE}/rnnoise.wasm`, simdUrl: `${BASE}/rnnoise_simd.wasm` });
    binary = loading;
    // A failed download is tried again next time rather than remembered.
    loading.catch(() => {
      if (binary === loading) binary = null;
    });
  }
  let worklet = worklets.get(context);
  if (!worklet) {
    worklet = context.audioWorklet.addModule(`${BASE}/rnnoise-worklet.js`);
    worklets.set(context, worklet);
    worklet.catch(() => worklets.delete(context));
  }
  const [wasmBinary] = await Promise.all([binary, worklet]);
  return new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary });
}

/**
 * A microphone track in, the same sound without the background noise out. It owns an
 * AudioContext at the rate RNNoise needs, whatever rate the device runs at.
 */
export class NoiseFilter {
  private source: MediaStreamAudioSourceNode | null = null;
  private stalled = false;

  private readonly context: AudioContext;
  private readonly node: NoiseNode;
  private readonly sink: MediaStreamAudioDestinationNode;
  private readonly onStall: () => void;

  private constructor(context: AudioContext, node: NoiseNode, sink: MediaStreamAudioDestinationNode, onStall: () => void) {
    this.context = context;
    this.node = node;
    this.sink = sink;
    this.onStall = onStall;
    context.addEventListener("statechange", this.watch);
  }

  /**
   * `onStall`: the browser stopped the audio graph (a phone call on iOS, for one) and it did not
   * start again. Until it does, `output` is silent, so whoever uses it should go back to the
   * plain microphone.
   */
  static async create(onStall: () => void = () => {}): Promise<NoiseFilter> {
    const context = new AudioContext({ sampleRate: NOISE_SAMPLE_RATE, latencyHint: "interactive" });
    try {
      if (context.state !== "running") {
        await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
      // A suspended graph would send silence in place of the microphone. Better none at all.
      if (context.state !== "running") throw new Error("The browser has not allowed audio to start yet.");
      const node = await createNoiseNode(context);
      const sink = context.createMediaStreamDestination();
      sink.channelCount = 1;
      node.connect(sink);
      return new NoiseFilter(context, node, sink, onStall);
    } catch (error) {
      context.close().catch(() => {});
      throw error;
    }
  }

  private watch = () => {
    if (this.context.state === "running" || this.context.state === "closed" || this.stalled) return;
    this.context.resume().catch(() => {});
    setTimeout(() => {
      if (this.context.state === "running" || this.context.state === "closed" || this.stalled) return;
      this.stalled = true;
      this.onStall();
    }, 1500);
  };

  /** What to send in place of the microphone track. The same track for as long as the filter lives. */
  get output(): MediaStreamTrack {
    return this.sink.stream.getAudioTracks()[0];
  }

  /** The microphone track being cleaned up. Call again when the microphone is restarted or swapped. */
  setInput(track: MediaStreamTrack): void {
    this.source?.disconnect();
    this.source = this.context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.node);
  }

  close(): void {
    this.context.removeEventListener("statechange", this.watch);
    this.source?.disconnect();
    this.source = null;
    this.node.disconnect();
    this.node.destroy();
    this.context.close().catch(() => {});
  }
}
