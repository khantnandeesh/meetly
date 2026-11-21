/**
 * What media's browser scenarios share: a program worth encoding, the fake camera, numbers.
 */
import type { Clock } from "../../runtime";
import { createProgramComposer } from "../compose";
import { DEFAULT_ENCODING } from "../index";
import type { ProgramEncoding } from "../types";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const quantile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};
export const round = (value: number | null, digits = 1) => (value === null ? null : Number(value.toFixed(digits)));

export function encodingFor(options: { width?: number; height?: number; bitrateKbps?: number; scalability?: string }): ProgramEncoding {
  return {
    video: {
      ...DEFAULT_ENCODING.video,
      width: options.width ?? DEFAULT_ENCODING.video.width,
      height: options.height ?? DEFAULT_ENCODING.video.height,
      bitrateKbps: options.bitrateKbps ?? DEFAULT_ENCODING.video.bitrateKbps,
      scalability: options.scalability ?? DEFAULT_ENCODING.video.scalability,
    },
    audio: DEFAULT_ENCODING.audio,
  };
}

export async function camera(encoding: ProgramEncoding, audio = true): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { exact: encoding.video.width }, height: { exact: encoding.video.height }, frameRate: encoding.video.fps },
    audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
  });
}

/**
 * A program worth encoding: the fake camera on a stage whose backdrop is fine texture that
 * moves. The fake camera's own test card is so easy to encode that an encoder asked for 1.2 Mbps
 * spends half of it, and a bitrate test would be measuring the test card.
 */
export async function program(encoding: ProgramEncoding, clock: Clock, options: { audio?: boolean; overlay?: (context: CanvasRenderingContext2D, frame: number) => void; audioContext?: AudioContext } = {}) {
  const stream = await camera({ ...encoding, video: { ...encoding.video, width: 640, height: 360 } }, options.audio ?? true);
  const tile = document.createElement("canvas");
  tile.width = tile.height = 256;
  const tileContext = tile.getContext("2d")!;
  const noise = tileContext.createImageData(256, 256);
  let state = 99;
  for (let i = 0; i < noise.data.length; i += 4) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const value = 96 + ((state >>> 16) & 0x3f);
    noise.data[i] = value;
    noise.data[i + 1] = value;
    noise.data[i + 2] = 255 - value;
    noise.data[i + 3] = 255;
  }
  tileContext.putImageData(noise, 0, 0);
  const { width, height } = encoding.video;
  // The texture as one strip, drawn once: a frame costs two blits.
  const band = Math.round(height * 0.18);
  const strip = document.createElement("canvas");
  strip.width = width + 256;
  strip.height = band;
  const stripContext = strip.getContext("2d")!;
  stripContext.fillStyle = stripContext.createPattern(tile, "repeat")!;
  stripContext.fillRect(0, 0, strip.width, band);
  const composer = createProgramComposer({
    width,
    height,
    fps: encoding.video.fps,
    clock,
    audioContext: options.audioContext,
    overlay: (context, frame) => {
      // The texture frames the camera's picture and slides a little every frame.
      const shift = (frame * 2) % 256;
      context.drawImage(strip, shift, 0, width, band, 0, 0, width, band);
      context.drawImage(strip, 256 - shift, 0, width, band, 0, height - band, width, band);
      options.overlay?.(context, frame);
    },
  });
  composer.setVideo(stream.getVideoTracks());
  if (options.audio ?? true) composer.setAudio(stream.getAudioTracks());
  return {
    input: composer.input(),
    composer,
    stop: () => {
      composer.close();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

/** How late a 10 ms timer fires: what the page's main thread was busy with instead. */
export function lagMonitor(clock: Clock) {
  const lags: number[] = [];
  let last = clock.now();
  const cancel = clock.setInterval(() => {
    const now = clock.now();
    lags.push(Math.max(0, now - last - 10));
    last = now;
  }, 10);
  return { stop: () => (cancel(), { p50: round(quantile(lags, 0.5)), p99: round(quantile(lags, 0.99)), max: round(quantile(lags, 1)) }) };
}
