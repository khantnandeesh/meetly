/**
 * Does the source hold its bitrate whatever the picture (./rateControl.ts)? The real source and
 * Chromium's VP8 encoder, fed pictures that are hard to encode: the harness's busy pattern
 * (harness/busyVideo.ts on overlay-harness, drawn here by the same formula), fine detail, noise,
 * and the fake camera for a picture that is easy. Every encoded video byte is counted over
 * sliding two-second windows.
 */
import { MediaFlag } from "../../protocol";
import type { EncodedFrame } from "../../types";
import { createProgramSource } from "../source";
import { createLocalSessionClock, createWorkerClock } from "../testing/realClock";
import { camera, encodingFor, round, sleep } from "./common";

type Content = "busy" | "fine" | "noise" | "camera";

/** A canvas track drawing `content` at `fps`, as a composer would. */
export function picture(content: Exclude<Content, "camera">, width: number, height: number, fps: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false })!;
  const track = canvas.captureStream(0).getVideoTracks()[0] as MediaStreamTrack & { requestFrame(): void };
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  // The harness's busy pattern: 640×360, 60 frames, a drifting smooth pattern with a little grain.
  const busy: ImageData[] = [];
  if (content === "busy") {
    for (let f = 0; f < 60; f++) {
      const image = new ImageData(640, 360);
      for (let y = 0; y < 360; y++)
        for (let x = 0; x < 640; x++) {
          const v = Math.max(0, Math.min(255, Math.round(128 + 70 * Math.sin((x + 12 * f) / 30) * Math.cos((y - 3 * f) / 24) + (random() - 0.5) * 4)));
          const i = (y * 640 + x) * 4;
          image.data[i] = v;
          image.data[i + 1] = v;
          image.data[i + 2] = v;
          image.data[i + 3] = 255;
        }
      busy.push(image);
    }
  }
  const small = document.createElement("canvas");
  small.width = 640;
  small.height = 360;
  const smallContext = small.getContext("2d")!;
  // Fine detail: one-pixel texture, sliding.
  const tile = document.createElement("canvas");
  tile.width = tile.height = 256;
  const tileContext = tile.getContext("2d")!;
  const texture = tileContext.createImageData(256, 256);
  for (let i = 0; i < texture.data.length; i += 4) {
    const v = random() * 255;
    texture.data[i] = v;
    texture.data[i + 1] = v;
    texture.data[i + 2] = 255 - v;
    texture.data[i + 3] = 255;
  }
  tileContext.putImageData(texture, 0, 0);
  const noise = content === "noise" ? new ImageData(width, height) : null;
  let frame = 0;
  const draw = () => {
    if (content === "busy") {
      smallContext.putImageData(busy[frame % 60] as ImageData, 0, 0);
      context.drawImage(small, 0, 0, width, height);
    } else if (content === "fine") {
      context.save();
      context.fillStyle = context.createPattern(tile, "repeat")!;
      context.translate((frame * 2) % 256, 0);
      context.fillRect(-256, 0, width + 256, height);
      context.restore();
    } else if (noise) {
      const words = new Uint32Array(noise.data.buffer);
      for (let i = 0; i < words.length; i += 16384) crypto.getRandomValues(words.subarray(i, Math.min(words.length, i + 16384)));
      for (let i = 3; i < noise.data.length; i += 4) noise.data[i] = 255;
      context.putImageData(noise, 0, 0);
    }
    frame++;
    track.requestFrame();
  };
  const timer = setInterval(draw, 1000 / fps);
  return { track, stop: () => (clearInterval(timer), track.stop()) };
}

