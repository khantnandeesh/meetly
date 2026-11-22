/**
 * One peer's place in the overlay: the forwarding loop, heartbeats and feedback, the failure
 * detector, warm and cold repair, joining, backups, STALLED, paths and loop refusal, leaving,
 * NACK and retransmission, and rebalancing. SPEC §3.3, §4.4–§4.6, §7.
 *
 * Shape of this file:
 * - A `Peer` is one link and what is known of whoever is at the other end. The same peer may be
 *   this node's parent, its backup, a child, or several of those over time.
 * - Upstream there is one state machine. SPEC §7 has one per (stream, stripe) and D14 makes them
 *   move together in stage 1: one parent and one backup serve every stream. So there is one
 *   machine here, reported once per (stream, stripe) in `status()`. Stage 2 splits it.
 * - Everything timed runs from one 10 ms tick (the detector's period, SPEC §7.4) on the injected
 *   `Clock`. Nothing else owns a timer.
 * - The forwarding path (`onMedia` → `forward`) does not decode a payload, wait for a frame, or
 *   allocate per child. It runs before this peer's own reassembly.
 *
 * Owner: E-transport+topology.
 */
import {
  FROM_LATEST_KEYFRAME,
  FROM_LIVE,
  FeedbackFlag,
  HeartbeatFlag,
  HopFlag,
  MAX_NACK_ITEMS,
  MediaFlag,
  PacketType,
  decodeFeedback,
  decodeHeartbeat,
  decodeMediaHeader,
  decodeNack,
  encodeFeedback,
  encodeHeartbeat,
  encodeNack,
  encodeProbe,
  nackFragments,
  packetLinkFields,
  packetizeFrame,
  writeHopFields,
  type Assignment,
  type Feedback,
  type Heartbeat,
  type MediaHeader,
  type MetricsEvent,
  type Nack,
  type OverlayRole,
  type PeerHint,
  type PeerId,
  type PeerMessage,
  type PeerMessageOf,
  type StreamConfig,
  type StreamHead,
} from "../protocol";
import type { Cancel, Unsubscribe } from "../runtime";
import type { EncodedFrame, LayerCap, LinkEstimate, ReceivedFrame } from "../types";
import type { LayerGate, LinkEstimator, UplinkProbe } from "../congestion/types";
import { Emitter } from "../transport/emitter";
import { createReassembler } from "../transport/reassembler";
import type { Link, LinkCloseReason, SendClass } from "../transport/types";
import { createGopCache } from "./gopCache";
import { createParentSelector } from "./scoring";
import type { Candidate, NodeStats, NodeStatus, OverlayNode, OverlayNodeEvents, OverlayNodeOptions, StripeState } from "./types";

/** The detector's period, and the node's only timer (SPEC §7.4). */
export const TICK_MS = 10;
/**
 * A tick this much later than due means this node itself was not running (a busy or throttled
 * tab): the time it lost is not the others' silence (SPEC §7.4).
 */
export const OWN_STALL_MS = 30;
/** A gap is called a loss after this long at least (SPEC D6). */
export const REORDER_MS = 10;
/** SPEC D39: the window follows the parent link's p95 inter-arrival jitter, up to this. */
export const REORDER_MAX_MS = 60;
/** How many inter-arrival samples the jitter's p95 is read from, and how often it is read again. */
const JITTER_SAMPLES = 256;
const JITTER_EVERY_MS = 250;
/** A packet that has made this many hops is in a loop (SPEC §4.2). */
export const MAX_HOPS = 32;
/** No candidate link opened this long after starting to join: cold repair (SPEC §7.1). */
export const JOIN_TIMEOUT_MS = 5000;
/** A `sub` or `repair` not answered in this long is taken as refused. */
export const SUB_ACK_TIMEOUT_MS = 1000;
/** Cold repair that has not found a parent in this long becomes "rejoining" (SPEC §7.5). */
export const COLD_GIVE_UP_MS = 5000;
/** How often cold repair asks again while it has nobody to try. */
export const COLD_RETRY_MS = 500;
/** How often a peer without a backup asks for one. */
export const BACKUP_RETRY_MS = 2000;
/** A peer refused as a backup (it is below this one, or full) is not tried again for this long. */
export const BACKUP_REJECT_MS = 10_000;
/** A parent takes a peer with nothing to watch over its fan-out, up to this many times it. */
export const OVER_FANOUT_FACTOR = 2;
/** One replay a second per child and stream (SPEC §14). */
export const REPLAY_MIN_INTERVAL_MS = 1000;
/** A parent spends at most this share of a stream's bitrate on retransmissions to one child (SPEC §4.6). */
export const RETRANSMIT_SHARE = 0.2;
/**
 * SPEC §4.6, D36: over this much backlog on a child's link, in ms of the stream's bitrate (§11.2's
 * strained line), its NACKs for the enhancement layers are not answered. (Proposed by E-congestion.)
 */
export const RETRANSMIT_BACKLOG_MS = 50;
/** D36: a base-layer or keyframe packet asked for over the line waits at most this long for the backlog to clear. */
export const RETRANSMIT_HOLD_MS = 500;
/**
 * D43: a keyframe bigger than this many frame intervals of B is paced to each child, not burst:
 * its packets are spread so the last leaves `PACE_FRAMES` frame intervals after the first, its
 * own and two more. What arrives for the child behind it waits its turn, so frames stay in order.
 */
export const PACE_ABOVE_FRAMES = 2;
export const PACE_FRAMES = 3;
/** D43: past this much held for one child, nothing more is held: the link's own queue sheds. */
const PACE_MAX_BYTES = 1 << 20;
/**
 * D43: a link just above B has absorbed a paced keyframe within this many times the keyframe's
 * own time at B after its pacing ends. At 1.1 × B the backlog drains only by what the link carries
 * beyond the frames behind the keyframe, a quarter of B: 300 ms of B is gone in about a second,
 * under the 1.2 s this allows. A backlog that stands longer is the link's, whatever the keyframe did.
 */
const PACE_ABSORB_FACTOR = 4;
/** How often a peer compares its parent with the alternatives (SPEC §7.6). */
export const REBALANCE_COMPARE_MS = 10_000;
/** A parent that has held this peer at the base layer for this long may be left at once (SPEC §7.6). */
export const STARVED_SWITCH_MS = 2000;
/** A voluntary switch whose new parent sends nothing for this long is called off. */
export const SWITCH_TIMEOUT_MS = 2000;
/** A repair's freeze is measured until this long after the new parent's first packet (SPEC §12.2). */
export const REPAIR_WINDOW_MS = 1000;
/** A peer that sent PROBE packets this recently is still probing, and is sent FEEDBACK. */
export const PROBING_MS = 1000;
/** How long `stop()` gives its goodbyes to leave before closing the links. */
export const LEAVE_FLUSH_MS = 50;
const REJOIN_BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
const DEPTH_UNKNOWN = 255;
const SEEN_WINDOW = 1024;
/** A missing frame not known to be shed after this many newer frames is lost. */
const GIVE_UP_FRAMES = 120;
const ALL_LAYERS: LayerCap = { maxSpatial: 15, maxTemporal: 15 };

/* ------------------------------ small pieces ------------------------------ */

/** Which (frame, fragment) pairs of a stream have been seen, over a sliding window of frames. */
class SeenWindow {
  private frames = new Map<number, Uint8Array>();
  private floor = 0;
  private newest = -1;

  /** True if it is new. Anything older than the window counts as seen. */
  add(frameId: number, fragIndex: number, fragCount: number): boolean {
    if (frameId < this.floor) return false;
    let bits = this.frames.get(frameId);
    if (!bits) {
      bits = new Uint8Array((Math.min(fragCount, 65535) + 7) >> 3);
      this.frames.set(frameId, bits);
      if (frameId > this.newest) {
        this.newest = frameId;
        if (this.frames.size > 2 * SEEN_WINDOW) {
          this.floor = frameId - SEEN_WINDOW;
          for (const id of this.frames.keys()) if (id < this.floor) this.frames.delete(id);
        }
      }
    }
    const byte = fragIndex >> 3;
    if (byte >= bits.length) return false;
    const bit = 1 << (fragIndex & 7);
    if (bits[byte] & bit) return false;
    bits[byte] |= bit;
    return true;
  }
}

/**
 * Follows a stream by its headers alone, as a decoder would: which frames could be decoded, in
 * what order they became decodable, and the newest base-layer one. That last is the "X" of
 * "send me everything after frame X" (SPEC §7.5).
 */
class DecodeTracker {
  /** Decodable frames, with the keyframe of their GOP. */
  private decodable = new Map<number, number>();
  /** Whole frames waiting for the frame they need, by that frame's id. */
  private parked = new Map<number, { id: number; key: number; temporal: number }[]>();
  /** The newest decodable base-layer frame (for audio, the newest frame), or -1. */
  lastBase = -1;
  newest = -1;
  /** Frame ids that never became decodable but were never sent to this node either (a shed layer). */
  readonly shed = new Set<number>();
  /** Missing ids not yet known to be shed or lost, and the newest id looked at. */
  private unclassified: number[] = [];
  private classifiedUpTo = -1;

  /**
   * Asks, while the reassembler still remembers the frames on each side, whether each frame that
   * did not arrive was ever sent (SPEC §7.5 step 2: a backup over its fan-out sheds a layer). A
   * frame not settled within `GIVE_UP_FRAMES` counts as lost.
   */
  classify(neverSent: (frameId: number) => boolean): void {
    if (this.newest < 0) return;
    if (this.classifiedUpTo < 0) this.classifiedUpTo = this.newest;
    for (let id = this.classifiedUpTo + 1; id < this.newest; id++) if (!this.decodable.has(id)) this.unclassified.push(id);
    if (this.newest - 1 > this.classifiedUpTo) this.classifiedUpTo = this.newest - 1;
    if (this.unclassified.length === 0) return;
    this.unclassified = this.unclassified.filter((id) => {
      if (this.decodable.has(id)) return false;
      if (neverSent(id)) {
        this.shed.add(id);
        return false;
      }
      return id > this.newest - GIVE_UP_FRAMES;
    });
    if (this.shed.size > 2 * SEEN_WINDOW) for (const id of this.shed) if (id < this.newest - SEEN_WINDOW) this.shed.delete(id);
  }
  /** When, on the local clock, frames became decodable: the times a player could have shown them. */
  readonly shown: { at: number; id: number }[] = [];

  constructor(private readonly audio: boolean) {}

  /** A whole frame arrived. */
  push(header: { frameId: number; flags: number; refDelta: number; keyDelta: number; temporal: number }, at: number): void {
    const id = header.frameId;
    if (this.decodable.has(id)) return;
    const key = id - header.keyDelta;
    if (this.audio || (header.flags & MediaFlag.Key) !== 0 || header.refDelta === 0) return this.accept(id, key, header.temporal, at);
    const ref = id - header.refDelta;
    if (this.decodable.get(ref) === key) return this.accept(id, key, header.temporal, at);
    const list = this.parked.get(ref);
    if (list) list.push({ id, key, temporal: header.temporal });
    else this.parked.set(ref, [{ id, key, temporal: header.temporal }]);
  }

  private accept(id: number, key: number, temporal: number, at: number): void {
    const queue = [{ id, key, temporal }];
    while (queue.length > 0) {
      const frame = queue.pop()!;
      this.decodable.set(frame.id, frame.key);
      this.shown.push({ at, id: frame.id });
      if ((this.audio || frame.temporal === 0) && frame.id > this.lastBase) this.lastBase = frame.id;
      if (frame.id > this.newest) this.newest = frame.id;
      const waiting = this.parked.get(frame.id);
      if (waiting) {
        this.parked.delete(frame.id);
        for (const next of waiting) if (next.key === frame.key) queue.push(next);
      }
    }
    if (this.shown.length > 512) this.shown.splice(0, 256);
    if (this.decodable.size > 2 * SEEN_WINDOW) {
      const floor = this.newest - SEEN_WINDOW;
      for (const frameId of this.decodable.keys()) if (frameId < floor) this.decodable.delete(frameId);
      for (const frameId of this.parked.keys()) if (frameId < floor) this.parked.delete(frameId);
    }
  }

