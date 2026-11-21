/**
 * A STAND-IN for the coordinator, so the harness can be built and run before E-coordinator's
 * `startNodeCoordinator` exists. It speaks the real wire protocol of SPEC §6 (tickets, `hello` /
 * `welcome`, `time`, `signal`, `need` / `assign`, `status`, `report`, `metrics`, the close codes
 * and the HTTP routes), with the simplest placement that makes a tree: the shallowest relay with
 * a free slot. It is not the coordinator: no promotion or demotion, no rebalancing, no hint, no
 * limits, and a `resume` is believed without checking its grant. A run that used it says so in
 * its report.
 *
 * Owner: E-harness. Delete when K3 lands and the harness has run against it.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_PARAMS,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeClientMessage,
  encodeServerMessage,
  exportGrantPublicKey,
  generateGrantKey,
  signGrant,
  verifyTicket,
  type Assignment,
  type Capabilities,
  type ClientMessage,
  type MetricsSample,
  type OverlayParams,
  type OverlayRole,
  type PeerHint,
  type PeerId,
  type ServerMessage,
  type StreamConfig,
} from "../../protocol";
import type { NodeCoordinator, NodeCoordinatorOptions, RoomStats } from "../../coordinator/types";
import { seededRandom } from "../clock";

type Peer = {
  peer: PeerId;
  socket: WebSocket;
  identity: string;
  role: OverlayRole;
  caps: Capabilities;
  joinedAt: number;
  lastStatusAt: number;
  parent: PeerId | null;
  backup: PeerId | null;
  /** What the peer last said of itself. */
  reported: { children: number; standby: number; free: number; depth: number } | null;
};

type Room = {
  name: string;
  /** The Unix time of session clock 0. Kept across a kill, as the real coordinator persists it. */
  epochMs: number;
  peers: Map<PeerId, Peer>;
  streams: StreamConfig[];
  metrics: MetricsSample[];
  nonces: Set<string>;
  nextPeer: number;
  key: { kid: string; pub: string; privateKey: CryptoKey };
};

/** What the stand-in adds to `NodeCoordinator` for the harness. */
export type StandinCoordinator = NodeCoordinator & {
  /** Listen again on the same port after `kill()`, having forgotten every peer (but not the session's clock). */
  restart(): Promise<void>;
  metrics(room: string): MetricsSample[];
  tree(room: string): { peer: PeerId; role: OverlayRole; parent: PeerId | null; backup: PeerId | null; depth: number; children: number }[];
};

const MAX_METRICS = 200_000;
const CLOSE = { badTicket: 4001, full: 4002, badMessage: 4005, replaced: 4006 } as const;

