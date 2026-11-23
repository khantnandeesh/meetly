/**
 * The composition root: the modules put together into a viewer and a source (index.ts's two
 * factories). Nothing here decides anything the modules decide; it carries numbers between them,
 * as PLAN §4 says it must, because they never import each other:
 *
 *   coordinator client ── welcome, signalling, CoordinatorPort, session clock
 *        │
 *   transport links ── grants checked against welcome.key (SPEC §5.2, §6.5)
 *        │
 *   topology node ── congestion's estimator and gate for every link and child; runs the uplink
 *        │            probe (SPEC §8.1, §11.6) after probation, the target a full fan-out's cost
 *        │
 *   media player (viewer) ◄── frames as they complete; link hints; wanted layers, the oldest
 *                              frame worth a NACK and the playout delay go back up
 *   media source (source) ──► frames to the node; congestion's rate controller sets its bitrate
 *
 * And the MetricsSample (SPEC §12.1) every `metricsMs`, from the player's counters and the node's
 * `takeStats()`, to the coordinator and to whoever listens.
 *
 * Shared file: the architect's, see docs/overlay/PLAN.md "Shared files".
 */
import { createEngineClock, type EngineClock } from "./clock";
import { createCoordinatorClient } from "./coordinator/index";
import type { CoordinatorClient } from "./coordinator/types";
import { createLayerGate, createLinkEstimator, createSourceRateController, createUplinkProbe } from "./congestion/index";
import { DEFAULT_ENCODING, createPlayer, createProgramSource, probeDecoders } from "./media/index";
import type { Player, ProgramEncoding, ProgramInput, ProgramSource } from "./media/types";
import { createOverlayNode, judgeRelay } from "./topology/index";
import type { NodeStats, NodeStatus, OverlayNode } from "./topology/types";
import { createLinkManager, probeNat } from "./transport/index";
import type { LinkManager } from "./transport/types";
import {
  emptyHistogram,
  importGrantPublicKey,
  latencyBucket,
  verifyGrant,
  type Capabilities,
  type MetricsEvent,
  type MetricsSample,
  type OverlayParams,
  type PeerId,
  type ServerMessageOf,
  type StreamConfig,
} from "./protocol";
import type { Listenable, Logger, SessionClock, Unsubscribe } from "./runtime";
import { FrameIntegrityError, inOrder, integrityCounter, markStreamConfig } from "./transform";
import type { OverlayConnectOptions, OverlayEvents, OverlaySource, OverlayState, OverlayViewer } from "./index";

/** SPEC D18, when the session's params do not say: nobody relays before this long; the probe waits for it too. */
const PROBATION_MS = 20_000;
/** SPEC §11.6: the probe runs again this often while the peer is eligible. */
const REPROBE_MS = 5 * 60_000;
/** A probe cut short (the parent changed under it) is tried again after this long. */
const PROBE_RETRY_MS = 10_000;
/** A peer with no parent yet to probe is looked at again this soon: it may be the next relay a waiting subtree needs. */
const PROBE_WAIT_MS = 2000;
/**
 * SPEC §8.1, §11.6 (as amended): a full fan-out's cost, maxFanout × 1.15 × B / 0.7, and 10% more.
 * The probe reports no more than its target, and fan-out is that figure's floor: at the target to
 * the digit, a measurement a hair short would prove one child fewer than the link carries.
 */
const PROBE_HEADROOM = 1.1;
/**
 * And never less than eligibility itself asks (SPEC §8.1 "uplink": room for two children,
 * 2 × 1.15 × B): with a fan-out of 1 the first figure is below it, and a probe that stops at its
 * target could never show a peer eligible.
 */
const probeTargetKbps = (params: OverlayParams, streamKbps: number, fanout = params.maxFanout) => PROBE_HEADROOM * Math.max((fanout * 1.15 * streamKbps) / 0.7, 2 * 1.15 * streamKbps);
/** SPEC §8.1 [D38], [D41]: the short probe, 1 s, as soon as there is a parent: sized for a provisional relay's two children. */
const SHORT_PROBE = { fanout: 2, durationMs: 1000 };
/**
 * The short probe starts this soon after the peer first has a parent, not at the next look
 * (`PROBE_WAIT_MS` after welcome): at a session's start every joiner past the first few waits
 * for the provisional relays, and each one opened a second sooner is a layer of the tree sooner.
 */