export async function rate(options: { content?: Content; seconds?: number; width?: number; height?: number; bitrateKbps?: number } = {}) {
  const content = options.content ?? "busy";
  const seconds = options.seconds ?? 30;
  const encoding = encodingFor(options);
  const { width, height, fps, bitrateKbps } = encoding.video;
  const clock = createWorkerClock();
  const sessionClock = createLocalSessionClock(clock);
  const source = createProgramSource({ encoding, sessionClock, clock });
  const errors: string[] = [];
  source.on("error", (error) => errors.push(error.message));
  const configs: { atS: number; width?: number; height?: number }[] = [];
  let startedAt = 0;
  source.on("config", (config) => {
    if (config.kind === "video") configs.push({ atS: round((clock.now() - startedAt) / 1000) as number, width: config.width, height: config.height });
  });
  const frames: { at: number; bytes: number; key: boolean; width: number; probe: boolean }[] = [];
  let currentWidth = width;
  /** Keyframes in the first 2.5 s after the picture was made bigger again: the source trying a size it may have to leave. */
  let tryingUntil = -Infinity;
  source.on("config", (config) => {
    if (config.kind !== "video" || !config.width) return;
    if (config.width > currentWidth) tryingUntil = clock.now() - startedAt + 2500;
    currentWidth = config.width;
  });
  source.on("frame", (frame: EncodedFrame) => {
    if (frame.header.streamId !== 0) return;
    const key = (frame.header.flags & MediaFlag.Key) !== 0;
    const at = clock.now() - startedAt;
    frames.push({ at, bytes: frame.data.byteLength, key, width: currentWidth, probe: key && at <= tryingUntil });
  });
  let input: MediaStreamTrack;
  let stop: () => void;
  if (content === "camera") {
    const stream = await camera(encoding, false);
    input = stream.getVideoTracks()[0]!;
    stop = () => stream.getTracks().forEach((track) => track.stop());
  } else {
    const made = picture(content, width, height, fps);
    input = made.track;
    stop = made.stop;
  }
  startedAt = clock.now();
  await source.start({ video: input });
  await sleep(seconds * 1000);
  const stats = source.stats();
  await source.stop();
  stop();
  clock.close();

  // Every two-second window, from the second on (the first frame of a new picture is the one nothing can predict).
  const budgetBytes = (bitrateKbps * 1000 * 2) / 8;
  let worst = 0;
  let worstAt = 0;
  let sum = 0;
  let start = 0;
  const kept = frames.filter((f) => f.at >= 2000);
  for (let end = 0; end < kept.length; end++) {
    sum += kept[end]!.bytes;
    while (kept[end]!.at - kept[start]!.at >= 2000) sum -= kept[start++]!.bytes;
    if (sum > worst) {
      worst = sum;
      worstAt = kept[end]!.at;
    }
  }
  const keys = frames.filter((f) => f.key && !f.probe);
  const probes = frames.filter((f) => f.probe);
  // Gaps between every keyframe, tries included: a viewer waits for any of them.
  const allKeys = frames.filter((f) => f.key);
  const keyGapsMs = allKeys.slice(1).map((k, i) => k.at - allKeys[i]!.at);
  const last = frames.filter((f) => f.at >= (seconds - 5) * 1000);
  const msOfB = (bytes: number) => round((bytes * 8) / bitrateKbps);
  return {
    content,
    seconds,
    targetKbps: bitrateKbps,
    worstWindowPct: round((100 * worst) / budgetBytes),
    worstWindowAtS: round(worstAt / 1000),
    meanKbps: round((kept.reduce((s, f) => s + f.bytes, 0) * 8) / (seconds * 1000 - 2000)),
    keyGapMaxMs: keyGapsMs.length ? Math.max(...keyGapsMs) : null,
    // Keyframes once the source has had 5 s to learn the picture.
    keyMsOfB: { max: keys.some((k) => k.at >= 5000) ? msOfB(Math.max(...keys.filter((k) => k.at >= 5000).map((k) => k.bytes))) : null, first: keys.length ? msOfB(keys[0]!.bytes) : null, last: keys.length ? msOfB(keys[keys.length - 1]!.bytes) : null },
    keyList: allKeys.map((k) => `${round(k.at / 1000)}s:${k.width}:${msOfB(k.bytes)}${k.probe ? "t" : ""}`).join(" "),
    probeKeys: { count: probes.length, maxMsOfB: probes.length ? msOfB(Math.max(...probes.map((p) => p.bytes))) : null },
    fpsLast5s: round(last.length / 5),
    widthLast: frames.length ? frames[frames.length - 1]!.width : null,
    sizes: configs.map((c) => `${c.atS}s:${c.width}x${c.height}`).join(" "),
    skippedRate: stats.skippedRate,
    encoderKbps: stats.encoderKbps,
    frames: frames.length,
    errors,
  };
}
