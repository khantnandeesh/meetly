/**
 * coordinator: who is in a session, what each may do, where each sits in the trees, and a relay
 * for WebRTC signalling. One per session. It never sees media, and the overlay keeps playing
 * and repairing without it; only joining needs it. SPEC §6.
 *
 * The logic is one class, `CoordinatorCore`, that does no I/O: it is told what happened and
 * answers with what to do (`Effect`s). Two thin entry points run it, a Durable Object
 * (./durableObject.ts) and a Node WebSocket server for tests (./node.ts), so the two cannot
 * behave differently.
 *
 * Owner: E-coordinator. This file is the module's contract with the others: change it only as
 * docs/overlay/PLAN.md "Changing an interface" says.
 */
import type { Clock, Listenable, Logger, SessionClock } from "../runtime";
import type { Capabilities, IceServer, MetricsSample, OverlayParams, OverlayRole, PeerId, ServerMessage, ServerMessageOf, StreamConfig } from "../protocol";
import type { Signaler } from "../transport/types";
import type { CoordinatorPort, JudgeRelay, ParentCost } from "../topology/types";

/* ------------------------------ the core ------------------------------ */

/** One WebSocket, as the entry point names it. */
export type ConnId = string;

/** What the entry point must do for the core. Carried out in order. */
export type Effect =
  | { type: "send"; conn: ConnId; message: ServerMessage }
  | { type: "close"; conn: ConnId; code: number; reason: string }
  /** Call `tick` no later than `at` (milliseconds since the Unix epoch). Replaces any earlier request. */
  | { type: "wake"; at: number }
  /** Keep `value` under `key` across restarts; null forgets it. Only what cannot be rebuilt from peers (SPEC §6.6). */
  | { type: "persist"; key: string; value: string | null }
  /**
   * Keep `value` with this socket across the entry point's own restarts (a Durable Object
   * hibernating). At most 2,000 characters.
   */
  | { type: "attach"; conn: ConnId; value: string };

/** What the entry point knows about a new socket before any message. */
export type ConnMeta = {
  /** A coarse place: a Cloudflare colo, or whatever the test says. */
  region?: string;
};

/** A request to the session's HTTP API (SPEC §6.2), already routed to this session. */
export type CoreRequest = {
  method: "GET" | "POST";
  /** What follows `/overlay/v1/rooms/<room>`: "/stats", "/end", "/kick", "/tree", "/metrics". */
  path: string;
  /** The bearer token of the `Authorization` header, if any. */
  bearer: string | null;
  body: unknown;
};
export type CoreResponse = { status: number; body: unknown };

/** One peer, as the coordinator has it. Rebuilt from `status` messages; not the truth, a recent report of it. */
export type PeerRecord = {
  peer: PeerId;
  conn: ConnId | null;
  identity: string;
  role: OverlayRole;
  caps: Capabilities;
  region: string | null;
  joinedAt: number;
  lastStatusAt: number;
  depth: number;
  /** Per stream and stripe: who it gets it from, and who stands by. */
  links: { stream: number; stripe: number; parent: PeerId | null; backup: PeerId | null }[];
  children: number;
  standby: number;
  free: number;
};

/** The whole session, for `/tree`, for tests and for the harness. */
export type RoomSnapshot = {
  room: string;
  startedAt: number;
  ended: boolean;
  source: PeerId | null;
  streams: StreamConfig[];
  peers: PeerRecord[];
};

/** What `/stats` answers: what Meetly's server needs for its gate and its viewer count. */
export type RoomStats = { viewers: number; relays: number; maxDepth: number; started: boolean; ended: boolean };

export type CoordinatorCoreOptions = {
  room: string;
  /** Shared with Meetly's server: verifies tickets. */
  admissionSecret: string;
  /** Meetly's server shows this to use the HTTP API. */
  serverSecret: string;
  params: OverlayParams;
  /** Where a joiner that can never relay goes: "shallow" (D54, the default) or "deep" (before D54), for tests. */
  leafPlacement?: "deep" | "shallow";
  /** D57: the source's probed fan-out "always" (the default), or only while it is "alone" (D49). For tests. */
  sourcePolicy?: "alone" | "always";
  /** The most viewers admitted. The source is never refused. */
  viewerCap: number;
  /** STUN and TURN servers for a new peer, with fresh credentials. */
  iceServers: () => Promise<IceServer[]>;
  /** Injected, so placement is repeatable in tests. Returns 0..1. */
  random: () => number;
  logger?: Logger;
  /** How many metrics samples to keep for `metrics()`; the oldest go first. Default 2,000. */
  metricsKeep?: number;
  /** Who may relay and what a parent costs. Default: topology's own (`./scoring.ts`). */
  scoring?: { judgeRelay: JudgeRelay; parentCost: ParentCost };
  /** False turns off the changes of parent the coordinator asks for (`assign` "move"). Default true. */
  moves?: boolean;
  /** False turns off D38's provisional relays (fan-out 2 before probation is over). Default true. */
  provisionalRelays?: boolean;
};

