/**
 * The coordinator's map of the tree, and placement on it (SPEC §6.6). Pure: no I/O, no clock of
 * its own, every method is given the time.
 *
 * The map is soft state. Nothing here is decided and then recorded; peers decide, say so in
 * `status` and `report`, and the map is the latest of what was said. What the coordinator adds
 * is a short memory of what it has just offered (`held`), so that a burst of joiners is not all
 * sent to the same free slot before the relay that owns it has had time to report.
 *
 * Owner: E-coordinator.
 */
import type { Capabilities, OverlayParams, OverlayRole, PeerHint, PeerId } from "../protocol";
import type { Candidate, Observed, RelayVerdict } from "../topology/types";
import type { ConnId, PeerRecord } from "./types";
import { PROVISIONAL_FANOUT } from "../topology/index";
import { relayFanout } from "../topology/scoring";
import type { Scoring } from "./scoring";

/** A place offered to a joiner is held for it this long, unless its `status` settles it sooner. */
export const HOLD_MS = 10_000;
/** A peer reported dead by a child, or one that refused a link, is not offered for this long. */
export const SUSPECT_MS = 3_000;
/**
 * [D65] A relay reported for changed frames (`parent-bad`) by this many different children within
 * `BAD_REPORT_WINDOW_MS` is offered to nobody, and promoted by nobody, for `DISTRUST_MS`. One
 * report alone is not enough: a single viewer must not be able to push a relay out.
 */
export const BAD_REPORTS_TO_DISTRUST = 2;
export const BAD_REPORT_WINDOW_MS = 60_000;
export const DISTRUST_MS = 10 * 60_000;
/** SPEC §6.6: a peer whose socket has been closed this long is forgotten. */
export const FORGET_MS = 30_000;
/** SPEC §8.1: a relay must have been failing for this long before it is demoted. */
export const DEMOTE_AFTER_MS = 10_000;
export { PROVISIONAL_FANOUT };
/** [D49] The most children the source takes while it is the only relay. */
export const SOURCE_ALONE_FANOUT = 6;
/** D38: a provisional relay that misbehaves this long is made a leaf again, sooner than a full one. */
export const PROVISIONAL_DEMOTE_AFTER_MS = 3_000;
/** A relay being made a leaf gives its children this long to move away first (make-before-break). */
export const DEMOTE_GRACE_MS = 5_000;
/** A demoted relay is not promoted again for this long. */
export const REPROMOTE_AFTER_MS = 60_000;
/** SPEC §6.6: unasked advice to one peer, at most this often. */
export const REBALANCE_EVERY_MS = 60_000;
/** SPEC §8.1: children's loss above this, in percent, counts against their relay. */
export const CHILD_LOSS_PCT = 5;
/** The share of the audience the coordinator may ask to change parent in one second, to shorten the tree. */
export const MOVE_SHARE = 0.05;
/** A peer the coordinator has moved may be moved again after this long (its own switching waits `rebalanceMinMs`, SPEC §7.6). */
export const MOVE_AGAIN_MS = 10_000;
/** `depth` in `status` when a peer does not know its own. */
export const DEPTH_UNKNOWN = 255;
/** A path longer than this is a loop (SPEC §4.2: `hops` ≥ 32 is dropped). */
const MAX_PATH = 32;

const NO_VERDICT: RelayVerdict = { eligible: false, reasons: [], fanout: 0, score: 0 };

/** One peer, as the coordinator has it: `PeerRecord`, and what placement keeps beside it. */
export type TreeNode = Omit<PeerRecord, "conn"> & {
  conn: ConnId | null;
  name: string;
  ticketRole: "source" | "viewer";
  /** When its socket closed, or null while it is open. */
  closedAt: number | null;
  /** Whether a `status` has arrived since it joined, was promoted, or the map was rebuilt. */
  reported: boolean;
  lossPct: number;
  rttMs: number | null;
  /** Who it says it gets the first stream's first stripe from: its parent, in stage 1 (D14). */
  parent: PeerId | null;
  /** Who it says stands by for it. */
  backup: PeerId | null;
  /** By what it says of itself alone, it could relay one day. */
  canRelay: boolean;
  verdict: RelayVerdict;
  /** Places held for joiners this peer was offered to: joiner, and when. */
  held: Map<PeerId, number>;
  /** When it lost or left a parent, lately. */
  parentChanges: number[];
  suspectUntil: number;
  /** [D65] Children that reported it for changed frames (`parent-bad`), and when. */
  badReports: Map<PeerId, number>;
  /** [D65] Not offered to anyone, nor promoted, until then: reported by enough children. */
  distrustedUntil: number;
  /** Peers a link to which failed, and until when not to offer them again. */
  avoid: Map<PeerId, number>;
  /** Since when it has been without anyone to connect to, or null. */
  waitingSince: number | null;
  lastAssignAt: number;
  lastRebalanceAt: number;
  /** When it was last offered a better backup (see `TreeMap.backupAdvice`). */
  backupAdviceAt: number;
  /** It has had a parent in this session: a `need` for one is a repair, not a join. */
  placedOnce: boolean;
  /**
   * D38: a relay before its probation is over, with `PROVISIONAL_FANOUT` children at most, used
   * only when no full relay has a free slot, and made a full relay at the end of probation.
   */
  provisional: boolean;
  /** Being made a leaf: its children were asked to move, and it is offered to nobody (see `demoting`). Null otherwise. */
  demotingSince: number | null;
  demotedAt: number;
  ineligibleSince: number | null;
  /** What its latest metrics sample said of its link to its parent. */
  up: { parent: PeerId; lossPct: number; at: number } | null;
  /** The top temporal layer it is being sent, from its latest metrics sample. */
  maxTemporal: number | null;
  maxTemporalAt: number;
  grant: string;
  /** Seconds since the Unix epoch. */
  grantExp: number;
  /** Peers the coordinator has named to this one, or this one to them, and when (SPEC §6.4). */
  introduced: Map<PeerId, number>;
};

