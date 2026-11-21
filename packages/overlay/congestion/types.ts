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
  estimate(now: number): LinkEstimate;
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
  /** How many bytes of replay may be handed to the channel now, so a catch-up does not swamp live media. */
  replayBudget(estimate: LinkEstimate, now: number): number;
}

export type LayerGateOptions = {
  /** The stream's bitrate with every layer, and with each temporal layer and below. */
  bitrateKbps: number;
  temporalLayers: number;
  frameIntervalMs: number;
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

export type SourceRateOptions = { maxKbps: number; minKbps: number };

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
