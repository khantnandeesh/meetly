import type { RoomSnapshot } from "@meetly/overlay/coordinator/types";

/**
 * Live (beta): "Who's connected", as anyone with the link may see it.
 *
 * The coordinator's tree map (its `/tree`, behind the server secret) names every peer by its
 * PeerId, with its identity, capabilities and region. None of that leaves the server: each peer
 * becomes a short key that cannot be turned back into its PeerId, a label ("Host", "Viewer 7"),
 * its parent's key, its depth and how many children it has. A browser finds its own node by
 * hashing its own PeerId the same way (`viewKey`).
 */

/** At most this many viewers watch one stream (the coordinator refuses the next one). */
export const LIVE_VIEWER_CAP = 50;

export type LiveNode = {
  key: string;
  label: string;
  source: boolean;
  /** The parent's key. Null for the source, and for a viewer still finding a place. */
  parent: string | null;
  /** Hops from the source (the source is 0). Null until the viewer has reported one. */
  depth: number | null;
  children: number;
};

export type LiveTree = {
  /** The host is connected and the stream has not ended. */
  started: boolean;
  ended: boolean;
  full: boolean;
  viewers: number;
  cap: number;
  nodes: LiveNode[];
};

/** The coordinator's mark for a depth nobody has reported yet. */
const DEPTH_UNKNOWN = 255;

/** A peer's public key in the tree: the first 12 hex digits of SHA-256("meetly-live:" + PeerId). */
export async function viewKey(peer: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`meetly-live:${peer}`)));
  return Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The coordinator's snapshot, with everything that could identify someone taken out. */
export async function anonymize(snapshot: RoomSnapshot, cap = LIVE_VIEWER_CAP): Promise<LiveTree> {
  // Peers whose socket has closed linger in the map for a while, in case they come back.
  const peers = snapshot.peers.filter((peer) => peer.conn !== null);
  const keys = new Map<string, string>();
  for (const peer of peers) keys.set(peer.peer, await viewKey(peer.peer));
  const viewers = peers.filter((peer) => peer.role !== "source").sort((a, b) => a.joinedAt - b.joinedAt || (a.peer < b.peer ? -1 : 1));
  const number = new Map(viewers.map((peer, index) => [peer.peer, index + 1]));
  const nodes: LiveNode[] = peers
    .map((peer) => {
      const source = peer.role === "source";
      // Stream 0, stripe 0: every stream follows the same tree in stage 1.
      const link = [...peer.links].sort((a, b) => a.stream - b.stream || a.stripe - b.stripe)[0];
      const parent = !source && link?.parent ? (keys.get(link.parent) ?? null) : null;
      return {
        key: keys.get(peer.peer)!,
        label: source ? "Host" : `Viewer ${number.get(peer.peer)}`,
        source,
        parent,
        depth: source ? 0 : peer.depth === DEPTH_UNKNOWN ? null : peer.depth,
        children: peer.children,
      };
    })
    .sort((a, b) => Number(b.source) - Number(a.source) || naturalOrder(a.label, b.label));
  const sourceOn = peers.some((peer) => peer.role === "source");
  return {
    started: sourceOn && !snapshot.ended,
    ended: snapshot.ended,
    full: viewers.length >= cap,
    viewers: viewers.length,
    cap,
    nodes,
  };
}

const naturalOrder = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** The tree as nested branches, for drawing: the source first, then anyone not yet placed. */
export type LiveBranch = LiveNode & { below: LiveBranch[] };

export function branches(nodes: LiveNode[]): { roots: LiveBranch[]; waiting: LiveNode[] } {
  const byKey = new Map(nodes.map((node) => [node.key, { ...node, below: [] as LiveBranch[] }]));
  const roots: LiveBranch[] = [];
  const waiting: LiveNode[] = [];
  for (const node of byKey.values()) {
    const parent = node.parent !== null ? byKey.get(node.parent) : undefined;
    if (parent && parent !== node) parent.below.push(node);
    else if (node.source) roots.push(node);
    else waiting.push(node);
  }
  // A cycle (two reports that crossed) is drawn as waiting rather than lost.
  const seen = new Set<string>();
  const visit = (branch: LiveBranch) => {
    seen.add(branch.key);
    branch.below.forEach(visit);
  };
  roots.forEach(visit);
  for (const node of byKey.values()) if (!seen.has(node.key) && !waiting.includes(node)) waiting.push(node);
  return { roots, waiting };
}