export function newNode(init: Pick<TreeNode, "peer" | "identity" | "name" | "ticketRole" | "role" | "caps" | "region" | "conn" | "joinedAt">): TreeNode {
  return {
    ...init,
    lastStatusAt: init.joinedAt,
    closedAt: null,
    reported: false,
    depth: init.role === "source" ? 0 : DEPTH_UNKNOWN,
    links: [],
    children: 0,
    standby: 0,
    free: 0,
    lossPct: 0,
    rttMs: null,
    parent: null,
    backup: null,
    canRelay: false,
    verdict: NO_VERDICT,
    held: new Map(),
    parentChanges: [],
    suspectUntil: 0,
    badReports: new Map(),
    distrustedUntil: 0,
    avoid: new Map(),
    waitingSince: null,
    lastAssignAt: 0,
    lastRebalanceAt: 0,
    backupAdviceAt: 0,
    placedOnce: false,
    provisional: false,
    demotingSince: null,
    demotedAt: -Infinity,
    ineligibleSince: null,
    up: null,
    maxTemporal: null,
    maxTemporalAt: 0,
    grant: "",
    grantExp: 0,
    introduced: new Map(),
  };
}

export type StatusFields = {
  depth: number;
  links: PeerRecord["links"];
  children: number;
  standby: number;
  free: number;
  caps: Capabilities;
  lossPct: number;
  rttMs: number | null;
};

export type Placement = { parents: PeerHint[]; backups: PeerHint[] };

export type PlaceOptions = {
  want: "parent" | "backup";
  exclude: readonly PeerId[];
  now: number;
  /** Only candidates that would put the peer shallower than this depth: for rebalancing advice. */
  shallowerThan?: number;
  /** Only candidates that would put the peer deeper than this depth: for making room (see `moves`). */
  deeperThan?: number;
  /** A joiner (welcome, or waiting to be placed): the last free slot may be kept from a dead end. Not for a peer that has lost its parent. */
  join?: boolean;
  /**
   * `exclude` is what a peer asked to avoid in `need`: as a rule its dead parent, and links that
   * failed. Nothing below those is offered either, since what hangs below a dead peer is cut off.
   */
  excludeBelow?: boolean;
  /** A change of parent the coordinator asks for: parents only, no backups. */
  move?: boolean;
  /**
   * Nobody has a free slot: offer the relays least over their fan-out instead. Only for a peer
   * that has lost its parent, which sends `repair`, and a `repair` is never refused (SPEC §7.5).
   */
  overload?: boolean;
};

/** A feeder with `excess` more children than its fan-out, and those of them that may be moved, smallest subtree first. */
export type Overload = { node: TreeNode; excess: number; candidates: TreeNode[] };

/** A change of parent the coordinator asks for, to keep the tree short (see `TreeMap.moves`). */
export type Move = { node: TreeNode; kind: "up" | "down"; placement: Placement };

export type TreeMapOptions = {
  params: OverlayParams;
  scoring: Scoring;
  /** The session's bitrate, all streams together. */
  streamKbps: () => number;
  /**
   * Where a joiner that can never relay is put. "deep" (the default) keeps the slots near the
   * source for peers that can; "shallow" is SPEC §6.6 read literally, kept for comparison.
   */
  leafPlacement?: "deep" | "shallow";
  /** D57: whether the source keeps its probed fan-out ("always", the default) or only while it is the only relay ("alone", D49 as first decided). */
  sourcePolicy?: "alone" | "always";
};

export class TreeMap {
  readonly nodes = new Map<PeerId, TreeNode>();
  /** Who says they are fed by whom. */
  private readonly kids = new Map<PeerId, Set<PeerId>>();
  /** Who says who stands by for them: the standby places a relay is holding (SPEC §7.3). */
  private readonly wards = new Map<PeerId, Set<PeerId>>();
  /** The source and the relays: everyone a joiner could be sent to. */
  private readonly feeders = new Set<PeerId>();
  private readonly params: OverlayParams;
  private readonly scoring: Scoring;
  private readonly streamKbps: () => number;
  private readonly leafPlacement: "deep" | "shallow";
  private readonly sourcePolicy: "alone" | "always";
  source: PeerId | null = null;
  /** Relays that `moves` last found deeper than they need be, with nowhere yet to go. */
  private misplaced = 0;

  constructor(options: TreeMapOptions) {
    this.params = options.params;
    this.scoring = options.scoring;
    this.streamKbps = options.streamKbps;
    // D54: every joiner, dead end or not, under the shallowest feeder with room.
    this.leafPlacement = options.leafPlacement ?? "shallow";
    this.sourcePolicy = options.sourcePolicy ?? "always";
  }

  /* ------------------------------ who is here ------------------------------ */

  add(node: TreeNode, now: number): void {
    this.nodes.set(node.peer, node);
    if (node.role === "source") {
      this.source = node.peer;
      node.depth = 0;
      if (!node.reported) node.free = this.params.sourceFanout;
    }
    if (node.role !== "leaf") this.feeders.add(node.peer);
    this.judge(node, now);
  }

  remove(peer: PeerId): TreeNode | undefined {
    const node = this.nodes.get(peer);
    if (!node) return undefined;
    this.setParent(node, null);
    this.setBackup(node, null);
    this.nodes.delete(peer);
    this.feeders.delete(peer);
    this.kids.delete(peer);
    this.wards.delete(peer);
    if (this.source === peer) this.source = null;
    for (const other of this.feeders) this.nodes.get(other)?.held.delete(peer);
    return node;
  }

  childrenOf(peer: PeerId): ReadonlySet<PeerId> {
    return this.kids.get(peer) ?? EMPTY;
  }

  setParent(node: TreeNode, parent: PeerId | null): void {
    if (node.parent === parent) return;
    if (node.parent !== null) this.kids.get(node.parent)?.delete(node.peer);
    node.parent = parent;
    if (parent !== null) {
      let set = this.kids.get(parent);
      if (!set) this.kids.set(parent, (set = new Set()));
      set.add(node.peer);
    }
  }

  setBackup(node: TreeNode, backup: PeerId | null): void {
    if (node.backup === backup) return;
    if (node.backup !== null) this.wards.get(node.backup)?.delete(node.peer);
    node.backup = backup;
    if (backup !== null) {
      let set = this.wards.get(backup);
      if (!set) this.wards.set(backup, (set = new Set()));
      set.add(node.peer);
    }
  }

  /** Standby places this peer is holding, by its own count or the map's, whichever is more. */
  standby(node: TreeNode): number {
    return Math.max(node.standby, this.wards.get(node.peer)?.size ?? 0);
  }

