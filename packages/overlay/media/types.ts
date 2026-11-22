/**
 * media: everything between a camera and a packet at the source, and between a frame and a
 * screen or loudspeaker at a viewer. It never sees a link or a peer. SPEC §9, §10.
 *
 * Owner: E-media. This file is the module's contract with the others: change it only as
 * docs/overlay/PLAN.md "Changing an interface" says.
 */
import type { Clock, Listenable, Logger, SessionClock } from "../runtime";
import type { StreamConfig } from "../protocol";
import type { EncodedFrame, LayerCap, ReceivedFrame } from "../types";

/* ------------------------------ the source ------------------------------ */

export type ProgramInput = {
  /** The program picture: the stage as the host's browser composes it (SPEC §9.1). */
  video: MediaStreamTrack;
  /** The program sound: the stage mixed down. Absent for a silent program. */
  audio?: MediaStreamTrack;
};

export type ProgramEncoding = {
  video: { codec: string; width: number; height: number; fps: number; bitrateKbps: number; scalability: string; keyIntervalFrames: number };
  audio: { codec: string; sampleRate: number; channels: number; bitrateKbps: number; frameUs: number };
};

export type ProgramSourceEvents = {
  /** An encoded frame, ready to packetize. Video and audio frames arrive interleaved, each stream in order. */
  frame: [frame: EncodedFrame];
  /** A stream's configuration, before its first frame and again whenever it changes. */
  config: [config: StreamConfig];
  error: [error: Error];
};

/** Captures and encodes the program feed. One per session, in the host's browser. */
export interface ProgramSource extends Listenable<ProgramSourceEvents> {
  start(input: ProgramInput): Promise<void>;
  /** What the congestion module wants the video encoder to aim for (SPEC §11.4). */
  setVideoBitrate(kbps: number): void;
  /** Make the next video frame a keyframe. Limited to one a second. */
  requestKeyframe(): void;
  streams(): StreamConfig[];
  /** Counters since the source was made. */
  stats(): ProgramSourceStats;
  stop(): Promise<void>;
}

export type ProgramSourceStats = {
  videoFrames: number;
  keyframes: number;
  videoBytes: number;
  /** Camera frames not encoded because the encoder already held two (SPEC §9.2). */
  skippedBusy: number;
  /** Camera frames not encoded because the camera runs faster than the stream. */
  skippedPacing: number;
  /** Camera frames not encoded because they would not have fitted in the stream's bitrate (./rateControl.ts). */
  skippedRate: number;
  /** What the encoder itself is asked for now, which is less than the stream's bitrate when it overshoots. */
  encoderKbps?: number;
  /** The size encoded at now: smaller than the program's when that is the only way to hold the bitrate. */
  width?: number;
  height?: number;
  /** The most frames the encoder ever held at once. */
  maxEncoderFrames: number;
  /** Audio frames encoded (each is announced `audioCopies` times). */
  audioFrames: number;
  audioBytes: number;
};

export type ProgramSourceOptions = {
  encoding: ProgramEncoding;
  /** Capture times are stamped on this clock. */
  sessionClock: SessionClock;
  clock: Clock;
  /**
   * How many times each audio frame is announced (SPEC §9.4): the copies carry the same
   * `frameId`, one frame apart. 2 unless said otherwise; 1 turns the redundancy off.
   */
  audioCopies?: number;
  logger?: Logger;
};

/* ------------------------------ the jitter buffer ------------------------------ */

/** What the jitter buffer hands the decoder, and when the result should be shown or heard. */
export type PlayoutFrame = {
  frame: ReceivedFrame;
  /** Session time, in microseconds, at which it is due. `captureUs` plus the playout delay. */
  dueUs: number;
  /** Decode it, but do not show it: it is late, or only needed by a later frame. */
  decodeOnly: boolean;
};

export type JitterBufferStats = {
  targetDelayMs: number;
  /** Media held ahead of playout. */
  bufferMs: number;
  framesIn: number;
  framesOut: number;
  /** Arrived after their time. */
  late: number;
  /** Given up on: never arrived whole, or undecodable because something they needed was. */
  lost: number;
  /** Times playout had to stop and wait. */
  stalls: number;
};

