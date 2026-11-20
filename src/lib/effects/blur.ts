/**
 * Background blur that runs in this browser. A small segmentation model says which pixels are
 * you; everything else is drawn out of focus.
 *
 * Nothing here knows about a media provider. LiveKit takes it as a track processor (a camera
 * track goes in, a blurred one comes out: `BlurPipeline`); RealtimeKit hands over a canvas with
 * each frame on it and wants it changed in place (`BlurRenderer.draw`). The pre-join preview uses
 * the pipeline too, which is why what you see there is what others get.
 *
 * - Model: MediaPipe Selfie Segmentation, landscape (256x144, 250 kB), from the npm package
 *   @mediapipe/selfie_segmentation (Apache-2.0).
 * - Runtime: LiteRT.js, @litertjs/core (Apache-2.0), on its WebAssembly CPU back end. It was
 *   chosen over a WebGL one because it does not depend on the graphics driver: about 6 to 9 ms
 *   a frame on one core, measured, where software WebGL took 70 to 150 ms.
 *
 * Both are copied out of node_modules into public/effects by scripts/copy-effects.mjs and served
 * by this app. The runtime is 11 MB (3 MB compressed), so none of it is fetched until blur is
 * switched on.
 */
import type { BackgroundMode } from "../rtc/types";

export type BlurStrength = Exclude<BackgroundMode, "none">;

const BASE = "/effects";
const MODEL_URL = `${BASE}/selfie_segmentation_landscape.tflite`;
const MODEL_W = 256;
const MODEL_H = 144;
/** The mask is refreshed at most this often; frames in between reuse the last one. */
const SEGMENT_EVERY_MS = 60;
/** Never draw more than this many frames a second, whatever the camera delivers. */
const MAX_FPS = 30;
/** Blur is switched off after this many seconds in a row under `SLOW_FPS`. */
export const SLOW_SECONDS = 10;
export const SLOW_FPS = 12;

/** How far the frame is shrunk before it is blurred, and the blur radius at that size. */
const STRENGTH: Record<BlurStrength, { shrink: number; radius: number }> = {
  light: { shrink: 4, radius: 1.5 },
  blur: { shrink: 8, radius: 3.5 },
};

/** Why this browser cannot blur the background, or null if it can. */
export function blurUnavailable(): string | null {
  if (typeof document === "undefined" || typeof WebAssembly === "undefined") {
    return "This browser can't blur the background.";
  }
  const canvas = document.createElement("canvas");
  if (typeof canvas.captureStream !== "function" || !canvas.getContext("2d")) {
    return "This browser can't blur the background.";
  }
  return null;
}

/* ------------------------------------------------------------------- model */

type Model = {
  /** Fills `scores` (one value per pixel, 0 background to 1 person) from `pixels` (RGB, 0 to 1). */
  run(pixels: Float32Array, scores: Float32Array): Promise<void>;
};

let model: Promise<Model> | null = null;

/** Fetches and starts the runtime and the model, once per page. */
function loadModel(): Promise<Model> {
  if (model) return model;
  const loading = (async (): Promise<Model> => {
    const { loadLiteRt, loadAndCompile, Tensor } = await import("@litertjs/core");
    await loadLiteRt(`${BASE}/`);
    const compiled = await loadAndCompile(MODEL_URL, { accelerator: "wasm" });
    // One run at a time: the preview and the call can both hold a renderer for a moment.
    let queue: Promise<void> = Promise.resolve();
    return {
      run(pixels, scores) {
        const next = queue.then(async () => {
          const input = new Tensor(pixels, [1, MODEL_H, MODEL_W, 3]);
          try {
            const [output] = await compiled.run(input);
            try {
              scores.set(output.toTypedArray() as Float32Array);
            } finally {
              output.delete();
            }
          } finally {
            input.delete();
          }
        });
        queue = next.catch(() => {});
        return next;
      },
    };
  })();
  model = loading;
  // A failed download is tried again next time rather than remembered.
  loading.catch(() => {
    if (model === loading) model = null;
  });
  return loading;
}

/* ---------------------------------------------------------------- renderer */

function makeCanvas(width: number, height: number, readBack = false) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", readBack ? { willReadFrequently: true } : undefined);
  if (!context) throw new Error("This browser can't blur the background.");
  return { canvas, context };
}

const canFilter = () => typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

/** Draws frames with the background out of focus. One per camera. */
export class BlurRenderer {
  strength: BlurStrength;
  /** Frames drawn since it was made. */
  frames = 0;
  /** Set if the model stopped working; frames are then drawn fully blurred. */
  failure: unknown = null;

