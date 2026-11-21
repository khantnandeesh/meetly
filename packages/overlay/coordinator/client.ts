/**
 * A peer's connection to the coordinator (SPEC §6.3, §4.1): the socket, kept up with `resume`;
 * the session clock; signalling; and the `CoordinatorPort` the topology module talks to.
 *
 * The overlay does not depend on this socket to keep playing or to repair (SPEC §3.1). So
 * nothing here throws or blocks while it is down: `need` answers null, `report` is kept and sent
 * later, `connected` is false, and the client goes on trying to come back.
 *
 * Owner: E-coordinator.
 */
import { PROTOCOL_VERSION, decodeServerMessage, encodeClientMessage } from "../protocol";
import type { Assignment, Capabilities, ClientMessage, ClientMessageOf, MetricsSample, OverlayRole, PeerId, ServerMessage, ServerMessageOf, SignalData, StreamConfig } from "../protocol";
import type { Cancel, SessionClock, Unsubscribe } from "../runtime";
import type { CoordinatorClient, CoordinatorClientEvents, CoordinatorClientOptions } from "./types";

type ClosedReason = CoordinatorClientEvents["closed"][0];

/** Why `connect()` failed. "unreachable": no coordinator answered; nothing was changed, try again later. */
export class CoordinatorError extends Error {
  constructor(
    readonly reason: ClosedReason | "unreachable",
    detail: string,
  ) {
    super(`coordinator: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "CoordinatorError";
  }
}

/** SPEC §4.1: five probes 100 ms apart on joining, one every 30 s after, the best of the last eight. */
const PROBE = { burst: 5, burstMs: 100, everyMs: 30_000, keep: 8, slewPerMs: 0.001, snapMs: 2_000 } as const;
/** SPEC §6.3 allows two `status` a second; the client sends at most one in this long. */
const STATUS_MIN_MS = 600;
const REPORTS_KEPT = 64;
const TERMINAL: Record<number, ClosedReason> = { 4001: "denied", 4002: "full", 4003: "kicked", 4004: "ended", 4006: "denied" };

type Status = Parameters<CoordinatorClient["sendStatus"]>[0];
type Listeners<Args extends unknown[]> = Set<(...args: Args) => void>;

class Client implements CoordinatorClient {
  private readonly o: CoordinatorClientOptions;
  private readonly listeners: { [K in keyof CoordinatorClientEvents]: Listeners<CoordinatorClientEvents[K]> } = { welcome: new Set(), offline: new Set(), message: new Set(), closed: new Set() };
  private readonly onSignalListeners: Listeners<[from: PeerId, data: SignalData]> = new Set();
  private readonly onAssignListeners: Listeners<[assignments: Assignment[], reason: "join" | "need" | "rebalance" | "move"]> = new Set();
  private readonly onRoleListeners: Listeners<[role: OverlayRole]> = new Set();
  private readonly onPeerGoneListeners: Listeners<[peer: PeerId]> = new Set();

  private socket: WebSocket | null = null;
  private caps: Capabilities | null = null;
  private welcomed: ServerMessageOf<"welcome"> | null = null;
  private currentGrant = "";
  private up = false;
  /** `connect()` has succeeded once: from then on a drop is `offline`, not a failure. */
  private joined = false;
  private finished = false;
  private attempts = 0;
  private retry: Cancel | null = null;
  private timers: Cancel[] = [];

  private nextNeed = 1;
  private readonly needs = new Map<number, { resolve: (assignment: Assignment | null) => void; cancel: Cancel }>();
  private reports: ClientMessageOf<"report">[] = [];
  private lastStatus: Status | null = null;
  private statusSentAt = -Infinity;
  private statusTimer: Cancel | null = null;
  private lastStreams: StreamConfig[] | null = null;

  /** Session clock minus this machine's clock, as last measured and as in use (it moves slowly toward the first). */
  private samples: { rtt: number; offset: number }[] = [];
  private target: number | null = null;
  private offset = 0;
  private offsetAt = 0;
  private probesLeft = 0;
  /** The first burst of probes is in: from here on the clock only moves slowly. */
  private clockSettled = false;
  private uncertainty = Infinity;

  readonly sessionClock: SessionClock;
  readonly signaler;

  constructor(options: CoordinatorClientOptions) {
    this.o = options;
    const uncertainty = () => this.uncertainty;
    this.sessionClock = {
      now: () => this.toSession(options.clock.now()),
      fromLocal: (localMs: number) => this.toSession(localMs),
      get uncertaintyMs() {
        return uncertainty();
      },
    };
    this.signaler = {
      send: (to: PeerId, data: SignalData) => {
        // With the socket down there is nobody to carry it: links already open do not need it.
        this.send({ t: "signal", to, data });
      },
      onSignal: (listener: (from: PeerId, data: SignalData) => void) => subscribe(this.onSignalListeners, listener),
    };
  }

  /* ------------------------------ Listenable ------------------------------ */

  on<K extends keyof CoordinatorClientEvents>(event: K, listener: (...args: CoordinatorClientEvents[K]) => void): Unsubscribe {
    return subscribe(this.listeners[event] as Listeners<CoordinatorClientEvents[K]>, listener);
  }

  private emit<K extends keyof CoordinatorClientEvents>(event: K, ...args: CoordinatorClientEvents[K]): void {
    for (const listener of [...this.listeners[event]]) (listener as (...a: CoordinatorClientEvents[K]) => void)(...args);
  }

  /* ------------------------------ connecting ------------------------------ */

  get connected(): boolean {
    return this.up;
  }

  grant(): string {
    return this.currentGrant;
  }

  async connect(caps: Capabilities): Promise<ServerMessageOf<"welcome">> {
    if (this.finished) throw new CoordinatorError("left", "closed");
    if (this.joined || this.socket) throw new Error("coordinator: connect() called twice");
    this.caps = caps;
    const welcome = await this.attempt();
    this.joined = true;
    return welcome;
  }

  /** One try: a ticket, a socket, `hello`, and `welcome` or a reason why not. */
  private attempt(): Promise<ServerMessageOf<"welcome">> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let welcomed = false;
      let socket: WebSocket | null = null;
      const fail = (error: CoordinatorError) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        if (socket && this.socket === socket) this.socket = null;
        try {
          socket?.close();
        } catch {
          // Already closed.
        }
        reject(error);
      };
      const cancelTimeout = this.o.clock.setTimeout(() => fail(new CoordinatorError("unreachable", "no answer in time")), this.o.connectTimeoutMs ?? 5_000);
      this.o.ticket().then(
        (ticket) => {
          if (settled || this.finished) return fail(new CoordinatorError("left", "closed"));
          try {
            const url = `${this.o.url}${this.o.url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
            socket = this.o.webSocket ? this.o.webSocket(url) : new WebSocket(url);
          } catch (error) {
            return fail(new CoordinatorError("unreachable", String(error)));
          }
          const mine = socket;
          this.socket = mine;
          mine.onopen = () => {
            const resume = this.welcomed ? { peer: this.welcomed.peer, grant: this.currentGrant } : undefined;
            mine.send(encodeClientMessage({ t: "hello", v: PROTOCOL_VERSION, caps: this.caps!, ...(resume ? { resume } : {}) }));
          };
          mine.onmessage = (event: MessageEvent) => {
            if (this.socket !== mine || typeof event.data !== "string") return;
            let message: ServerMessage;
            try {
              message = decodeServerMessage(event.data);
            } catch (error) {
              this.o.logger?.warn("coordinator", "a message from the coordinator did not parse", error);
              return;
            }
            if (message.t === "welcome" && !settled) {
              settled = true;
              welcomed = true;
              cancelTimeout();
              this.onWelcome(message);
              resolve(message);
            } else if (welcomed) this.onMessage(message);
            // Told why before being shown the door: the close that follows carries the code.
          };
          // A browser follows an error with a close; Node's WebSocket, refused a connection, fires
          // only the error and stays "connecting". Either way, before `welcome` it is a failure.
          mine.onerror = () => {
            if (!welcomed) fail(new CoordinatorError("unreachable", "connection failed"));
            else if (mine.readyState === 1) mine.close();
          };
          mine.onclose = (event: CloseEvent) => {
            if (this.socket === mine) this.socket = null;
            const reason = TERMINAL[event.code];
            if (!welcomed) return fail(new CoordinatorError(reason ?? "unreachable", event.reason || `closed (${event.code})`));
            this.onDrop(reason, event.reason);
          };
        },
        (error) => fail(new CoordinatorError("unreachable", `no ticket: ${String(error)}`)),
      );
    });
  }

  private onWelcome(welcome: ServerMessageOf<"welcome">): void {
    this.welcomed = welcome;
    this.currentGrant = welcome.grant;
    this.up = true;
    this.attempts = 0;
    this.stopTimers();
    // The clock (SPEC §4.1).
    this.probesLeft = PROBE.burst;
    this.probe();
    this.timers.push(this.o.clock.setInterval(() => this.probe(), PROBE.everyMs));
    // The map is rebuilt from what peers say (SPEC §6.6): say it again, now and every `statusMs`.
    this.timers.push(
      this.o.clock.setInterval(() => {
        if (this.lastStatus && this.o.clock.now() - this.statusSentAt >= welcome.params.statusMs) this.flushStatus();
      }, Math.max(250, welcome.params.statusMs / 4)),
    );
    if (this.lastStreams) this.send({ t: "streams", streams: this.lastStreams });
    if (this.lastStatus) this.flushStatus();
    for (const report of this.reports.splice(0)) this.send(report);
    this.emit("welcome", welcome);
  }

  /** The socket closed after `welcome`. */
  private onDrop(reason: ClosedReason | undefined, detail: string): void {
    const wasUp = this.up;
    this.up = false;
    this.stopTimers();
    for (const [id, need] of this.needs) {
      need.cancel();
      need.resolve(null);
      this.needs.delete(id);
    }
    if (this.finished) return;
    if (reason) return this.finish(reason, detail);
    if (wasUp) this.emit("offline");
    this.reconnect();
  }

  private reconnect(): void {
    if (this.finished || this.retry) return;
    const delay = Math.min(this.o.maxBackoffMs ?? 2_000, 250 * 2 ** Math.min(this.attempts, 10));
    this.attempts++;
    this.retry = this.o.clock.setTimeout(() => {
      this.retry = null;
      if (this.finished) return;
      this.attempt().then(
        () => {},
        (error: CoordinatorError) => {
          if (this.finished) return;
          if (error.reason !== "unreachable") this.finish(error.reason, error.message);
          else this.reconnect();
        },
      );
    }, delay);
  }

  private finish(reason: ClosedReason, detail: string): void {
    if (this.finished) return;
    this.finished = true;
    this.up = false;
    this.stopTimers();
    this.retry?.();
    this.retry = null;
    this.statusTimer?.();
    this.statusTimer = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000);
    } catch {
      // Already closed.
    }
    this.emit("closed", reason, detail);
  }

  private stopTimers(): void {
    for (const cancel of this.timers.splice(0)) cancel();
  }

  close(): void {
    if (this.finished) return;
    this.send({ t: "bye" });
    this.finish("left", "");
  }

  /* ------------------------------ messages ------------------------------ */

  private send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!this.up || !socket || socket.readyState !== 1) return false;
    try {
      socket.send(encodeClientMessage(message));
      return true;
    } catch {
      return false;
    }
  }

  private onMessage(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
        break;
      case "time":
        this.onTime(message.t0, message.t1);
        break;
      case "signal":
        for (const listener of [...this.onSignalListeners]) listener(message.from, message.data);
        break;
      case "assign": {
        const need = message.id !== undefined ? this.needs.get(message.id) : undefined;
        if (need) {
          this.needs.delete(message.id!);
          need.cancel();
          need.resolve(message.assign[0] ?? null);
        } else if (message.id === undefined) for (const listener of [...this.onAssignListeners]) listener(message.assign, message.reason);
        break;
      }
      case "role":
        this.currentGrant = message.grant;
        for (const listener of [...this.onRoleListeners]) listener(message.role);
        break;
      case "grant":
        this.currentGrant = message.grant;
        break;
      case "peer-gone":
        for (const listener of [...this.onPeerGoneListeners]) listener(message.peer);
        break;
      case "kick":
        this.finish("kicked", message.reason);
        break;
      case "end":
        this.finish("ended", message.reason);
        break;
      case "error": {
        const need = message.id !== undefined ? this.needs.get(message.id) : undefined;
        if (need) {
          this.needs.delete(message.id!);
          need.cancel();
          need.resolve(null);
        }
        this.emit("message", message);
        break;
      }
      default:
        this.emit("message", message);
    }
  }

  /* ------------------------------ CoordinatorPort ------------------------------ */

  need(stream: number, stripe: number, want: "parent" | "backup", exclude: PeerId[]): Promise<Assignment | null> {
    const id = this.nextNeed++;
    if (!this.send({ t: "need", id, stream, stripe, want, exclude: exclude.slice(0, 64) })) return Promise.resolve(null);
    return new Promise((resolve) => {
      const cancel = this.o.clock.setTimeout(() => {
        this.needs.delete(id);
        resolve(null);
      }, this.o.needTimeoutMs ?? 5_000);
      this.needs.set(id, { resolve, cancel });
    });
  }

  report(event: ClientMessageOf<"report">["event"], stream: number, stripe: number, peer: PeerId, next?: PeerId | null): void {
    const message: ClientMessageOf<"report"> = { t: "report", event, stream, stripe, peer, ...(next !== undefined ? { next } : {}) };
    if (this.send(message)) return;
    // It is news after the fact (SPEC §7.5): it keeps until the coordinator is back.
    this.reports.push(message);
    if (this.reports.length > REPORTS_KEPT) this.reports.shift();
  }

  onAssign(listener: (assignments: Assignment[], reason: "join" | "need" | "rebalance" | "move") => void): Unsubscribe {
    return subscribe(this.onAssignListeners, listener);
  }

  onRole(listener: (role: OverlayRole) => void): Unsubscribe {
    return subscribe(this.onRoleListeners, listener);
  }

  onPeerGone(listener: (peer: PeerId) => void): Unsubscribe {
    return subscribe(this.onPeerGoneListeners, listener);
  }

  /* ------------------------------ what the peer says of itself ------------------------------ */

  sendStatus(status: Status): void {
    this.lastStatus = status;
    if (!this.up || this.statusTimer) return;
    const wait = this.statusSentAt + STATUS_MIN_MS - this.o.clock.now();
    if (wait <= 0) this.flushStatus();
    else
      this.statusTimer = this.o.clock.setTimeout(() => {
        this.statusTimer = null;
        this.flushStatus();
      }, wait);
  }

  private flushStatus(): void {
    if (!this.lastStatus) return;
    if (this.send({ t: "status", ...this.lastStatus })) this.statusSentAt = this.o.clock.now();
  }

  sendMetrics(sample: MetricsSample): void {
    this.send({ t: "metrics", sample });
  }

  sendStreams(streams: StreamConfig[]): void {
    this.lastStreams = streams;
    this.send({ t: "streams", streams });
  }

  /* ------------------------------ the session clock (SPEC §4.1) ------------------------------ */

  private probe(): void {
    this.send({ t: "time", t0: this.o.clock.now() });
    if (this.probesLeft > 0 && --this.probesLeft > 0) this.timers.push(this.o.clock.setTimeout(() => this.probe(), PROBE.burstMs));
  }

  private onTime(t0: number, t1: number): void {
    const t2 = this.o.clock.now();
    const rtt = t2 - t0;
    if (!(rtt >= 0) || rtt > 60_000) return;
    this.samples.push({ rtt, offset: t1 + rtt / 2 - t2 });
    if (this.samples.length > PROBE.keep) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    const current = this.target === null ? null : this.offsetNow(t2);
    this.target = best.offset;
    this.uncertainty = best.rtt / 2;
    // The first probes of all settle the clock; after that it only ever moves slowly,
    // unless it is so far out that the coordinator must have started a new session clock.
    if (current === null || !this.clockSettled || Math.abs(best.offset - current) > PROBE.snapMs) {
      this.offset = best.offset;
      this.offsetAt = t2;
    }
    if (this.samples.length >= PROBE.burst) this.clockSettled = true;
  }

  /** The offset in use at `local`: it moves toward the measured one by at most 1 ms a second. */
  private offsetNow(local: number): number {
    if (this.target === null) return 0;
    const room = Math.max(0, local - this.offsetAt) * PROBE.slewPerMs;
    const diff = this.target - this.offset;
    this.offset += Math.max(-room, Math.min(room, diff));
    this.offsetAt = Math.max(this.offsetAt, local);
    return this.offset;
  }

  private toSession(local: number): number {
    return local + this.offsetNow(local);
  }
}

function subscribe<Args extends unknown[]>(set: Listeners<Args>, listener: (...args: Args) => void): Unsubscribe {
  set.add(listener);
  return () => set.delete(listener);
}

export const createClient = (options: CoordinatorClientOptions): CoordinatorClient => new Client(options);
