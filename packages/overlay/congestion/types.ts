/**
 * congestion: what each link can carry, and what to do when that is less than the stream.
 * It is all arithmetic on numbers it is handed: it owns no timer, link or channel, which is what
 * lets every rule in SPEC §11 be a unit test with a fake clock.
 *
 * Owner: E-congestion. This file is the module's contract with the others: change it only as
 * docs/overlay/PLAN.md "Changing an interface" says.
 */
import type { Listenable } from "../runtime";
import type { Feedback, Heartbeat, MediaHeader } from "../protocol";
import type { LayerCap, LinkEstimate } from "../types";

/** The fields of a `Feedback` packet that the estimator fills; the link adds `linkSeq` and `sendMs`. */
export type FeedbackBody = Pick<Feedback, "highestSeq" | "received" | "expected" | "jitterTenthsMs" | "queueDelayTenthsMs" | "echoMs" | "echoHoldMs">;

/**
 * One per link, covering both directions: what arrives from the peer (to tell it, in feedback)
 * and what the peer says of what we send (to act on). All times are this machine's `Clock`.
 */
export interface LinkEstimator {
  /** Any packet arrived on the unreliable channel. */
  onReceived(linkSeq: number, sendMs: number, bytes: number, now: number): void;
  /** Any packet was handed to the unreliable channel. */
  onSent(bytes: number, now: number): void;
  /** The peer's feedback about what we sent it. */
  onFeedback(feedback: Feedback, now: number): void;
  /** The peer's heartbeat: carries an echo, so a round-trip time. */
  onHeartbeat(heartbeat: Heartbeat, now: number): void;
  /** The channel's `bufferedAmount`, sampled by the sender before each frame. */
  onBuffered(bytes: number, now: number): void;
  /** What to tell the peer about the interval since the last call. Resets the interval. */
  takeFeedback(now: number): FeedbackBody;
  /** The echo fields for a heartbeat we are about to send. */
  echo(now: number): { echoMs: number; echoHoldMs: number };
  /**
   * The link as a whole: the direction that carries the media. A peer that hears fresh feedback
   * and sends at least as much as it receives is judged on what it sends; otherwise on what it
   * receives.
   */
  estimate(now: number): LinkEstimate;
  /**
   * One direction by name. "sent": what the peer's feedback says of what we send (a parent's view
   * of a child; a prober's view of its probe). "received": what we measure of what arrives (a
   * child's view of its parent, whatever it is sending upstream at the time).
   */
  directed?(direction: "sent" | "received", now: number): LinkEstimate;
}

export type LayerGateEvents = {
  /** What this child is sent changed. Topology tells the child (`layers`) and records a metric. */
  change: [cap: LayerCap, reason: "congestion" | "overload" | "restore"];
  /** Even the base layer does not fit. Topology tells the child to find a better parent (SPEC §11.3). */
  starved: [];
};

/**
 * One per child and stream: decides, frame by frame, whether a frame is sent to that child.
 * It always answers for a whole frame, so a frame is never sent in part.
 */
export interface LayerGate extends Listenable<LayerGateEvents> {
  /**
   * Whether to send the frame whose first packet has `header`. Called once per frame, with the
   * link's estimate and `bufferedAmount` at that moment.
   */
  admit(header: MediaHeader, frameBytes: number, estimate: LinkEstimate, now: number): boolean;
  /** The child asked for no more than this. */
  setWanted(cap: LayerCap): void;
  /** This relay has more children than slots (after a repair): cap everyone until rebalanced. */
  setOverload(on: boolean): void;
  readonly cap: LayerCap;
  /**
   * How many bytes of replay may be handed to the channel now, so a catch-up does not swamp live
   * media. Ask only when there is replay waiting: the gate takes a budget it gave as a replay in
   * progress, and for a moment afterwards reads the channel's backlog as the replay's own.
   */
  replayBudget(estimate: LinkEstimate, now: number): number;
  /**
   * Whether `admit` let this frame through, for the last 256 frames. A frame the gate refused
   * must not reach the child by another door: a NACK for it is not answered.
   */
  wasSent?(frameId: number): boolean;
}

