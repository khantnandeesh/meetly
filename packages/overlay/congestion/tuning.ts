/**
 * Every number of SPEC §11 in one place. These are the spec's values; a test or a tuning run
 * passes others through the factories' `tuning` option, and nothing else in the module holds a
 * threshold of its own.
 */

import type { GateTuning, SourceRateTuning } from "./types";

export type { GateTuning, SourceRateTuning };

/** Stage 1's video bitrate (SPEC §9.2): what *B* is when a factory is not told. */
export const DEFAULT_STREAM_KBPS = 1200;

/** Bytes that `ms` of a stream at `kbps` come to. "150 ms of B" is `bytesOf(B, 150)`. */
export const bytesOf = (kbps: number, ms: number): number => (kbps * ms) / 8;

export type EstimatorTuning = {
  /** Loss, sent and delivered rates are taken over this long (§11.1). */
  windowMs: number;
  /** The one-way delay's floor is the smallest seen in this long (§11.1). */
  delayFloorMs: number;
  /**
   * C6 (see README): §11.2's backlog is judged by its least value over this long, so a keyframe's
   * burst that the link drains within it is not read as the link falling behind. 0 reads each
   * sample as it comes, the spec to the letter.
   */
  backlogWindowMs: number;
  /**
   * C6 (see README): loss makes a link strained or congested only while the link also shows a
   * queue (`queueDelayMs` or `bufferedBytes` over the strained line). False is the spec's letter.
   */
  lossNeedsQueue: boolean;
  /** §11.2, strained: `bufferedBytes` over this many ms of B. */
  strainedBufferMs: number;
  strainedLossPct: number;
  strainedQueueMs: number;
  /** §11.2, congested. */
  congestedBufferMs: number;
  congestedLossPct: number;
  congestedQueueMs: number;
  /** How long the queue delay must stay at or over `congestedQueueMs`. */
  congestedQueueForMs: number;
  /** Feedback older than this no longer describes the link: the estimator falls back to what it receives. */
  feedbackFreshMs: number;
};

export const ESTIMATOR_TUNING: EstimatorTuning = {
  windowMs: 1000,
  delayFloorMs: 10_000,
  backlogWindowMs: 150,
  lossNeedsQueue: true,
  strainedBufferMs: 50,
  strainedLossPct: 3,
  strainedQueueMs: 40,
  congestedBufferMs: 150,
  congestedLossPct: 10,
  congestedQueueMs: 100,
  congestedQueueForMs: 500,
  feedbackFreshMs: 3000,
};

export const GATE_TUNING: Required<GateTuning> = {
  dropEveryMs: 500,
  dropHoldMinMs: 1000,
  dropHoldRttFactor: 2,
  reactionMs: 250,
  riseAfterMs: 5000,
  riseProbationMs: 3000,
  riseAfterMaxMs: 60_000,
  staleBufferMs: 200,
  starvedAfterMs: 1000,
  replayBufferMs: 250,
  replayGraceMs: 500,
};

export const SOURCE_RATE_TUNING: SourceRateTuning = { everyMs: 1000, congestedShare: 0.5, downFactor: 0.85, okForMs: 10_000, upFactor: 1.05 };

export type ProbeTuning = {
  /** Probe packets are this big: the largest packet there is. */
  packetBytes: number;
  /** The probe keeps this many packets more in the channel than the link takes between two calls. */
  headroomPackets: number;
  /** However fast the link, the probe never leaves more than this in the channel. */
  maxWindowBytes: number;
  /** A late timer is not made up for beyond this much sending time. */
  maxCatchUpMs: number;
  /** After the last packet, the result waits this long for the feedback that covers it. */
  settleMs: number;
};

export const PROBE_TUNING: ProbeTuning = { packetBytes: 1150, headroomPackets: 2, maxWindowBytes: 64 * 1150, maxCatchUpMs: 25, settleMs: 400 };