  /**
   * Over [from, to] on the local clock: the longest gap between two frames becoming decodable
   * (the last one before `from` is the left edge; with nothing at all after it, the gap runs to
   * `to`), and how many frame ids after that edge, up to the newest seen, never became decodable.
   */
  gap(from: number, to: number, neverSent: (frameId: number) => boolean = () => false): { freezeMs: number; lost: number } {
    let edge: { at: number; id: number } | null = null;
    let previous: number | null = null;
    let longest = 0;
    let highest = -1;
    let inWindow = 0;
    for (const entry of this.shown) {
      if (entry.at > to) break;
      if (entry.at < from) {
        edge = entry;
        previous = entry.at;
        continue;
      }
      if (previous !== null) longest = Math.max(longest, entry.at - previous);
      previous = entry.at;
      if (edge === null || entry.id > edge.id) {
        inWindow++;
        if (entry.id > highest) highest = entry.id;
      }
    }
    if (inWindow === 0) return { freezeMs: edge ? to - edge.at : 0, lost: 0 };
    const first = edge ? edge.id + 1 : highest - inWindow + 1;
    // A frame the parent never sent (a layer it was shedding, SPEC §7.5 step 2, §11.3) is not lost.
    let shed = 0;
    for (let id = first; id <= highest; id++) if (!this.decodable.has(id) && neverSent(id)) shed++;
    return { freezeMs: longest, lost: Math.max(0, highest - first + 1 - inWindow - shed) };
  }
}

/** A quantile of the last few hundred values handed in. */
class Reservoir {
  private values = new Float64Array(512);
  private used = 0;
  private next = 0;
  add(value: number): void {
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.values.length;
    if (this.used < this.values.length) this.used++;
  }
  take(): { p50: number; p95: number } {
    if (this.used === 0) return { p50: 0, p95: 0 };
    const sorted = this.values.slice(0, this.used).sort();
    const out = { p50: sorted[Math.floor(0.5 * (this.used - 1))], p95: sorted[Math.floor(0.95 * (this.used - 1))] };
    this.used = this.next = 0;
    return out;
  }
}

type StreamCtx = {
  config: StreamConfig;
  audio: boolean;
  stripes: number[];
  sendClass: SendClass;
  seen: SeenWindow;
  tracker: DecodeTracker;
  wanted: LayerCap;
  /** What the parent says it is sending at most. */
  parentCap: number;
};

type ChildSub = {
  mode: "active" | "standby";
  stripes: number[];
  gate: LayerGate;
  offs: Unsubscribe[];
  /** frameId → whether the gate admitted it. */
  decisions: Map<number, boolean>;
  replay: Uint8Array[];
  lastReplayAt: number;
  /** Bytes of retransmission this child may still be sent. */
  retransmitTokens: number;
  /** D36: base-layer and keyframe packets asked for while the link was backed up, sent when it clears. */
  held: { packet: Uint8Array; at: number }[];
  tokensAt: number;
};

type Peer = {
  id: PeerId;
  link: Link;
  estimator: LinkEstimator;
  offs: Unsubscribe[];
  lastHeardAt: number;
  /** When media last arrived from it. */
  lastMediaAt: number;
  /** What it says of itself in heartbeats and acks, as a possible parent. */
  path: PeerId[] | null;
  depth: number;
  stalled: boolean;
  full: boolean;
  alt: PeerHint[];
  /** As a child of this node: one entry per stream it subscribed to. Empty if it is not a child. */
  subs: Map<number, ChildSub>;
  heartbeatAt: number;
  feedbackAt: number;
  /** This node opened the link for its own purposes (a candidate), so it may close it. */
  mine: boolean;
  /** When a PROBE last came from it, and whether it is being sent FEEDBACK about them. */
  lastProbeAt: number;
  probeReporting: boolean;
  probeFeedbackAt: number;
  /** D43: the packets held back to pace a keyframe, and what of it may still be in the channel. */
  pacer: Pacer;
};

type Pacer = {
  /** In order of release. Copies: the cache's own bytes are restamped for retransmits. */
  queue: { packet: Uint8Array; due: number }[];
  queuedBytes: number;
  /**
   * The last keyframe paced: its first packet's due time and the spacing of the rest; its size,
   * the backlog (channel and queue) it found, whether its last packet has been seen, and the
   * least the backlog has stood over that since its pacing ended.
   */
  frame: { stream: number; frameId: number; start: number; spacing: number; bytes: number; before: number; whole: boolean; paceEnd: number; low: number; until: number } | null;
};

const newPacer = (): Pacer => ({ queue: [], queuedBytes: 0, frame: null });

type Purpose = "join" | "repair" | "cold" | "switch" | "standby";
type PendingSub = { peer: PeerId; stream: number; purpose: Purpose };

type RepairRecord = {
  dead: PeerId;
  next: PeerId | null;
  kind: "warm" | "cold" | "wait";
  /** Local clock. */
  lastHeard: number;
  detected: number;
  resubscribed: number;
  firstPacket: number | null;
  usedCoordinator: boolean;
};