  setRole(node: TreeNode, role: OverlayRole, now: number, provisional = false): void {
    node.role = role;
    node.provisional = role === "relay" && provisional;
    node.demotingSince = null;
    if (role === "leaf") {
      this.feeders.delete(node.peer);
      node.free = 0;
      node.held.clear();
    } else {
      this.feeders.add(node.peer);
      // Until it says otherwise, it is taken to have the slots its verdict gave it.
      node.free = Math.max(0, this.fanout(node) - node.children);
      node.lastStatusAt = now;
    }
  }

  /** D38: may this peer be a provisional relay? Topology's `judgeProvisional`, on what is known of it. */
  provisionallyEligible(node: TreeNode, now: number): boolean {
    const judge = this.scoring.judgeProvisional;
    if (!judge || this.judge(node, now).eligible) return false;
    const observed: Observed = { uptimeMs: now - node.joinedAt, spareUplinkKbps: node.caps.uplinkKbps, lossPct: node.lossPct, churnPerMin: node.parentChanges.length };
    return judge(node.caps, observed, this.streamKbps(), this.params).eligible;
  }

  /** What a peer said of itself. True if it may have made room for someone. */
  applyStatus(node: TreeNode, status: StatusFields, now: number): boolean {
    const before = node.reported ? node.children + node.free : -1;
    node.caps = status.caps;
    node.links = status.links;
    node.children = status.children;
    node.standby = status.standby;
    node.free = node.role === "leaf" ? 0 : status.free;
    node.lossPct = status.lossPct;
    node.rttMs = status.rttMs;
    node.lastStatusAt = now;
    node.reported = true;
    node.suspectUntil = 0;
    // Only the source is at depth 0, whatever anyone says.
    node.depth = node.role === "source" ? 0 : status.depth === 0 ? DEPTH_UNKNOWN : status.depth;
    const parent = node.role === "source" ? null : (status.links[0]?.parent ?? null);
    const hadParent = node.parent !== null;
    this.setParent(node, parent !== null && parent !== node.peer ? parent : null);
    const backup = node.role === "source" ? null : (status.links[0]?.backup ?? null);
    this.setBackup(node, backup !== null && backup !== node.peer ? backup : null);
    if (node.parent !== null) {
      node.placedOnce = true;
      // It has settled somewhere: nothing is held for it any more.
      for (const other of this.feeders) this.nodes.get(other)?.held.delete(node.peer);
      node.waitingSince = null;
    }
    this.judge(node, now);
    return node.children + node.free > before || (hadParent && node.parent === null);
  }

  /** Re-reads what a peer may do from what is known of it. */
  judge(node: TreeNode, now: number): RelayVerdict {
    while (node.parentChanges.length > 0 && now - node.parentChanges[0] > 60_000) node.parentChanges.shift();
    const kbps = this.streamKbps();
    const observed: Observed = { uptimeMs: now - node.joinedAt, spareUplinkKbps: node.caps.uplinkKbps, lossPct: node.lossPct, churnPerMin: node.parentChanges.length };
    node.verdict = this.scoring.judgeRelay(node.caps, observed, kbps, this.params);
    // "Could relay one day": what it says of itself passes, and so does its uplink if a probe
    // has measured it. [D76] A peer whose probe found no room for two children (the gate's
    // "slow" viewer) is a dead end from then on, until a later probe says otherwise: before, it
    // counted as able to relay for the whole session, so nothing ever moved it out of a place
    // a relay needed, and nobody waited behind it as behind a dead end.
    node.canRelay =
      node.role !== "source" &&
      this.scoring.judgeRelay(node.caps, { uptimeMs: 3_600_000, spareUplinkKbps: node.caps.uplinkKbps ?? 1e9, lossPct: 0, churnPerMin: 0 }, kbps, this.params).eligible;
    return node.verdict;
  }

  /** [D76] Its probe has measured its uplink, and found the room a relay needs. */
  passedProbe(node: TreeNode): boolean {
    return node.caps.uplinkKbps !== null && node.caps.uplinkKbps !== undefined && node.canRelay;
  }

  /**
   * [D76] Every viewer on the source has shown it cannot relay: a probe found no room, or it was
   * a dead end by what it says of itself. None of them is still to be probed.
   */
  sourceChildrenKnown(): boolean {
    if (this.source === null) return true;
    for (const child of this.childrenOf(this.source)) {
      const kid = this.nodes.get(child);
      if (kid && kid.conn !== null && kid.role === "leaf" && kid.canRelay) return false;
    }
    return true;
  }

  /**
   * [D76] A viewer that could relay, waiting with no relay anywhere and viewers on the source that
   * cannot, is sent to the source one over its fan-out, in place of one of them: once it relays,
   * the source's excess goes under it (D67's relief). As many at once as there are such viewers
   * on the source, and never beyond twice its fan-out (the most its node takes in, D37). Null if
   * not so.
   */
  swapFor(joiner: TreeNode, now: number): Placement | null {
    if (this.source === null || !this.sourceAlone() || !joiner.canRelay || joiner.role !== "leaf" || this.swaps.has(joiner.peer)) return null;
    const source = this.nodes.get(this.source)!;
    if (!this.offerable(source, now) || (joiner.avoid.get(source.peer) ?? 0) > now) return null;
    for (const [peer] of this.swaps) if (this.nodes.get(peer)?.conn == null) this.swaps.delete(peer);
    let deadEnds = 0;
    for (const child of this.childrenOf(source.peer)) {
      const kid = this.nodes.get(child);
      if (kid && kid.conn !== null && kid.role === "leaf" && !kid.canRelay && !this.swaps.has(child)) deadEnds++;
    }
    const children = Math.max(source.children, this.childrenOf(source.peer).size);
    // Those sent and not yet linked count too.
    let coming = 0;
    for (const [peer] of this.swaps) if (this.nodes.get(peer)?.parent !== source.peer) coming++;
    if (deadEnds <= this.swaps.size || children + coming >= 2 * this.fanout(source)) return null;
    this.swaps.set(joiner.peer, now);
    return { parents: [{ peer: source.peer, depth: 0, free: 0, ...(source.region ? { region: source.region } : {}) }], backups: [] };
  }

  /** [D76] Viewers sent to the source in place of ones that cannot relay, while their probes are out, and when. */
  readonly swaps = new Map<PeerId, number>();

  /* ------------------------------ reading the map ------------------------------ */