  private readonly model: Model;
  private readonly filters = canFilter();
  private readonly shrunk = makeCanvas(MODEL_W, MODEL_H, true);
  private readonly rough = makeCanvas(MODEL_W, MODEL_H);
  private readonly mask = makeCanvas(MODEL_W, MODEL_H);
  private readonly person = makeCanvas(2, 2);
  private readonly backdrop = makeCanvas(2, 2);
  private readonly pixels = new Float32Array(MODEL_W * MODEL_H * 3);
  private readonly scores = new Float32Array(MODEL_W * MODEL_H);
  private readonly maskImage = new ImageData(MODEL_W, MODEL_H);
  private segmenting = false;
  private segmentedAt = -Infinity;

  private constructor(model: Model, strength: BlurStrength) {
    this.model = model;
    this.strength = strength;
  }

  /** Resolves once the model is loaded and ready to draw. */
  static async create(strength: BlurStrength): Promise<BlurRenderer> {
    return new BlurRenderer(await loadModel(), strength);
  }

  /**
   * Draws `source` onto `target` with everything but the person blurred. `source` may be the
   * canvas `target` draws on: it is read before anything is written.
   *
   * Until the first mask is back the whole frame is blurred, so nothing sharp is ever shown of a
   * room that was meant to be hidden.
   */
  draw(source: CanvasImageSource, width: number, height: number, target: CanvasRenderingContext2D, now = performance.now()): void {
    if (width < 2 || height < 2) return;
    if (!this.segmenting && !this.failure && now - this.segmentedAt >= SEGMENT_EVERY_MS) this.segment(source, now);

    const { shrink, radius } = STRENGTH[this.strength];
    // Without canvas filters (older Safari) the blur is the shrinking alone, so shrink further.
    const factor = this.filters ? shrink : shrink * 2.5;
    const backdrop = this.backdrop;
    const bw = Math.max(16, Math.round(width / factor));
    const bh = Math.max(9, Math.round(height / factor));
    if (backdrop.canvas.width !== bw || backdrop.canvas.height !== bh) {
      backdrop.canvas.width = bw;
      backdrop.canvas.height = bh;
    }
    if (this.filters) backdrop.context.filter = `blur(${radius}px)`;
    backdrop.context.drawImage(source, 0, 0, bw, bh);

    const person = this.person;
    if (person.canvas.width !== width || person.canvas.height !== height) {
      person.canvas.width = width;
      person.canvas.height = height;
    }
    person.context.globalCompositeOperation = "copy";
    person.context.drawImage(this.mask.canvas, 0, 0, width, height);
    person.context.globalCompositeOperation = "source-in";
    person.context.drawImage(source, 0, 0, width, height);

    target.save();
    target.globalCompositeOperation = "source-over";
    target.globalAlpha = 1;
    target.filter = "none";
    target.imageSmoothingEnabled = true;
    target.drawImage(backdrop.canvas, 0, 0, width, height);
    target.drawImage(person.canvas, 0, 0, width, height);
    target.restore();
    this.frames++;
  }

  private segment(source: CanvasImageSource, now: number): void {
    this.segmenting = true;
    this.segmentedAt = now;
    const { context } = this.shrunk;
    context.drawImage(source, 0, 0, MODEL_W, MODEL_H);
    const rgba = context.getImageData(0, 0, MODEL_W, MODEL_H).data;
    const pixels = this.pixels;
    for (let from = 0, to = 0; from < rgba.length; from += 4) {
      pixels[to++] = rgba[from] / 255;
      pixels[to++] = rgba[from + 1] / 255;
      pixels[to++] = rgba[from + 2] / 255;
    }
    this.model.run(pixels, this.scores).then(
      () => {
        const alpha = this.maskImage.data;
        const scores = this.scores;
        for (let i = 0; i < scores.length; i++) {
          // Steepened around the middle: a firm edge, with a pixel or two of give.
          const t = Math.min(1, Math.max(0, (scores[i] - 0.3) / 0.4));
          alpha[i * 4 + 3] = t * t * (3 - 2 * t) * 255;
        }
        this.rough.context.putImageData(this.maskImage, 0, 0);
        // Softened at its own small size, where that costs nothing, then stretched over the frame.
        const mask = this.mask.context;
        mask.globalCompositeOperation = "copy";
        if (this.filters) mask.filter = "blur(1.2px)";
        mask.drawImage(this.rough.canvas, 0, 0);
        this.segmenting = false;
      },
      (error) => {
        this.failure = error;
        this.segmenting = false;
      },
    );
  }
}

/* ---------------------------------------------------------------- pipeline */

