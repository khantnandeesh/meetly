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
import type { IceServer, MetricsSample, OverlayParams, PeerId } from "../protocol";
import type { Clock } from "../runtime";
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
  options?: ImpairmentOptions,
) => (channel: PacketChannel, info: { peer: PeerId; kind: ChannelKind }) => PacketChannel;

/** What the shim did, for the report: a harness that cannot keep its own time is a bad instrument. */
export type ImpairmentCounters = {
  sent: number;
  delivered: number;
  /** Dropped as loss. */
  lost: number;
  /** Dropped because a capped link's queue was full. */
  queueDropped: number;
  /** How much later than planned packets were handed on, summed and at worst: the timers' own error. */
  lateMsSum: number;
  lateMsMax: number;
};

export type ImpairmentOptions = {
  /** This peer: given to `pick` as `self`, and part of each link's seed. */
  self?: PeerId;
  /** Defaults to the machine's own. */
  clock?: Clock;
  /** Added to by every channel the factory wraps. */
  counters?: ImpairmentCounters;
};

/* ------------------------------ a run ------------------------------ */

/** Something done to the swarm at a moment of the run. */
export type ChurnEvent =
  | { atS: number; action: "kill"; pick: PeerPick; count: number }
  | { atS: number; action: "leave"; pick: PeerPick; count: number }
  | { atS: number; action: "join"; count: number; profile?: string }
  /**
   * `link` "access" (the default): the profile is the peer's own network, on every link it has.
   * "from-parent": only the one link to whoever is its parent at that moment, as if that parent's
   * link to it were the slow one; its links to its own children stay clean (PLAN C3).
   */
  | { atS: number; action: "impair"; pick: PeerPick; count: number; profile: string; link?: "access" | "from-parent" }
  | { atS: number; action: "kill-coordinator"; forS: number };

/** Whom a churn event falls on. Resolved against the coordinator's tree at that moment, with the run's seed. */
export type PeerPick = "any" | "relay" | "leaf" | "deepest-relay" | "shallowest-relay" | "busiest-relay" | "impaired";

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
  /** Who does what, when shard 0 has laid the run out (./layout.ts). Without it, the modulo rule above. */
  layout?: ShardLayout;
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
  /** The scenario this run was made from, for the report. */
  scenario?: string;
  /**
   * What runs in each page. "real": `createOverlayViewer` / `createOverlaySource`. "standin": the
   * harness's own small engine (./page/standin.ts), there so the harness can be built and tested
   * before the modules exist. "auto" (the default): the real one if it is built, else the stand-in.
   */
  engine?: "auto" | "real" | "standin";
  /**
   * Where the coordinator comes from. "auto": the package's Node entry point if it is built, else
   * the harness's stand-in. "external": `coordinatorUrl` is already running (another shard, or
   * another job, started it).
   */
  coordinator?: "auto" | "real" | "standin" | "external";
  /** The stand-in's program: a real VP8 encode of Chromium's fake camera, or frames of the right sizes with no picture in them. */
  program?: {
    source: "camera" | "synthetic";
    bitrateKbps: number;
    fps: number;
    keyIntervalFrames: number;
    /**
     * "camera" only: pad each encoded frame up to the size a synthetic frame of its layer would
     * have, so the stream really is `bitrateKbps` (Chromium's fake camera encodes to far less) and
     * a few viewers can still decode it as D29's check.
     */
    pad?: boolean;
  };
  /** STUN and TURN servers, for `ice` "stun" and "turn". */
  iceServers?: IceServer[];
  /** Seconds the swarm takes to fill, when it is not to be worked out from `joinPerS`. */
  fillS?: number;
  /**
   * When the run starts, in milliseconds since the Unix epoch: the same on every shard, so that
   * their joins and their churn line up without their talking. Default: now.
   */
  startAtMs?: number;
  /** What the report asks of this run in place of the gate's 200 peers and 100 repairs: for the small scenarios. */
  expect?: ReportOptions;
  /** Called with each line of progress. */
  log?: (line: string) => void;
};

/**
 * Which runner does what (./layout.ts): the coordinator alone on one, the source alone on another,
 * the viewers spread over the rest, and the runners that cannot take part left out.
 */
export type ShardLayout = { coordinatorShard: number; sourceShard: number; viewerShards: number[]; excluded: { shard: number; why: string }[] };