/**
 * The coordinator's whole behaviour. Every method takes the time (`now`, milliseconds since the
 * Unix epoch) rather than reading a clock, and the entry point must not run two at once.
 */
export interface CoordinatorCore {
  /** Bring back what `persist` and `attach` effects saved, after a restart. Before anything else. */
  restore(stored: Record<string, string>, conns: { conn: ConnId; attachment: string }[], now: number): Promise<Effect[]>;
  /** A socket opened with this ticket. The answer accepts it (nothing yet: `welcome` follows `hello`) or closes it. */
  open(conn: ConnId, ticket: string, meta: ConnMeta, now: number): Promise<Effect[]>;
  /** Text arrived on a socket. Anything that is not a valid `ClientMessage` is answered with `error`. */
  message(conn: ConnId, text: string, now: number): Promise<Effect[]>;
  closed(conn: ConnId, now: number): Promise<Effect[]>;
  /** Time passed: expire peers that went quiet, refresh grants, rebalance. */
  tick(now: number): Promise<Effect[]>;
  http(request: CoreRequest, now: number): Promise<{ response: CoreResponse; effects: Effect[] }>;
  snapshot(): RoomSnapshot;
  /** Every metrics sample received, oldest first, up to a limit: the Node entry point serves it to the harness. */
  metrics(): MetricsSample[];
}

/* ------------------------------ the entry points ------------------------------ */

export type NodeCoordinatorOptions = {
  /** 4100–4199 in this repository's tests. 0 picks a free port. */
  port: number;
  host?: string;
  admissionSecret: string;
  serverSecret: string;
  params?: Partial<OverlayParams>;
  viewerCap?: number;
  iceServers?: IceServer[];
  /** Makes placement repeatable. */
  seed?: number;
  logger?: Logger;
  /** Metrics samples kept per session for `GET …/metrics`. Default 100,000. */
  metricsKeep?: number;
  /**
   * Where `persist` effects go, per room: what a Durable Object's storage is in production. Hand
   * the same one to a second `startNodeCoordinator` and sessions survive the first one's `kill()`
   * as they survive a Durable Object's eviction (the signing key, so `resume` works). Default: a
   * new one, so a restart forgets everything.
   */
  storage?: Map<string, Map<string, string>>;
};

export type NodeCoordinator = {
  /** "http://127.0.0.1:4100": the same paths as the deployed coordinator. */
  url: string;
  port: number;
  /** A session's core, for a test to look inside. */
  room(room: string): CoordinatorCore | undefined;
  /** Drop every socket without a goodbye and stop answering: the coordinator "dies". */
  kill(): Promise<void>;
  close(): Promise<void>;
};

/* ------------------------------ the client ------------------------------ */

export type CoordinatorClientEvents = {
  /** The socket is up (again) and `welcome` has arrived. */
  welcome: [welcome: ServerMessageOf<"welcome">];
  /** The socket dropped; the client is reconnecting with `resume`. The overlay carries on. */
  offline: [];
  /** A message the client does not handle itself. */
  message: [message: ServerMessage];
  /** Removed, or the session ended: do not reconnect. */
  closed: [reason: "kicked" | "ended" | "denied" | "full" | "left", detail: string];
};

/**
 * A peer's connection to the coordinator. It keeps the socket up (reconnecting with backoff and
 * `resume`), keeps the session clock, carries signalling, and is the `CoordinatorPort` the
 * topology module talks to.
 */
export interface CoordinatorClient extends Listenable<CoordinatorClientEvents>, CoordinatorPort {
  connect(caps: Capabilities): Promise<ServerMessageOf<"welcome">>;
  readonly sessionClock: SessionClock;
  readonly signaler: Signaler;
  /** The grant currently held: renewed by the coordinator before it expires. */
  grant(): string;
  sendStatus(status: { depth: number; links: PeerRecord["links"]; children: number; standby: number; free: number; caps: Capabilities; lossPct: number; rttMs: number | null }): void;
  sendMetrics(sample: MetricsSample): void;
  /** The source only. */
  sendStreams(streams: StreamConfig[]): void;
  /** Says `bye` and closes for good. */
  close(): void;
}

export type CoordinatorClientOptions = {
  /** "wss://…/overlay/v1/rooms/<room>/ws". */
  url: string;
  /** From Meetly's server. Asked for again on each reconnect, since a ticket is used once. */
  ticket: () => Promise<string>;
  clock: Clock;
  logger?: Logger;
  /** For tests: something that behaves like `WebSocket`. */
  webSocket?: (url: string) => WebSocket;
  /** How long `connect()` waits for `welcome` before it gives up. Default 5,000 ms. */
  connectTimeoutMs?: number;
  /** How long `need()` waits for an answer before it resolves null. Default 5,000 ms. */
  needTimeoutMs?: number;
  /** The longest wait between two attempts to reconnect. Default 2,000 ms. */
  maxBackoffMs?: number;
};
