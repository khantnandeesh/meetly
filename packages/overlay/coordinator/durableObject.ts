/**
 * The coordinator in production: one Durable Object per session, running `CoordinatorCore`
 * behind hibernatable WebSockets, and the Worker that routes a request to its session's object.
 * Deployed as its own Worker, `meetly-overlay` (./wrangler.jsonc), apart from the Next.js app
 * (SPEC §6.7, D13): the app's Worker is not touched, and neither is the cloudflare-deploy branch.
 *
 * Everything here is plumbing, as in ./node.ts: an event becomes one call on the core, and the
 * effects that come back are carried out in order. What a hibernating object loses is given
 * back to a new core by `restore`: the stored keys, and each socket's attachment.
 *
 * The Workers runtime's types are declared here, as far as this file uses them, instead of
 * depending on @cloudflare/workers-types: that package's globals clash with the DOM's, which
 * the rest of the repository is checked against.
 *
 * Owner: E-coordinator.
 */
import { DEFAULT_PARAMS, encodeServerMessage } from "../protocol";
import type { IceServer, OverlayParams } from "../protocol";
import { createCore } from "./core";
import { HEALTH_PATH, createSerial, parseRoomPath } from "./routing";
import { turnFrom } from "./turn";
import type { ConnId, CoordinatorCore, CoreRequest, Effect } from "./types";

/** What this file uses of a Durable Object's state. */
export interface DurableObjectStateLike {
  readonly id: { toString(): string; readonly name?: string };
  readonly storage: {
    get(key: string): Promise<unknown>;
    list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  acceptWebSocket(socket: WebSocketLike, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocketLike[];
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
}

/** What this file uses of a server-side WebSocket in a Worker. */
export interface WebSocketLike {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The runtime's pair of connected sockets (Workers' `WebSocketPair`). */
declare const WebSocketPair: new () => { 0: WebSocketLike; 1: WebSocketLike };

/** The Worker's bindings: wrangler.jsonc names them. */
export type CoordinatorEnv = {
  /** The Durable Object namespace of `OverlayRoom`. */
  OVERLAY_ROOM: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  /** Secret: shared with Meetly's server, verifies tickets. */
  OVERLAY_ADMISSION_SECRET: string;
  /** Secret: Meetly's server shows it to use the HTTP API. */
  OVERLAY_SERVER_SECRET: string;
  /** Optional: a Cloudflare TURN key, to mint credentials for peers that need a relay (SPEC §6.7). */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Optional override of the audience limit. */
  OVERLAY_VIEWER_CAP?: string;
  /** Optional: JSON, a partial `OverlayParams` (tests run with shorter timings). */
  OVERLAY_PARAMS?: string;
  /**
   * "1" turns on `POST /overlay/v1/rooms/:room/evict`, which throws away the object's memory
   * as an eviction does, for the contract suite. Never set in production.
   */
  OVERLAY_TEST_HOOKS?: string;
};

/** The header the Worker uses to tell the object which session it is. */
const ROOM_HEADER = "x-overlay-room";
/** Storage keys: the core's own under one prefix, the session's name under another. */
const CORE_PREFIX = "core:";
const ROOM_KEY = "room";
const STUN: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
/** TURN credentials last this long, and each peer is given fresh ones at half that (SPEC §6.7, [D80]). */
const TURN_TTL_S = 6 * 3600;

/** What a socket carries with it across hibernation: its id, and what the core attached. */
type SocketAttachment = { id: ConnId; core?: string };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });

function params(env: CoordinatorEnv): OverlayParams {
  if (!env.OVERLAY_PARAMS) return DEFAULT_PARAMS;
  try {
    return { ...DEFAULT_PARAMS, ...(JSON.parse(env.OVERLAY_PARAMS) as Partial<OverlayParams>) };
  } catch {
    return DEFAULT_PARAMS;
  }
}

/**
 * What a Worker that embeds `OverlayRoom`, rather than deploying this file's own Worker, may set
 * for its sessions. It passes them from a subclass: the runtime constructs a Durable Object with
 * `(state, env)` only.
 */
export type OverlayRoomOptions = {
  /** The STUN servers offered to every peer, in place of Cloudflare's alone. Empty: none. */
  stun?: IceServer[];
  /** The most viewers admitted, over `OVERLAY_VIEWER_CAP` and the default. */
  viewerCap?: number;
  /**
   * Tests only: a TURN server of the test's own (coturn with `use-auth-secret`), whose
   * credentials are minted here by the TURN REST API's rule from its shared secret, to last
   * `ttlS`. Used when no Cloudflare TURN key is configured. Never set in production.
   */
  testTurn?: { urls: string[]; secret: string; ttlS: number };
};

