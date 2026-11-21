/**
 * media's public face. Owner: E-media. See ./README.md.
 */
import { notImplemented } from "../runtime";
import type { JitterBuffer, JitterBufferOptions, Player, PlayerOptions, ProgramEncoding, ProgramSource, ProgramSourceOptions } from "./types";

export type * from "./types";

/** Stage 1's program feed (SPEC §9.2). The video numbers are a starting point; the proof ran VP8 L1T2 at 640×360. */
export const DEFAULT_ENCODING: ProgramEncoding = {
  video: { codec: "vp8", width: 1280, height: 720, fps: 30, bitrateKbps: 1200, scalability: "L1T3", keyIntervalFrames: 60 },
  audio: { codec: "opus", sampleRate: 48000, channels: 1, bitrateKbps: 32, frameUs: 20000 },
};

export const createProgramSource: (options: ProgramSourceOptions) => ProgramSource = () => notImplemented("E-media", "media.createProgramSource");

export const createJitterBuffer: (options: JitterBufferOptions) => JitterBuffer = () => notImplemented("E-media", "media.createJitterBuffer");

export const createPlayer: (options: PlayerOptions) => Player = () => notImplemented("E-media", "media.createPlayer");

/** The WebCodecs codec strings this browser can decode, for `Capabilities.decode`. */
export const probeDecoders: () => Promise<string[]> = () => notImplemented("E-media", "media.probeDecoders");
