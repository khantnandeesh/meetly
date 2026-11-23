/**
 * A video for Chromium's fake camera busier than its own: two seconds of a drifting pattern with
 * a little grain, drawn at 640 × 360 and delivered at the program's 1280 × 720, 30 fps, as Y4M
 * (`--use-file-for-fake-video-capture`). Chromium's own fake camera
 * draws a simple pattern that VP8 encodes to 700–800 kbps whatever it is asked for, so a
 * 900 kbps "slow" viewer was not under the session's 1,200 kbps (E-congestion found it). With
 * this, the package's encoder spends what its rate control allows; the stand-in pads on top
 * (`program.pad`). The report checks what the stream really was (`streamKbps`).
 *
 * Owner: E-harness.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mixSeed, seededRandom } from "./clock";

export const BUSY_VIDEO = { width: 640, height: 360, fps: 30, frames: 60 } as const;
/**
 * The size the camera delivers: the program's (scenarios.ts, 1280 × 720). A camera of another size
 * is fitted to the program on the source page's main thread, frame by frame (media/source.ts
 * `scale`, a 2D canvas and a readback): with the 640 × 360 file that was 16% of the source page's
 * main thread in a local profile, in single frames of up to 190 ms, and the largest of the source's
 * main-thread stalls (D69; round 6, the coordinator's decision 5). Drawn at 640 × 360 as before and
 * doubled here with the same bilinear filter a canvas uses, so the encoder sees the picture it saw.
 */
export const BUSY_VIDEO_OUT = { width: 1280, height: 720 } as const;

/** One plane doubled in each direction, bilinear (pixel centres), clamped at the edges. */
function double(src: Uint8Array, w: number, h: number): Uint8Array {
  const W = 2 * w;
  const out = new Uint8Array(W * 2 * h);
  for (let Y = 0; Y < 2 * h; Y++) {
    const sy = Math.max(0, Math.min(h - 1, (Y - 0.5) / 2));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let X = 0; X < W; X++) {
      const sx = Math.max(0, Math.min(w - 1, (X - 0.5) / 2));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const top = src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx;
      const bottom = src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx;
      out[Y * W + X] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return out;
}

/** Writes the file once (it is the same every time) and returns its path. */
export function busyVideoFile(dir = join(tmpdir(), "overlay-harness")): string {
  const { width, height, fps, frames } = BUSY_VIDEO;
  const out = BUSY_VIDEO_OUT;
  const path = join(dir, `busy-v3-${width}x${height}-at-${out.width}x${out.height}-${fps}-${frames}.y4m`);
  const frameBytes = (width * height * 3) / 2;
  const outBytes = (out.width * out.height * 3) / 2;
  const header = Buffer.from(`YUV4MPEG2 W${out.width} H${out.height} F${fps}:1 Ip A1:1 C420jpeg\n`);
  if (existsSync(path) && statSync(path).size === header.length + frames * (6 + outBytes)) return path;
  mkdirSync(dir, { recursive: true });
  const parts: Buffer[] = [header];
  const random = seededRandom(mixSeed(1, "busy-video"));
  for (let f = 0; f < frames; f++) {
    const frame = Buffer.alloc(frameBytes);
    // A smooth pattern drifting across the picture, with a little grain. Chosen by measurement
    // (Chromium's VP8, L1T3, realtime, asked for 1,200 kbps at 1280 × 720): this comes out at
    // about 1,500 kbps. Pure noise came out at 15,000, fine detail at 4,000: past some point
    // the encoder overshoots whatever it is asked for, which is E-media's to know, not a
    // network for a congestion test.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const base = 128 + 70 * Math.sin((x + 12 * f) / 30) * Math.cos((y - 3 * f) / 24);
        frame[y * width + x] = Math.max(0, Math.min(255, Math.round(base + (random() - 0.5) * 4)));
      }
    for (let i = width * height; i < frameBytes; i++) frame[i] = 128 + Math.round(40 * Math.sin(i / 300 + f / 7));
    const luma = width * height;
    const chroma = luma / 4;
    parts.push(
      Buffer.from("FRAME\n"),
      Buffer.from(double(frame.subarray(0, luma), width, height).buffer),
      Buffer.from(double(frame.subarray(luma, luma + chroma), width / 2, height / 2).buffer),
      Buffer.from(double(frame.subarray(luma + chroma), width / 2, height / 2).buffer),
    );
  }
  writeFileSync(path, Buffer.concat(parts));
  return path;
}