/** The numbers of SPEC §11.3 and §11.5. `GATE_TUNING` (./tuning.ts) holds the spec's values. */
export type GateTuning = {
  /** Rule 3: the cap drops at most once in this long. */
  dropEveryMs: number;
  /**
   * Rule 3 (decided by the integrator, 2026-11-21): after a drop, the next waits at least this
   * long, so the link can show what the first drop did.
   */
  dropHoldMinMs?: number;
  /** Rule 3: or this many times the link's reaction time (`rttMs` + `reactionMs`), if longer. */
  dropHoldRttFactor?: number;
  /** Rule 3: what the link's reaction takes beyond a round trip: a feedback interval and the backlog's standing window. */
  reactionMs?: number;
  /** Rule 5: this long *ok* before the cap rises. */
  riseAfterMs: number;
  /** Rule 5: congested again within this long of a rise, and the wait doubles. */
  riseProbationMs: number;
  /** Rule 5: the wait never exceeds this. */
  riseAfterMaxMs: number;
  /** Rule 6: no video once `bufferedBytes` is over this many ms of B. */
  staleBufferMs: number;
  /** Rule 7: congested this long at the base layer is starved. */
  starvedAfterMs: number;
  /** §11.5: a replay may fill the channel up to this many ms of B. */
  replayBufferMs: number;
  /**
   * Not in the spec (see README, "Where the spec was silent"): for this long after a replay was
   * last given a budget, the channel's own backlog is the replay's and is not read as congestion.
   */
  replayGraceMs: number;
};

export type LayerGateOptions = {
  /** The stream's bitrate with every layer, and with each temporal layer and below. */
  bitrateKbps: number;
  temporalLayers: number;
  frameIntervalMs: number;
  /**
   * An audio stream's gate refuses nothing. Without this, the gate takes stream 1 for audio and
   * every other stream for video, which is stage 1 (SPEC §2).
   */
  kind?: "video" | "audio";
  /** 1 when absent: stage 1 has one spatial layer. */
  spatialLayers?: number;
  /** Other numbers than SPEC §11.3's, for a test or a tuning run. */
  tuning?: Partial<GateTuning>;
};

export type SourceRateEvents = {
  /** The video encoder should aim for this. */
  target: [kbps: number];
};

/** One, at the source: turns the state of its own uplink, and the coordinator's hints, into an encoder bitrate. */
export interface SourceRateController extends Listenable<SourceRateEvents> {
  /** The estimates of every link to a direct child, sampled about once a second. */
  onChildren(estimates: LinkEstimate[], now: number): void;
  /** The coordinator's view of the whole audience (`hint`). */
  onHint(bitrateKbps: number, now: number): void;
  readonly targetKbps: number;
}

/** The numbers of SPEC §11.4. `SOURCE_RATE_TUNING` (./tuning.ts) holds the spec's values. */
export type SourceRateTuning = {
  /** §11.4: the uplink rule is applied once in this long. */
  everyMs: number;
  /** Down: at least this share of the direct children's links congested. */
  congestedShare: number;
  downFactor: number;
  /** Up: every link *ok* for this long. */
  okForMs: number;
  upFactor: number;
};

export type SourceRateOptions = { maxKbps: number; minKbps: number; tuning?: Partial<SourceRateTuning> };

/**
 * Measures how much more a peer could send than it does, by loading a link with probe packets
 * for a moment. The answer is `Capabilities.uplinkKbps`, which decides who may relay (SPEC §8).
 */
export interface UplinkProbe {
  /** Packets to send now, as sizes in bytes. Empty when the probe is idle or done. */
  next(estimate: LinkEstimate, now: number): number[];
  /** The result, once there is one. */
  readonly spareKbps: number | null;
}
