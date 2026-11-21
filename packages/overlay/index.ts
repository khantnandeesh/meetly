/**
 * @meetly/overlay: a self-healing peer-relay overlay that carries a webinar's program feed from
 * the host's browser to a large audience, viewer to viewer, with no media server.
 *
 * docs/overlay/SPEC.md is the design; docs/overlay/PLAN.md says who builds what. This file is
 * what an application uses: two factories that put the modules together. Nothing in src/ may
 * import this package until the integration step (PLAN.md "Integration"); eslint.config.mjs
 * enforces that.
 *
 * Shared file: see docs/overlay/PLAN.md "Shared files".
 */
import { notImplemented, type Listenable, type Logger, type SessionClock } from "./runtime";
import type { MetricsSample, StreamConfig } from "./protocol";
import type { PlayerStats, ProgramEncoding, ProgramInput } from "./media/types";
import type { NodeStatus } from "./topology/types";
import type { TransportOptions } from "./transport/types";

export * from "./protocol";
export * from "./runtime";
export type * from "./types";

export type OverlayConnectOptions = {
  /** "wss://…/overlay/v1/rooms/<room>/ws". */
  coordinatorUrl: string;
  /** Asks Meetly's server for a ticket. Called again on each reconnect. */
  ticket: () => Promise<string>;
  logger?: Logger;
  /**
   * The harness's impairment shim, handed to the transport as it is (SPEC §13.1). An application
   * never sets it.
   */
  wrapChannel?: TransportOptions["wrapChannel"];
};

export type OverlayState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export type OverlayEvents = {
  state: [state: OverlayState];
  /** Why it closed, when it was not `close()`: removed, the session ended, refused at the door. */
  closed: [reason: "kicked" | "ended" | "denied" | "full" | "left", detail: string];
  error: [error: Error];
  /** One every `metricsMs`, as sent to the coordinator. */
  metrics: [sample: MetricsSample];
};

/** A member of the audience. */
export interface OverlayViewer extends Listenable<OverlayEvents & { firstFrame: []; audioBlocked: [blocked: boolean]; streams: [streams: StreamConfig[]] }> {
  readonly state: OverlayState;
  connect(): Promise<void>;
  /** The program picture, for a `<video>` element. Null until it is known. */
  videoTrack(): MediaStreamTrack | null;
  /** Call from a click or key press after `audioBlocked`. */
  resumeAudio(): Promise<void>;
  setVolume(volume: number): void;
  status(): NodeStatus | null;
  stats(): PlayerStats | null;
  /** The session clock, once the first probes are back: the harness reads its `uncertaintyMs` (SPEC §12.3). */
  sessionClock(): SessionClock | null;
  close(): Promise<void>;
}

/** The host's browser, seeding the program feed. */
export interface OverlaySource extends Listenable<OverlayEvents> {
  readonly state: OverlayState;
  connect(): Promise<void>;
  /** Start (or replace) what is being sent. */
  publish(input: ProgramInput): Promise<void>;
  status(): NodeStatus | null;
  /** As `OverlayViewer.sessionClock`. */
  sessionClock(): SessionClock | null;
  close(): Promise<void>;
}

export const createOverlayViewer: (
  options: OverlayConnectOptions & {
    /** False for the harness's light viewers: `PlayerOptions.decode` (SPEC §13.2). */
    decode?: boolean;
  },
) => OverlayViewer = () => notImplemented("architect", "createOverlayViewer");

export const createOverlaySource: (options: OverlayConnectOptions & { encoding?: ProgramEncoding }) => OverlaySource = () =>
  notImplemented("architect", "createOverlaySource");
