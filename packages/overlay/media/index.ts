/**
 * media's public face. Owner: E-media. See ./README.md.
 */
import type { ProgramEncoding } from "./types";

export type * from "./types";

/** Stage 1's program feed (SPEC §9.2). The video numbers are a starting point; the proof ran VP8 L1T2 at 640×360. */
export const DEFAULT_ENCODING: ProgramEncoding = {
  video: { codec: "vp8", width: 1280, height: 720, fps: 30, bitrateKbps: 1200, scalability: "L1T3", keyIntervalFrames: 60 },
  audio: { codec: "opus", sampleRate: 48000, channels: 1, bitrateKbps: 32, frameUs: 20000 },
};

export { createProgramSource, VIDEO_STREAM_ID, AUDIO_STREAM_ID } from "./source";

export { createJitterBuffer, playoutDelayTarget } from "./jitterBuffer";

export { createPlayer } from "./player";

export { probeDecoders } from "./probe";

export { createProgramComposer } from "./compose";
export type { ProgramComposer, ProgramComposerOptions } from "./compose";