/** Calls `fn` every `ms`, also while the tab is in the background (where page timers are slowed to a crawl). */
function createTicker(ms: number, fn: () => void): () => void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${ms})`], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = fn;
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  }
}

/**
 * Watches how many frames a second are actually drawn. `onSlow` fires once, after
 * `SLOW_SECONDS` in a row under `floor`. Seconds with no frames at all (camera off, tab asleep)
 * do not count either way.
 */
export function watchFrameRate(
  frames: () => number,
  onSlow: () => void,
  floor: () => number = () => SLOW_FPS,
): { stop(): void; fps(): number } {
  let last = frames();
  let lastAt = performance.now();
  let slowFor = 0;
  let fps = 0;
  let fired = false;
  const timer = setInterval(() => {
    const now = performance.now();
    const count = frames();
    fps = ((count - last) * 1000) / Math.max(1, now - lastAt);
    const drew = count > last;
    last = count;
    lastAt = now;
    if (typeof document !== "undefined" && document.hidden) return void (slowFor = 0);
    slowFor = drew && fps < floor() ? slowFor + 1 : 0;
    if (slowFor >= SLOW_SECONDS && !fired) {
      fired = true;
      onSlow();
    }
  }, 1000);
  return { stop: () => clearInterval(timer), fps: () => fps };
}

/** A camera track in, the same picture with the background blurred out. */
export class BlurPipeline {
  private readonly renderer: BlurRenderer;
  private readonly video = document.createElement("video");
  private readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D;
  private readonly track: MediaStreamTrack;
  private input: MediaStreamTrack | null = null;
  private stopTicker: (() => void) | null = null;
  private watch: { stop(): void; fps(): number } | null = null;
  private drawnAt = 0;
  private interval = 1000 / MAX_FPS;
  /** Share of the camera's size the output is drawn at. Lowered if drawing cannot keep up. */
  private scale = 1;
  private cost = 0;
  private closed = false;

  private constructor(renderer: BlurRenderer) {
    this.renderer = renderer;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("This browser can't blur the background.");
    this.context = context;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.canvas.width = 640;
    this.canvas.height = 360;
    this.track = this.canvas.captureStream(MAX_FPS).getVideoTracks()[0];
  }

  /**
   * Resolves once a blurred frame is ready to send. `onSlow` fires if the frame rate then stays
   * under a usable level (see `SLOW_FPS`): the device cannot keep up, and blur should go.
   */
  static async create(input: MediaStreamTrack, strength: BlurStrength, onSlow: () => void = () => {}): Promise<BlurPipeline> {
    const reason = blurUnavailable();
    if (reason) throw new Error(reason);
    const pipeline = new BlurPipeline(await BlurRenderer.create(strength));
    try {
      await pipeline.start(input, onSlow);
    } catch (error) {
      pipeline.close();
      throw error;
    }
    return pipeline;
  }

  /** What to send in place of the camera track. The same track for as long as the pipeline lives. */
  get output(): MediaStreamTrack {
    return this.track;
  }

  get fps(): number {
    return this.watch?.fps() ?? 0;
  }

  /** For measuring: the size of the picture being sent, and how long drawing a frame takes (ms, smoothed). */
  get stats(): { width: number; height: number; drawMs: number; frameMs: number; fps: number } {
    return { width: this.canvas.width, height: this.canvas.height, drawMs: this.cost, frameMs: this.interval, fps: this.fps };
  }

  setStrength(strength: BlurStrength): void {
    this.renderer.strength = strength;
  }

  /** The camera track being blurred. Call again when the camera is restarted or swapped. */
  setInput(track: MediaStreamTrack): void {
    this.input = track;
    const rate = track.getSettings().frameRate;
    this.interval = 1000 / Math.min(MAX_FPS, rate && rate > 1 ? rate : MAX_FPS);
    this.video.srcObject = new MediaStream([track]);
    this.video.play().catch(() => {});
  }

  private async start(input: MediaStreamTrack, onSlow: () => void): Promise<void> {
    this.setInput(input);
    // Wait for a first picture, so the track that replaces the camera is never blank.
    const deadline = performance.now() + 4000;
    while (!this.closed && this.video.videoWidth === 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    if (this.video.videoWidth === 0) throw new Error("The camera did not start.");
    this.tick();
    this.stopTicker = createTicker(Math.round(this.interval), this.tick);
    this.watch = watchFrameRate(
      () => this.renderer.frames,
      onSlow,
      // A camera that only delivers ten frames a second is not blur being slow.
      () => Math.min(SLOW_FPS, (1000 / this.interval) * 0.6),
    );
  }

  private tick = () => {
    const { video, input } = this;
    if (this.closed || !input || input.readyState !== "live" || video.readyState < 2 || video.videoWidth === 0) return;
    const started = performance.now();
    // Ticks that queued up behind a busy main thread are dropped, not drawn in a burst.
    if (started - this.drawnAt < this.interval * 0.6) return;
    const width = Math.max(2, Math.round((video.videoWidth * this.scale) / 2) * 2);
    const height = Math.max(2, Math.round((video.videoHeight * this.scale) / 2) * 2);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.renderer.draw(video, width, height, this.context, started);
    this.drawnAt = started;
    // If drawing a frame takes most of the time there is for one, send a smaller picture
    // rather than a slower one.
    this.cost = this.cost * 0.9 + (performance.now() - started) * 0.1;
    if (this.cost > this.interval * 0.75 && this.scale > 0.5) {
      this.scale -= 0.25;
      this.cost = 0;
    }
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTicker?.();
    this.watch?.stop();
    this.track.stop();
    this.video.srcObject = null;
  }
}