export function createOverlayNode(options: OverlayNodeOptions): OverlayNode {
  const { self, links, coordinator, params, clock, sessionClock, logger } = options;
  const events = new Emitter<OverlayNodeEvents>((error) => logger?.error("node", "a listener threw", error));
  const cache = createGopCache({ maxMs: params.gopCacheMs, maxBytes: params.gopCacheBytes });
  const selector = createParentSelector({ rebalanceMinMs: params.rebalanceMinMs });
  const streams = new Map<number, StreamCtx>();
  const peers = new Map<PeerId, Peer>();
  const offs: Unsubscribe[] = [];

  let role: OverlayRole = "leaf";
  let started = false;
  let stopping = false;
  let ticker: Cancel | null = null;

  /* upstream */
  let state: StripeState = "idle";
  let parent: Peer | null = null;
  let backup: Peer | null = null;
  /** Who a `sub` or `repair` has been sent to and not yet answered. */
  let next: Peer | null = null;
  let nextPurpose: Purpose = "join";
  let nextDeadline = 0;
  let subSeq = 0;
  const pendingSubs = new Map<number, PendingSub>();
  /** Join and cold repair: who may still be tried, in order, and who has been. */
  let candidates: PeerHint[] = [];
  const tried = new Set<PeerId>();
  let joinBackups: PeerId[] = [];
  let joinDeadline = 0;
  let coldSince = 0;
  let coldRetryAt = 0;
  let coldAsking = false;
  /** When cold repair stops waiting for its current candidate's link to open; 0 when it is waiting for none. */
  let coldLinkDeadline = 0;
  /** Peers that turned out to be no use as a backup, and until when not to ask them again. */
  const backupRejects = new Map<PeerId, number>();
  /**
   * Peers this node takes to be dead or out of reach, and until when: a parent it lost, a link
   * that never opened or failed. Only these go in `need`'s `exclude`: the coordinator reads that
   * list as dead and leaves out what hangs below them as well (coordinator/treeMap.ts), so a peer
   * that merely said no (full, a loop) must not be in it. Those are skipped here instead.
   */
  const unreachable = new Map<PeerId, number>();
  const markUnreachable = (id: PeerId, now: number) => unreachable.set(id, now + BACKUP_REJECT_MS);
  const excluded = (now: number): PeerId[] => {
    for (const [id, until] of unreachable) if (until <= now) unreachable.delete(id);
    return [...unreachable.keys()];
  };
  let rejoinAttempt = 0;
  let waitingSince = 0;
  let backupPending: Peer | null = null;
  let backupDeadline = 0;
  let backupRetryAt = 0;
  let backupAsking = false;
  /** The parent this node last left, if its link is still up: it may come back as a backup. */
  let previous: Peer | null = null;
  let previousLeftAt = 0;
  /** It answered after this node left it: it is alive. */
  let previousAlive = false;
  let path: PeerId[] = [self];
  let depth = DEPTH_UNKNOWN;
  let starvedSince: number | null = null;
  let lastSwitchAt = 0;
  let compareAt = 0;
  let switching: { to: Peer; at: number; acked: boolean; move: boolean } | null = null;
  /** The coordinator said "move": parents to try, in order, and the one whose link is opening. */
  let moveTo: PeerId[] = [];
  let moveLinking: Peer | null = null;
  let repair: RepairRecord | null = null;
  const finishing: { record: RepairRecord; at: number }[] = [];
  const switchesFinishing: { from: PeerId; to: PeerId; at: number; until: number }[] = [];
  let uplinkAt = 0;
  /** What the player says of its playout, for FEEDBACK. */
  const playout = { delayMs: 0, bufferMs: 0 };
  /** A probe of the link to the parent, while it runs (`runProbe`). */
  let probing: { probe: UplinkProbe; parent: Peer } | null = null;
  let lastStatus = "";

  /* stats */
  let nacksSent = 0;
  let retransmitsReceived = 0;
  let duplicates = 0;
  let layerDrops = 0;
  let retransmitsSent = 0;
  let bufferedMax = 0;
  let rxBytes = 0;
  let txBytes = 0;
  let statsAt = 0;
  let malformed = 0;
  const forwardUs = new Reservoir();
  let joinTimes: { linked: number; firstPacket: number | null; turn: boolean } | null = null;
  const audioRepeats: { at: number; stream: number; frameId: number }[] = [];

  /**
   * SPEC D39: the reordering window, max(10 ms, the p95 of the inter-arrival jitter), at most
   * 60 ms. Jitter is RFC 3550's |D| with the frame's `captureUs` as the media timestamp: the change
   * in (arrival − capture) from one live video packet to the next. That is the stream as it
   * arrives, every hop's reordering in it: a relay forwards packets in the order they reached it,
   * so a link's own jitter (from its `sendMs`) would miss what the hops above added. Replays and
   * retransmissions are late on purpose and are left out. Packets that overtake each other by up
   * to the window are not taken for lost and asked for again.
   */
  const jitter = { values: new Float64Array(JITTER_SAMPLES), used: 0, next: 0, from: null as PeerId | null, lastTransit: NaN, windowMs: REORDER_MS, readAt: -Infinity };
  const noteTransit = (from: PeerId, transit: number) => {
    if (jitter.from !== from) {
      jitter.from = from;
      jitter.used = jitter.next = 0;
      jitter.lastTransit = NaN;
    }
    if (jitter.lastTransit === jitter.lastTransit) {
      jitter.values[jitter.next] = Math.abs(transit - jitter.lastTransit);
      jitter.next = (jitter.next + 1) % JITTER_SAMPLES;
      if (jitter.used < JITTER_SAMPLES) jitter.used++;
    }
    jitter.lastTransit = transit;
  };
  const reorderWindowMs = () => {
    const now = clock.now();
    if (now - jitter.readAt < JITTER_EVERY_MS) return jitter.windowMs;
    jitter.readAt = now;
    if (jitter.used < 16) return (jitter.windowMs = REORDER_MS);
    const sorted = jitter.values.slice(0, jitter.used).sort();
    const p95 = sorted[Math.floor(0.95 * (jitter.used - 1))];
    return (jitter.windowMs = Math.min(REORDER_MAX_MS, Math.max(REORDER_MS, p95)));
  };

  const reassembler = createReassembler({
    clock,
    reorderMs: reorderWindowMs,
    maxPending: 64,
    nackRetries: params.nackRetries,
    retryMs: () => Math.max(20, parent?.estimator.estimate(clock.now()).rttMs ?? 100),
  });

  /* ------------------------------ helpers ------------------------------ */

  const primary = (): StreamCtx | null => {
    let first: StreamCtx | null = null;
    for (const stream of streams.values()) {
      if (!stream.audio) return stream;
      first ??= stream;
    }
    return first;
  };
  const primaryId = () => primary()?.config.id ?? 0;

  /** What the coordinator capped this relay's fan-out at (a provisional relay, SPEC §8.1 [D38]), if it did. */
  let fanoutCap: number | null = null;
  const fanout = () => (role === "source" ? params.sourceFanout : role === "relay" ? Math.min(params.maxFanout, fanoutCap ?? Infinity) : 0);
  const isActiveChild = (peer: Peer) => {
    for (const sub of peer.subs.values()) if (sub.mode === "active") return true;
    return false;
  };
  const activeChildren = () => [...peers.values()].filter(isActiveChild);
  const standbyChildren = () => [...peers.values()].filter((peer) => peer.subs.size > 0 && !isActiveChild(peer));
  const myDepth = () => (role === "source" ? 0 : depth !== DEPTH_UNKNOWN ? depth : path.length > 1 ? Math.min(254, path.length - 1) : DEPTH_UNKNOWN);

  const status = (): NodeStatus => {
    const active = activeChildren();
    const stripes = [...streams.values()].flatMap((stream) =>
      stream.stripes.map((stripe) => ({ stream: stream.config.id, stripe, state, parent: parent?.id ?? null, backup: backup?.id ?? null })),
    );
    return {
      role,
      depth: myDepth(),
      path: [...path],
      stripes,
      children: active.map((peer) => peer.id),
      standbyChildren: standbyChildren().map((peer) => peer.id),
      freeSlots: Math.max(0, fanout() - active.length),
    };
  };

  /** Announces `status` if anything in it changed. */
  const changed = () => {
    const now = JSON.stringify(status());
    if (now === lastStatus) return;
    lastStatus = now;
    events.emit("status");
  };

  const metric = (event: MetricsEvent) => events.emit("metric", event);
  const session = (local: number) => Math.max(0, sessionClock.fromLocal(local));

  const setState = (to: StripeState) => {
    if (state === to) return;
    logger?.debug("node", `${self}: ${state} → ${to}`);
    const was = state;
    state = to;
    // Children are told at once when this node is cut off, and when it is back: they wait
    // instead of repairing, and know how long they waited (SPEC D17).
    if (role !== "source" && (was === "active") !== (to === "active")) sendHeartbeats(clock.now(), true);
  };

  const addStream = (config: StreamConfig): StreamCtx => {
    const existing = streams.get(config.id);
    if (existing) {
      existing.config = config;
      return existing;
    }
    const audio = config.kind === "audio";
    const stream: StreamCtx = {
      config,
      audio,
      stripes: config.stripes.length > 0 ? config.stripes.map((stripe) => stripe.index) : [0],
      sendClass: audio ? "audio" : "video",
      seen: new SeenWindow(),
      tracker: new DecodeTracker(audio),
      wanted: { ...ALL_LAYERS },
      parentCap: 15,
    };
    streams.set(config.id, stream);
    return stream;
  };

  const temporalLayers = (config: StreamConfig) => {
    const match = /T(\d)/.exec(config.scalability ?? "");
    return match ? Number(match[1]) : 1;
  };
  const frameIntervalMs = (config: StreamConfig) => (config.kind === "audio" ? (config.frameUs ?? 20_000) / 1000 : 1000 / (config.fps ?? 30));

  const hint = (peer: Peer): PeerHint => ({ peer: peer.id, depth: peer.depth === DEPTH_UNKNOWN ? 254 : peer.depth, free: peer.full ? 0 : 1 });

  /**
   * Why `peer`, by its path, cannot be this node's backup (SPEC §7.3): it is below this node, which
   * would be a loop the moment it was used; or it is below the parent (unless that is the source),
   * so whatever cuts this node off cuts it off too. Null if it can.
   */
  const unfitBackup = (peer: Peer, theirs: PeerId[] | null = peer.path): "loop" | "below-parent" | null => {
    if (!theirs) return null;
    if (theirs.includes(self)) return "loop";
    if (parent && parent !== peer && role !== "source" && myDepth() > 1 && theirs.includes(parent.id)) return "below-parent";
    return null;
  };

  /* ------------------------------ peers and links ------------------------------ */

  const attach = (link: Link, mine: boolean): Peer => {
    const known = peers.get(link.peer);
    if (known && known.link === link) {
      known.mine ||= mine;
      return known;
    }
    if (known) detach(known);
    const now = clock.now();
    const peer: Peer = {
      id: link.peer,
      link,
      estimator: options.createLinkEstimator({ bitrateKbps: primary()?.config.bitrateKbps ?? 1200 }),
      offs: [],
      lastHeardAt: now,
      lastMediaAt: -Infinity,
      path: null,
      depth: DEPTH_UNKNOWN,
      stalled: false,
      full: false,
      alt: [],
      subs: new Map(),
      heartbeatAt: -Infinity,
      feedbackAt: -Infinity,
      mine,
      lastProbeAt: -Infinity,
      probeReporting: false,
      probeFeedbackAt: -Infinity,
      pacer: newPacer(),
    };
    peers.set(peer.id, peer);
    peer.offs.push(
      link.on("packet", (packet, receivedAt) => onPacket(peer, packet, receivedAt)),
      link.on("message", (message) => onMessage(peer, message)),
      link.on("state", (linkState, reason) => {
        if (linkState === "open") onLinkOpen(peer);
        else if (linkState === "closed") onLinkClosed(peer, reason);
      }),
    );
    return peer;
  };

  const detach = (peer: Peer) => {
    for (const off of peer.offs.splice(0)) off();
    dropSubs(peer);
    if (peers.get(peer.id) === peer) peers.delete(peer.id);
  };

  const dropSubs = (peer: Peer) => {
    for (const sub of peer.subs.values()) for (const off of sub.offs) off();
    peer.subs.clear();
    peer.pacer = newPacer();
  };

  /** Opens (or finds) the link to a peer this node wants something from. */
  const reach = (id: PeerId): Peer => attach(links.connect(id), true);

  /** Closes a link this node opened and no longer has a use for. */
  const release = (peer: Peer) => {
    if (peer === parent || peer === backup || peer === next || peer === backupPending || peer === previous || switching?.to === peer || peer === moveLinking || peer.subs.size > 0) return;
    if (!peer.mine) return;
    detach(peer);
    peer.link.close("local");
  };

  const send = (peer: Peer, message: PeerMessage) => peer.link.sendMessage(message);

  /** Sends one packet on a link and tells its estimator. */
  const sendPacket = (peer: Peer, packet: Uint8Array, sendClass: SendClass, now: number): boolean => {
    if (!peer.link.sendPacket(packet, sendClass)) return false;
    peer.estimator.onSent(packet.byteLength, now);
    txBytes += packet.byteLength;
    return true;
  };

  /**
   * D43: a live video packet for a child, sent now or held so that a large keyframe goes out over
   * `PACE_FRAMES` frame intervals. Anything behind a held packet is held too, in order.
   */
  const paceOrSend = (child: Peer, stream: StreamCtx, header: MediaHeader, packet: Uint8Array, now: number): void => {
    const pacer = child.pacer;
    let due = now;
    if (header.flags & MediaFlag.Key) {
      const interval = frameIntervalMs(stream.config);
      const bytes = header.fragCount * packet.byteLength;
      if (bytes > (stream.config.bitrateKbps * PACE_ABOVE_FRAMES * interval) / 8) {
        let frame = pacer.frame;
        if (!frame || frame.stream !== stream.config.id || frame.frameId !== header.frameId) {
          const last = pacer.queue.length > 0 ? pacer.queue[pacer.queue.length - 1].due : now;
          const before = child.link.bufferedAmount + pacer.queuedBytes;
          const start = Math.max(now, last);
          const paceEnd = start + PACE_FRAMES * interval;
          const until = paceEnd + (PACE_ABSORB_FACTOR * bytes * 8) / stream.config.bitrateKbps;
          frame = pacer.frame = { stream: stream.config.id, frameId: header.frameId, start, spacing: (PACE_FRAMES * interval) / header.fragCount, bytes, before, whole: false, paceEnd, low: Infinity, until };
        }
        due = frame.start + header.fragIndex * frame.spacing;
        if (header.fragIndex === header.fragCount - 1) frame.whole = true;
      }
    }
    if (pacer.queue.length > 0) due = Math.max(due, pacer.queue[pacer.queue.length - 1].due);
    if ((due <= now && pacer.queue.length === 0) || pacer.queuedBytes > PACE_MAX_BYTES) {
      sendPacket(child, packet, stream.sendClass, now);
      return;
    }
    pacer.queue.push({ packet: packet.slice(), due });
    pacer.queuedBytes += packet.byteLength;
  };

  /** D43: hands each child the held packets now due. */
  function releasePaced(now: number): void {
    for (const peer of peers.values()) {
      const pacer = peer.pacer;
      while (pacer.queue.length > 0 && pacer.queue[0].due <= now) {
        const held = pacer.queue.shift()!;
        pacer.queuedBytes -= held.packet.byteLength;
        sendPacket(peer, held.packet, streams.get(held.packet[2])?.sendClass ?? "video", now);
      }
    }
  }

  /**
   * D43: what of the last paced keyframe the link has yet to absorb: how far the backlog (the
   * channel's and the pacer's) stands over the one the keyframe found, never more than the
   * keyframe itself. Once the pacing is done a link that carries the stream only drains it, so
   * the remainder never rises again: a backlog that grows back is the link's, not the keyframe's.
   * Nothing once the backlog is back down to where it was, or once the link has had
   * `PACE_ABSORB_FACTOR` times the keyframe's time at B to absorb it.
   */
  const pacedRemainder = (peer: Peer, now: number): number => {
    const frame = peer.pacer.frame;
    if (!frame) return 0;
    let over = now >= frame.until ? 0 : Math.min(frame.bytes, peer.link.bufferedAmount + peer.pacer.queuedBytes - frame.before);
    if (now >= frame.paceEnd) over = frame.low = Math.min(frame.low, over);
    if (over > 0) return over;
    if (frame.whole) peer.pacer.frame = null;
    return 0;
  };

  /* ------------------------------ receiving ------------------------------ */

  function onPacket(peer: Peer, packet: Uint8Array, receivedAt: number): void {
    const fields = packetLinkFields(packet);
    if (!fields) {
      malformed++;
      return;
    }
    peer.lastHeardAt = receivedAt;
    peer.estimator.onReceived(fields.linkSeq, fields.sendMs, packet.byteLength, receivedAt);
    // Every packet from whoever may be sending media, duplicates included: it is how the
    // reassembler tells a layer the sender shed from a loss (by the link sequence).
    if (peer === parent || peer === next || peer === switching?.to) reassembler.noteLinkPacket(peer.id, fields.linkSeq);
    switch (fields.type) {
      case PacketType.Media:
      case PacketType.Parity:
        onMedia(peer, packet, receivedAt);
        return;
      case PacketType.Heartbeat: {
        const heartbeat = decodeHeartbeat(packet);
        if (!heartbeat) malformed++;
        else onHeartbeat(peer, heartbeat, receivedAt);
        return;
      }
      case PacketType.Feedback: {
        const feedback = decodeFeedback(packet);
        if (!feedback) malformed++;
        else onFeedback(peer, feedback, receivedAt);
        return;
      }
      case PacketType.Nack: {
        const nack = decodeNack(packet);
        if (!nack) malformed++;
        else onNack(peer, nack, receivedAt);
        return;
      }
      default:
        // PROBE: counted by the estimator; a child probing this node is told how it fared (below).
        if (fields.type === PacketType.Probe) peer.lastProbeAt = receivedAt;
    }
  }

  function onMedia(peer: Peer, packet: Uint8Array, receivedAt: number): void {
    // Media is taken only from whoever this node has asked for it.
    if (peer !== parent && peer !== next && peer !== switching?.to) return;
    const header = decodeMediaHeader(packet);
    if (!header) {
      malformed++;
      return;
    }
    if (header.hops >= MAX_HOPS) return;
    const stream = streams.get(header.streamId);
    if (!stream) return;
    rxBytes += packet.byteLength;
    peer.lastMediaAt = receivedAt;
    if (peer === parent && !stream.audio && !(header.hopFlags & (HopFlag.Replay | HopFlag.Retransmit))) noteTransit(peer.id, session(receivedAt) - header.captureUs / 1000);
    if (header.hopFlags & HopFlag.Retransmit) retransmitsReceived++;
    if (peer === parent && state === "waiting") resumeFromWaiting(receivedAt);
    if (repair && repair.firstPacket === null && repair.next === peer.id) {
      repair.firstPacket = receivedAt;
      if (peer === parent) finishRepairLater();
    }
    if (joinTimes && joinTimes.firstPacket === null) joinTimes.firstPacket = session(receivedAt);
    if (switching?.to === peer) completeSwitch(receivedAt);

    if (!stream.seen.add(header.frameId, header.fragIndex, header.fragCount)) {
      duplicates++;
      return;
    }
    forward(stream, header, packet, receivedAt, header.hops + 1, header.hopFlags & (HopFlag.Replay | HopFlag.Retransmit));
    cache.add(packet, header, receivedAt);
    if (header.type !== PacketType.Media) return;
    const frame = reassembler.push(packet, header, peer.id, receivedAt);
    if (frame) onFrame(stream, frame);
  }

  function onFrame(stream: StreamCtx, frame: ReceivedFrame): void {
    stream.tracker.push(frame.header, frame.completeAt);
    events.emit("frame", frame);
  }

  /**
   * The forwarding loop: one packet to every child subscribed to its stream. The gate is asked
   * once per frame and child, at the frame's first packet to arrive; the same bytes go to every
   * child, the link stamping its own `linkSeq` and `sendMs` on each copy.
   */
  function forward(stream: StreamCtx, header: MediaHeader, packet: Uint8Array, receivedAt: number, hops: number, hopFlags: number): void {
    let sent = false;
    let stamped = false;
    const id = stream.config.id;
    for (const child of peers.values()) {
      if (child.subs.size === 0) continue;
      const sub = child.subs.get(id);
      if (!sub || sub.mode !== "active" || !sub.stripes.includes(header.stripe)) continue;
      let admit = sub.decisions.get(header.frameId);
      if (admit === undefined) {
        const buffered = child.link.bufferedAmount;
        if (buffered > bufferedMax) bufferedMax = buffered;
        child.estimator.onBuffered(buffered, receivedAt);
        admit = sub.gate.admit(header, header.fragCount * packet.byteLength, child.estimator.estimate(receivedAt), receivedAt, pacedRemainder(child, receivedAt));
        sub.decisions.set(header.frameId, admit);
        if (sub.decisions.size > 256) {
          let drop = 128;
          for (const key of sub.decisions.keys()) {
            if (drop-- <= 0) break;
            sub.decisions.delete(key);
          }
        }
        if (!admit) layerDrops++;
      }
      if (!admit) continue;
      if (!stamped) {
        writeHopFields(packet, { hopFlags, hops: Math.min(255, hops), linkSeq: 0, sendMs: 0 });
        stamped = true;
      }
      if (hopFlags & (HopFlag.Replay | HopFlag.Retransmit) || stream.audio) sendPacket(child, packet, hopFlags & HopFlag.Replay ? "replay" : stream.sendClass, receivedAt);
      else paceOrSend(child, stream, header, packet, receivedAt);
      sent = true;
    }
    if (sent) {
      forwardUs.add((clock.now() - receivedAt) * 1000);
      // Each audio frame goes twice on every hop, a frame apart (SPEC D25).
      if (stream.audio && header.fragIndex === 0 && !(hopFlags & HopFlag.Retransmit)) {
        audioRepeats.push({ at: receivedAt + frameIntervalMs(stream.config), stream: id, frameId: header.frameId });
      }
    }
  }

  function repeatAudio(now: number): void {
    while (audioRepeats.length > 0 && audioRepeats[0].at <= now) {
      const repeat = audioRepeats.shift()!;
      const stream = streams.get(repeat.stream);
      if (!stream) continue;
      for (const packet of cache.fragments(repeat.stream, repeat.frameId, null)) {
        const stripe = packet[3];
        writeHopFields(packet, { hopFlags: 0, hops: Math.min(255, role === "source" ? 0 : myHops()), linkSeq: 0, sendMs: 0 });
        for (const child of peers.values()) {
          const sub = child.subs.get(repeat.stream);
          if (sub && sub.mode === "active" && sub.stripes.includes(stripe) && sub.decisions.get(repeat.frameId) !== false) sendPacket(child, packet, "audio", now);
        }
      }
    }
  }

  /** The `hops` this node writes on what it sends from its cache: its own depth. */
  const myHops = () => {
    const d = myDepth();
    return d === DEPTH_UNKNOWN ? Math.max(1, path.length - 1) : d;
  };

  /* ------------------------------ heartbeats and feedback ------------------------------ */

  function onHeartbeat(peer: Peer, heartbeat: Heartbeat, now: number): void {
    peer.estimator.onHeartbeat(heartbeat, now);
    peer.depth = heartbeat.depth;
    peer.full = (heartbeat.flags & HeartbeatFlag.Full) !== 0;
    const wasStalled = peer.stalled;
    peer.stalled = (heartbeat.flags & HeartbeatFlag.Stalled) !== 0;
    if (heartbeat.flags & HeartbeatFlag.Leaving) {
      if (peer === parent) parentDied(now, "leaving");
      else if (peer === backup) backupLost(now, false);
      return;
    }
    if (peer !== parent) return;
    if (heartbeat.depth !== DEPTH_UNKNOWN && depth !== heartbeat.depth + 1) {
      depth = Math.min(254, heartbeat.depth + 1);
      changed();
    }
    if (peer.stalled && state === "active") {
      // The parent is alive but cut off, and is repairing: wait for it (SPEC D17).
      setState("waiting");
      waitingSince = now;
      repair = { dead: peer.id, next: peer.id, kind: "wait", lastHeard: Number.isFinite(peer.lastMediaAt) ? peer.lastMediaAt : now, detected: now, resubscribed: now, firstPacket: null, usedCoordinator: false };
      changed();
    } else if (!peer.stalled && wasStalled && state === "waiting") {
      resumeFromWaiting(now);
    }
  }

  function resumeFromWaiting(now: number): void {
    setState("active");
    if (repair && repair.kind === "wait" && repair.firstPacket === null) {
      repair.firstPacket = now;
      finishRepairLater();
    }
    changed();
  }

  function onFeedback(peer: Peer, feedback: Feedback, now: number): void {
    // From a child about what this node sends it; or from the parent about this node's probe.
    peer.estimator.onFeedback(feedback, now);
    if (peer.subs.size === 0) return;
    const cap = { maxSpatial: feedback.maxSpatial, maxTemporal: feedback.maxTemporal };
    for (const [id, sub] of peer.subs) if (!streams.get(id)?.audio) sub.gate.setWanted(cap);
  }

  function sendHeartbeats(now: number, force = false): void {
    let heads: StreamHead[] | null = null;
    let flags = -1;
    for (const child of peers.values()) {
      if (child.subs.size === 0) continue;
      const active = isActiveChild(child);
      if (!force && now - child.heartbeatAt < (active ? params.heartbeatMs : params.standbyHeartbeatMs) - 1) continue;
      child.heartbeatAt = now;
      if (!heads) {
        heads = [];
        for (const id of streams.keys()) {
          const head = cache.head(id);
          if (head && heads.length < 16) heads.push(head);
        }
        flags =
          (role !== "source" && state !== "active" ? HeartbeatFlag.Stalled : 0) | (stopping ? HeartbeatFlag.Leaving : 0) | (activeChildren().length >= fanout() ? HeartbeatFlag.Full : 0);
      }
      const packet = encodeHeartbeat({ flags: flags | (active ? 0 : HeartbeatFlag.Standby), linkSeq: 0, sendMs: 0, ...child.estimator.echo(now), depth: myDepth(), streams: heads });
      sendPacket(child, packet, "control", now);
    }
  }

  function sendFeedback(now: number): void {
    const to = (peer: Peer | null, everyMs: number, standby: boolean) => {
      if (!peer || peer.link.state !== "open" || now - peer.feedbackAt < everyMs - 1) return;
      peer.feedbackAt = now;
      const video = primary();
      const packet = encodeFeedback({
        flags: (standby ? FeedbackFlag.Standby : 0) | (starvedSince !== null ? FeedbackFlag.Starved : 0),
        linkSeq: 0,
        sendMs: 0,
        ...peer.estimator.takeFeedback(now),
        playoutDelayMs: Math.min(0xffff, Math.max(0, Math.round(playout.delayMs))),
        bufferMs: Math.min(0xffff, Math.max(0, Math.round(playout.bufferMs))),
        maxSpatial: video?.wanted.maxSpatial ?? 15,
        maxTemporal: video?.wanted.maxTemporal ?? 15,
      });
      sendPacket(peer, packet, "control", now);
    };
    to(parent, params.feedbackMs, false);
    if (switching) to(switching.to, params.feedbackMs, false);
    to(backup, params.standbyHeartbeatMs, true);

    // FEEDBACK goes down, too, to a peer probing this one, for as long as its PROBE packets keep
    // coming: a prober must hear how its probe fared (SPEC §11.6; congestion's README, item 12).
    // The first interval is thrown away, so the count starts with the probe.
    for (const peer of peers.values()) {
      const probingUs = now - peer.lastProbeAt < PROBING_MS && peer.link.state === "open";
      if (!probingUs) {
        peer.probeReporting = false;
        continue;
      }
      if (!peer.probeReporting) {
        peer.estimator.takeFeedback(now);
        peer.probeReporting = true;
        peer.probeFeedbackAt = now;
        continue;
      }
      if (now - peer.probeFeedbackAt < params.feedbackMs - 1) continue;
      peer.probeFeedbackAt = now;
      const packet = encodeFeedback({ flags: 0, linkSeq: 0, sendMs: 0, ...peer.estimator.takeFeedback(now), playoutDelayMs: 0, bufferMs: 0, maxSpatial: 15, maxTemporal: 15 });
      sendPacket(peer, packet, "control", now);
    }
  }

  /** Runs a probe handed to `runProbe`: what it asks for, to the parent, in the lowest class. */
  function runProbe(now: number): void {
    if (!probing) return;
    const { probe } = probing;
    if (parent !== probing.parent || !parent || parent.link.state !== "open") {
      probing = null;
      events.emit("probe", null);
      return;
    }
    parent.estimator.onBuffered(parent.link.bufferedAmount, now);
    const view = parent.estimator.directed ? parent.estimator.directed("sent", now) : parent.estimator.estimate(now);
    for (const size of probe.next(view, now)) sendPacket(parent, encodeProbe({ linkSeq: 0, sendMs: 0, size }), "replay", now);
    if (probe.spareKbps !== null) {
      probing = null;
      events.emit("probe", probe.spareKbps);
    }
  }

  /* ------------------------------ NACK ------------------------------ */

  function sendNacks(now: number): void {
    if (!parent || state !== "active" || parent.link.state !== "open") return;
    const items = reassembler.missing(now, MAX_NACK_ITEMS);
    if (items.length === 0) return;
    nacksSent += items.length;
    sendPacket(parent, encodeNack({ linkSeq: 0, sendMs: 0, items }), "control", now);
  }

  function onNack(peer: Peer, nack: Nack, now: number): void {
    for (const item of nack.items) {
      const sub = peer.subs.get(item.streamId);
      const stream = streams.get(item.streamId);
      if (!sub || !stream || sub.mode !== "active") continue;
      // A frame the gate kept from this child is not sent on request either.
      if (sub.decisions.get(item.frameId) === false) continue;
      // At most 20% of the stream's bitrate, over any second.
      const perSecond = RETRANSMIT_SHARE * stream.config.bitrateKbps * 125;
      sub.retransmitTokens = Math.min(perSecond, sub.retransmitTokens + ((now - sub.tokensAt) / 1000) * perSecond);
      sub.tokensAt = now;
      // D36: a link that overflowed asks for what it lost, and answering at once refills the queue
      // it lost it from. Over the strained line (50 ms of B, §11.2) an enhancement layer is not sent
      // again; the base layer and keyframes (losing one costs the whole GOP) are held, and sent
      // when the backlog clears (`flushHeld`), within the same budget.
      const backlogged = backlogOver(peer, stream);
      for (const packet of cache.fragments(item.streamId, item.frameId, nackFragments(item))) {
        if (backlogged) {
          if ((packet[4] & 0x0f) === 0 || packet[1] & MediaFlag.Key) {
            if (!sub.held.some((held) => held.packet === packet) && sub.held.length < 256) sub.held.push({ packet, at: now });
          }
          continue;
        }
        if (sub.retransmitTokens < packet.byteLength) return;
        const layer = packet[4];
        if ((layer & 0x0f) > sub.gate.cap.maxTemporal || layer >> 4 > sub.gate.cap.maxSpatial || !sub.stripes.includes(packet[3])) continue;
        sub.retransmitTokens -= packet.byteLength;
        writeHopFields(packet, { hopFlags: HopFlag.Retransmit, hops: Math.min(255, myHops()), linkSeq: 0, sendMs: 0 });
        if (sendPacket(peer, packet, stream.sendClass, now)) retransmitsSent++;
      }
    }
  }

  const backlogOver = (peer: Peer, stream: StreamCtx) => peer.link.bufferedAmount > (stream.config.bitrateKbps * RETRANSMIT_BACKLOG_MS) / 8;

  /** D36: the base-layer and keyframe packets a backed-up child asked for, once its backlog has cleared. */
  function flushHeld(peer: Peer, now: number): void {
    for (const [id, sub] of peer.subs) {
      if (sub.held.length === 0) continue;
      const stream = streams.get(id);
      if (!stream || sub.mode !== "active") {
        sub.held = [];
        continue;
      }
      sub.held = sub.held.filter((held) => now - held.at <= RETRANSMIT_HOLD_MS);
      if (sub.held.length === 0 || backlogOver(peer, stream)) continue;
      const perSecond = RETRANSMIT_SHARE * stream.config.bitrateKbps * 125;
      sub.retransmitTokens = Math.min(perSecond, sub.retransmitTokens + ((now - sub.tokensAt) / 1000) * perSecond);
      sub.tokensAt = now;
      let sent = 0;
      for (const { packet } of sub.held) {
        if (sub.retransmitTokens < packet.byteLength || backlogOver(peer, stream)) break;
        sub.retransmitTokens -= packet.byteLength;
        writeHopFields(packet, { hopFlags: HopFlag.Retransmit, hops: Math.min(255, myHops()), linkSeq: 0, sendMs: 0 });
        if (sendPacket(peer, packet, stream.sendClass, now)) retransmitsSent++;
        sent++;
      }
      sub.held.splice(0, sent);
    }
  }

  /* ------------------------------ being a parent ------------------------------ */

  function makeSub(peer: Peer, stream: StreamCtx, stripes: number[], now: number): ChildSub {
    const gate = options.createLayerGate({
      bitrateKbps: stream.config.bitrateKbps,
      temporalLayers: temporalLayers(stream.config),
      frameIntervalMs: frameIntervalMs(stream.config),
      kind: stream.config.kind,
      spatialLayers: 1,
    });
    const id = stream.config.id;
    const tell = (cap: LayerCap, reason: "congestion" | "overload" | "restore") => {
      send(peer, { t: "layers", stream: id, maxSpatial: cap.maxSpatial, maxTemporal: cap.maxTemporal, reason });
      metric({ t: "layer", stream: id, peer: peer.id, at: session(clock.now()), maxTemporal: cap.maxTemporal, reason });
    };
    const sub: ChildSub = {
      mode: "standby",
      stripes,
      gate,
      offs: [gate.on("change", tell), gate.on("starved", () => tell(gate.cap, "congestion"))],
      decisions: new Map(),
      replay: [],
      lastReplayAt: -Infinity,
      retransmitTokens: RETRANSMIT_SHARE * stream.config.bitrateKbps * 125,
      tokensAt: now,
      held: [],
    };
    peer.subs.set(id, sub);
    return sub;
  }

  function onSubscribe(peer: Peer, message: PeerMessageOf<"sub"> | PeerMessageOf<"repair">): void {
    const now = clock.now();
    const stream = streams.get(message.stream);
    const refuse = (code: "full" | "no-stream" | "loop" | "denied" | "leaving") => send(peer, { t: "sub-ack", id: message.id, ok: false, code });
    if (stopping) return refuse("leaving");
    if (role === "leaf") return refuse("denied");
    if (!stream) return refuse("no-stream");
    // Never a child that is one of this node's ancestors, or that it is asking to be its parent.
    if (path.includes(peer.id, 1) || peer === parent || peer === next || switching?.to === peer) return refuse("loop");
    const isRepair = message.t === "repair";
    const mode = isRepair ? "active" : message.mode;
    const existing = peer.subs.get(stream.config.id);
    const wasChild = peer.subs.size > 0;
    const wasActive = isActiveChild(peer);
    if (mode === "standby") {
      if (!wasChild && standbyChildren().length >= 2 * params.maxFanout) return refuse("full");
    } else if (!wasActive && !isRepair && activeChildren().length >= fanout()) {
      // A peer with nothing to watch yet (it asks from the latest keyframe: a joiner, or one the
      // coordinator found no free slot for) is taken in over the fan-out, up to twice it, and
      // every child is sent one layer fewer until the coordinator moves someone (SPEC §7.5 step 2,
      // §11.3 rule 8): a picture at a lower frame rate now is better than none until a relay is
      // promoted, which at a session's start is a probation (D18) away. A peer that is watching
      // elsewhere (a switch, a move: it asks from a frame) is refused as before.
      if (message.fromFrame !== FROM_LATEST_KEYFRAME || activeChildren().length >= OVER_FANOUT_FACTOR * fanout()) return refuse("full");
    } else if (!isRepair && message.fromFrame !== FROM_LIVE && existing && now - existing.lastReplayAt < REPLAY_MIN_INTERVAL_MS) {
      return refuse("denied");
    }
    const sub = existing ?? makeSub(peer, stream, message.stripes, now);
    sub.stripes = message.stripes.length > 0 ? message.stripes : stream.stripes;
    sub.mode = mode;
    if (!wasChild) {
      peer.lastHeardAt = now;
      peer.heartbeatAt = -Infinity;
    }
    if (message.t === "sub") sub.gate.setWanted({ maxSpatial: message.maxSpatial, maxTemporal: message.maxTemporal });
    const head = cache.head(stream.config.id);
    send(peer, {
      t: "sub-ack",
      id: message.id,
      ok: true,
      config: stream.config,
      headFrame: head?.headFrameId,
      keyFrame: head?.keyFrameId,
      path: path.slice(0, 64),
      maxTemporal: Math.min(15, sub.gate.cap.maxTemporal),
    });
    if (mode === "active") {
      sub.replay = cache.replay(stream.config.id, sub.stripes, message.fromFrame, sub.gate.cap);
      if (sub.replay.length > 0) sub.lastReplayAt = now;
      for (const packet of sub.replay) sub.decisions.set(decodeFrameId(packet), true);
      pumpReplay(peer, now);
    } else {
      sub.replay = [];
    }
    // A heartbeat at once: the child starts its silence clock from this.
    sendHeartbeats(now);
    checkOverload();
    changed();
  }

  const decodeFrameId = (packet: Uint8Array) => ((packet[8] << 24) | (packet[9] << 16) | (packet[10] << 8) | packet[11]) >>> 0;

  /** Sends as much of a child's pending replay as the gate allows: behind live media (SPEC §11.5). */
  function pumpReplay(peer: Peer, now: number): void {
    for (const sub of peer.subs.values()) {
      if (sub.replay.length === 0) continue;
      if (sub.mode !== "active") {
        sub.replay = [];
        continue;
      }
      peer.estimator.onBuffered(peer.link.bufferedAmount, now);
      let budget = sub.gate.replayBudget(peer.estimator.estimate(now), now);
      let sentCount = 0;
      const hops = Math.min(255, myHops());
      while (sentCount < sub.replay.length && budget >= sub.replay[sentCount].byteLength) {
        const packet = sub.replay[sentCount++];
        budget -= packet.byteLength;
        writeHopFields(packet, { hopFlags: HopFlag.Replay, hops, linkSeq: 0, sendMs: 0 });
        sendPacket(peer, packet, "replay", now);
      }
      if (sentCount > 0) sub.replay.splice(0, sentCount);
    }
  }

  /** More active children than slots (a repair was taken in): every child sheds a layer until that is put right (SPEC §7.5, §11.3). */
  function checkOverload(): void {
    const over = activeChildren().length > fanout();
    for (const child of peers.values()) for (const sub of child.subs.values()) sub.gate.setOverload(over);
  }

  function removeChild(peer: Peer, report: boolean): void {
    if (peer.subs.size === 0) return;
    dropSubs(peer);
    if (report && !stopping) coordinator.report("child-gone", primaryId(), 0, peer.id);
    checkOverload();
    changed();
  }

  /* ------------------------------ messages ------------------------------ */

  function onMessage(peer: Peer, message: PeerMessage): void {
    const now = clock.now();
    switch (message.t) {
      case "sub":
      case "repair":
        return onSubscribe(peer, message);
      case "sub-ack":
        return onSubAck(peer, message, now);
      case "unsub": {
        const sub = peer.subs.get(message.stream);
        if (!sub) return;
        for (const off of sub.offs) off();
        peer.subs.delete(message.stream);
        checkOverload();
        changed();
        return;
      }
      case "layers": {
        const sub = peer.subs.get(message.stream);
        if (sub) sub.gate.setWanted({ maxSpatial: message.maxSpatial, maxTemporal: message.maxTemporal });
        if (peer === parent) {
          const stream = streams.get(message.stream);
          if (stream) stream.parentCap = message.maxTemporal;
          if (stream && !stream.audio) {
            if (message.maxTemporal === 0 && message.reason === "congestion") starvedSince ??= now;
            else starvedSince = null;
          }
        }
        return;
      }
      case "path":
        return onPath(peer, message.path, now);
      case "config": {
        if (peer !== parent && peer !== next) return;
        const known = streams.get(message.stream.id);
        const stream = addStream(message.stream);
        events.emit("config", stream.config);
        for (const child of peers.values()) if (child.subs.size > 0) send(child, { t: "config", stream: stream.config });
        // A stream this node had not heard of: ask for it too.
        if (!known && parent && state === "active") subscribe(parent, "join", [stream], () => FROM_LATEST_KEYFRAME, false);
        return;
      }
      case "bye":
        peer.alt = message.alt ?? [];
        // The link closes itself after this; `onLinkClosed` does the rest.
        return;
      default:
        // hello is the link's; peers, sig and keyreq are for later stages.
        return;
    }
  }

  function onPath(peer: Peer, theirs: PeerId[], now: number): void {
    peer.path = theirs;
    if (peer === parent) {
      if (theirs.includes(self)) {
        // This node is its own ancestor: out, at once (SPEC §7.2).
        for (const stream of streams.values()) send(peer, { t: "unsub", stream: stream.config.id, stripes: stream.stripes });
        parentDied(now, "loop");
        return;
      }
      setPath([self, ...theirs]);
    } else if (peer === backup && unfitBackup(peer)) {
      // A backup whose path comes to contain this node or its parent is replaced (SPEC §7.3).
      backupRejects.set(peer.id, now + BACKUP_REJECT_MS);
      backupLost(now, true);
    }
  }

  function setPath(to: PeerId[]): void {
    const trimmed = to.slice(0, 64);
    if (trimmed.length === path.length && trimmed.every((id, i) => id === path[i])) return;
    path = trimmed;
    for (const child of peers.values()) if (child.subs.size > 0) send(child, { t: "path", path });
    changed();
  }

  /* ------------------------------ subscribing ------------------------------ */

  /** Sends `sub` (or `repair`) for each stream to `peer`, and remembers what the answers are for. */
  function subscribe(peer: Peer, purpose: Purpose, which: Iterable<StreamCtx>, fromFrame: (stream: StreamCtx) => number, asRepair: boolean, dead?: PeerId): void {
    for (const stream of which) {
      const id = (subSeq = (subSeq + 1) >>> 0);
      pendingSubs.set(id, { peer: peer.id, stream: stream.config.id, purpose });
      if (asRepair && dead !== undefined) send(peer, { t: "repair", id, stream: stream.config.id, stripes: stream.stripes, fromFrame: fromFrame(stream), dead });
      else
        send(peer, {
          t: "sub",
          id,
          stream: stream.config.id,
          stripes: stream.stripes,
          mode: purpose === "standby" ? "standby" : "active",
          fromFrame: purpose === "standby" ? FROM_LIVE : fromFrame(stream),
          maxSpatial: stream.wanted.maxSpatial,
          maxTemporal: stream.wanted.maxTemporal,
        });
    }
  }

  /** "Everything after X": the newest frame this node could decode (SPEC §7.5). */
  const after = (stream: StreamCtx) => (stream.tracker.lastBase >= 0 ? stream.tracker.lastBase : FROM_LATEST_KEYFRAME);

  const forgetPending = (peer: Peer, purpose?: Purpose) => {
    for (const [id, pending] of pendingSubs) if (pending.peer === peer.id && (purpose === undefined || pending.purpose === purpose)) pendingSubs.delete(id);
  };

  /** Asks `peer` to be the parent. */
  function ask(peer: Peer, purpose: Purpose, now: number, dead?: PeerId): void {
    next = peer;
    nextPurpose = purpose;
    nextDeadline = now + SUB_ACK_TIMEOUT_MS;
    coldLinkDeadline = 0;
    tried.add(peer.id);
    // A repair, warm or cold, says so: a parent does not refuse a `repair` for want of a slot
    // (SPEC §7.5), which is what lets an orphaned subtree back in when every relay is full.
    const lost = dead ?? (purpose === "cold" ? repair?.dead : undefined);
    subscribe(peer, purpose, streams.values(), purpose === "join" ? () => FROM_LATEST_KEYFRAME : after, lost !== undefined, lost);
    if (repair && purpose !== "join") {
      repair.next = peer.id;
      repair.resubscribed = now;
    }
  }

  function onSubAck(peer: Peer, message: PeerMessageOf<"sub-ack">, now: number): void {
    const pending = pendingSubs.get(message.id);
    if (!pending || pending.peer !== peer.id) return;
    pendingSubs.delete(message.id);
    if (message.ok && message.path) peer.path = message.path;
    const loop = message.ok && (message.path?.includes(self) ?? false);

    if (pending.purpose === "standby") {
      const unfit = message.ok && unfitBackup(peer, message.path ?? null) !== null;
      if (peer === previous && peer !== backupPending) {
        // The parent this node gave up on is alive after all.
        if (message.ok && !loop) {
          previousAlive = true;
          promotePrevious(now);
        }
        return;
      }
      if (peer !== backupPending && peer !== backup) return;
      if (!message.ok || unfit) {
        if (message.code === "no-stream") return;
        if (peer === backupPending) backupPending = null;
        if (peer === backup) backup = null;
        if (unfit) for (const stream of streams.values()) send(peer, { t: "unsub", stream: stream.config.id, stripes: stream.stripes });
        forgetPending(peer, "standby");
        backupRejects.set(peer.id, now + BACKUP_REJECT_MS);
        release(peer);
        backupRetryAt = now + COLD_RETRY_MS;
        changed();
        return;
      }
      if (peer === backupPending) {
        backupPending = null;
        backup = peer;
        peer.lastHeardAt = now;
        changed();
      }
      return;
    }

    if (pending.purpose === "switch") {
      if (!switching || switching.to !== peer) return;
      if (!message.ok || loop) {
        if (message.code === "no-stream") return;
        cancelSwitch(now);
        return;
      }
      switching.acked = true;
      applyAck(message);
      return;
    }

    if (peer !== next) {
      // A second stream's answer from the parent already adopted, or a late one from someone given up on.
      if (peer === parent && message.ok) applyAck(message);
      return;
    }
    if (!message.ok || loop) {
      if (message.code === "no-stream" && [...pendingSubs.values()].some((other) => other.peer === peer.id)) return;
      if (loop) for (const stream of streams.values()) send(peer, { t: "unsub", stream: stream.config.id, stripes: stream.stripes });
      attemptFailed(peer, now);
      return;
    }
    applyAck(message);
    adopt(peer, now);
  }

  function applyAck(message: PeerMessageOf<"sub-ack">): void {
    if (!message.config) return;
    const known = streams.get(message.config.id);
    const before = known ? JSON.stringify(known.config) : "";
    const stream = addStream(message.config);
    if (message.maxTemporal !== undefined) stream.parentCap = message.maxTemporal;
    if (JSON.stringify(stream.config) !== before) events.emit("config", stream.config);
  }

  /** `peer` said yes: it is the parent now. */
  function adopt(peer: Peer, now: number): void {
    const purpose = nextPurpose;
    const old = parent;
    next = null;
    parent = peer;
    peer.lastHeardAt = now;
    if (peer === backup) backup = null;
    if (peer === backupPending) backupPending = null;
    if (peer === previous) previous = null;
    depth = peer.depth !== DEPTH_UNKNOWN ? Math.min(254, peer.depth + 1) : peer.path ? Math.min(254, peer.path.length) : DEPTH_UNKNOWN;
    starvedSince = null;
    setState("active");
    rejoinAttempt = 0;
    setPath([self, ...(peer.path ?? [peer.id])]);
    if (old && old !== peer) release(old);

    // The first parent, however it was found (a joiner with nowhere to go at first finds it by cold repair): the node's part of the join event.
    joinTimes ??= { linked: session(now), firstPacket: null, turn: peer.link.turn };
    if (purpose === "join") {
      lastSwitchAt = now;
      compareAt = now + REBALANCE_COMPARE_MS;
      // One other open link becomes the backup; the rest are closed (SPEC §7.1 step 6).
      const order = [...joinBackups, ...candidates.map((c) => c.peer)];
      const others = order.map((id) => peers.get(id)).filter((other): other is Peer => other !== undefined && other !== peer);
      const spare = others.find((other) => other.link.state === "open") ?? others.find((other) => other.link.state === "connecting");
      if (spare) startStandby(spare, now);
      for (const id of order) {
        const other = peers.get(id);
        if (other && other !== peer && other !== spare) release(other);
      }
      if (!spare) backupRetryAt = now;
    } else {
      if (repair) {
        repair.next = peer.id;
        if (repair.firstPacket === null && peer.lastMediaAt >= repair.resubscribed) repair.firstPacket = peer.lastMediaAt;
        if (repair.firstPacket !== null) finishRepairLater();
        // Afterwards, and not before (SPEC §7.5 step 4).
        coordinator.report("parent-dead", primaryId(), 0, repair.dead, peer.id);
      }
      backupRetryAt = now;
    }
    candidates = [];
    tried.clear();
    promotePrevious(now);
    changed();
  }

  /** The peer asked to be the parent said no, did not answer, or went away. */
  function attemptFailed(peer: Peer, now: number): void {
    if (next !== peer) return;
    next = null;
    forgetPending(peer);
    if (peer === backup) backup = null;
    release(peer);
    if (nextPurpose === "join") {
      if (!tryJoinCandidate(now)) {
        const waitingForLinks = candidates.some((c) => !tried.has(c.peer) && peers.get(c.peer)?.link.state === "connecting");
        if (waitingForLinks) {
          setState("probing");
          joinDeadline = Math.max(joinDeadline, now + SUB_ACK_TIMEOUT_MS);
        } else coldRepair(now);
      }
      changed();
      return;
    }
    coldRepair(now);
  }

  /* ------------------------------ joining ------------------------------ */

  function beginJoin(assignments: Assignment[], now: number): void {
    const parents: PeerHint[] = [];
    const backups: PeerHint[] = [];
    for (const assignment of assignments) {
      for (const p of assignment.parents) if (p.peer !== self && !parents.some((q) => q.peer === p.peer)) parents.push(p);
      for (const b of assignment.backups) if (b.peer !== self && !backups.some((q) => q.peer === b.peer)) backups.push(b);
    }
    candidates = parents;
    joinBackups = backups.filter((b) => !parents.slice(0, 2).some((p) => p.peer === b.peer)).map((b) => b.peer);
    tried.clear();
    setState("probing");
    joinDeadline = now + JOIN_TIMEOUT_MS;
    // The first two parents and the first backup, at once (SPEC §7.1 step 3).
    for (const p of parents.slice(0, 2)) reach(p.peer);
    if (joinBackups.length > 0) reach(joinBackups[0]);
    if (parents.length === 0) coldRepair(now);
    else tryJoinCandidate(now);
    changed();
  }

  /** Subscribes to the first candidate parent whose link is open. False if none is; then up to two more are being linked. */
  function tryJoinCandidate(now: number): boolean {
    if (next || parent) return true;
    // No streams yet (welcomed before the source started): nothing to ask anyone for. setStreams goes on.
    if (streams.size === 0) return false;
    for (const candidate of candidates) {
      if (tried.has(candidate.peer)) continue;
      const peer = peers.get(candidate.peer);
      if (!peer || peer.link.state !== "open") continue;
      setState("subscribing");
      ask(peer, "join", now);
      return true;
    }
    let reaching = 0;
    for (const candidate of candidates) {
      if (tried.has(candidate.peer)) continue;
      if (!peers.has(candidate.peer)) reach(candidate.peer);
      if (++reaching >= 2) break;
    }
    return false;
  }

  function onLinkOpen(peer: Peer): void {
    const now = clock.now();
    peer.lastHeardAt = now;
    if (state === "probing") {
      // The first parent link to open wins (SPEC D15).
      if (candidates.some((c) => c.peer === peer.id) && !tried.has(peer.id)) tryJoinCandidate(now);
    } else if ((state === "cold-repair" || state === "rejoining") && !next && candidates.some((c) => c.peer === peer.id) && !tried.has(peer.id)) {
      candidates = candidates.filter((c) => c.peer !== peer.id);
      ask(peer, "cold", now);
    } else if (peer === backupPending) {
      subscribe(peer, "standby", streams.values(), () => FROM_LIVE, false);
      backupDeadline = now + SUB_ACK_TIMEOUT_MS;
    } else if (peer === moveLinking) {
      moveTo.unshift(peer.id);
      tryMove(now);
    }
    changed();
  }

  /* ------------------------------ losing the parent ------------------------------ */

  function parentDied(now: number, why: "silent" | "closed" | "leaving" | "loop" | "grace"): void {
    const dead = parent;
    if (!dead) return;
    moveTo = [];
    moveLinking = null;
    logger?.info("node", `${self}: parent ${dead.id} lost (${why})`);
    parent = null;
    depth = DEPTH_UNKNOWN;
    starvedSince = null;
    if (switching) {
      // Already moving: the new parent is the repair, and a move is called off.
      const to = switching.to;
      switching = null;
      forgetPending(to, "switch");
    }
    const lastHeard = why === "grace" && repair ? repair.lastHeard : dead.lastHeardAt;
    repair = { dead: dead.id, next: null, kind: "warm", lastHeard, detected: now, resubscribed: now, firstPacket: null, usedCoordinator: false };
    forgetPending(dead);
    if (why !== "loop") markUnreachable(dead.id, now);
    if (previous && previous !== dead) {
      const older = previous;
      previous = null;
      release(older);
    }
    if (dead.link.state === "open" && why !== "loop" && why !== "leaving") {
      // Perhaps only a stall. Ask it to stand by instead: if it is alive it says so, and becomes
      // the new backup (SPEC §7.4). If it is dead, nothing comes back and the link is dropped.
      previous = dead;
      previousLeftAt = now;
      previousAlive = false;
      subscribe(dead, "standby", streams.values(), () => FROM_LIVE, false);
    } else if (dead.link.state === "open") {
      release(dead);
    }
    tried.clear();
    tried.add(dead.id);
    candidates = dead.alt.filter((alt) => alt.peer !== self && alt.peer !== dead.id);
    const warm = backup;
    // A backup that is itself cut off (STALLED), or that is below the parent just lost, cannot
    // carry this node: that is a cold repair, not a wait on someone else's repair.
    if (
      warm &&
      warm.link.state === "open" &&
      now - warm.lastHeardAt < params.standbyDeadMs &&
      !warm.stalled &&
      !(warm.path?.includes(self) ?? false) &&
      !(warm.path?.includes(dead.id) ?? false)
    ) {
      // Warm repair: the backup takes over, and nobody else is asked (SPEC §7.5).
      setState("repairing");
      ask(warm, "repair", now, dead.id);
    } else {
      coldRepair(now);
    }
    changed();
  }

  function coldRepair(now: number): void {
    if (state !== "cold-repair" && state !== "rejoining") {
      setState("cold-repair");
      coldSince = now;
    }
    if (repair) {
      repair.kind = "cold";
      repair.usedCoordinator = true;
    }
    coldRetryAt = now;
    tryCold(now);
    changed();
  }

  /** Tries the next candidate for a new parent, or asks the coordinator for some. */
  function tryCold(now: number): void {
    if (next || stopping || streams.size === 0) return;
    while (candidates.length > 0) {
      const candidate = candidates[0];
      if (tried.has(candidate.peer) || candidate.peer === self) {
        candidates.shift();
        continue;
      }
      const peer = reach(candidate.peer);
      if (peer.link.state === "open") {
        candidates.shift();
        ask(peer, "cold", now);
      } else if (coldLinkDeadline === 0) {
        // `onLinkOpen` subscribes; the tick gives up on a link that never opens.
        coldLinkDeadline = now + JOIN_TIMEOUT_MS;
      }
      return;
    }
    if (coldAsking || now < coldRetryAt) return;
    coldRetryAt = now + COLD_RETRY_MS;
    if (!coordinator.connected) return;
    coldAsking = true;
    coordinator.need(primaryId(), 0, "parent", [self, ...excluded(now).filter((id) => id !== self)]).then(
      (assignment) => {
        coldAsking = false;
        if (stopping || parent || next || (state !== "cold-repair" && state !== "rejoining") || !assignment) return;
        candidates = [...assignment.parents, ...assignment.backups].filter((c) => c.peer !== self && !tried.has(c.peer));
        coldLinkDeadline = 0;
        tryCold(clock.now());
      },
      () => {
        coldAsking = false;
      },
    );
  }

  /* ------------------------------ the backup ------------------------------ */

  function startStandby(peer: Peer, now: number): void {
    backupPending = peer;
    backupDeadline = now + (peer.link.state === "open" ? SUB_ACK_TIMEOUT_MS : JOIN_TIMEOUT_MS);
    if (peer.link.state === "open") subscribe(peer, "standby", streams.values(), () => FROM_LIVE, false);
  }

  function backupLost(now: number, tell: boolean): void {
    const lost = backup;
    if (!lost) return;
    backup = null;
    forgetPending(lost, "standby");
    if (tell && lost.link.state === "open") for (const stream of streams.values()) send(lost, { t: "unsub", stream: stream.config.id, stripes: stream.stripes });
    release(lost);
    if (!stopping) coordinator.report("backup-lost", primaryId(), 0, lost.id);
    backupRetryAt = now;
    changed();
  }

  /** The parent this node left turned out to be alive: it becomes the backup, if there is none (SPEC §7.4). */
  function promotePrevious(now: number): void {
    if (!previous || !previousAlive || !parent || backup || backupPending || state !== "active" || previous.link.state !== "open") return;
    backup = previous;
    previous = null;
    backup.lastHeardAt = now;
    changed();
  }

  /** Asks the coordinator for someone to stand by, and links to them (SPEC §7.3). */
  function seekBackup(now: number): void {
    promotePrevious(now);
    if (stopping || role === "source" || backup || backupPending || backupAsking || !parent || state !== "active" || now < backupRetryAt) return;
    backupRetryAt = now + BACKUP_RETRY_MS;
    if (!coordinator.connected) return;
    backupAsking = true;
    for (const [id, until] of backupRejects) if (until <= now) backupRejects.delete(id);
    // The parent too: a backup must not hang below it (SPEC §7.3), which is what excluding it asks.
    coordinator.need(primaryId(), 0, "backup", [self, parent.id, ...excluded(now).filter((id) => id !== self && id !== parent!.id)]).then(
      (assignment) => {
        backupAsking = false;
        if (!assignment || stopping || backup || backupPending || !parent) return;
        const pick = [...assignment.backups, ...assignment.parents].find((c) => c.peer !== self && c.peer !== parent!.id && !backupRejects.has(c.peer));
        if (pick) startStandby(reach(pick.peer), clock.now());
      },
      () => {
        backupAsking = false;
      },
    );
  }

  /* ------------------------------ rebalancing ------------------------------ */

  const candidateOf = (peer: Peer, now: number): Candidate => {
    const estimate = peer.estimator.estimate(now);
    return { ...hint(peer), rttMs: estimate.rttMs, lossPct: estimate.lossPct, path: peer.path, turn: peer.link.turn };
  };

  function compare(now: number): void {
    if (!parent || !backup || state !== "active" || switching || role === "source") return;
    if (backup.link.state !== "open" || (backup.path?.includes(self) ?? false)) return;
    const starved = starvedSince !== null && now - starvedSince >= STARVED_SWITCH_MS && !backup.full;
    let go = starved;
    if (!go && now >= compareAt) {
      compareAt = now + REBALANCE_COMPARE_MS;
      go = selector.shouldSwitch(candidateOf(parent, now), candidateOf(backup, now), now - lastSwitchAt);
    }
    if (!go) return;
    // Make before break: ask the new parent first, and leave the old one when its media arrives (SPEC §7.6).
    switching = { to: backup, at: now, acked: false, move: false };
    subscribe(backup, "switch", streams.values(), after, false);
  }

  function completeSwitch(now: number): void {
    if (!switching || !parent) return;
    const to = switching.to;
    const from = parent;
    const startedAt = switching.at;
    switching = null;
    parent = to;
    if (backup === to) backup = null;
    depth = to.depth !== DEPTH_UNKNOWN ? Math.min(254, to.depth + 1) : DEPTH_UNKNOWN;
    starvedSince = null;
    lastSwitchAt = now;
    compareAt = now + REBALANCE_COMPARE_MS;
    setPath([self, ...(to.path ?? [to.id])]);
    // The old parent becomes the backup. One that was standing by elsewhere is let go.
    for (const other of [backup, backupPending]) {
      if (!other || other === to || other === from) continue;
      if (other.link.state === "open") for (const stream of streams.values()) send(other, { t: "unsub", stream: stream.config.id, stripes: stream.stripes });
      forgetPending(other, "standby");
    }
    const others = [backup, backupPending].filter((other): other is Peer => other !== null && other !== to && other !== from);
    backup = null;
    backupPending = null;
    for (const other of others) release(other);
    moveTo = [];
    moveLinking = null;
    startStandby(from, now);
    switchesFinishing.push({ from: from.id, to: to.id, at: startedAt, until: now + REPAIR_WINDOW_MS });
    coordinator.report("parent-switch", primaryId(), 0, from.id, to.id);
    changed();
  }

  function cancelSwitch(now: number): void {
    if (!switching) return;
    const { to, move } = switching;
    switching = null;
    forgetPending(to, "switch");
    // Back to standing by.
    if (to.link.state === "open" && to === backup) subscribe(to, "standby", streams.values(), () => FROM_LIVE, false);
    else if (to.link.state === "open" && to.subs.size === 0) {
      for (const stream of streams.values()) send(to, { t: "unsub", stream: stream.config.id, stripes: stream.stripes });
      release(to);
    }
    compareAt = now + REBALANCE_COMPARE_MS;
    if (move) tryMove(now);
  }

  /**
   * "move" (coordinator/README.md, "Keeping the tree short"): change to the first of the parents
   * given that will have this node, make-before-break as in SPEC §7.6, whatever the cost rule
   * says; stay where it is if none will.
   */
  function tryMove(now: number): void {
    if (switching || !parent || state !== "active" || stopping) return;
    moveLinking = null;
    while (moveTo.length > 0) {
      const id = moveTo.shift()!;
      if (id === self || id === parent.id || path.includes(id)) continue;
      const peer = reach(id);
      if (peer.path?.includes(self)) continue;
      if (peer.link.state !== "open") {
        // `onLinkOpen` goes on from here; a link that closes moves to the next.
        moveLinking = peer;
        return;
      }
      switching = { to: peer, at: now, acked: false, move: true };
      subscribe(peer, "switch", streams.values(), after, false);
      return;
    }
  }

  /* ------------------------------ links closing ------------------------------ */

  function onLinkClosed(peer: Peer, reason?: LinkCloseReason): void {
    const now = clock.now();
    const wasChild = peer.subs.size > 0;
    // Gone, or never reachable: not to be offered to this node again for a while.
    if (reason !== undefined && reason !== "local") markUnreachable(peer.id, now);
    detach(peer);
    if (wasChild) {
      if (!stopping) coordinator.report("child-gone", primaryId(), 0, peer.id);
      checkOverload();
    }
    if (peer === previous) previous = null;
    if (switching?.to === peer) {
      const move = switching.move;
      switching = null;
      if (move) tryMove(now);
    }
    if (peer === moveLinking) tryMove(now);
    if (peer === backupPending) {
      backupPending = null;
      backupRetryAt = now + COLD_RETRY_MS;
    }
    if (peer === backup) {
      backup = null;
      if (!stopping) coordinator.report("backup-lost", primaryId(), 0, peer.id);
      backupRetryAt = now;
    }
    if (peer === parent) parentDied(now, "closed");
    else if (peer === next) attemptFailed(peer, now);
    else if ((state === "cold-repair" || state === "rejoining") && candidates[0]?.peer === peer.id) {
      tried.add(peer.id);
      candidates.shift();
      coldLinkDeadline = 0;
      tryCold(now);
    }
    changed();
  }

  /* ------------------------------ metrics ------------------------------ */

  function finishRepairLater(): void {
    if (!repair || repair.firstPacket === null) return;
    finishing.push({ record: repair, at: repair.firstPacket + REPAIR_WINDOW_MS });
    repair = null;
  }

  function finishRepairs(now: number): void {
    while (finishing.length > 0 && finishing[0].at <= now) {
      const { record } = finishing.shift()!;
      const stream = primary();
      const measured = stream ? stream.tracker.gap(record.lastHeard, record.firstPacket! + REPAIR_WINDOW_MS, (frameId) => stream.tracker.shed.has(frameId)) : { freezeMs: 0, lost: 0 };
      metric({
        t: "repair",
        stream: stream?.config.id ?? 0,
        stripe: 0,
        dead: record.dead,
        next: record.next,
        kind: record.kind,
        lastHeard: session(record.lastHeard),
        detected: session(record.detected),
        resubscribed: session(record.resubscribed),
        firstPacket: record.firstPacket === null ? null : session(record.firstPacket),
        freezeMs: Math.min(3_600_000, measured.freezeMs),
        framesLost: measured.lost,
        usedCoordinator: record.usedCoordinator,
      });
    }
    while (switchesFinishing.length > 0 && switchesFinishing[0].until <= now) {
      const done = switchesFinishing.shift()!;
      const stream = primary();
      const measured = stream ? stream.tracker.gap(done.at, done.until) : { freezeMs: 0, lost: 0 };
      metric({ t: "switch", stream: stream?.config.id ?? 0, stripe: 0, from: done.from, to: done.to, at: session(done.at), freezeMs: Math.min(3_600_000, measured.freezeMs) });
    }
  }

  function takeStats(): NodeStats {
    const now = clock.now();
    const seconds = Math.max(0.001, (now - statsAt) / 1000);
    const active = activeChildren();
    const estimate = parent?.estimator.estimate(now);
    const forwarding = forwardUs.take();
    const stats: NodeStats = {
      up:
        parent && estimate
          ? {
              parent: parent.id,
              rttMs: estimate.rttMs,
              lossPct: estimate.lossPct,
              queueDelayMs: estimate.queueDelayMs,
              rxKbps: (rxBytes * 8) / 1000 / seconds,
              nacksSent,
              retransmitsReceived,
              duplicates,
              turn: parent.link.turn,
            }
          : null,
      relay:
        role === "leaf" && active.length === 0
          ? null
          : {
              children: active.length,
              standby: standbyChildren().length,
              txKbps: (txBytes * 8) / 1000 / seconds,
              forwardP50Us: forwarding.p50,
              forwardP95Us: forwarding.p95,
              bufferedMaxBytes: bufferedMax,
              layerDrops,
              retransmitsSent,
            },
      join: joinTimes ? { ...joinTimes } : null,
      malformed,
    };
    statsAt = now;
    nacksSent = retransmitsReceived = duplicates = layerDrops = retransmitsSent = bufferedMax = rxBytes = txBytes = 0;
    return stats;
  }

  /* ------------------------------ the tick ------------------------------ */

  let lastTickAt = NaN;

  /**
   * This node was not running for `lostMs`: whatever it did not hear meanwhile may be sitting in
   * its own queue, behind this very tick. Every silence it measures, and every deadline it set,
   * moves on by that much, and this tick does nothing more, so the packets that queued are read
   * before anyone is judged. A parent that really is dead is found on the next ticks, by as much
   * later as the node was itself away.
   */
  function forgiveOwnStall(lostMs: number): void {
    for (const peer of peers.values()) peer.lastHeardAt += lostMs;
    waitingSince += lostMs;
    nextDeadline += lostMs;
    joinDeadline += lostMs;
    backupDeadline += lostMs;
    previousLeftAt += lostMs;
    if (coldLinkDeadline > 0) coldLinkDeadline += lostMs;
    if (switching) switching.at += lostMs;
  }

  function tick(): void {
    const now = clock.now();
    const late = lastTickAt === lastTickAt ? now - lastTickAt - TICK_MS : 0;
    lastTickAt = now;
    releasePaced(now);
    if (late > OWN_STALL_MS) {
      forgiveOwnStall(late);
      return;
    }

    // The failure detector (SPEC §7.4).
    if (parent && (state === "active" || state === "waiting")) {
      if (now - parent.lastHeardAt >= params.deadMs) parentDied(now, "silent");
      else if (state === "waiting" && now - waitingSince >= params.stallGraceMs) parentDied(now, "grace");
    }
    if (next && now >= nextDeadline) attemptFailed(next, now);
    // Waiting for the source's streams is not a failed join.
    if (streams.size === 0) {
      joinDeadline = Math.max(joinDeadline, now + JOIN_TIMEOUT_MS);
      coldSince = now;
    }
    if (state === "probing" && now >= joinDeadline) coldRepair(now);
    if (state === "cold-repair" || state === "rejoining") {
      if (!next && candidates.length > 0 && coldLinkDeadline > 0 && now >= coldLinkDeadline) {
        // The candidate's link never opened.
        const stuck = candidates.shift()!;
        markUnreachable(stuck.peer, now);
        tried.add(stuck.peer);
        const peer = peers.get(stuck.peer);
        if (peer) release(peer);
        coldLinkDeadline = 0;
      }
      if (state === "cold-repair" && now - coldSince >= COLD_GIVE_UP_MS) {
        // Nothing worked: start again, with backoff (SPEC §7.5).
        setState("rejoining");
        tried.clear();
        if (repair) tried.add(repair.dead);
        coldRetryAt = now + REJOIN_BACKOFF_MS[Math.min(rejoinAttempt++, REJOIN_BACKOFF_MS.length - 1)];
        events.emit("error", new Error("overlay: no parent could be found; rejoining"));
        changed();
      } else if (state === "rejoining" && !next && candidates.length === 0 && now >= coldRetryAt && !coldAsking) {
        tried.clear();
        tryCold(now);
        coldRetryAt = now + REJOIN_BACKOFF_MS[Math.min(rejoinAttempt++, REJOIN_BACKOFF_MS.length - 1)];
      } else {
        tryCold(now);
      }
    }
    if (switching && now - switching.at >= SWITCH_TIMEOUT_MS) cancelSwitch(now);

    // The backup: alive and still apart from this node's parent, or replaced (SPEC §7.3).
    if (backup && now - backup.lastHeardAt >= params.standbyDeadMs) backupLost(now, true);
    else if (backup && state === "active" && unfitBackup(backup)) {
      backupRejects.set(backup.id, now + BACKUP_REJECT_MS);
      backupLost(now, true);
    }
    if (backupPending && now >= backupDeadline) {
      const failed = backupPending;
      backupPending = null;
      forgetPending(failed, "standby");
      backupRejects.set(failed.id, now + BACKUP_REJECT_MS);
      if (failed.link.state !== "open") markUnreachable(failed.id, now);
      release(failed);
      backupRetryAt = now + COLD_RETRY_MS;
    }
    if (previous && now - previousLeftAt >= params.standbyDeadMs) {
      const gone = previous;
      previous = null;
      if (previousAlive) for (const stream of streams.values()) send(gone, { t: "unsub", stream: stream.config.id, stripes: stream.stripes });
      release(gone);
    }
    seekBackup(now);
    compare(now);

    // Children: gone if silent (SPEC §4.5).
    for (const child of peers.values()) {
      if (child.subs.size > 0 && now - child.lastHeardAt >= params.childDeadMs) {
        removeChild(child, true);
        release(child);
      }
    }

    sendHeartbeats(now);
    sendFeedback(now);
    sendNacks(now);
    runProbe(now);
    repeatAudio(now);
    for (const child of peers.values()) {
      if (child.subs.size === 0) continue;
      pumpReplay(child, now);
      flushHeld(child, now);
    }
    for (const stream of streams.values()) if (!stream.audio) stream.tracker.classify((frameId) => reassembler.neverSent(stream.config.id, frameId));
    finishRepairs(now);

    if (now - uplinkAt >= 1000) {
      uplinkAt = now;
      // How what the parent sends arrives: the direction the player sizes its delay from.
      if (parent) events.emit("uplink", parent.estimator.directed ? parent.estimator.directed("received", now) : parent.estimator.estimate(now));
    }
  }

  /* ------------------------------ the coordinator, unasked ------------------------------ */

  function onAssign(assignments: Assignment[], reason: "join" | "need" | "rebalance" | "move"): void {
    const now = clock.now();
    if (!started || stopping || role === "source") return;
    const offered = assignments.flatMap((assignment) => [...assignment.parents, ...assignment.backups]).filter((c) => c.peer !== self);
    if (state === "cold-repair" || state === "rejoining" || state === "idle") {
      if (!next && candidates.length === 0) {
        candidates = offered.filter((c) => !tried.has(c.peer));
        tryCold(now);
      }
      return;
    }
    if (reason === "move") {
      if (!parent || state !== "active") return;
      if (switching && !switching.move) cancelSwitch(now);
      if (switching) return;
      moveTo = assignments.flatMap((assignment) => assignment.parents.map((hint) => hint.peer));
      tryMove(now);
      return;
    }
    if (reason !== "rebalance" || !parent || state !== "active" || switching || backupPending) return;
    // Advice: the best of them becomes the backup if it sits nearer the source than the one this
    // node has, so that the next comparisons measure it. The rule of §7.6 still decides.
    // A backup needs a standby place, not an active slot: a relay with none free (free 0) may still be one.
    const better = offered.find((c) => c.peer !== parent!.id && c.peer !== backup?.id && !path.includes(c.peer) && c.depth < (backup ? backup.depth : DEPTH_UNKNOWN));
    if (!better) return;
    if (backup) {
      const old = backup;
      backup = null;
      for (const stream of streams.values()) send(old, { t: "unsub", stream: stream.config.id, stripes: stream.stripes });
      release(old);
    }
    startStandby(reach(better.peer), now);
    changed();
  }

  function onRole(to: OverlayRole, cap?: number): void {
    if (role === "source" || to === "source") return;
    const nextCap = to === "relay" && cap !== undefined ? cap : null;
    if (to === role && nextCap === fanoutCap) return;
    // A provisional relay confirmed past probation is sent role relay again, without a cap.
    fanoutCap = nextCap;
    if (to === role) {
      checkOverload();
      changed();
      return;
    }
    role = to;
    if (to === "leaf") {
      // No longer a relay: its children are sent elsewhere (SPEC §6.6).
      const alt = [parent, backup].filter((peer): peer is Peer => peer !== null).map(hint);
      for (const child of [...peers.values()]) {
        if (child.subs.size === 0) continue;
        send(child, { t: "bye", reason: "rebalance", alt });
        dropSubs(child);
      }
    }
    checkOverload();
    changed();
  }

  /* ------------------------------ the public face ------------------------------ */

  return {
    on: (event, listener) => events.on(event, listener),

    start(as, streamConfigs, assignments) {
      if (started) throw new Error("overlay node: already started");
      started = true;
      role = as;
      const now = clock.now();
      statsAt = now;
      for (const config of streamConfigs) addStream(config);
      offs.push(
        links.on("incoming", (link) => {
          attach(link, false);
        }),
        coordinator.onAssign(onAssign),
        coordinator.onRole(onRole),
        coordinator.onPeerGone((peer) => links.get(peer)?.close("local")),
      );
      ticker = clock.setInterval(tick, TICK_MS);
      if (role === "source") {
        depth = 0;
        setState("active");
        changed();
      } else beginJoin(assignments, now);
    },

    publish(frame: EncodedFrame) {
      if (role !== "source" || stopping) return;
      const stream = streams.get(frame.header.streamId);
      if (!stream) return;
      const now = clock.now();
      for (const packet of packetizeFrame(frame.header, frame.data)) {
        const header = decodeMediaHeader(packet)!;
        if (!stream.seen.add(header.frameId, header.fragIndex, header.fragCount)) continue;
        forward(stream, header, packet, now, 0, 0);
        cache.add(packet, header, now);
      }
    },

    setStreams(configs) {
      if (role === "source" || stopping) return;
      const added: StreamCtx[] = [];
      for (const config of configs) {
        if (streams.has(config.id)) continue;
        const stream = addStream(config);
        events.emit("config", stream.config);
        added.push(stream);
      }
      if (added.length === 0) return;
      const now = clock.now();
      if (parent) subscribe(parent, "join", added, () => FROM_LATEST_KEYFRAME, false);
      else if (next) subscribe(next, nextPurpose, added, nextPurpose === "join" ? () => FROM_LATEST_KEYFRAME : after, nextPurpose === "repair", repair?.dead);
      else if (state === "probing") {
        joinDeadline = now + JOIN_TIMEOUT_MS;
        tryJoinCandidate(now);
      }
      else if (state === "cold-repair" || state === "rejoining") tryCold(now);
      changed();
    },

    publishConfig(config) {
      if (role !== "source") return;
      const stream = addStream(config);
      for (const child of peers.values()) if (child.subs.size > 0) send(child, { t: "config", stream: stream.config });
      events.emit("config", stream.config);
    },

    setWanted(streamId, cap) {
      const stream = streams.get(streamId);
      if (!stream || (stream.wanted.maxSpatial === cap.maxSpatial && stream.wanted.maxTemporal === cap.maxTemporal)) return;
      stream.wanted = { ...cap };
      if (parent) send(parent, { t: "layers", stream: streamId, maxSpatial: cap.maxSpatial, maxTemporal: cap.maxTemporal, reason: "viewport" });
    },

    setPlayout(playoutDelayMs, bufferMs) {
      playout.delayMs = Number.isFinite(playoutDelayMs) ? playoutDelayMs : 0;
      playout.bufferMs = Number.isFinite(bufferMs) ? bufferMs : 0;
    },

    setOldestWanted(streamId, frameId) {
      if (frameId !== null) reassembler.expireBefore(streamId, frameId);
    },

    status,

    childEstimates(): LinkEstimate[] {
      const now = clock.now();
      return activeChildren().map((child) => {
        child.estimator.onBuffered(child.link.bufferedAmount, now);
        return child.estimator.estimate(now);
      });
    },

    takeStats,

    runProbe(probe) {
      if (role === "source" || !parent || state !== "active") {
        events.emit("probe", null);
        return;
      }
      if (probing) events.emit("probe", null);
      probing = { probe, parent };
    },

    async stop() {
      if (stopping || !started) return;
      stopping = true;
      const now = clock.now();
      // Children first, with somewhere to go; then upstream (SPEC §7.7).
      const alt = [parent, backup].filter((peer): peer is Peer => peer !== null).map(hint);
      // LEAVING, at once and to everyone subscribed, ahead of the bye.
      sendHeartbeats(now, true);
      for (const peer of peers.values()) if (peer.subs.size > 0) send(peer, { t: "bye", reason: "leave", alt });
      for (const peer of new Set([parent, backup, backupPending, next])) if (peer && peer.subs.size === 0) send(peer, { t: "bye", reason: "leave" });
      ticker?.();
      ticker = null;
      for (const off of offs.splice(0)) off();
      await new Promise<void>((resolve) => clock.setTimeout(resolve, LEAVE_FLUSH_MS));
      for (const peer of [...peers.values()]) {
        detach(peer);
        peer.link.close("local");
      }
      parent = backup = next = backupPending = previous = null;
      setState("idle");
    },
  };
}