  /** `peer`, its parent, … as far as the map knows. */
  path(peer: PeerId): PeerId[] {
    const out: PeerId[] = [];
    let at: PeerId | null = peer;
    while (at !== null && out.length < MAX_PATH && !out.includes(at)) {
      out.push(at);
      at = this.nodes.get(at)?.parent ?? null;
    }
    return out;
  }

  private isStale(node: TreeNode, now: number): boolean {
    return now - node.lastStatusAt > 3 * this.params.statusMs;
  }

  /**
   * Whether `peer`'s path, as the map has it, reaches the source. One that does not hangs from a
   * peer that has lost its own parent: offering it would hang the asker from a cut-off branch.
   */
  reachesSource(peer: PeerId): boolean {
    if (this.source === null) return false;
    const path = this.path(peer);
    return path[path.length - 1] === this.source;
  }

  /** Whether a joiner may be sent to this peer at all, slots aside. */
  offerable(node: TreeNode, now: number): boolean {
    if (node.role === "leaf" || node.conn === null || node.demotingSince !== null) return false;
    if (this.isStale(node, now) || node.suspectUntil > now) return false;
    if (node.role !== "source" && node.distrustedUntil > now) return false;
    return node.role === "source" || (node.parent !== null && node.depth !== DEPTH_UNKNOWN && this.reachesSource(node.peer));
  }

  /**
   * [D49] The source's fan-out: `sourceFanout`, and while it is the only relay of the session, up
   * to SOURCE_ALONE_FANOUT if its probe showed the uplink for them (the fan-out formula, §8.1).
   */
  sourceFanout(node: TreeNode): number {
    const base = this.params.sourceFanout;
    const uplink = node.caps.uplinkKbps;
    if (uplink === null || uplink === undefined || (this.sourcePolicy === "alone" && !this.sourceAlone())) return base;
    return Math.max(base, relayFanout(uplink, this.streamKbps(), this.params.sourceAloneFanout ?? SOURCE_ALONE_FANOUT));
  }

  /** No relay, full or provisional, is connected: the source feeds everyone it can. */
  sourceAlone(): boolean {
    for (const node of this.nodes.values()) if (node.role === "relay" && node.conn !== null) return false;
    return true;
  }

  /** How many active children this feeder takes: the source's fan-out, or its verdict's (SPEC §8.1). */
  fanout(node: TreeNode): number {
    if (node.role === "source") return this.sourceFanout(node);
    if (node.role !== "relay") return 0;
    return node.provisional ? Math.min(PROVISIONAL_FANOUT, this.params.maxFanout) : node.verdict.fanout;
  }

  /**
   * Slots this peer can still give, by the coordinator's reckoning: what it said it has, less
   * the children who have since said they are fed by it, less the places held for joiners.
   */
  free(node: TreeNode, now: number): number {
    for (const [joiner, at] of node.held) if (now - at > HOLD_MS) node.held.delete(joiner);
    // A provisional relay takes no more than its fan-out, whatever it says (D38).
    const capacity = node.provisional ? Math.min(node.children + node.free, this.fanout(node)) : node.children + node.free;
    const known = this.kids.get(node.peer);
    let taken = Math.max(node.children, known?.size ?? 0);
    for (const joiner of node.held.keys()) if (!known?.has(joiner)) taken++;
    return Math.max(0, capacity - taken);
  }

  /** Free slots in the whole tree. */
  totalFree(now: number): number {
    let total = 0;
    for (const peer of this.feeders) {
      const node = this.nodes.get(peer)!;
      if (this.offerable(node, now)) total += this.free(node, now);
    }
    return total;
  }

  /** Viewers with an open socket. */
  audience(): number {
    let count = 0;
    for (const node of this.nodes.values()) if (node.role !== "source" && node.conn !== null) count++;
    return count;
  }

  /** Relays (not the source) in the session now. */
  relayCount(): number {
    let count = 0;
    for (const peer of this.feeders) if (this.nodes.get(peer)?.role === "relay") count++;
    return count;
  }

  /** A leaf in the session, in the tree or waiting for a place, that could one day relay. */
  couldGrow(): boolean {
    for (const node of this.nodes.values()) if (node.role === "leaf" && node.canRelay && node.conn !== null) return true;
    return false;
  }

  /** A leaf already in the tree that could be made a relay: the tree can still grow. */
  private growthPending(): boolean {
    for (const node of this.nodes.values()) if (node.role === "leaf" && node.canRelay && node.conn !== null && node.parent !== null) return true;
    return false;
  }

  /* ------------------------------ placement ------------------------------ */

