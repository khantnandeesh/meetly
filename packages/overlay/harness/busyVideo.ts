/**
 * A video for Chromium's fake camera that no encoder can make small: two seconds of moving noise
 * at 640 × 360, 30 fps, as Y4M (`--use-file-for-fake-video-capture`). Chromium's own fake camera
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

/** Writes the file once (it is the same every time) and returns its path. */
export function busyVideoFile(dir = join(tmpdir(), "overlay-harness")): string {
  const { width, height, fps, frames } = BUSY_VIDEO;
  const path = join(dir, `busy-${width}x${height}-${fps}-${frames}.y4m`);
  const frameBytes = (width * height * 3) / 2;
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
  if (existsSync(path) && statSync(path).size === header.length + frames * (6 + frameBytes)) return path;
  mkdirSync(dir, { recursive: true });
  const parts: Buffer[] = [header];
  const random = seededRandom(mixSeed(1, "busy-video"));
  for (let f = 0; f < frames; f++) {
    const frame = Buffer.alloc(frameBytes);
    // Luma: noise over a pattern that moves, so neither intra nor inter prediction saves much.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) frame[y * width + x] = (((x + 7 * f) ^ (y + 3 * f)) & 0x3f) + Math.floor(random() * 192);
    for (let i = width * height; i < frameBytes; i++) frame[i] = 64 + Math.floor(random() * 128);
    parts.push(Buffer.from("FRAME\n"), frame);
  }
  writeFileSync(path, Buffer.concat(parts));
  return path;
}