/** The TURN REST API's credentials (what coturn's `use-auth-secret` checks): "<expiry>:<name>", and its HMAC-SHA1. */
async function restCredentials(secret: string, ttlS: number): Promise<{ username: string; credential: string }> {
  const username = `${Math.floor(Date.now() / 1000) + ttlS}:overlay`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)));
  return { username, credential: btoa(String.fromCharCode(...mac)) };
}

/**
 * The configured STUN servers, and TURN minted for this peer from a Cloudflare TURN key when one
 * is configured. The STUN servers stay: the NAT probe needs two of them (SPEC §8.1), and
 * Cloudflare's answer has one. If minting fails the peer gets STUN only, and the reason (a
 * status code, never the key) is logged.
 */
async function iceServers(env: CoordinatorEnv, stun: IceServer[] = STUN, testTurn?: OverlayRoomOptions["testTurn"]): Promise<IceServer[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    if (!testTurn) return stun;
    return [...stun, { urls: testTurn.urls.slice(0, 8), ...(await restCredentials(testTurn.secret, testTurn.ttlS)) }].slice(0, 8);
  }
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
    });
    if (!response.ok) {
      console.warn(`overlay: TURN credentials not minted (HTTP ${response.status}); STUN only`);
      return stun;
    }
    return [...stun, ...turnFrom(await response.json())].slice(0, 8);
  } catch {
    // Not reached, or not JSON: the peer still gets STUN, not nothing.
    console.warn("overlay: TURN credentials not minted (no answer); STUN only");
    return stun;
  }
}

/** One session. The class name is what wrangler.jsonc's `durable_objects` and `migrations` refer to. */
export class OverlayRoom {
  private core: CoordinatorCore | null = null;
  private room: string | null = null;
  private readonly sockets = new Map<ConnId, WebSocketLike>();
  private readonly serial = createSerial();
  private alarmAt: number | null = null;

  constructor(
    readonly state: DurableObjectStateLike,
    readonly env: CoordinatorEnv,
    private readonly options: OverlayRoomOptions = {},
  ) {}

