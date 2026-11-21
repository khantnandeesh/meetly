/**
 * topology: where this peer sits in the trees and how it stays there. Choosing a parent, keeping
 * a warm backup, heartbeats, noticing a dead parent, repairing, the GOP cache that makes repair
 * lossless, and forwarding to children. SPEC §6, §7, §8.
 *
 * Owner: E-transport+topology. This file is the module's contract with the others: change it
 * only as docs/overlay/PLAN.md "Changing an interface" says.
 */
import type { Clock, Listenable, Logger, SessionClock } from "../runtime";
import type { Assignment, Capabilities, MediaHeader, MetricsEvent, OverlayParams, OverlayRole, PeerHint, PeerId, StreamConfig, StreamHead } from "../protocol";
import type { EncodedFrame, LayerCap, LinkEstimate, ReceivedFrame } from "../types";
import type { LinkManager } from "../transport/types";
import type { LayerGate, LayerGateOptions, LinkEstimator } from "../congestion/types";

/* ------------------------------ the GOP cache ------------------------------ */

/**
 * The packets of each stream since its last keyframe (and a little before), exactly as they
 * arrived. It answers two questions: "send me everything after frame X" (a join or a repair) and
 * "send me fragment F of frame X again" (a NACK). Held by every peer that has children, and by
 * the source.
 */
export interface GopCache {
  /** Keeps `packet` (a copy is taken). */
  add(packet: Uint8Array, header: MediaHeader, now: number): void;
  /**
   * The packets a subscriber needs to continue after `fromFrame` (a frame id, or
   * `FROM_LATEST_KEYFRAME`), within `cap` and `stripes`, in sending order. If `fromFrame` is
   * older than the cache reaches, it starts at the newest keyframe instead.
   */
  replay(streamId: number, stripes: readonly number[], fromFrame: number, cap: LayerCap): Uint8Array[];
  /** The packets of one frame, or just the fragments asked for. Empty if they are gone. */
  fragments(streamId: number, frameId: number, fragments: readonly number[] | null): Uint8Array[];
  head(streamId: number): StreamHead | null;
  /** Drops whatever is beyond the limits. Called as packets are added; public for tests. */
  trim(now: number): void;
  bytes(): number;
}

export type GopCacheOptions = { maxMs: number; maxBytes: number };

/* ------------------------------ choosing a parent ------------------------------ */

/** A possible parent, with what this peer has measured of it so far. */
export type Candidate = PeerHint & {
  /** Null until measured over a standby link. */
  rttMs: number | null;
  lossPct: number;
  /** Its path to the source, itself first. A candidate whose path contains this peer is never chosen. */
  path: PeerId[] | null;
  /** The link to it goes through TURN. */
  turn: boolean;
};

/**
 * Lower is better (SPEC §8.3). Exported so the coordinator's placement and a peer's own choice
 * rank the same way.
 */
export type ParentCost = (candidate: Candidate) => number;

export interface ParentSelector {
  /** Candidates this peer may use, best first. */
  rank(self: PeerId, candidates: Candidate[]): Candidate[];
  /** Whether to leave `current` for `best` of its own accord, given how long ago it last moved (SPEC §7.6). */
  shouldSwitch(current: Candidate, best: Candidate, sinceLastSwitchMs: number): boolean;
}

/* ------------------------------ who may relay ------------------------------ */

/** What has been seen of a peer since it joined, as opposed to what it said of itself. */
export type Observed = {
  uptimeMs: number;
  /** Measured by `UplinkProbe`, or null before that. */
  spareUplinkKbps: number | null;
  lossPct: number;
  /** Parents it had that it left or lost, per minute. */
  churnPerMin: number;
};

export type RelayVerdict = {
  eligible: boolean;
  /** Why not, in the order checked. Empty when eligible. */
  reasons: ("browser" | "mobile" | "battery" | "nat" | "data-saver" | "hidden" | "uplink" | "probation" | "lossy")[];
  /** Active children it may take: 0 when not eligible. */
  fanout: number;
  /** 0..1: among eligible relays, who is put nearer the source. */
  score: number;
};

/** SPEC §8.1–§8.2. Pure, and used by both the coordinator and the peer itself. */
export type JudgeRelay = (caps: Capabilities, observed: Observed, streamKbps: number, params: OverlayParams) => RelayVerdict;

