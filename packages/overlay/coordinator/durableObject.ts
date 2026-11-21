/**
 * The coordinator in production: one Durable Object per session, running `CoordinatorCore`
 * behind hibernatable WebSockets, and the Worker that routes a request to its session's object.
 * Deployed as its own Worker, apart from the Next.js app (SPEC §6.7): the app's Worker is not
 * touched, and neither is the cloudflare-deploy branch, until the integration step.
 *
 * The Workers runtime's types are declared here, as far as this file uses them, instead of
 * depending on @cloudflare/workers-types: that package's globals clash with the DOM's, which
 * the rest of the repository is checked against.
 *
 * Owner: E-coordinator.
 */
import { notImplemented } from "../runtime";

/** What this file uses of a Durable Object's state. */
export interface DurableObjectStateLike {
  readonly id: { toString(): string; readonly name?: string };
  readonly storage: {
    get(keys: string[]): Promise<Map<string, string>>;
    list(options?: { prefix?: string }): Promise<Map<string, string>>;
    put(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  acceptWebSocket(socket: WebSocketLike, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocketLike[];
  waitUntil(promise: Promise<unknown>): void;
}

/** What this file uses of a server-side WebSocket in a Worker. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The Worker's bindings: wrangler.jsonc names them. */
export type CoordinatorEnv = {
  /** The Durable Object namespace of `OverlayRoom`. */
  OVERLAY_ROOM: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  /** Secret: shared with Meetly's server, verifies tickets. */
  OVERLAY_ADMISSION_SECRET: string;
  /** Secret: Meetly's server shows it to use the HTTP API. */
  OVERLAY_SERVER_SECRET: string;
  /** Optional: a Cloudflare TURN key, to mint credentials for peers that need a relay. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Optional override of the audience limit. */
  OVERLAY_VIEWER_CAP?: string;
};

/** One session. The class name is what wrangler.jsonc's `durable_objects` and `migrations` refer to. */
export class OverlayRoom {
  constructor(
    readonly state: DurableObjectStateLike,
    readonly env: CoordinatorEnv,
  ) {}

  /** HTTP requests and WebSocket upgrades for this session. */
  fetch(_request: Request): Promise<Response> {
    return notImplemented("E-coordinator", "OverlayRoom.fetch");
  }

  webSocketMessage(_socket: WebSocketLike, _message: string | ArrayBuffer): Promise<void> {
    return notImplemented("E-coordinator", "OverlayRoom.webSocketMessage");
  }

  webSocketClose(_socket: WebSocketLike, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    return notImplemented("E-coordinator", "OverlayRoom.webSocketClose");
  }

  webSocketError(_socket: WebSocketLike, _error: unknown): Promise<void> {
    return notImplemented("E-coordinator", "OverlayRoom.webSocketError");
  }

  /** The core's `wake` effect arrives here. */
  alarm(): Promise<void> {
    return notImplemented("E-coordinator", "OverlayRoom.alarm");
  }
}

/** The Worker: finds the session in the path and hands the request to its Durable Object. */
const worker = {
  fetch(_request: Request, _env: CoordinatorEnv): Promise<Response> {
    return notImplemented("E-coordinator", "coordinator worker fetch");
  },
};

export default worker;