  /** The core, rebuilt from storage and the sockets' attachments if this object has just woken. */
  private async ready(room: string | null): Promise<CoordinatorCore> {
    if (this.core) return this.core;
    if (this.room === null) this.room = room ?? ((await this.state.storage.get(ROOM_KEY)) as string | undefined) ?? null;
    if (this.room === null) throw new Error("overlay room: no session name");
    if (room !== null) await this.state.storage.put(ROOM_KEY, room);
    const core = createCore({
      room: this.room,
      admissionSecret: this.env.OVERLAY_ADMISSION_SECRET ?? "",
      serverSecret: this.env.OVERLAY_SERVER_SECRET ?? "",
      params: params(this.env),
      viewerCap: this.options.viewerCap ?? (Number(this.env.OVERLAY_VIEWER_CAP) > 0 ? Number(this.env.OVERLAY_VIEWER_CAP) : 10_000),
      iceServers: () => iceServers(this.env, this.options.stun, this.options.testTurn),
      // [D80] Fresh credentials at half their life, when there is TURN at all.
      iceRefreshMs: this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN ? (TURN_TTL_S * 1000) / 2 : this.options.testTurn ? (this.options.testTurn.ttlS * 1000) / 2 : undefined,
      random: Math.random,
    });
    const stored: Record<string, string> = {};
    for (const [key, value] of await this.state.storage.list({ prefix: CORE_PREFIX })) if (typeof value === "string") stored[key.slice(CORE_PREFIX.length)] = value;
    const conns: { conn: ConnId; attachment: string }[] = [];
    this.sockets.clear();
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment?.id) continue;
      this.sockets.set(attachment.id, socket);
      // A socket that never got as far as the core's own attachment is one it never accepted.
      conns.push({ conn: attachment.id, attachment: attachment.core ?? "" });
    }
    this.core = core;
    this.alarmAt = null;
    await this.apply(await core.restore(stored, conns, Date.now()));
    return core;
  }

  /** Carries the effects out, in order. */
  private async apply(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.type) {
        case "send":
          try {
            this.sockets.get(effect.conn)?.send(encodeServerMessage(effect.message));
          } catch {
            // The socket is going: its close event is on the way.
          }
          break;
        case "close": {
          const socket = this.sockets.get(effect.conn);
          this.sockets.delete(effect.conn);
          try {
            socket?.close(effect.code, effect.reason.slice(0, 120));
          } catch {
            // Already closed.
          }
          break;
        }
        case "wake":
          if (this.alarmAt !== effect.at) {
            this.alarmAt = effect.at;
            await this.state.storage.setAlarm(effect.at);
          }
          break;
        case "persist":
          if (effect.value === null) await this.state.storage.delete(CORE_PREFIX + effect.key);
          else await this.state.storage.put(CORE_PREFIX + effect.key, effect.value);
          break;
        case "attach": {
          const socket = this.sockets.get(effect.conn);
          if (socket) socket.serializeAttachment({ id: effect.conn, core: effect.value } satisfies SocketAttachment);
          break;
        }
      }
    }
  }

  /** One call on the core at a time, in the order things happened, its effects carried out before the next. */
  private run<T>(room: string | null, call: (core: CoordinatorCore, now: number) => Promise<{ effects: Effect[]; result: T }>): Promise<T> {
    const now = Date.now();
    return this.serial(async () => {
      const core = await this.ready(room);
      const { effects, result } = await call(core, now);
      await this.apply(effects);
      return result;
    });
  }

  private connOf(socket: WebSocketLike): ConnId | null {
    try {
      return (socket.deserializeAttachment() as SocketAttachment | null)?.id ?? null;
    } catch {
      return null;
    }
  }

  /** HTTP requests and WebSocket upgrades for this session. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = parseRoomPath(url.pathname);
    if (!route) return json(404, { error: "not found" });
    const room = request.headers.get(ROOM_HEADER) ?? route.room;

    if (route.rest === "/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "upgrade required" });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      const conn: ConnId = crypto.randomUUID();
      const region = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? url.searchParams.get("region") ?? undefined;
      await this.run(room, async (core, now) => {
        const effects = await core.open(conn, url.searchParams.get("ticket") ?? "", region ? { region } : {}, now);
        const refused = effects.find((effect): effect is Extract<Effect, { type: "close" }> => effect.type === "close" && effect.conn === conn);
        if (refused) {
          // Refused at the door: an ordinary socket, closed with the reason, never hibernated.
          server.accept();
          server.close(refused.code, refused.reason.slice(0, 120));
          return { effects: effects.filter((effect) => effect !== refused), result: null };
        }
        // Accepted only now that the core is up and has said yes: a core waking from
        // hibernation must not find, among the sockets it is given back, one it never admitted.
        this.state.acceptWebSocket(server);
        server.serializeAttachment({ id: conn } satisfies SocketAttachment);
        this.sockets.set(conn, server);
        return { effects, result: null };
      });
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }

    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
    if (route.rest === "/evict" && this.env.OVERLAY_TEST_HOOKS === "1" && request.method === "POST" && bearer === this.env.OVERLAY_SERVER_SECRET) {
      // What an eviction leaves: storage and the sockets with their attachments. Nothing else.
      await this.serial(async () => {
        this.core = null;
        this.sockets.clear();
        this.alarmAt = null;
      });
      return json(200, { evicted: true });
    }

    if (request.method !== "GET" && request.method !== "POST") return json(405, { error: "method not allowed" });
    let body: unknown = null;
    if (request.method === "POST") {
      const text = await request.text();
      try {
        body = text && text.length <= 64 * 1024 ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
    }
    const core: CoreRequest = { method: request.method, path: route.rest, bearer, body };
    const response = await this.run(room, async (c, now) => {
      const answer = await c.http(core, now);
      return { effects: answer.effects, result: answer.response };
    });
    return json(response.status, response.body);
  }

  async webSocketMessage(socket: WebSocketLike, message: string | ArrayBuffer): Promise<void> {
    const conn = this.connOf(socket);
    if (conn === null) return;
    await this.run(null, async (core, now) => {
      if (!this.sockets.has(conn)) this.sockets.set(conn, socket);
      return { effects: await core.message(conn, typeof message === "string" ? message : "", now), result: null };
    });
  }

  async webSocketClose(socket: WebSocketLike, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const conn = this.connOf(socket);
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
    if (conn === null) return;
    await this.run(null, async (core, now) => {
      this.sockets.delete(conn);
      return { effects: await core.closed(conn, now), result: null };
    });
  }

  async webSocketError(socket: WebSocketLike, _error: unknown): Promise<void> {
    const conn = this.connOf(socket);
    if (conn === null) return;
    await this.run(null, async (core, now) => {
      this.sockets.delete(conn);
      return { effects: await core.closed(conn, now), result: null };
    });
  }

  /** The core's `wake` effect arrives here. */
  async alarm(): Promise<void> {
    await this.run(null, async (core, now) => {
      this.alarmAt = null;
      return { effects: await core.tick(now), result: null };
    });
  }
}

/** The Worker: finds the session in the path and hands the request to its Durable Object. */
const worker = {
  async fetch(request: Request, env: CoordinatorEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === HEALTH_PATH) return json(200, { ok: true });
    const route = parseRoomPath(url.pathname);
    if (!route) return json(404, { error: "not found" });
    const headers = new Headers(request.headers);
    headers.set(ROOM_HEADER, route.room);
    const stub = env.OVERLAY_ROOM.get(env.OVERLAY_ROOM.idFromName(route.room));
    return stub.fetch(new Request(request, { headers }));
  },
};

export default worker;
