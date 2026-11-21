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
import type { Scoring } from "./scoring";

/** A place offered to a joiner is held for it this long, unless its `status` settles it sooner. */
export const HOLD_MS = 10_000;
/** A peer reported dead by a child, or one that refused a link, is not offered for this long. */
export const SUSPECT_MS = 3_000;
/** SPEC §6.6: a peer whose socket has been closed this long is forgotten. */
export const FORGET_MS = 30_000;
/** SPEC §8.1: a relay must have been failing for this long before it is demoted. */
export const DEMOTE_AFTER_MS = 10_000;
/** A demoted relay is not promoted again for this long. */
export const REPROMOTE_AFTER_MS = 60_000;
/** SPEC §6.6: unasked advice to one peer, at most this often. */
export const REBALANCE_EVERY_MS = 60_000;
/** SPEC §8.1: children's loss above this, in percent, counts against their relay. */
export const CHILD_LOSS_PCT = 5;
/** The share of the audience the coordinator may ask to change parent in one second, to shorten the tree. */
export const MOVE_SHARE = 0.02;
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
  /** Peers a link to which failed, and until when not to offer them again. */
  avoid: Map<PeerId, number>;
  /** Since when it has been without anyone to connect to, or null. */
  waitingSince: number | null;
  lastAssignAt: number;
  lastRebalanceAt: number;
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
    avoid: new Map(),
    waitingSince: null,
    lastAssignAt: 0,
    lastRebalanceAt: 0,
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
};

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
  source: PeerId | null = null;
  /** Relays that `moves` last found deeper than they need be, with nowhere yet to go. */
  private misplaced = 0;

  constructor(options: TreeMapOptions) {
    this.params = options.params;
    this.scoring = options.scoring;
    this.streamKbps = options.streamKbps;
    this.leafPlacement = options.leafPlacement ?? "deep";
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

  setRole(node: TreeNode, role: OverlayRole, now: number): void {
    node.role = role;
    if (role === "leaf") {
      this.feeders.delete(node.peer);
      node.free = 0;
      node.held.clear();
    } else {
      this.feeders.add(node.peer);
      // Until it says otherwise, it is taken to have the slots its verdict gave it.
      node.free = Math.max(0, node.verdict.fanout - node.children);
      node.lastStatusAt = now;
    }
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
    // "Could relay one day": what it says of itself passes, whatever has been measured so far.
    node.canRelay =
      node.role !== "source" && this.scoring.judgeRelay(node.caps, { uptimeMs: 3_600_000, spareUplinkKbps: 1e9, lossPct: 0, churnPerMin: 0 }, kbps, this.params).eligible;
    return node.verdict;
  }

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

  /** Whether a joiner may be sent to this peer at all, slots aside. */
  offerable(node: TreeNode, now: number): boolean {
    if (node.role === "leaf" || node.conn === null) return false;
    if (this.isStale(node, now) || node.suspectUntil > now) return false;
    return node.role === "source" || (node.parent !== null && node.depth !== DEPTH_UNKNOWN);
  }

  /**
   * Slots this peer can still give, by the coordinator's reckoning: what it said it has, less
   * the children who have since said they are fed by it, less the places held for joiners.
   */
  free(node: TreeNode, now: number): number {
    for (const [joiner, at] of node.held) if (now - at > HOLD_MS) node.held.delete(joiner);
    const capacity = node.children + node.free;
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
      if (hasSubtree || (!forParent && joiner.parent !== null)) {
        const path = this.path(peer);
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
    const moving = options.shallowerThan !== undefined || options.deeperThan !== undefined;
    let withheld = false;
    if (forParent && deadEnd && !moving) {
      const spare = this.misplaced > 0 ? Math.max(1, Math.min(this.misplaced, Math.ceil(this.audience() * MOVE_SHARE))) : this.growthPending() ? 0 : 1;
      withheld = treeFree <= spare;
    }

    // SPEC §6.6: shallowest first (by parent cost, which prices depth), then the same region,
    // then the best relay. A dead end is placed the other way up, deepest first, so that the
    // slots near the source stay free for the peers the tree will grow from.
    const deepFirst = deadEnd && this.leafPlacement === "deep" && options.shallowerThan === undefined;
    const order = (a: Ranked, b: Ranked) => a.near - b.near || b.score - a.score || (a.hint.peer < b.hint.peer ? -1 : 1);
    const parents = forParent
      ? pool
          .filter((candidate) => {
            if (withheld || candidate.free <= 0) return false;
            if (options.shallowerThan !== undefined && candidate.node.depth + 1 >= options.shallowerThan) return false;
            return options.deeperThan === undefined || candidate.node.depth + 1 > options.deeperThan;
          })
          .sort((a, b) => (deepFirst ? b.cost - a.cost : a.cost - b.cost) || order(a, b))
          .slice(0, 3)
      : [];
    if (moving) return { parents: parents.map((candidate) => candidate.hint), backups: [] };

    // A backup needs no free slot, only a standby place (SPEC §7.3: a relay holds 2 × `maxFanout`
    // of them, and a repair is never refused). First those that would outlive every parent
    // offered, then shallowest first, then whoever holds the fewest places.
    const places = 2 * this.params.maxFanout;
    const backups = pool
      .filter((candidate) => !parents.includes(candidate) && this.standby(candidate.node) < places)
      .map((candidate) => {
        const path = parents.length > 0 ? this.path(candidate.hint.peer) : [];
        return { candidate, below: parents.some((parent) => path.includes(parent.hint.peer)) ? 1 : 0, held: this.standby(candidate.node) };
      })
      .sort((a, b) => a.below - b.below || a.candidate.cost - b.candidate.cost || a.held - b.held || order(a.candidate, b.candidate))
      .slice(0, 3)
      .map((entry) => entry.candidate);
    return { parents: parents.map((candidate) => candidate.hint), backups: backups.map((candidate) => candidate.hint) };
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
  promotable(now: number): TreeNode[] {
    const audience = this.audience();
    let free = this.totalFree(now);
    if (free * 5 >= audience) return [];
    const eligible: TreeNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.role !== "leaf" || !node.canRelay || node.conn === null || node.parent === null || node.depth === DEPTH_UNKNOWN) continue;
      if (this.isStale(node, now) || now - node.demotedAt < REPROMOTE_AFTER_MS) continue;
      if (this.judge(node, now).eligible && node.verdict.fanout > 0) eligible.push(node);
    }
    eligible.sort((a, b) => a.depth - b.depth || b.verdict.score - a.verdict.score || (a.peer < b.peer ? -1 : 1));
    const out: TreeNode[] = [];
    for (const node of eligible) {
      if (free * 5 >= audience) break;
      out.push(node);
      free += node.verdict.fanout;
    }
    return out;
  }

  /**
   * Relays to make leaves again (SPEC §8.1): no longer eligible, or their children have been
   * losing more than 5% for 10 s. One child with a bad line of its own is not the relay's
   * doing, so it takes at least half of the children that report.
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
      const failing = !this.judge(node, now).eligible || (reporting > 0 && lossy * 2 >= reporting);
      if (!failing) node.ineligibleSince = null;
      else if (node.ineligibleSince === null) node.ineligibleSince = now;
      else if (now - node.ineligibleSince >= DEMOTE_AFTER_MS) out.push(node);
    }
    return out;
  }

  /** The depth a tree of this audience needs, with every relay full: ⌈log₄(n + 1)⌉. */
  neededDepth(): number {
    let depth = 1;
    let holds = this.params.sourceFanout;
    let level = this.params.sourceFanout;
    const audience = this.audience();
    while (holds < audience && depth < MAX_PATH) {
      level *= this.params.maxFanout;
      holds += level;
      depth++;
    }
    return depth;
  }

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
      node.conn !== null && node.parent !== null && node.depth !== DEPTH_UNKNOWN && !this.isStale(node, now) && now - node.lastRebalanceAt >= this.params.rebalanceMinMs;
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