const PROBE_AFTER_PARENT_MS = 200;
/** [D49] While it is the only relay the source may take up to six: its probe, toward its first child, is sized for them. */
const SOURCE_ALONE_FANOUT = 6;
/** How often what the player wants is passed to the node. */
const WANTS_EVERY_MS = 200;
/**
 * [D65] Frames from one peer that fail their integrity checks (tampered, forged, stripped of their
 * encryption: media/sframe.ts), this many within `INTEGRITY_WINDOW_MS`, and a viewer leaves that
 * parent. A frame over DTLS is not damaged by the network: only a relay changes one.
 */
export const INTEGRITY_FAILURES_TO_LEAVE = 5;
export const INTEGRITY_WINDOW_MS = 2000;
/** The source applies SPEC §11.4's uplink rule once a second. */
const RATE_EVERY_MS = 1000;
/** §11.4: the source never goes below this. */
const MIN_SOURCE_KBPS = 300;
/** Grants are checked with this much slack for clocks that disagree. */
const GRANT_LEEWAY_S = 60;

/* ------------------------------ small pieces ------------------------------ */

class Emitter<Events extends Record<string, unknown[]>> implements Listenable<Events> {
  private listeners: { [K in keyof Events]?: Set<(...args: Events[K]) => void> } = {};
  constructor(private readonly logger?: Logger) {}
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): Unsubscribe {
    const set = (this.listeners[event] ??= new Set());
    set.add(listener);
    return () => set.delete(listener);
  }
  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const listener of [...(this.listeners[event] ?? [])]) {
      try {
        listener(...args);
      } catch (error) {
        this.logger?.error("overlay", "a listener threw", error);
      }
    }
  }
}

type Navigatorish = Navigator & {
  getBattery?: () => Promise<{ charging: boolean; level: number }>;
  connection?: { saveData?: boolean };
  userAgentData?: { mobile?: boolean; brands?: { brand: string }[] };
};