  /** SPEC §6.6 "Placing a joiner" and "Answering `need`". Holds nothing: see `hold`. */
  place(joiner: TreeNode, options: PlaceOptions): Placement {
    const { now, want } = options;
    const hasSubtree = this.childrenOf(joiner.peer).size > 0;
    const forParent = want === "parent";
    type Ranked = { node: TreeNode; hint: PeerHint; cost: number; near: number; score: number; free: number };
    /** Everyone the asker could be linked to, whether or not they have a slot free. */
    const pool: Ranked[] = [];
    let treeFree = 0;
    for (const peer of this.feeders) {
      const node = this.nodes.get(peer)!;
      if (!this.offerable(node, now)) continue;
      const free = this.free(node, now);
      treeFree += free;
      if (peer === joiner.peer || options.exclude.includes(peer)) continue;
      if ((joiner.avoid.get(peer) ?? 0) > now) continue;
      if (hasSubtree || (!forParent && joiner.parent !== null) || options.excludeBelow === true) {
        const path = this.path(peer);
        // What the asker excludes is, as a rule, dead (SPEC §7.5): what hangs below it is cut off with it.
        if (options.excludeBelow === true && options.exclude.some((excluded) => path.includes(excluded))) continue;
        // Never one of its own descendants: that is a loop (SPEC §7.2).
        if (hasSubtree && path.includes(joiner.peer)) continue;
        // A backup that hangs below the parent dies with it (SPEC §7.3).
        if (!forParent && joiner.parent !== null && path.includes(joiner.parent)) continue;
      }
      const hint: PeerHint = { peer, depth: node.depth, free: Math.min(255, free), ...(node.region ? { region: node.region } : {}) };
      // The coordinator has measured nothing of the link: the cost is the depth's (SPEC §8.3).
      const candidate: Candidate = { ...hint, free: Math.max(1, free), rttMs: null, lossPct: 0, path: null, turn: false };
      const cost = this.scoring.parentCost(candidate);
      if (!Number.isFinite(cost)) continue;
      pool.push({ node, hint, cost, free, near: node.region !== null && node.region === joiner.region ? 0 : 1, score: node.role === "source" ? 2 : node.verdict.score });
    }

    // A peer that can never relay ends a branch. The tree's last free slot is kept for one that
    // can, while there is nobody in the tree whose promotion would open more: otherwise the
    // next peer able to relay would have nowhere to stand, and nobody after it either.
    // And while relays are waiting to come up (`moves`), a few slots are kept free to move through.
    const deadEnd = joiner.role === "leaf" && !joiner.canRelay;
    const moving = options.shallowerThan !== undefined || options.deeperThan !== undefined || options.move === true;
    let withheld = false;
    if (forParent && deadEnd && !moving && options.join === true) {
      const spare = this.misplaced > 0 ? Math.max(1, Math.min(this.misplaced, Math.ceil(this.audience() * MOVE_SHARE))) : this.growthPending() ? 0 : 1;
      withheld = treeFree <= spare;
    }

    // SPEC §6.6: shallowest first (by parent cost, which prices depth), then the same region,
    // then the best relay. A dead end is placed the other way up, deepest first, so that the
    // slots near the source stay free for the peers the tree will grow from.
    const deepFirst = deadEnd && this.leafPlacement === "deep" && options.shallowerThan === undefined;
    const order = (a: Ranked, b: Ranked) => a.near - b.near || b.score - a.score || (a.hint.peer < b.hint.peer ? -1 : 1);
    // Wherever it goes, the asker takes its subtree with it. A place where that ends deeper than
    // the tree needs (`neededDepth() + 1`) comes after every place where it does not; and a dead
    // end moved down to make room is never moved below that line.
    const deepest = this.neededDepth(now) + 1;
    const height = hasSubtree ? this.height(joiner.peer) : 0;
    const over = (candidate: Ranked) => (candidate.node.depth + 1 + height > deepest ? 1 : 0);
    if (forParent && options.overload === true) {
      // Everyone is full. The least over its fan-out first, then the shallowest.
      const load = (candidate: Ranked) => Math.max(this.childrenOf(candidate.node.peer).size, candidate.node.children) - this.fanout(candidate.node);
      // Up to twice the fan-out (D37): beyond that, nobody.
      // [D76] Never the source for a peer that has not passed its probe: at a session's start six
      // "slow" viewers took its slots and the three over its fan-out, and nobody could relay.
      const parents = pool
        .filter((candidate) => load(candidate) < this.fanout(candidate.node))
        .filter((candidate) => candidate.node.role !== "source" || this.passedProbe(joiner))
        .sort((a, b) => load(a) - load(b) || a.cost - b.cost || order(a, b))
        .slice(0, 3);
      return { parents: parents.map((candidate) => ({ ...candidate.hint, free: 0 })), backups: [] };
    }
    // [D76] While no relay exists, the source's last slot is kept for a peer that has passed its
    // probe, or, once every viewer on the source has shown it cannot relay, for one that could:
    // the first relay must have somewhere to stand and probe.
    const sourceReserve = forParent && !moving && this.sourceAlone() && !this.passedProbe(joiner) && !(joiner.canRelay && this.sourceChildrenKnown()) ? 1 : 0;
    // D38: a provisional relay only when no full relay (or the source) has a free slot.
    const reserved = (candidate: Ranked) =>
      candidate.node.role === "source" ? sourceReserve : options.join === true && !candidate.node.provisional && candidate.node.role === "relay" && this.fanout(candidate.node) >= 4 ? 1 : 0;
    const fullRoom = pool.some((candidate) => !candidate.node.provisional && candidate.free > reserved(candidate) && over(candidate) === 0);
    const parents = forParent
      ? pool
          .filter((candidate) => {
            if (withheld || candidate.free <= 0) return false;
            // D60: a join leaves a full relay's last slot to repairs. With fan-out 6 a depth-1
            // relay carries a sixth of the audience; with every slot taken by joiners, the cut-off
            // subtree of a killed one found nowhere to go (gate run 45146597862: ~180 cold repairs
            // twice, 118 and 120 "no parent could be found").
            if (candidate.free <= reserved(candidate)) return false;
            if (candidate.node.provisional && fullRoom) return false;
            if (options.shallowerThan !== undefined && candidate.node.depth + 1 >= options.shallowerThan) return false;
            return options.deeperThan === undefined || (candidate.node.depth + 1 > options.deeperThan && over(candidate) === 0);
          })
          .sort((a, b) => over(a) - over(b) || (deepFirst ? b.cost - a.cost : a.cost - b.cost) || order(a, b))
          .slice(0, 3)
      : [];
    if (moving) return { parents: parents.map((candidate) => candidate.hint), backups: [] };

    // A backup needs no free slot, only a standby place (SPEC §7.3: a relay holds 2 × `maxFanout`
    // of them, and a repair is never refused). First those that would outlive every parent
    // offered; then those at the parent's own depth, then one level shallower and so on, then
    // deeper ones, shallowest first; then whoever holds the fewest places. At the parent's depth,
    // a warm repair leaves the peer and its whole subtree where they were: a deeper backup pushes
    // them all down, and a shallower one spends a place near the source that a peer nearer the
    // source will want.
    const places = 2 * this.params.maxFanout;
    const parentDepth = forParent ? (parents[0]?.node.depth ?? null) : joiner.parent !== null ? (this.nodes.get(joiner.parent)?.depth ?? null) : null;
    const level = (candidate: Ranked) => {
      // A peer with nothing below it risks only itself: the deepest backup that still keeps it
      // within the depth the tree needs, so that the places near the source are left for the
      // peers that carry subtrees.
      if (height === 0 && !hasSubtree) return candidate.node.depth + 1 <= deepest ? deepest - 1 - candidate.node.depth : 1000 + candidate.node.depth;
      if (parentDepth === null || parentDepth === DEPTH_UNKNOWN) return candidate.node.depth;
      return candidate.node.depth <= parentDepth ? parentDepth - candidate.node.depth : 1000 + candidate.node.depth;
    };
    // [D67] The children of one parent repair at once when it dies, each to its own backup. A
    // backup more of them stand by on than it has room for then goes over its fan-out (D37), and
    // the source, which nothing is as shallow as, can never be relieved of a child that relays
    // (gate run 45211601384: over its fan-out in 51% of depth-1 samples, shedding the top layer
    // for the whole tree). So among backups at one level the uncrowded come first, and the source
    // crowded comes after every other backup, deeper ones included.
    const parentPeer = forParent ? (parents[0]?.node.peer ?? null) : joiner.parent;
    const crowded = (candidate: Ranked) => (parentPeer !== null && this.crowdAhead(candidate.node, parentPeer, joiner.peer, false) >= this.roomFor(candidate.node, parentPeer) ? 1 : 0);
    const backups = pool
      .filter((candidate) => !parents.includes(candidate) && this.standby(candidate.node) < places)
      .map((candidate) => {
        const path = parents.length > 0 ? this.path(candidate.hint.peer) : [];
        const crowd = crowded(candidate);
        return { candidate, below: parents.some((parent) => path.includes(parent.hint.peer)) ? 1 : 0, held: this.standby(candidate.node), level: level(candidate), crowd, sourceCrowded: candidate.node.role === "source" ? crowd : 0 };
      })
      .sort((a, b) => a.below - b.below || Number(a.candidate.node.provisional) - Number(b.candidate.node.provisional) || a.sourceCrowded - b.sourceCrowded || a.level - b.level || a.crowd - b.crowd || a.candidate.cost - b.candidate.cost || a.held - b.held || order(a.candidate, b.candidate))
      .slice(0, 3)
      .map((entry) => entry.candidate);
    return { parents: parents.map((candidate) => candidate.hint), backups: backups.map((candidate) => candidate.hint) };
  }