/** What one shard hands back: every metrics sample of every peer it ran. */
export type ShardResult = {
  runId: string;
  shard: { index: number; count: number };
  startedAt: number;
  endedAt: number;
  peersStarted: number;
  /** Set when this shard was left out of the run (./layout.ts) and started no peer: not a failure. */
  excluded?: string;
  /** What this shard did. */
  role?: "coordinator" | "source" | "viewers" | "all" | "excluded";
  /** How many of the run's peers (not churn's later joins) this shard started. */
  peersOfRun?: number;
  /** "turn" offered a relay to every link; anything else, none was. */
  ice?: SwarmConfig["ice"];
  /** Peers whose page crashed or never joined: a run with any is not a valid measurement. */
  peersFailed: { index: number; why: string }[];
  samples: MetricsSample[];
  /** What the machine could not keep up with: a run that starved is not a valid measurement. */
  host: {
    cores: number;
    loadAvg1: number[];
    /** The same, only once the swarm had filled: what the health bar is read from. */
    loadAvg1Settled?: number[];
    maxEventLoopLagMs: number;
    /** This machine's own time sync (chrony), if it could be read: `boundMs` = |offset| + root delay / 2 + root dispersion. */
    ntp?: { boundMs: number | null; text: string };
    /** What NAT this machine is behind, by two STUN servers (ci/natcheck.mjs): symmetric needs TURN between machines. */
    nat?: { symmetric: boolean | null; mapped: string[] };
    /** The driver's own event-loop lag, and its pages', as histograms on the 97 latency buckets. */
    driverLag?: number[];
    pageLag?: number[];
  };
  /** The whole run's size and length, so a report can tell a missing shard from a small run. */
  peers?: number;
  durationS?: number;
  scenario?: string;
  seed?: number;
  expect?: ReportOptions;
  /** What ran in the pages and as the coordinator. */
  engine?: "real" | "standin";
  coordinator?: "real" | "standin" | "external";
  /** Parts of the package that were still stubs, by name. A run with any is not a test of the overlay. */
  stubbed?: string[];
  /**
   * Session-clock uncertainty (SPEC §4.1), in milliseconds: the source's, if this shard ran it,
   * and each viewer's, at their worst during the run. Latency between two peers is wrong by up
   * to the sum of theirs.
   */
  clock?: {
    source: number | null;
    viewers: number[];
    /**
     * Each page's session clock minus this machine's wall clock (`Date.now()`), at its last poll:
     * an independent check of the bound above. Two pages' values differ by their clocks' real
     * disagreement plus how far apart their machines' wall clocks are (`host.ntp` bounds that).
     */
    sourceVsWallMs?: number | null;
    viewersVsWallMs?: number[];
    /** The same, as the lowest and highest seen over the whole run: the worst moment counts, not the last. */
    sourceVsWallRangeMs?: [number, number] | null;
    viewersVsWallRangeMs?: [number, number][];
  };
  /** Links the shard's peers opened, and how: what ICE chose. */
  links?: LinkCounts;
  /** The viewers that decoded for real (D29); every other viewer ran the light player. */
  decoders?: PeerId[];
  impairment?: ImpairmentCounters;
  /** What the churn script did, and to whom. */
  churnLog?: { atS: number; action: string; targets: string[]; peer?: PeerId; sessionMs?: number }[];
  /** Each peer's parent when the run ended, as its page said: who was under whom. */
  tree?: { peer: PeerId; parent: PeerId | null; index: number }[];
  notes?: string[];
};

