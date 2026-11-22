/**
 * The coordinator as a Node process: `CoordinatorCore` behind an HTTP server and `ws`. For unit
 * tests and the swarm harness, not for production. It must serve exactly the paths and messages
 * the Durable Object does (./durableObject.ts); a contract test runs one suite against both
 * (PLAN.md, E-coordinator K3).
 *
 * Everything here is plumbing: a request or a socket event becomes one call on the core, and the
 * effects that come back are carried out in order. This is the edge of the package, so it is
 * the one place that reads the wall clock (`Date.now`) and sets real timers.
 *
 * Owner: E-coordinator.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { DEFAULT_PARAMS, encodeServerMessage } from "../protocol";
import { createCore } from "./core";
import { ROOM_PATH, createSerial, parseRoomPath } from "./routing";
import type { ConnId, CoordinatorCore, Effect, NodeCoordinator, NodeCoordinatorOptions } from "./types";

type Room = {
  core: CoordinatorCore;
  /** Runs one call on the core at a time, in the order things happened. */
  serial: <T>(task: () => Promise<T>) => Promise<T>;
  sockets: Map<ConnId, WebSocket>;
  timer: ReturnType<typeof setTimeout> | null;
  store: Map<string, string>;
};

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

export const startNodeCoordinator = async (options: NodeCoordinatorOptions): Promise<NodeCoordinator> => {
  const params = { ...DEFAULT_PARAMS, ...options.params };
  const random = options.seed !== undefined ? seeded(options.seed) : Math.random;
  const storage = options.storage ?? new Map<string, Map<string, string>>();
  const rooms = new Map<string, Room>();
  let nextConn = 1;
  let dead = false;

  const apply = (room: Room, effects: Effect[]): void => {
    for (const effect of effects) {
      switch (effect.type) {
        case "send":
          room.sockets.get(effect.conn)?.send(encodeServerMessage(effect.message));
          break;
        case "close": {
          const socket = room.sockets.get(effect.conn);
          room.sockets.delete(effect.conn);
          socket?.close(effect.code, effect.reason.slice(0, 120));
          break;
        }
        case "wake":
          if (room.timer) clearTimeout(room.timer);
          room.timer = setTimeout(
            () => {
              room.timer = null;
              if (!dead) void room.serial(async () => apply(room, await room.core.tick(Date.now())));
            },
            Math.max(0, effect.at - Date.now()),
          );
          break;
        case "persist":
          if (effect.value === null) room.store.delete(effect.key);
          else room.store.set(effect.key, effect.value);
          break;
        case "attach":
          // A Durable Object keeps this with the socket across hibernation. A process has no such thing to survive.
          break;
      }
    }
  };

  const roomFor = (name: string): Room => {
    let room = rooms.get(name);
    if (room) return room;
    let store = storage.get(name);
    if (!store) storage.set(name, (store = new Map()));
    const core = createCore({
      room: name,
      admissionSecret: options.admissionSecret,
      serverSecret: options.serverSecret,
      params,
      viewerCap: options.viewerCap ?? 10_000,
      iceServers: async () => options.iceServers ?? [],
      random,
      logger: options.logger,
      metricsKeep: options.metricsKeep ?? 100_000,
    });
    room = { core, serial: createSerial(), sockets: new Map(), timer: null, store };
    rooms.set(name, room);
    const made = room;
    void made.serial(async () => apply(made, await core.restore(Object.fromEntries(made.store), [], Date.now())));
    return room;
  };

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    response.end(JSON.stringify(body));
  };

  const readBody = (request: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        if (text.length < 64 * 1024) text += chunk;
      });
      request.on("end", () => {
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          resolve(null);
        }
      });
      request.on("error", () => resolve(null));
    });

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://coordinator");
      if (url.pathname === "/overlay/v1/health") return json(response, 200, { ok: true });
      const route = parseRoomPath(url.pathname);
      if (!route || route.rest === "/ws") return json(response, route ? 426 : 404, { error: route ? "upgrade required" : "not found" });
      if (request.method !== "GET" && request.method !== "POST") return json(response, 405, { error: "method not allowed" });
      const method = request.method;
      const body = method === "POST" ? await readBody(request) : null;
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null;
      const room = roomFor(route.room);
      const result = await room.serial(async () => {
        const answer = await room.core.http({ method, path: route.rest, bearer, body }, Date.now());
        apply(room, answer.effects);
        return answer.response;
      });
      json(response, result.status, result.body);
    })().catch((error: unknown) => {
      options.logger?.error("coordinator", "request failed", error);
      if (!response.headersSent) json(response, 500, { error: "internal" });
    });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://coordinator");
    const route = parseRoomPath(url.pathname);
    if (!route || route.rest !== "/ws" || dead) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const room = roomFor(route.room);
      const conn: ConnId = `c${nextConn++}`;
      room.sockets.set(conn, ws);
      const call = (run: (now: number) => Promise<Effect[]>) => {
        if (dead) return;
        // The time is taken when the event happens, not when its turn comes.
        const now = Date.now();
        void room.serial(async () => apply(room, await run(now))).catch((error: unknown) => options.logger?.error("coordinator", "core failed", error));
      };
      const region = url.searchParams.get("region") ?? undefined;
      call((now) => room.core.open(conn, url.searchParams.get("ticket") ?? "", region ? { region } : {}, now));
      ws.on("message", (data, isBinary) => call((now) => room.core.message(conn, isBinary ? "" : data.toString(), now)));
      ws.on("close", () => {
        room.sockets.delete(conn);
        call((now) => room.core.closed(conn, now));
      });
      ws.on("error", () => {});
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  const stop = async (graceful: boolean) => {
    dead = true;
    for (const room of rooms.values()) {
      if (room.timer) clearTimeout(room.timer);
      for (const socket of room.sockets.values()) {
        if (graceful) socket.close(1001, "coordinator stopping");
        else socket.terminate();
      }
      room.sockets.clear();
    }
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    port,
    room: (name) => rooms.get(name)?.core,
    kill: () => stop(false),
    close: () => stop(true),
  };
};

export { ROOM_PATH };