  /**
   * [D67] How many children of `parent` stand by on `backup`: all but `asker`, or, with
   * `ranked`, only those whose id sorts before it (so that of a crowd, the first `roomFor` keep
   * their place and the rest are the ones to move).
   */
  crowdAhead(backup: TreeNode, parent: PeerId, asker: PeerId, ranked: boolean): number {
    let crowd = 0;
    for (const kid of this.childrenOf(parent)) {
      if (kid === asker || (ranked && kid > asker)) continue;
      if (this.nodes.get(kid)?.backup === backup.peer) crowd++;
    }
    return crowd;
  }

  /** [D67] The children of `parent` that `backup` could take in, if `parent` died, without going over its fan-out. */
  roomFor(backup: TreeNode, parent: PeerId): number {
    const taken = Math.max(backup.children, this.kids.get(backup.peer)?.size ?? 0);
    const freed = this.nodes.get(parent)?.parent === backup.peer ? 1 : 0;
    return Math.max(0, this.fanout(backup) - taken + freed);
  }

  /**
   * Keeps a place for `joiner` at the first two parents it was offered: those are the links it
   * opens (SPEC §7.1), and either may win. Let go when it says where it settled, or `HOLD_MS`.
   */
  hold(joiner: TreeNode, placement: Placement, now: number): void {
    for (const hint of placement.parents.slice(0, 2)) this.nodes.get(hint.peer)?.held.set(joiner.peer, now);
  }

  /* ------------------------------ promotion and demotion ------------------------------ */

  /**
   * Leaves to make relays now, best first (SPEC §6.6): eligible by §8.1, and only while the
   * tree's free slots are fewer than a fifth of the audience.
   */
  promotable(now: number, provisional = true): { node: TreeNode; provisional: boolean }[] {
    const audience = this.audience();
    let free = this.totalFree(now);
    if (free * 5 >= audience) return [];
    const eligible: { node: TreeNode; provisional: boolean }[] = [];
    for (const node of this.nodes.values()) {
      if (node.role !== "leaf" || !node.canRelay || node.conn === null || node.parent === null || node.depth === DEPTH_UNKNOWN) continue;
      if (this.isStale(node, now) || now - node.demotedAt < REPROMOTE_AFTER_MS) continue;
      if (this.judge(node, now).eligible && node.verdict.fanout > 0) eligible.push({ node, provisional: false });
      else if (provisional && this.provisionallyEligible(node, now)) eligible.push({ node, provisional: true });
    }
    // Full relays first (D38), then the shallowest, then the best.
    eligible.sort((a, b) => Number(a.provisional) - Number(b.provisional) || a.node.depth - b.node.depth || b.node.verdict.score - a.node.verdict.score || (a.node.peer < b.node.peer ? -1 : 1));
    const out: { node: TreeNode; provisional: boolean }[] = [];
    for (const entry of eligible) {
      if (free * 5 >= audience) break;
      out.push(entry);
      free += entry.provisional ? PROVISIONAL_FANOUT : entry.node.verdict.fanout;
    }
    return out;
  }

  /**
   * Leaves that could be made relays to give `asker` a parent now (SPEC §6.6): eligible by §8.1,
   * connected to the source, outside the asker's own subtree and not among `exclude`, best
   * first. Not limited by the fifth-of-the-audience rule: they are wanted because someone has
   * nowhere to go.
   */
  promotableFor(asker: TreeNode, exclude: readonly PeerId[], now: number, provisional = true): { node: TreeNode; provisional: boolean }[] {
    const out: { node: TreeNode; provisional: boolean }[] = [];
    for (const node of this.nodes.values()) {
      if (node === asker || node.role !== "leaf" || !node.canRelay || node.conn === null || node.parent === null || node.depth === DEPTH_UNKNOWN) continue;
      if (exclude.includes(node.peer) || this.isStale(node, now) || now - node.demotedAt < REPROMOTE_AFTER_MS || node.suspectUntil > now || node.distrustedUntil > now) continue;
      const path = this.path(node.peer);
      if (path.includes(asker.peer) || path[path.length - 1] !== this.source || exclude.some((peer) => path.includes(peer))) continue;
      if (this.judge(node, now).eligible && node.verdict.fanout > 0) out.push({ node, provisional: false });
      else if (provisional && this.provisionallyEligible(node, now)) out.push({ node, provisional: true });
    }
    return out.sort((a, b) => Number(a.provisional) - Number(b.provisional) || a.node.depth - b.node.depth || b.node.verdict.score - a.node.verdict.score || (a.node.peer < b.node.peer ? -1 : 1));
  }

  /** D38: provisional relays whose probation is over and that are eligible in full: made full relays. */
  graduating(now: number): TreeNode[] {
    const out: TreeNode[] = [];
    for (const peer of this.feeders) {
      const node = this.nodes.get(peer)!;
      if (node.provisional && node.demotingSince === null && this.judge(node, now).eligible && node.verdict.fanout > 0) out.push(node);
    }
    return out;
  }

