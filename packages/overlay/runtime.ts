/**
 * What every module of the overlay is handed instead of reaching for a global: time, timers and
 * logging. Nothing in the package calls `Date.now`, `performance.now`, `setTimeout` or
 * `setInterval` directly, so every state machine can be driven by a fake clock in a unit test,
 * and the browser can run its timers where a hidden tab does not slow them (SPEC §7.3).
 *
 * Shared file: see docs/overlay/PLAN.md "Shared files".
 */

export type Cancel = () => void;
export type Unsubscribe = () => void;

/** This machine's own clock. Monotonic; its zero means nothing to anyone else. */
export interface Clock {
  /** Milliseconds, with a fraction. */
  now(): number;
  setTimeout(callback: () => void, ms: number): Cancel;
  setInterval(callback: () => void, ms: number): Cancel;
}

/**
 * The session's clock (SPEC §4.1): milliseconds since the coordinator started the session, the
 * same on every peer to within `uncertaintyMs`. Capture times, playout and every metric use it.
 */
export interface SessionClock {
  /** Session time now, in milliseconds. */
  now(): number;
  /** Session time for a reading of this machine's `Clock`. */
  fromLocal(localMs: number): number;
  /** Half the round trip of the best clock probe so far: how wrong `now()` may be. Infinity before any. */
  readonly uncertaintyMs: number;
}

export interface Logger {
  debug(scope: string, message: string, data?: unknown): void;
  info(scope: string, message: string, data?: unknown): void;
  warn(scope: string, message: string, data?: unknown): void;
  error(scope: string, message: string, data?: unknown): void;
}

/** Something that announces events. `on` returns the undo. */
export interface Listenable<Events extends Record<string, unknown[]>> {
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): Unsubscribe;
}

/** The five engineers of docs/overlay/PLAN.md, and the architect for the shared files. */
export type Owner = "E-transport+topology" | "E-media" | "E-congestion" | "E-coordinator" | "E-harness" | "architect";

/** Thrown by every part of the skeleton that has not been built yet. */
export class NotImplementedError extends Error {
  constructor(
    readonly owner: Owner,
    readonly what: string,
  ) {
    super(`not implemented: ${what} (owner: ${owner}, see docs/overlay/PLAN.md)`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(owner: Owner, what: string): never {
  throw new NotImplementedError(owner, what);
}
