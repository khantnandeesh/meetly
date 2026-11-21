/**
 * harness: many real peers in headless Chromium against one coordinator, with bad networks and
 * people leaving, and a report that says whether the go/no-go gate is met. SPEC §13.
 *
 * It is the only module that depends on Playwright and on Node. Nothing else in the package may
 * import from it, except `ImpairmentProfile`, which the transport's `wrapChannel` hook is given.
 *
 * Owner: E-harness. This file is the module's contract with the others: change it only as
 * docs/overlay/PLAN.md "Changing an interface" says.
 */
import type { MetricsSample, OverlayParams, PeerId } from "../protocol";
import type { ChannelKind, PacketChannel } from "../transport/types";

/* ------------------------------ impairment ------------------------------ */

/** What one direction of one link is made to suffer. Applied where a packet is handed to its channel. */
export type ImpairmentProfile = {
  name: string;
  /** Added to every packet. */
  delayMs: number;
  /** Extra delay, different for each packet, up to this much. Packets may overtake each other. */
  jitterMs: number;
  /** Packets dropped, in percent. On the reliable channel a "dropped" message is delayed by `retransmitMs` instead. */
  lossPct: number;
  /** Losses in bursts (Gilbert–Elliott) instead of one by one. */
  burst?: { enterPct: number; leavePct: number; lossPctInBurst: number };
  /** The most the link carries. More than this queues, up to `queueMs`, and then is dropped. */
  kbps?: number;
  queueMs?: number;
  retransmitMs?: number;
};

/** The transport's `wrapChannel` hook, made from profiles. `seed` makes a run repeatable. */
export type ImpairmentFactory = (
  pick: (info: { self: PeerId; peer: PeerId; kind: ChannelKind }) => ImpairmentProfile | null,
  seed: number,
) => (channel: PacketChannel, info: { peer: PeerId; kind: ChannelKind }) => PacketChannel;

/* ------------------------------ a run ------------------------------ */

/** Something done to the swarm at a moment of the run. */
export type ChurnEvent =
  | { atS: number; action: "kill"; pick: PeerPick; count: number }
  | { atS: number; action: "leave"; pick: PeerPick; count: number }
  | { atS: number; action: "join"; count: number; profile?: string }
  | { atS: number; action: "impair"; pick: PeerPick; count: number; profile: string }
  | { atS: number; action: "kill-coordinator"; forS: number };

/** Whom a churn event falls on. Resolved against the coordinator's tree at that moment, with the run's seed. */
export type PeerPick = "any" | "relay" | "leaf" | "deepest-relay" | "busiest-relay";

export type SwarmConfig = {
  /** Shared by every shard of one run. */
  runId: string;
  seed: number;
  /** "http://127.0.0.1:4100", or the deployed coordinator. */
  coordinatorUrl: string;
  room: string;
  admissionSecret: string;
  /** Peers in the whole run, the source included. */
  peers: number;
  /** This process runs the peers whose index modulo `count` is `index`. Shard 0 also runs the source. */
  shard: { index: number; count: number };
  durationS: number;
  /** Viewers joining per second while the swarm fills. */
  joinPerS: number;
  /** Named profiles, and what share of peers gets each. */
  profiles: ImpairmentProfile[];
  mix: { profile: string; share: number }[];
  churn: ChurnEvent[];
  /** One viewer in this many decodes for real; the rest run the light player (SPEC §13.2). 1 = all. */
  decodeEvery: number;
  pagesPerBrowser: number;
  /** "host": host candidates only, one machine. "stun" and "turn": for shards on different machines. */
  ice: "host" | "stun" | "turn";
  params?: Partial<OverlayParams>;
};

/** What one shard hands back: every metrics sample of every peer it ran. */
export type ShardResult = {
  runId: string;
  shard: { index: number; count: number };
  startedAt: number;
  endedAt: number;
  peersStarted: number;
  /** Peers whose page crashed or never joined: a run with any is not a valid measurement. */
  peersFailed: { index: number; why: string }[];
  samples: MetricsSample[];
  /** What the machine could not keep up with: a run that starved is not a valid measurement. */
  host: { cores: number; loadAvg1: number[]; maxEventLoopLagMs: number };
};

export type Quantiles = { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null };

/** The go/no-go gate for stage 1 (SPEC §12.3). */
export const GATE = { peers: 200, repairP95Ms: 500, glassToGlassP95Ms: 500, joinP95Ms: 3000 } as const;

export type SwarmReport = {
  runId: string;
  peers: number;
  shards: number;
  durationS: number;
  /** From `join` events: `firstFrame - start`. */
  joinMs: Quantiles;
  /** From `repair` events: `freezeMs`. */
  repairMs: Quantiles;
  /** From every rendered frame of every viewer. */
  glassToGlassMs: Quantiles;
  /** The same, split by depth in the tree. */
  glassToGlassByDepth: Record<number, Quantiles>;
  repairs: { warm: number; cold: number; wait: number; usedCoordinator: number; framesLost: number };
  freezes: { count: number; totalMs: number };
  /** Each check of the gate, and whether the run was big and clean enough to count. */
  gate: { pass: boolean; valid: boolean; checks: { name: string; limit: number; value: number | null; pass: boolean }[]; notes: string[] };
};

/* ------------------------------ the page ------------------------------ */

/**
 * What the harness's page puts on `window.__overlay` for the driver to call through Playwright.
 * Each page is one peer.
 */
export interface PageApi {
  start(options: { coordinatorUrl: string; room: string; ticket: string; role: "source" | "viewer"; decode: boolean; profile: ImpairmentProfile | null; seed: number }): Promise<void>;
  setProfile(profile: ImpairmentProfile | null): void;
  /** Samples not yet taken by an earlier call. */
  takeSamples(): MetricsSample[];
  /** Leave as a person would. */
  leave(): Promise<void>;
}