  /** Relays being made leaves whose children have gone, or whose grace is over: time to say so. */
  demoted(now: number): TreeNode[] {
    const out: TreeNode[] = [];
    for (const peer of this.feeders) {
      const node = this.nodes.get(peer)!;
      if (node.demotingSince === null) continue;
      const left = [...this.childrenOf(peer)].filter((child) => this.nodes.get(child)?.conn !== null).length;
      if (left === 0 || now - node.demotingSince >= DEMOTE_GRACE_MS) out.push(node);
    }
    return out;
  }

  /**
   * Feeders with more children than their fan-out, as their children say (SPEC §7.5: a backup
   * takes a repair whatever its slots), and which of those children to move: dead ends first,
   * then those with the smallest subtrees. Each child at most once in `rebalanceMinMs`.
   */
  overloaded(now: number): Overload[] {
    const out: Overload[] = [];
    for (const peer of this.feeders) {
      const node = this.nodes.get(peer)!;
      const kids = [...this.childrenOf(peer)].map((child) => this.nodes.get(child)).filter((kid): kid is TreeNode => kid !== undefined && kid.conn !== null);
      // Those asked to move lately are on their way: not asked again, and not counted twice.
      const leaving = kids.filter((kid) => now - kid.lastRebalanceAt < HOLD_MS).length;
      // What its node takes before it is over its fan-out (D37), or what it last said it can take
      // if that is more and it still had room then. [D50] Every relay is told its fan-out in
      // `role` and its node holds to it, so the verdict and the node agree: relief by the
      // verdict is relief by what the node takes. (Before D50 a full relay was told none, and its
      // node took `maxFanout`.)
      const capacity = node.free > 0 ? Math.max(this.fanout(node), node.children + node.free) : this.fanout(node);
      const excess = kids.length - leaving - capacity;
      if (excess <= 0) continue;
      const movable = kids
        .filter((kid) => !this.isStale(kid, now) && now - kid.lastRebalanceAt >= this.params.rebalanceMinMs)
        .map((kid) => ({ kid, height: this.height(kid.peer) }))
        .sort((a, b) => a.height - b.height || (a.kid.peer < b.kid.peer ? -1 : 1))
        .map((entry) => entry.kid);
      if (movable.length > 0) out.push({ node, excess, candidates: movable });
    }
    return out;
  }

  /**
   * Relays to make leaves again (SPEC §8.1): no longer eligible, or their children have been
   * losing more than 5% for 10 s. One child with a bad line of its own is not the relay's
   * doing, so it takes more than half of the children that report, and two of them at least:
   * with half, a provisional relay (two children) one of whose children is on a bad network was
   * demoted 3 s on, its children moved, and the tree churned (the gate: 85 to 109 demotions in a
   * run of 200 peers, 15% of them on "bad").
   */
  demotable(now: number): TreeNode[] {
    const out: TreeNode[] = [];
    for (const peer of this.feeders) {
      const node = this.nodes.get(peer)!;
      if (node.role !== "relay") continue;
      let reporting = 0;
      let lossy = 0;
      for (const child of this.childrenOf(peer)) {
        const kid = this.nodes.get(child);
        if (!kid || kid.conn === null) continue;
        const fresh = kid.up !== null && kid.up.parent === peer && now - kid.up.at <= 3 * this.params.metricsMs;
        const loss = fresh ? kid.up!.lossPct : this.isStale(kid, now) ? null : kid.lossPct;
        if (loss === null) continue;
        reporting++;
        if (loss > CHILD_LOSS_PCT) lossy++;
      }
      if (node.demotingSince !== null) continue;
      // A provisional relay is not yet eligible in full: only what it does wrong besides that counts (D38).
      const ineligible = node.provisional ? !this.judge(node, now).eligible && !this.provisionallyEligible(node, now) : !this.judge(node, now).eligible;
      const failing = ineligible || (lossy >= 2 && lossy * 2 > reporting);
      if (!failing) node.ineligibleSince = null;
      else if (node.ineligibleSince === null) node.ineligibleSince = now;
      if (failing && now - node.ineligibleSince! >= (node.provisional ? PROVISIONAL_DEMOTE_AFTER_MS : DEMOTE_AFTER_MS)) out.push(node);
    }
    return out;
  }

  /** How many levels hang below `peer`, as the map has it: 0 for a peer with no children. */
  height(peer: PeerId, seen = 0): number {
    if (seen >= MAX_PATH) return 0;
    let most = 0;
    for (const child of this.childrenOf(peer)) most = Math.max(most, 1 + this.height(child, seen + 1));
    return most;
  }

  /**
   * Peers whose warm repair would push them and their subtree deeper than the tree needs: their
   * backup sits deeper than their parent, and with their subtree they would end up below
   * `neededDepth() + 1`. Topology's node takes the best candidate of an `assign` "rebalance" as
   * its backup when it sits nearer the source than the one it has (SPEC §7.6 leaves the parent
   * to the cost rule), so these are offered better ones. A move leaves the old parent as the
   * backup (SPEC §7.6), which after a move up is deeper than the new parent: this is what keeps
   * the next repair from undoing the move. At most once in `rebalanceMinMs` per peer.
   */
  backupAdvice(now: number, budget: number): { node: TreeNode; placement: Placement }[] {
    const deepest = this.neededDepth() + 1;
    const out: { node: TreeNode; placement: Placement; height: number }[] = [];
    for (const node of this.nodes.values()) {
      if (node.role === "source" || node.conn === null || node.parent === null || node.parent === this.source || node.depth === DEPTH_UNKNOWN) continue;
      if (this.isStale(node, now) || now - node.backupAdviceAt < REBALANCE_EVERY_MS) continue;
      const parent = this.nodes.get(node.parent);
      if (!parent || parent.depth === DEPTH_UNKNOWN) continue;
      const backup = node.backup !== null ? this.nodes.get(node.backup) : undefined;
      const backupDepth = backup && backup.conn !== null && backup.depth !== DEPTH_UNKNOWN ? backup.depth : DEPTH_UNKNOWN;
      const height = this.height(node.peer);
      // [D67] Standing by on the source beside more of its parent's children than the source
      // could take in: offered a relay at the parent's depth, which keeps it and its subtree as
      // deep as they are. Most of these chose the source while it had room, as the tree filled.
      if (backup && backup.role === "source" && parent.role !== "source") {
        if (this.crowdAhead(backup, parent.peer, node.peer, true) < this.roomFor(backup, parent.peer)) continue;
        const level = this.place(node, { want: "backup", exclude: [backup.peer], now }).backups.filter((hint) => hint.depth === parent.depth && hint.peer !== node.parent);
        if (level.length > 0) out.push({ node, placement: { parents: [], backups: level }, height });
        continue;
      }
      if (backupDepth <= parent.depth || backupDepth + 1 + height <= deepest) continue;
      const placement = this.place(node, { want: "backup", exclude: [], now });
      // What the node will take: nearer the source than the backup it has, and with room (its rule).
      const better = placement.backups.filter((hint) => hint.depth < backupDepth && hint.peer !== node.parent);
      if (better.length === 0) continue;
      out.push({ node, placement: { parents: [], backups: better }, height });
    }
    // The biggest subtrees first: a repair under them costs the most.
    return out.sort((a, b) => b.height - a.height || (a.node.peer < b.node.peer ? -1 : 1)).slice(0, budget);
  }