export type JitterBufferEvents = {
  /** Playout is waiting for frame `frameId`. The topology module may want to ask for it again. */
  stall: [streamId: number, frameId: number];
  /** Playout jumped forward to keyframe `frameId`, giving up on what was before it. */
  skip: [streamId: number, frameId: number];
  /** `targetDelayMs` changed. */
  delay: [targetDelayMs: number];
};

/** One per stream. The contract is SPEC §10; its acceptance tests are in PLAN.md (E-media M2). */
export interface JitterBuffer extends Listenable<JitterBufferEvents> {
  /** Any order, duplicates allowed. */
  push(frame: ReceivedFrame): void;
  /** Every frame that is decodable and due by session time `nowUs`, in decode order. */
  pop(nowUs: number): PlayoutFrame[];
  /** What the link looks like, to size the delay: jitter, and whether a NACK round trip is worth waiting for. */
  setLinkHints(hints: { jitterMs: number; rttMs: number | null; lossPct: number }): void;
  /** The oldest frame still wanted. Fragments of anything older need not be recovered. */
  oldestWanted(): number | null;
  stats(): JitterBufferStats;
  reset(): void;
}

export type JitterBufferOptions = {
  config: StreamConfig;
  playoutMinMs: number;
  playoutMaxMs: number;
  clock: Clock;
};

/* ------------------------------ playout ------------------------------ */

export type PlayerStats = {
  video: { rendered: number; dropped: number; lost: number; decodeMsP95: number; width: number; height: number } | null;
  audio: { playedMs: number; concealedMs: number; underruns: number; avOffsetMs: number } | null;
  playoutDelayMs: number;
};

export type PlayerEvents = {
  /** A video frame reached the screen: its capture time and when it was shown, both session microseconds. */
  rendered: [streamId: number, frameId: number, captureUs: number, renderedUs: number];
  /** The first video frame reached the screen. */
  firstFrame: [];
  /** Rendering stopped for longer than the freeze threshold (SPEC §12.2), and has now resumed. */
  freeze: [streamId: number, ms: number];
  /** The browser will not play sound until the person does something. See `resumeAudio`. */
  audioBlocked: [blocked: boolean];
  error: [error: Error];
};

/**
 * A viewer's whole receive side: jitter buffers, decoders, A/V sync, an AudioWorklet for sound
 * and a track for the picture. Frames go in; a `MediaStreamTrack` and sound come out.
 */
export interface Player extends Listenable<PlayerEvents> {
  /** The streams to expect. Call again when a stream's `configId` changes. */
  configure(streams: StreamConfig[]): Promise<void>;
  push(frame: ReceivedFrame): void;
  /** The picture, for a `<video>` element. Null until there is a video stream. */
  videoTrack(): MediaStreamTrack | null;
  /** Call from a click or key press when `audioBlocked` fired. */
  resumeAudio(): Promise<void>;
  setVolume(volume: number): void;
  setLinkHints(hints: { jitterMs: number; rttMs: number | null; lossPct: number }): void;
  /** The most this viewer can use right now (window size, decoder speed): topology passes it upstream. */
  wantedLayers(streamId: number): LayerCap;
  /** The oldest frame of a stream still worth recovering. */
  oldestWanted(streamId: number): number | null;
  stats(): PlayerStats;
  close(): Promise<void>;
}

export type PlayerOptions = {
  sessionClock: SessionClock;
  clock: Clock;
  playoutMinMs: number;
  playoutMaxMs: number;
  /**
   * The harness's light viewers: run the jitter buffer and report `rendered` at each frame's due
   * time, without decoding. Lets one machine hold many more peers (SPEC §13.2).
   */
  decode?: boolean;
  /**
   * A light viewer has no sound card. It takes the output latency one would have had to be this,
   * so that its latency is a decoding viewer's (40 unless said).
   */
  lightOutputLatencyMs?: number;
  logger?: Logger;
};