export async function startStandinCoordinator(options: NodeCoordinatorOptions): Promise<StandinCoordinator> {
  const params: OverlayParams = { ...DEFAULT_PARAMS, ...options.params };
  const random = seededRandom(options.seed ?? 1);
  const rooms = new Map<string, Room>();
  const host = options.host ?? "127.0.0.1";
  let server: Server | null = null;
  let sockets: WebSocketServer | null = null;
  let port = options.port;

  const room = async (name: string): Promise<Room> => {
    let found = rooms.get(name);
    if (!found) {
      const pair = await generateGrantKey();
      found = {
        name,
        epochMs: Date.now(),
        peers: new Map(),
        streams: [],
        metrics: [],
        nonces: new Set(),
        nextPeer: 0,
        key: { kid: "standin-1", pub: await exportGrantPublicKey(pair.publicKey), privateKey: pair.privateKey },
      };
      // A second caller may have made it while this one awaited the key.
      const raced = rooms.get(name);
      if (raced) return raced;
      rooms.set(name, found);
    }
    return found;
  };

  const send = (peer: Peer | undefined, message: ServerMessage): void => {
    if (peer && peer.socket.readyState === peer.socket.OPEN) peer.socket.send(encodeServerMessage(message));
  };

  /* ------------------------------ the tree, as the stand-in sees it ------------------------------ */

  const childrenOf = (r: Room, parent: PeerId): number => {
    let count = 0;
    for (const peer of r.peers.values()) if (peer.parent === parent) count++;
    return count;
  };
  /** A peer, its parent, … the source; null if the chain does not reach the source. */
  const pathOf = (r: Room, from: PeerId): PeerId[] | null => {
    const path: PeerId[] = [];
    for (let at: PeerId | null = from; at; ) {
      const peer = r.peers.get(at);
      if (!peer || path.includes(at) || path.length > 64) return null;
      path.push(at);
      if (peer.role === "source") return path;
      at = peer.parent;
    }
    return null;
  };
  const fanoutOf = (r: Room, peer: Peer): number => {
    if (peer.role === "source") return params.sourceFanout;
    const caps = peer.caps;
    if (caps.browser !== "chromium" || !caps.desktop || caps.dataSaver || !caps.visible || caps.nat === "symmetric" || caps.nat === "relay") return 0;
    const streamKbps = r.streams.reduce((sum, stream) => sum + stream.bitrateKbps, 0) || 1;
    if (caps.uplinkKbps !== null && caps.uplinkKbps < 2 * streamKbps) return 0;
    return caps.uplinkKbps === null ? params.maxFanout : Math.min(params.maxFanout, Math.floor(caps.uplinkKbps / streamKbps));
  };
  const hint = (peer: Peer, depth: number, free: number): PeerHint => ({ peer: peer.peer, depth: Math.min(255, depth), free: Math.max(0, Math.min(255, free)) });

  /** Who `self` could take a stripe from: not itself, not below it, not excluded; shallowest and emptiest first. */
  const candidates = (r: Room, self: PeerId, exclude: readonly PeerId[]): { peer: Peer; path: PeerId[]; free: number }[] => {
    const out: { peer: Peer; path: PeerId[]; free: number; tie: number }[] = [];
    for (const peer of r.peers.values()) {
      if (peer.peer === self || exclude.includes(peer.peer) || peer.socket.readyState !== peer.socket.OPEN) continue;
      const fanout = fanoutOf(r, peer);
      if (fanout === 0) continue;
      const path = pathOf(r, peer.peer);
      if (!path || path.includes(self)) continue;
      out.push({ peer, path, free: fanout - childrenOf(r, peer.peer), tie: random() });
    }
    return out.sort((a, b) => a.path.length - b.path.length || b.free - a.free || a.tie - b.tie);
  };

  const assign = (r: Room, self: Peer, want: "parent" | "backup" | "both", exclude: readonly PeerId[]): Assignment => {
    const all = candidates(r, self.peer, exclude);
    const parents: PeerHint[] = [];
    const backups: PeerHint[] = [];
    let parentPath: PeerId[] | null = self.parent ? pathOf(r, self.parent) : null;
    if (want !== "backup") {
      const parent = all.find((c) => c.free > 0) ?? null;
      if (parent) {
        parents.push(hint(parent.peer, parent.path.length - 1, parent.free));
        self.parent = parent.peer.peer;
        parentPath = parent.path;
      }
    }
    if (want !== "parent") {
      const others = all.filter((c) => c.peer.peer !== self.parent);
      // A backup that does not hang off the parent survives the parent's death: prefer those.
      const apart = others.filter((c) => !parentPath || !c.path.includes(parentPath[0]));
      const backup = apart.find((c) => c.free > 0) ?? apart[0] ?? others[0] ?? null;
      if (backup) {
        backups.push(hint(backup.peer, backup.path.length - 1, backup.free));
        self.backup = backup.peer.peer;
      }
    }
    return { stream: 0, stripe: 0, parents, backups };
  };

  /* ------------------------------ messages ------------------------------ */

  const onMessage = async (r: Room, state: { peer: Peer | null; role: "source" | "viewer"; identity: string }, socket: WebSocket, text: string): Promise<void> => {
    let message: ClientMessage;
    try {
      message = decodeClientMessage(text);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      socket.send(encodeServerMessage({ t: "error", code: "bad-message", message: error.message.slice(0, 250) }));
      return;
    }
    if (message.t === "time") {
      socket.send(encodeServerMessage({ t: "time", t0: message.t0, t1: Math.max(0, Date.now() - r.epochMs) }));
      return;
    }
    if (message.t === "hello") {
      if (state.peer) return;
      const resumed = message.resume?.peer;
      const id: PeerId = resumed ?? `${state.role === "source" ? "s" : "v"}${(r.nextPeer++).toString(36)}`;
      const old = r.peers.get(id);
      if (old && old.socket !== socket) old.socket.close(CLOSE.replaced, "replaced");
      const role: OverlayRole = state.role === "source" ? "source" : "relay";
      const peer: Peer = { peer: id, socket, identity: state.identity, role, caps: message.caps, joinedAt: Date.now(), lastStatusAt: Date.now(), parent: old?.parent ?? null, backup: old?.backup ?? null, reported: null };
      r.peers.set(id, peer);
      state.peer = peer;
      if (role !== "source" && fanoutOf(r, peer) === 0) peer.role = "leaf";
      const nowS = Math.floor(Date.now() / 1000);
      const grant = await signGrant({ v: 1, room: r.name, peer: id, role: peer.role, scope: role === "source" ? ["publish:0"] : ["view", "relay"], iat: nowS, exp: nowS + 3600, kid: r.key.kid }, r.key.privateKey);
      // A peer that resumes keeps what it has; a new one is placed.
      const assignments = role === "source" || resumed ? [] : [assign(r, peer, "both", [])];
      send(peer, {
        t: "welcome",
        v: PROTOCOL_VERSION,
        peer: id,
        room: r.name,
        role: peer.role,
        grant,
        key: { kid: r.key.kid, pub: r.key.pub },
        epochMs: r.epochMs,
        ice: options.iceServers ?? [],
        params,
        streams: r.streams,
        assign: assignments,
      });
      return;
    }
    const self = state.peer;
    if (!self) {
      socket.close(CLOSE.badMessage, "hello first");
      return;
    }
    switch (message.t) {
      case "signal":
        send(r.peers.get(message.to), { t: "signal", from: self.peer, data: message.data });
        return;
      case "need": {
        if (message.want === "parent") self.parent = null;
        else self.backup = null;
        send(self, { t: "assign", id: message.id, reason: "need", assign: [assign(r, self, message.want, message.exclude)] });
        return;
      }
      case "status": {
        self.lastStatusAt = Date.now();
        self.caps = message.caps;
        self.reported = { children: message.children, standby: message.standby, free: message.free, depth: message.depth };
        const link = message.links.find((l) => l.stream === 0 && l.stripe === 0);
        if (link) {
          // The peer knows where it is better than a map does: this is how the map comes back after a restart.
          self.parent = link.parent;
          self.backup = link.backup;
        }
        return;
      }
      case "report":
        if (message.event === "parent-switch" || message.event === "parent-dead") self.parent = message.next ?? self.parent;
        return;
      case "metrics":
        if (r.metrics.length < MAX_METRICS) r.metrics.push(message.sample);
        return;
      case "streams":
        if (self.role !== "source") {
          send(self, { t: "error", code: "denied", message: "only the source says what is sent" });
          return;
        }
        r.streams = message.streams;
        for (const peer of r.peers.values()) if (peer !== self) send(peer, { t: "streams", streams: r.streams });
        return;
      case "bye":
        socket.close(1000, "bye");
        return;
    }
  };

  const onSocket = (r: Room, socket: WebSocket, role: "source" | "viewer", identity: string): void => {
    const state: { peer: Peer | null; role: "source" | "viewer"; identity: string } = { peer: null, role, identity };
    let queue: Promise<void> = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      queue = queue.then(() => onMessage(r, state, socket, text)).catch((error) => options.logger?.error("standin-coordinator", String(error)));
    });
    socket.on("close", () => {
      const peer = state.peer;
      if (!peer || r.peers.get(peer.peer) !== peer) return;
      r.peers.delete(peer.peer);
      for (const other of r.peers.values()) send(other, { t: "peer-gone", peer: peer.peer });
    });
    socket.on("error", () => socket.terminate());
  };

  /* ------------------------------ HTTP ------------------------------ */

  const depthOf = (r: Room, peer: PeerId): number => (pathOf(r, peer)?.length ?? 256) - 1;
  const tree = (name: string) => {
    const r = rooms.get(name);
    if (!r) return [];
    return [...r.peers.values()].map((peer) => ({ peer: peer.peer, role: peer.role, parent: peer.parent, backup: peer.backup, depth: depthOf(r, peer.peer), children: childrenOf(r, peer.peer) }));
  };
  const stats = (name: string): RoomStats => {
    const nodes = tree(name);
    const viewers = nodes.filter((n) => n.role !== "source");
    return { viewers: viewers.length, relays: viewers.filter((n) => n.children > 0).length, maxDepth: Math.max(0, ...viewers.map((n) => (n.depth > 64 ? 0 : n.depth))), started: nodes.some((n) => n.role === "source"), ended: false };
  };

  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const http = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://x");
        const json = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
          response.end(JSON.stringify(body));
        };
        if (url.pathname === "/overlay/v1/health") return json(200, { ok: true, standin: true });
        const match = /^\/overlay\/v1\/rooms\/([^/]+)\/(stats|tree|metrics)$/.exec(url.pathname);
        if (!match || request.method !== "GET") return json(404, { error: "not-found" });
        if (request.headers.authorization !== `Bearer ${options.serverSecret}`) return json(401, { error: "denied" });
        const name = decodeURIComponent(match[1]);
        if (match[2] === "stats") return json(200, stats(name));
        if (match[2] === "tree") return json(200, { room: name, standin: true, peers: tree(name) });
        return json(200, rooms.get(name)?.metrics ?? []);
      });
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
      http.on("upgrade", (request: IncomingMessage, socket, head) => {
        const url = new URL(request.url ?? "/", "http://x");
        const match = /^\/overlay\/v1\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
        const name = match ? decodeURIComponent(match[1]) : "";
        void (async () => {
          const r = match ? await room(name) : null;
          const ticket = r ? await verifyTicket(url.searchParams.get("ticket") ?? "", options.admissionSecret, { room: name, now: Date.now() }) : null;
          wss.handleUpgrade(request, socket, head, (ws) => {
            if (!r || !ticket || r.nonces.has(ticket.nonce)) {
              ws.close(CLOSE.badTicket, "bad ticket");
              return;
            }
            r.nonces.add(ticket.nonce);
            const viewers = [...r.peers.values()].filter((p) => p.role !== "source").length;
            if (ticket.role === "viewer" && options.viewerCap !== undefined && viewers >= options.viewerCap) {
              ws.close(CLOSE.full, "full");
              return;
            }
            onSocket(r, ws, ticket.role, ticket.identity);
          });
        })().catch(() => socket.destroy());
      });
      http.once("error", reject);
      http.listen(port, host, () => {
        const address = http.address();
        if (address && typeof address === "object") port = address.port;
        server = http;
        sockets = wss;
        resolve();
      });
    });

  const stop = async (): Promise<void> => {
    const http = server;
    const wss = sockets;
    server = null;
    sockets = null;
    if (wss) for (const client of wss.clients) client.terminate();
    for (const r of rooms.values()) r.peers.clear();
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };

  await listen();
  return {
    get url() {
      return `http://${host}:${port}`;
    },
    get port() {
      return port;
    },
    room: () => undefined,
    kill: stop,
    close: stop,
    restart: () => (server ? Promise.resolve() : listen()),
    metrics: (name) => rooms.get(name)?.metrics ?? [],
    tree,
  };
}