/** Links opened, and what ICE chose for them. `crossShard`: the other end ran on another shard. */
export type LinkCounts = {
  opened: number;
  failed: number;
  turn: number;
  candidates: Record<string, number>;
  crossShard: number;
  crossShardTurn: number;
  /** Links to a peer on another shard that never opened: what ICE could not do between machines. */
  crossShardFailed?: number;
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
  gate: {
    pass: boolean;
    valid: boolean;
    checks: GateCheck[];
    notes: string[];
    /** What makes a run a measurement at all (SPEC §12.3). `valid` is all of these. */
    validity: GateCheck[];
    /** "invalid": neither a pass nor a fail. */
    verdict: "pass" | "fail" | "invalid";
    /** 200 peers and no stubbed module: only then is the verdict the gate's. */
    isGate: boolean;
  };
  /** Freezes, as lengths. */
  freezeMs: Quantiles;
  frames: { rendered: number; dropped: number; lost: number };
  /** Over viewers: the viewer's clock uncertainty plus the source's. Its p95 is the validity check. */
  clockUncertaintyMs: Quantiles;
  /**
   * The same, shard by shard. The source runs on shard 0, so on every other shard each sum is a
   * cross-shard one: two machines, two clocks, both reading the session clock through their own
   * path to the coordinator.
   */
  clockByShard: {
    shard: number;
    viewers: number;
    p95: number | null;
    max: number | null;
    /** |viewer's session clock − source's|, both read against wall clocks: what the clocks really disagreed by, give or take `ntpBoundMs`. */
    measuredP95?: number | null;
    /** The two machines' wall clocks may differ by up to this (theirs plus shard 0's). */
    ntpBoundMs?: number | null;
  }[];
  /** Shards the layout left out (./layout.ts), and why. Not failures: they started no peer. */
  excluded: { shard: number; why: string; nat: string[] }[];
  /** What part of a real audience the run speaks for, when it is not all of it. */
  coverage: string | null;
  /** What the stream really was: `up.rxKbps` of every viewer at depth 1, sample by sample. Too low, and a "slow" cap is not under it. */
  streamKbps: Quantiles;
  /** Viewer-plus-source clock disagreement as measured against wall clocks, with their bounds; null when a shard could not be read so. */
  measuredClockMs: Quantiles | null;
  /** Where joins' time went: connect() to welcome, to a parent linked, to its first packet, to the first frame. Exact. */
  joinPhasesMs: { welcome: Quantiles; linked: Quantiles; firstPacket: Quantiles; firstFrame: Quantiles };
  /** Latency of the viewers that decoded for real, and of the light ones (D29). */
  glassToGlassDecoding: Quantiles;
  glassToGlassLight: Quantiles;
  /**
   * Whether the instrument can be believed, beyond SPEC §12.3's validity: light viewers agree with
   * decoding ones (D29). A failure here is a note on every number, not a verdict.
   */
  honesty: GateCheck[];
  /** Event-loop lag over every shard's driver and pages. */
  eventLoopLagMs: Quantiles;
  hosts: { shard: number; role?: ShardResult["role"]; cores: number; loadAvg1Max: number; lagP99Ms: number | null; peersStarted?: number; peersFailed?: number; joins?: number; nat?: "symmetric" | "open" | "unknown"; loadSettledMax?: number }[];
  engine: "real" | "standin" | "mixed" | "unknown";
  /** Parts of the package that were stubs in any shard. */
  stubbed: string[];
  links: LinkCounts;
  impairment: (ImpairmentCounters & { lateMsMean: number }) | null;
  scenario: string | null;
  failed: { shard: number; index: number; why: string }[];
};

export type GateCheck = { name: string; limit: number; value: number | null; pass: boolean };

/** What `buildReport` asks of a run when it is not the gate itself. */
export type ReportOptions = { peers?: number; minRepairs?: number };

/* ------------------------------ the page ------------------------------ */

/**
 * What the harness's page puts on `window.__overlay` for the driver to call through Playwright.
 * Each page is one peer.
 */
export interface PageApi {
  start(options: PageStartOptions): Promise<void>;
  /** With `onlyPeer`, the profile applies to the link to that peer alone ("parent": the current parent's), and every other link is clean. */
  setProfile(profile: ImpairmentProfile | null, onlyPeer?: PeerId | "parent"): void;
  /** Samples not yet taken by an earlier call. */
  takeSamples(): MetricsSample[];
  /** Leave as a person would. */
  leave(): Promise<void>;
  /** Everything else the driver reads, in one call. */
  state(): PageState;
}

export type PageStartOptions = {
  coordinatorUrl: string;
  room: string;
  ticket: string;
  role: "source" | "viewer";
  decode: boolean;
  profile: ImpairmentProfile | null;
  seed: number;
  engine?: "auto" | "real" | "standin";
  ice?: "host" | "stun" | "turn";
  program?: SwarmConfig["program"];
  /** The peer's index in the run, and its shard: for logs, and to tell a link between shards. */
  index?: number;
  shard?: number;
};

export type PageState = {
  engine: "real" | "standin";
  peer: PeerId | null;
  /** The first frame has been rendered (a viewer), or the program is being sent (the source). */
  started: boolean;
  error: string | null;
  /** How many times a viewer of the package's engine called `connect()` before it got in. */
  connectAttempts?: number;
  /** Session clock minus `Date.now()`, now: see `ShardResult.clock.viewersVsWallMs`. Null before the clock is known. */
  sessionMinusWallMs?: number | null;
  /** The session clock's uncertainty now, and at its worst since the first probes. */
  clockUncertaintyMs: number;
  clockUncertaintyMaxMs: number;
  /** This page's event-loop lag since the last call, on the 97 latency buckets. */
  lag: number[];
  links: LinkCounts;
  impairment: ImpairmentCounters;
  parent: PeerId | null;
  backup: PeerId | null;
  children: number;
  depth: number;
};