  /** The depth a tree of this audience needs, with every relay full: ⌈log₄(n + 1)⌉. Kept for the rest of the moment `now`. */
  neededDepth(now?: number): number {
    if (now !== undefined && this.needed?.at === now) return this.needed.depth;
    let depth = 1;
    let holds = this.params.sourceFanout;
    let level = this.params.sourceFanout;
    const audience = this.audience();
    while (holds < audience && depth < MAX_PATH) {
      level *= this.params.maxFanout;
      holds += level;
      depth++;
    }
    if (now !== undefined) this.needed = { at: now, depth };
    return depth;
  }
  private needed: { at: number; depth: number } | null = null;

  /** Peers more than two levels deeper than the tree needs, not advised in the last minute (SPEC §6.6). */
  tooDeep(now: number): TreeNode[] {
    const limit = this.neededDepth() + 2;
    const out: TreeNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.conn === null || node.depth === DEPTH_UNKNOWN || node.depth <= limit) continue;
      if (now - node.lastRebalanceAt >= REBALANCE_EVERY_MS) out.push(node);
    }
    return out;
  }

  /**
   * Changes of parent that would shorten the tree, at most `budget` of them.
   *
   * Placement alone cannot keep a growing tree short. Peers arrive in no order, and one that
   * can never relay ends the branch it is put on: when most arrivals are such, they fill every
   * new relay's slots before the next relay arrives, and the relays end up in chains. So:
   *
   * - "up": a relay moves to a free slot nearer the source, whenever there is one. Its whole
   *   subtree comes up with it.
   * - "down": a dead end sitting nearer the source than some relay gives its slot up, by
   *   moving to a free slot further down. The relay then comes up into it.
   *
   * Dead ends only ever move down and relays only up, so this settles; and each peer is moved
   * at most once in `rebalanceMinMs`.
   */
  moves(now: number, budget: number): Move[] {
    const out: Move[] = [];
    const movable = (node: TreeNode) =>
      node.conn !== null && node.parent !== null && node.depth !== DEPTH_UNKNOWN && !this.isStale(node, now) && now - node.lastRebalanceAt >= MOVE_AGAIN_MS;
    const relays: TreeNode[] = [];
    for (const peer of this.feeders) {
      const node = this.nodes.get(peer)!;
      if (node.role === "relay" && node.parent !== null && node.depth !== DEPTH_UNKNOWN) relays.push(node);
    }
    relays.sort((a, b) => b.depth - a.depth || b.verdict.score - a.verdict.score || (a.peer < b.peer ? -1 : 1));
    /** Relays still deeper than they need be, deepest first: what a dead end's slot is wanted for. */
    const left: TreeNode[] = [];
    for (const relay of relays) {
      if (relay.depth <= 1) continue;
      if (out.length >= budget || !movable(relay)) {
        left.push(relay);
        continue;
      }
      const placement = this.place(relay, { want: "parent", exclude: [relay.parent!], now, shallowerThan: relay.depth });
      if (placement.parents.length === 0) left.push(relay);
      else {
        this.hold(relay, placement, now);
        out.push({ node: relay, kind: "up", placement });
      }
    }
    this.misplaced = 0;
    if (left.length === 0) return out;
    const deadEnds: TreeNode[] = [];
    let shallowest = DEPTH_UNKNOWN;
    for (const node of this.nodes.values()) {
      if (node.role !== "leaf" || node.canRelay || node.conn === null || node.parent === null || node.depth >= left[0].depth) continue;
      shallowest = Math.min(shallowest, node.depth);
      if (movable(node)) deadEnds.push(node);
    }
    // Relays that a dead end is in the way of: while there are any, `place` keeps slots to move through.
    this.misplaced = left.filter((relay) => relay.depth > shallowest).length;
    if (out.length >= budget) return out;
    deadEnds.sort((a, b) => a.depth - b.depth || (a.peer < b.peer ? -1 : 1));
    let wanted = 0;
    for (const node of deadEnds) {
      if (out.length >= budget) break;
      // One slot per relay that is deeper than this dead end and has not been found a place.
      const deeper = left.filter((relay) => relay.depth > node.depth).length;
      if (deeper <= wanted) break;
      const placement = this.place(node, { want: "parent", exclude: [node.parent!], now, deeperThan: node.depth });
      if (placement.parents.length === 0) continue;
      this.hold(node, placement, now);
      out.push({ node, kind: "down", placement });
      wanted++;
    }
    return out;
  }

  /** Peers with nowhere to connect, those who could relay first, then whoever has waited longest. */
  waiting(): TreeNode[] {
    const out: TreeNode[] = [];
    for (const node of this.nodes.values()) if (node.waitingSince !== null && node.conn !== null && node.parent === null) out.push(node);
    return out.sort((a, b) => Number(b.canRelay) - Number(a.canRelay) || a.waitingSince! - b.waitingSince!);
  }

  record(node: TreeNode): PeerRecord {
    return {
      peer: node.peer,
      conn: node.conn,
      identity: node.identity,
      role: node.role,
      caps: node.caps,
      region: node.region,
      joinedAt: node.joinedAt,
      lastStatusAt: node.lastStatusAt,
      depth: node.depth,
      links: node.links,
      children: node.children,
      standby: node.standby,
      free: node.free,
    };
  }
}

const EMPTY: ReadonlySet<PeerId> = new Set();