/** What this browser says of itself (SPEC §6.3 `caps`). A claim: §8 says how far it is trusted. */
async function gatherCapabilities(): Promise<Capabilities> {
  const nav = (typeof navigator === "undefined" ? {} : navigator) as Navigatorish;
  const ua = nav.userAgent ?? "";
  const brands = nav.userAgentData?.brands?.map((b) => b.brand).join(" ") ?? "";
  const browser: Capabilities["browser"] = /Chrom/.test(brands) || (/Chrome\/|Chromium\//.test(ua) && !/Edg\/|OPR\//.test(ua)) || /Edg\//.test(ua) ? "chromium" : /Firefox\//.test(ua) ? "firefox" : /Safari\//.test(ua) ? "safari" : "other";
  const mobile = nav.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/.test(ua);
  let onPower: boolean | null = null;
  try {
    const battery = await nav.getBattery?.();
    // A machine with no battery reports one that is charging and full.
    if (battery) onPower = battery.charging;
  } catch {
    onPower = null;
  }
  let decode: string[] = [];
  try {
    decode = (await probeDecoders()).slice(0, 16);
  } catch {
    decode = [];
  }
  return {
    browser,
    desktop: !mobile,
    onPower,
    nat: "unknown",
    uplinkKbps: null,
    cores: Math.min(1024, Math.max(1, Math.round(nav.hardwareConcurrency || 1))),
    decode,
    dataSaver: nav.connection?.saveData === true,
    visible: typeof document === "undefined" ? true : document.visibilityState === "visible",
  };
}

const round = (x: number) => Math.round(x);
const clampInt = (x: number, max = 0xffffffff) => Math.min(max, Math.max(0, Math.round(Number.isFinite(x) ? x : 0)));

/* ------------------------------ what both sides share ------------------------------ */

type PeerEvents = OverlayEvents & { firstFrame: []; audioBlocked: [blocked: boolean]; streams: [streams: StreamConfig[]] };

/**
 * One peer's engine, either side: the client, the links, the node, and what runs between them.
 * The viewer adds a player, the source a program source.
 */
abstract class PeerEngine {
  readonly events: Emitter<PeerEvents>;
  state: OverlayState = "idle";
  protected readonly clock: EngineClock;
  protected readonly client: CoordinatorClient;
  protected node: OverlayNode | null = null;
  protected links: LinkManager | null = null;
  protected welcome: ServerMessageOf<"welcome"> | null = null;
  protected caps: Capabilities | null = null;
  protected readonly streams = new Map<number, StreamConfig>();
  protected readonly timers: (() => void)[] = [];
  protected readonly pending: MetricsEvent[] = [];
  private seq = 0;
  private sampledAt = 0;
  private probeTimer: (() => void) | null = null;
  protected startedAt = 0;
  protected welcomedAt = 0;

  constructor(protected readonly options: OverlayConnectOptions) {
    this.events = new Emitter(options.logger);
    this.clock = createEngineClock();
    this.client = createCoordinatorClient({ url: options.coordinatorUrl, ticket: options.ticket, clock: this.clock, logger: options.logger });
    this.client.on("closed", (reason, detail) => this.finish(reason, detail));
    this.client.on("offline", () => this.setState("reconnecting"));
    this.client.on("welcome", () => {
      if (this.state === "reconnecting") this.setState("connected");
    });
  }

  protected setState(state: OverlayState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit("state", state);
  }

  protected session = (local: number) => Math.max(0, this.client.sessionClock.fromLocal(local));

  /** `hello` → `welcome`, then the links and the node. The side's own parts come after. */
  async connect(): Promise<void> {
    if (this.state !== "idle") throw new Error(`overlay: connect() when ${this.state}`);
    this.setState("connecting");
    this.startedAt = this.clock.now();
    try {
      this.caps = { ...(await gatherCapabilities()), ...this.options.capabilities };
      const welcome = await this.client.connect(this.caps);
      this.welcome = welcome;
      this.welcomedAt = this.clock.now();
      for (const stream of welcome.streams) this.streams.set(stream.id, stream);
      const key = await importGrantPublicKey(welcome.key.pub);
      const room = welcome.room;
      const links = createLinkManager({
        self: welcome.peer,
        grant: () => this.client.grant(),
        verifyPeer: async (peer, grant) => (await verifyGrant(grant, key, { room, peer, now: welcome.epochMs + this.client.sessionClock.now(), leewayS: GRANT_LEEWAY_S })) !== null,
        signaler: this.client.signaler,
        ice: welcome.ice,
        clock: this.clock,
        logger: this.options.logger,
        wrapChannel: this.options.wrapChannel,
      });
      this.links = links;
      const node = createOverlayNode({
        self: welcome.peer,
        links,
        coordinator: this.client,
        params: welcome.params,
        clock: this.clock,
        sessionClock: this.client.sessionClock,
        createLinkEstimator: (estimatorOptions) => createLinkEstimator(estimatorOptions),
        createLayerGate,
        logger: this.options.logger,
      });
      this.node = node;
      node.on("metric", (event) => this.pending.push(event));
      // The node's only error is "no parent could be found; rejoining": a state it comes back from
      // by itself, not the end of this peer. It is logged and goes in the metrics sample.
      node.on("error", (error) => {
        this.options.logger?.warn("overlay", error.message);
        this.pending.push({ t: "error", at: Math.max(0, this.client.sessionClock.now()), where: "node", message: error.message.slice(0, 512) });
      });
      node.on("status", () => {
        this.sendStatus();
        this.probeOnFirstParent();
      });
      node.on("config", (config) => this.onConfig(config));
      // The session's streams, later than welcome: a viewer welcomed before the source started.
      this.client.on("message", (message) => {
        if (message.t === "streams" && welcome.role !== "source") node.setStreams(message.streams);
      });
      node.on("probe", (spare) => this.onProbe(spare));
      await this.beforeStart(welcome);
      node.start(welcome.role, welcome.streams, welcome.assign);
      this.sampledAt = this.clock.now();
      this.timers.push(this.clock.setInterval(() => this.sample(), welcome.params.metricsMs));
      this.setState("connected");
      this.sendStatus();
      // NAT type, once the ICE servers are known. A session offering none is one network (the
      // harness on one machine, a LAN): every peer's host candidates reach every other's.
      this.natPending = !this.options.capabilities?.nat;
      void (welcome.ice.length === 0 ? Promise.resolve<Capabilities["nat"]>("open") : probeNat(welcome.ice)).then((nat) => {
        this.natPending = false;
        if (!this.caps || this.options.capabilities?.nat) return;
        this.caps = { ...this.caps, nat };
        this.sendStatus();
        // A short probe that was waiting for the NAT type runs now (`maybeProbe`).
        if (this.probePhase === "short" && this.hadParent && !this.probeRunning) this.scheduleProbe(0);
      });
      // The short probe as soon as there is a parent (D38); the full one after probation.
      if (welcome.role !== "source") this.scheduleProbe(PROBE_WAIT_MS);
    } catch (error) {
      this.setState("closed");
      throw error;
    }
  }

  /** The side's own wiring, before the node starts. */
  protected abstract beforeStart(welcome: ServerMessageOf<"welcome">): Promise<void>;
  protected abstract sideOfSample(sample: MetricsSample): void;

  protected onConfig(config: StreamConfig): void {
    this.streams.set(config.id, config);
    this.events.emit("streams", [...this.streams.values()]);
  }

  /* --- status, the probe --- */

  protected sendStatus(): void {
    const node = this.node;
    if (!node || !this.caps) return;
    const status = node.status();
    const up = this.lastUp;
    this.client.sendStatus({
      depth: Math.min(255, status.depth),
      links: status.stripes.map((s) => ({ stream: s.stream, stripe: s.stripe, parent: s.parent, backup: s.backup })),
      children: status.children.length,
      standby: status.standbyChildren.length,
      free: status.freeSlots,
      caps: this.caps,
      lossPct: up?.lossPct ?? 0,
      rttMs: up?.rttMs ?? null,
    });
  }
  protected lastUp: NodeStats["up"] = null;

  /**
   * [D50] The B a relay is sized by: the session's streams together, as the coordinator's
   * fan-out formula takes it (video and audio), so that the probe proves what the verdict asks.
   */
  private sessionKbps(): number {
    let total = 0;
    for (const stream of this.streams.values()) total += stream.bitrateKbps;
    return total > 0 ? total : DEFAULT_ENCODING.video.bitrateKbps + DEFAULT_ENCODING.audio.bitrateKbps;
  }

  private hadParent = false;
  private probeRunning = false;
  /**
   * `probeNat` has not answered yet (it takes up to its 3 s timeout). A joiner linked sooner than
   * that would otherwise find "nat" against it and put the short probe off by PROBE_RETRY_MS:
   * at a session's start, nearly every joiner (the gate's: all linked under 2.7 s after welcome).
   */
  private natPending = false;

  private probeOnFirstParent(): void {
    if (this.welcome?.role === "source") return this.probeSourceOnFirstChild();
    if (this.hadParent) return;
    const stripe = this.node?.status().stripes[0];
    if (!stripe || stripe.state !== "active" || stripe.parent === null) return;
    this.hadParent = true;
    if (this.probePhase === "short" && !this.probeRunning) this.scheduleProbe(PROBE_AFTER_PARENT_MS);
  }

  /**
   * [D49] The source's uplink, once it has a child to probe toward: the coordinator gives it up
   * to SOURCE_ALONE_FANOUT children while it is the only relay, if this shows the room for them.
   */
  private probeSourceOnFirstChild(): void {
    const node = this.node;
    const welcome = this.welcome;
    if (this.hadParent || !node || !welcome || this.probeRunning || this.options.capabilities?.uplinkKbps != null) return;
    if (node.status().children.length === 0) return;
    const most = welcome.params.sourceAloneFanout ?? SOURCE_ALONE_FANOUT;
    if (most <= welcome.params.sourceFanout) return;
    this.hadParent = true;
    this.probePhase = "full";
    this.probeRunning = true;
    node.runProbe(createUplinkProbe({ targetKbps: probeTargetKbps(welcome.params, this.sessionKbps(), most), durationMs: 1000 }));
  }

  private scheduleProbe(afterMs: number): void {
    this.probeTimer?.();
    this.probeTimer = this.clock.setTimeout(() => this.maybeProbe(), afterMs);
  }

  /** Which probe is next: the short one of D38, then the full one of §8.1. */
  private probePhase: "short" | "full" = "short";

  /**
   * SPEC §8.1 [D38]: a short probe, sized for two children, as soon as the peer has a parent, so
   * that it may be a provisional relay before probation ends; then, past probation and every 5
   * minutes while eligible, the full one. Either only if the claim could make this peer a relay.
   */
  private maybeProbe(): void {
    const node = this.node;
    const welcome = this.welcome;
    if (!node || !welcome || !this.caps || this.state === "closed") return;
    // Nothing to probe until there is a parent to send the probe to.
    const stripe = node.status().stripes[0];
    if (!stripe || stripe.state !== "active" || stripe.parent === null) return this.scheduleProbe(PROBE_WAIT_MS);
    const verdict = judgeRelay(this.caps, { uptimeMs: this.clock.now() - this.welcomedAt, spareUplinkKbps: null, lossPct: this.lastUp?.lossPct ?? 0, churnPerMin: 0 }, this.sessionKbps(), welcome.params);
    // Only the uplink is unknown (and, for the short probe, probation not over): the probe is what
    // finds the one, and the other passes by itself. Anything else, and it would be wasted.
    const allowed = this.probePhase === "short" ? ["uplink", "probation"] : ["uplink"];
    // The NAT type is on its way: its answer starts the probe (`connect`), not a retry 10 s on.
    if (this.natPending && verdict.reasons.every((reason) => allowed.includes(reason) || reason === "nat")) return;
    if (verdict.reasons.some((reason) => !allowed.includes(reason))) return this.scheduleProbe(PROBE_RETRY_MS);
    const short = this.probePhase === "short";
    this.probeRunning = true;
    node.runProbe(
      createUplinkProbe({
        targetKbps: probeTargetKbps(welcome.params, this.sessionKbps(), short ? SHORT_PROBE.fanout : welcome.params.maxFanout),
        durationMs: short ? SHORT_PROBE.durationMs : 1000,
      }),
    );
  }

  private onProbe(spare: number | null): void {
    this.probeRunning = false;
    if (this.welcome?.role === "source") {
      // [D49] Once: what it found, or (cut short) another try at the next change of status.
      if (spare === null) this.hadParent = false;
      else if (this.caps) {
        this.caps = { ...this.caps, uplinkKbps: Math.round(spare) };
        this.sendStatus();
      }
      return;
    }
    if (spare === null) return this.scheduleProbe(this.probePhase === "short" ? PROBE_WAIT_MS : PROBE_RETRY_MS);
    if (this.caps) this.caps = { ...this.caps, uplinkKbps: Math.round(spare) };
    this.sendStatus();
    if (this.probePhase === "short") {
      // The full probe once probation is over.
      this.probePhase = "full";
      const probation = this.welcome?.params.probationMs ?? PROBATION_MS;
      return this.scheduleProbe(Math.max(PROBE_WAIT_MS, this.welcomedAt + probation - this.clock.now()));
    }
    this.scheduleProbe(REPROBE_MS);
  }

  /* --- metrics --- */

  private sample(): void {
    const node = this.node;
    const welcome = this.welcome;
    if (!node || !welcome) return;
    const now = this.clock.now();
    const intervalMs = Math.max(0, now - this.sampledAt);
    this.sampledAt = now;
    const stats = node.takeStats();
    this.lastUp = stats.up;
    const status = node.status();
    const sample: MetricsSample = {
      peer: welcome.peer,
      seq: this.seq++,
      at: Math.max(0, this.client.sessionClock.now()),
      intervalMs: Math.min(3_600_000, intervalMs),
      role: status.role,
      depth: clampInt(status.depth, 255),
      playoutDelayMs: 0,
      events: [],
    };
    if (stats.up) {
      sample.up = { ...stats.up, rttMs: stats.up.rttMs === null ? null : Math.min(3_600_000, Math.max(0, stats.up.rttMs)), queueDelayMs: Math.min(3_600_000, Math.max(0, stats.up.queueDelayMs)), lossPct: Math.min(100, Math.max(0, stats.up.lossPct)) };
    }
    if (stats.relay) {
      sample.relay = {
        ...stats.relay,
        children: clampInt(stats.relay.children, 255),
        standby: clampInt(stats.relay.standby, 255),
        bufferedMaxBytes: clampInt(stats.relay.bufferedMaxBytes),
        layerDrops: clampInt(stats.relay.layerDrops),
        retransmitsSent: clampInt(stats.relay.retransmitsSent),
      };
    }
    this.sideOfSample(sample);
    if (stats.join) this.onJoinStats(stats.join);
    sample.events = this.pending.splice(0, 64);
    try {
      this.client.sendMetrics(sample);
    } catch (error) {
      this.options.logger?.warn("overlay", "a metrics sample did not encode", error);
    }
    this.events.emit("metrics", sample);
  }

  /** The viewer reports its `join` event when it has everything for it. */
  protected onJoinStats(_join: NonNullable<NodeStats["join"]>): void {}

  /* --- the end --- */

  private finish(reason: "kicked" | "ended" | "denied" | "full" | "left", detail: string): void {
    if (this.state === "closed") return;
    void this.teardown(false);
    this.events.emit("closed", reason, detail);
  }

  protected async teardown(graceful: boolean): Promise<void> {
    if (this.state === "closed") return;
    this.setState("closed");
    this.probeTimer?.();
    for (const stop of this.timers.splice(0)) stop();
    if (graceful) await this.node?.stop().catch(() => undefined);
    this.links?.closeAll();
    this.client.close();
    this.clock.close();
  }

  status(): NodeStatus | null {
    return this.node?.status() ?? null;
  }

  sessionClock(): SessionClock | null {
    return this.welcome ? this.client.sessionClock : null;
  }
}

/* ------------------------------ the viewer ------------------------------ */

class ViewerEngine extends PeerEngine {
  private player: Player | null = null;
  private readonly decode: boolean;
  /** [D65] Integrity failures per peer the frame came from. */
  private readonly integrity = integrityCounter(INTEGRITY_FAILURES_TO_LEAVE, INTEGRITY_WINDOW_MS);
  /** [D66] Configurations are checked one after another, so that an older one never lands last. */
  private configChecks: Promise<void> = Promise.resolve();
  private glassToGlass = emptyHistogram();
  /** [D46] Frames shown during a [D45] catch-up: counted apart from the latency. */
  private catchUpAge = emptyHistogram();
  private catchUpFrames = 0;
  private frameGap = emptyHistogram();
  private audioGlassToGlass = emptyHistogram();
  private lastRenderedUs: number | null = null;
  private counted = { rendered: 0, dropped: 0, lost: 0, playedMs: 0, concealedMs: 0, underruns: 0 };
  private firstFrameAt: number | null = null;
  private joinReported = false;

  constructor(options: OverlayConnectOptions & { decode?: boolean }) {
    super(options);
    this.decode = options.decode ?? true;
  }

  protected async beforeStart(welcome: ServerMessageOf<"welcome">): Promise<void> {
    const node = this.node!;
    const player = createPlayer({ sessionClock: this.client.sessionClock, clock: this.clock, playoutMinMs: welcome.params.playoutMinMs, playoutMaxMs: welcome.params.playoutMaxMs, decode: this.decode, logger: this.options.logger });
    this.player = player;
    if (this.streams.size > 0) await player.configure([...this.streams.values()]);
    // Frames go to the player the moment they are whole (SPEC §3.3), through the application's
    // `frameTransform` when it has one (its decryption: ./transform.ts), in the order they came.
    const receive = this.options.frameTransform?.receive;
    node.on(
      "frame",
      receive
        ? inOrder(receive, (frame) => player.push(frame), {
            alive: () => this.state !== "closed",
            onError: (error, frame) => {
              // [D65] Changed on the way: counted against the peer it came from.
              if (error instanceof FrameIntegrityError) this.noteIntegrityFailure(frame?.from ?? null);
              else this.options.logger?.warn("overlay", "a frame transform failed; the frame is dropped", error);
            },
          })
        : (frame) => player.push(frame),
    );
    // §10.2: D follows the link to the parent: congestion's estimate of what arrives.
    node.on("uplink", (estimate) => player.setLinkHints({ jitterMs: estimate.jitterMs, rttMs: estimate.rttMs, lossPct: estimate.lossPct }));
    player.on("rendered", (_stream, _frameId, captureUs, renderedUs, catchUp) => {
      if (catchUp) {
        this.catchUpFrames++;
        this.catchUpAge[latencyBucket((renderedUs - captureUs) / 1000)]++;
      } else this.glassToGlass[latencyBucket((renderedUs - captureUs) / 1000)]++;
      if (this.lastRenderedUs !== null) this.frameGap[latencyBucket((renderedUs - this.lastRenderedUs) / 1000)]++;
      this.lastRenderedUs = renderedUs;
    });
    player.on("firstFrame", () => {
      this.firstFrameAt ??= this.clock.now();
      this.events.emit("firstFrame");
    });
    player.on("freeze", (stream, ms) => this.pending.push({ t: "freeze", stream, at: Math.max(0, this.client.sessionClock.now()), ms: Math.min(3_600_000, Math.max(0, ms)) }));
    player.on("audioBlocked", (blocked) => this.events.emit("audioBlocked", blocked));
    player.on("error", (error) => this.events.emit("error", error));
    // What the player can use, the oldest frame still worth a NACK, and D, go back up (SPEC §4.5, §4.6).
    this.timers.push(
      this.clock.setInterval(() => {
        for (const id of this.streams.keys()) {
          node.setWanted(id, player.wantedLayers(id));
          node.setOldestWanted(id, player.oldestWanted(id));
        }
        node.setPlayout(player.stats().playoutDelayMs, 0);
      }, WANTS_EVERY_MS),
    );
  }

  protected override onConfig(config: StreamConfig): void {
    // [D66] With a `verifyConfig`, only the source's own configuration is used; one that is not
    // counts against the parent it came down from (D65).
    const verify = this.options.frameTransform?.verifyConfig;
    if (!verify) return this.useConfig(config);
    this.configChecks = this.configChecks.then(async () => {
      const genuine = await verify(config).catch(() => false);
      if (this.state === "closed") return;
      if (genuine) return this.useConfig(config);
      this.options.logger?.warn("overlay", `stream ${config.id}: a configuration that is not the source's was ignored`);
      this.noteIntegrityFailure(this.node?.status().stripes[0]?.parent ?? null, INTEGRITY_FAILURES_TO_LEAVE);
    });
  }

  private useConfig(config: StreamConfig): void {
    const known = this.streams.get(config.id);
    super.onConfig(config);
    if (!known || known.configId !== config.configId) void this.player?.configure([...this.streams.values()]).catch((error: unknown) => this.events.emit("error", error instanceof Error ? error : new Error(String(error))));
  }

  /** [D65] One more integrity failure from `peer` (`weight` of them, for a forged configuration): too many, and the node leaves it. */
  private noteIntegrityFailure(peer: PeerId | null, weight = 1): void {
    if (!peer || !this.node) return;
    const now = this.clock.now();
    let over = false;
    for (let i = 0; i < weight && !over; i++) over = this.integrity.note(peer, now);
    if (over && this.node.rejectParent(peer)) this.options.logger?.warn("overlay", `left parent ${peer}: its frames failed their integrity checks`);
  }

  protected sideOfSample(sample: MetricsSample): void {
    const player = this.player;
    if (!player) return;
    const stats = player.stats();
    sample.playoutDelayMs = Math.min(3_600_000, Math.max(0, stats.playoutDelayMs));
    if (stats.video) {
      const video = stats.video;
      let maxTemporal = 15;
      for (const stream of this.streams.values()) if (stream.kind === "video") maxTemporal = Math.min(15, player.wantedLayers(stream.id).maxTemporal);
      sample.video = {
        rendered: clampInt(video.rendered - this.counted.rendered),
        dropped: clampInt(video.dropped - this.counted.dropped),
        lost: clampInt(video.lost - this.counted.lost),
        glassToGlass: this.glassToGlass,
        frameGap: this.frameGap,
        maxTemporal,
        ...(this.catchUpFrames > 0 ? { catchUp: { frames: this.catchUpFrames, age: this.catchUpAge } } : {}),
      };
      this.catchUpFrames = 0;
      this.catchUpAge = emptyHistogram();
      this.counted.rendered = video.rendered;
      this.counted.dropped = video.dropped;
      this.counted.lost = video.lost;
      this.glassToGlass = emptyHistogram();
      this.frameGap = emptyHistogram();
    }
    if (stats.audio) {
      const audio = stats.audio;
      sample.audio = {
        playedMs: Math.min(3_600_000, Math.max(0, audio.playedMs - this.counted.playedMs)),
        concealedMs: Math.min(3_600_000, Math.max(0, audio.concealedMs - this.counted.concealedMs)),
        underruns: clampInt(audio.underruns - this.counted.underruns),
        // The player reports no per-frame audio timing; the picture's is the gate's measure (§12.3).
        glassToGlass: this.audioGlassToGlass,
        avOffsetMs: Math.min(10_000, Math.max(-10_000, round(audio.avOffsetMs))),
      };
      this.counted.playedMs = audio.playedMs;
      this.counted.concealedMs = audio.concealedMs;
      this.counted.underruns = audio.underruns;
    }
  }

  protected override onJoinStats(join: NonNullable<NodeStats["join"]>): void {
    if (this.joinReported || this.firstFrameAt === null) return;
    this.joinReported = true;
    const firstFrame = this.session(this.firstFrameAt);
    // First among the sample's events: `sample()` takes them from `pending` after this.
    this.pending.unshift({
      t: "join",
      start: this.session(this.startedAt),
      welcome: this.session(this.welcomedAt),
      linked: join.linked,
      firstPacket: join.firstPacket ?? firstFrame,
      firstFrame,
      turn: join.turn,
    });
  }

  videoTrack(): MediaStreamTrack | null {
    return this.player?.videoTrack() ?? null;
  }
  resumeAudio(): Promise<void> {
    return this.player?.resumeAudio() ?? Promise.resolve();
  }
  setVolume(volume: number): void {
    this.player?.setVolume(volume);
  }
  stats() {
    return this.player?.stats() ?? null;
  }
  async close(): Promise<void> {
    await this.teardown(true);
    await this.player?.close().catch(() => undefined);
  }
}

/* ------------------------------ the source ------------------------------ */

class SourceEngine extends PeerEngine {
  private source: ProgramSource | null = null;
  private readonly encoding: ProgramEncoding;

  constructor(options: OverlayConnectOptions & { encoding?: ProgramEncoding }) {
    super(options);
    this.encoding = options.encoding ?? DEFAULT_ENCODING;
  }

  protected async beforeStart(): Promise<void> {
    const node = this.node!;
    // The node sends each audio frame twice on every hop (SPEC D25), so the source sends it once.
    const source = createProgramSource({ encoding: this.encoding, sessionClock: this.client.sessionClock, clock: this.clock, audioCopies: 1, logger: this.options.logger });
    this.source = source;
    // Each frame goes through the application's `frameTransform` when it has one (its
    // encryption: ./transform.ts), in order; one that fails is not sent at all.
    const send = this.options.frameTransform?.send;
    const ordered = send
      ? inOrder(send, (frame) => node.publish(frame), { alive: () => this.state !== "closed", onError: (error) => this.options.logger?.warn("overlay", "a frame transform failed; the frame is not sent", error) })
      : null;
    source.on("frame", ordered ?? ((frame) => node.publish(frame)));
    // A new configuration goes out after the frames encoded before it, as it does without a
    // transform: frames still being transformed must not reach viewers after it.
    source.on("config", (raw) => {
      const announce = async () => {
        const config = await this.announced(raw);
        node.publishConfig(config);
        this.streams.set(config.id, config);
        this.client.sendStreams(await Promise.all(source.streams().map(this.announced)));
      };
      const failed = (error: unknown) => this.events.emit("error", error instanceof Error ? error : new Error(String(error)));
      if (ordered) ordered.after(() => announce().catch(failed));
      else void announce().catch(failed);
    });
    source.on("error", (error) => this.events.emit("error", error));
    // SPEC §11.4: the encoder's target from the source's own uplink and the audience's hint.
    const rate = createSourceRateController({ maxKbps: this.encoding.video.bitrateKbps, minKbps: Math.min(MIN_SOURCE_KBPS, this.encoding.video.bitrateKbps) });
    rate.on("target", (kbps) => source.setVideoBitrate(kbps));
    this.client.on("message", (message) => {
      if (message.t === "hint") rate.onHint(message.bitrateKbps, this.clock.now());
    });
    this.timers.push(this.clock.setInterval(() => rate.onChildren(node.childEstimates(), this.clock.now()), RATE_EVERY_MS));
  }

  protected sideOfSample(): void {}

  /** A stream's configuration as announced: `sframe` when the transform encrypts. */
  private readonly mark = (config: StreamConfig) => markStreamConfig(config, this.options.frameTransform);
  /** [D66] And signed, when the transform signs configurations. */
  private readonly announced = async (raw: StreamConfig): Promise<StreamConfig> => {
    const config = this.mark(raw);
    const sign = this.options.frameTransform?.signConfig;
    return sign ? sign(config) : config;
  };

  async publish(input: ProgramInput): Promise<void> {
    const node = this.node;
    const source = this.source;
    if (!node || !source) throw new Error("overlay: publish() before connect()");
    await source.start(input);
    const streams = await Promise.all(source.streams().map(this.announced));
    for (const config of streams) {
      node.publishConfig(config);
      this.streams.set(config.id, config);
    }
    this.client.sendStreams(streams);
  }

  async close(): Promise<void> {
    await this.source?.stop().catch(() => undefined);
    await this.teardown(true);
  }
}

/* ------------------------------ the factories ------------------------------ */

export function createViewer(options: OverlayConnectOptions & { decode?: boolean }): OverlayViewer {
  const engine = new ViewerEngine(options);
  return {
    on: (event, listener) => engine.events.on(event, listener),
    get state() {
      return engine.state;
    },
    connect: () => engine.connect(),
    videoTrack: () => engine.videoTrack(),
    resumeAudio: () => engine.resumeAudio(),
    setVolume: (volume) => engine.setVolume(volume),
    status: () => engine.status(),
    stats: () => engine.stats(),
    sessionClock: () => engine.sessionClock(),
    close: () => engine.close(),
  };
}

export function createSource(options: OverlayConnectOptions & { encoding?: ProgramEncoding }): OverlaySource {
  const engine = new SourceEngine(options);
  return {
    on: (event, listener) => engine.events.on(event as keyof OverlayEvents, listener as never),
    get state() {
      return engine.state;
    },
    connect: () => engine.connect(),
    publish: (input) => engine.publish(input),
    status: () => engine.status(),
    sessionClock: () => engine.sessionClock(),
    close: () => engine.close(),
  };
}