/* ------------------------------ the node ------------------------------ */

/** Where one stripe of one stream stands. The states and their transitions are SPEC §7. */
export type StripeState =
  /** Not subscribed. */
  | "idle"
  /** Opening links to candidates and measuring them. */
  | "probing"
  /** `sub` sent to the chosen parent; no `sub-ack` yet. */
  | "subscribing"
  /** Media is flowing from the parent. */
  | "active"
  /** The parent says it is repairing (`HeartbeatFlag.Stalled`): waiting up to `stallGraceMs`. */
  | "waiting"
  /** The parent is dead; `repair` sent to the backup. */
  | "repairing"
  /** No live backup: asking the coordinator, or the neighbours, for a new parent. */
  | "cold-repair"
  /** Nothing worked: starting again from `hello`, with backoff. */
  | "rejoining";

export type StripeStatus = {
  stream: number;
  stripe: number;
  state: StripeState;
  parent: PeerId | null;
  backup: PeerId | null;
};

export type NodeStatus = {
  role: OverlayRole;
  depth: number;
  /** This peer, its parent, … the source. */
  path: PeerId[];
  stripes: StripeStatus[];
  children: PeerId[];
  standbyChildren: PeerId[];
  freeSlots: number;
};

/** What the node needs from the coordinator. `coordinator/client.ts` provides it; tests fake it. */
export interface CoordinatorPort {
  /** False while the socket is down. Repair must work regardless (SPEC §7.5). */
  readonly connected: boolean;
  need(stream: number, stripe: number, want: "parent" | "backup", exclude: PeerId[]): Promise<Assignment | null>;
  report(event: "parent-dead" | "parent-switch" | "backup-lost" | "link-failed" | "child-gone", stream: number, stripe: number, peer: PeerId, next?: PeerId | null): void;
  /** `assign` and `role` messages the coordinator sends unasked. */
  onAssign(listener: (assignments: Assignment[], reason: "join" | "need" | "rebalance") => void): () => void;
  onRole(listener: (role: OverlayRole) => void): () => void;
  onPeerGone(listener: (peer: PeerId) => void): () => void;
}

export type OverlayNodeEvents = {
  /** A whole frame for this peer's own playout. Not fired on the source. */
  frame: [frame: ReceivedFrame];
  /** A stream's configuration arrived or changed. */
  config: [config: StreamConfig];
  /** `status()` changed. */
  status: [];
  /** Something for the metrics sample: a join, a repair, a switch, a layer change. */
  metric: [event: MetricsEvent];
  /** How the link to the parent is doing, about once a second: the player sizes its delay from it. */
  uplink: [estimate: LinkEstimate];
  /** The node gave up and is rejoining, or was told to leave. */
  error: [error: Error];
};

/**
 * One peer's place in the overlay. It owns the heartbeat and feedback timers, the failure
 * detector, the repair state machine, the GOP cache and the forwarding loop, and drives the
 * links (transport) and the gates (congestion).
 */
export interface OverlayNode extends Listenable<OverlayNodeEvents> {
  /** Begin, with what `welcome` said. */
  start(role: OverlayRole, streams: StreamConfig[], assignments: Assignment[]): void;
  /** The source only: send this frame to the overlay. */
  publish(frame: EncodedFrame): void;
  /** The source only: a stream's configuration changed. */
  publishConfig(config: StreamConfig): void;
  /** What the player can use right now; passed upstream in feedback. */
  setWanted(streamId: number, cap: LayerCap): void;
  /** The oldest frame of a stream the player still wants: nothing older is NACKed. */
  setOldestWanted(streamId: number, frameId: number | null): void;
  status(): NodeStatus;
  /** The estimates of the links to direct children: the source feeds them to its rate controller. */
  childEstimates(): LinkEstimate[];
  /** Leave gracefully: `bye` to children with somewhere to go, then to parents (SPEC §7.7). */
  stop(): Promise<void>;
}

export type OverlayNodeOptions = {
  self: PeerId;
  links: LinkManager;
  coordinator: CoordinatorPort;
  params: OverlayParams;
  clock: Clock;
  sessionClock: SessionClock;
  /** From the congestion module; injected so topology can be tested with fakes. */
  createLinkEstimator: () => LinkEstimator;
  createLayerGate: (options: LayerGateOptions) => LayerGate;
  logger?: Logger;
};
