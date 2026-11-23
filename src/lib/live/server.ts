import { getCloudflareContext } from "@opennextjs/cloudflare";
import { PROTOCOL_VERSION, signTicket } from "@meetly/overlay/protocol";
import { mintTurn } from "@meetly/overlay/coordinator/turn";
import type { RoomSnapshot } from "@meetly/overlay/coordinator/types";
import { isValidCode } from "@/lib/code";
import { LIVE_VIEWER_CAP, anonymize, type LiveTree } from "./tree";

/**
 * Live (beta) on the server: the share id, the host's key, tickets for the coordinator, and the
 * two calls Meetly makes on it (the tree, the end).
 *
 * The coordinator is the overlay's Durable Object, `OverlayRoom`, bound in the app's own Worker
 * as OVERLAY_ROOM (wrangler.jsonc; custom-worker.ts sends it the WebSocket upgrades). Two
 * secrets are shared with it, and Live is off until both are set:
 * - OVERLAY_ADMISSION_SECRET signs tickets (the coordinator checks them) and the host's key;
 * - OVERLAY_SERVER_SECRET lets this server read the tree and end a stream.
 *
 * The host: "Go live" makes the id and hands the browser that pressed it a key, an HMAC of the
 * id. Only that key gets a source ticket or ends the stream. Nothing is stored.
 */

export class LiveUnavailable extends Error {}

/** How long a TURN check's answer is kept: a working key for five minutes, a failing one for thirty seconds. */
const TURN_CHECK_OK_MS = 5 * 60_000;
const TURN_CHECK_FAILED_MS = 30_000;
let turnCheck: { key: string; at: number; ok: boolean } | null = null;

/**
 * Whether TURN works on this deployment (SPEC §6.7, §8.1 [D82]), so that a viewer on a strict
 * network can watch through a relay: a mint from the Cloudflare TURN key returned TURN servers
 * (the same mint the coordinator makes, with a one-minute life, never shown to anyone). Kept a
 * while (see above). Without a key, false and no request. A local run's test TURN server
 * (custom-worker.ts) counts as working. Why a mint failed is logged, never the key.
 */
export async function liveTurn(fetcher: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  const env = process.env;
  if (env.OVERLAY_LOCAL_ONE_NETWORK === "1" && env.OVERLAY_TEST_TURN_URL && env.OVERLAY_TEST_TURN_SECRET) return true;
  const key = env.TURN_KEY_ID?.trim() ?? "";
  if (!key || !env.TURN_KEY_API_TOKEN?.trim()) return false;
  if (turnCheck && turnCheck.key === key && now - turnCheck.at < (turnCheck.ok ? TURN_CHECK_OK_MS : TURN_CHECK_FAILED_MS)) return turnCheck.ok;
  const minted = await mintTurn(key, env.TURN_KEY_API_TOKEN, 60, fetcher);
  if (minted.problem) console.warn(`live: TURN credentials not minted (${minted.problem})`);
  turnCheck = { key, at: now, ok: minted.servers.length > 0 };
  return turnCheck.ok;
}

type LiveEnv = {
  OVERLAY_ROOM?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
};

function secrets(): { admission: string; server: string } {
  const admission = process.env.OVERLAY_ADMISSION_SECRET ?? "";
  const server = process.env.OVERLAY_SERVER_SECRET ?? "";
  if (admission.length < 16 || server.length < 16) throw new LiveUnavailable("Live isn't set up on this server yet.");
  return { admission, server };
}

const utf8 = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function randomText(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet[byte % alphabet.length]).join("");
}

export const isLiveId = isValidCode;

/** The host's key for a stream: HMAC-SHA-256 of its id under the admission secret, in its own domain. */
export async function hostKey(id: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8.encode(`meetly-live-host:${secrets().admission}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(id))));
}

/** `presented` is `expected`, compared in constant time (for its length), after a cheap shape check. */
function matches(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string" || presented.length === 0 || presented.length > 128) return false;
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

export async function isHostKey(id: string, presented: unknown): Promise<boolean> {
  if (typeof presented !== "string" || presented.length === 0 || presented.length > 128) return false;
  return matches(await hostKey(id), presented);
}

/**
 * The viewers' pass for a stream: what a viewer's browser shows to get a ticket, so that knowing
 * the id alone (it is in the link's path, on the host's screen, in logs) does not let anyone take
 * a viewer's place or join the tree and learn viewers' addresses. It travels in the link's
 * fragment with the media key (`&a=…`, src/lib/live/e2ee.ts), so it is no wider than the key; the
 * server sees it only in the ticket request's body, and it is not the key. HMAC-SHA-256 of the id
 * under the admission secret in its own domain, cut to 128 bits.
 */
export async function viewerPass(id: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8.encode(`meetly-live-viewer:${secrets().admission}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(id))).slice(0, 16));
}

export async function isViewerPass(id: string, presented: unknown): Promise<boolean> {
  if (typeof presented !== "string" || presented.length === 0 || presented.length > 128) return false;
  return matches(await viewerPass(id), presented);
}

/** The most a Live request's JSON body may be: they carry a title, a key or a pass, and a role. */
export const BODY_MAX = 4096;

export class BodyTooLarge extends Error {}

/**
 * A request's JSON body, read no further than `max` bytes: a larger one is refused (BodyTooLarge)
 * by its Content-Length when it says, or as soon as that many bytes have come. Malformed JSON, or
 * JSON that is not an object, is a SyntaxError.
 */
export async function readJsonBody(request: Request, max = BODY_MAX): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new SyntaxError("not an object");
  return body as Record<string, unknown>;
}

/** The answer for a body readJsonBody refused: 413 when too large, 400 otherwise. */
export function badBody(error: unknown): Response {
  return error instanceof BodyTooLarge ? json(413, { error: "Request too large." }) : json(400, { error: "Bad request." });
}

const VIEWER_IDENTITY = /^v-[A-Za-z0-9]{16}$/;

/**
 * A ticket for the coordinator, good for a minute and for one connection. A viewer keeps the
 * identity it was given the first time, so reconnecting is not counted as a second viewer.
 */
export async function liveTicket(id: string, role: "source" | "viewer", identity?: unknown): Promise<{ ticket: string; identity: string }> {
  const who = role === "source" ? "host" : typeof identity === "string" && VIEWER_IDENTITY.test(identity) ? identity : `v-${randomText(16)}`;
  const ticket = await signTicket(
    { v: PROTOCOL_VERSION, room: id, identity: who, name: role === "source" ? "Host" : "Viewer", role, exp: Math.floor(Date.now() / 1000) + 60, nonce: randomText(16) },
    secrets().admission,
  );
  return { ticket, identity: who };
}

/** One HTTP call on the stream's coordinator, with the server secret. */
async function coordinator(id: string, path: "/tree" | "/end", init: { method: "GET" | "POST"; body?: unknown }): Promise<Response> {
  const { server } = secrets();
  let env: LiveEnv;
  try {
    env = getCloudflareContext().env as LiveEnv;
  } catch {
    throw new LiveUnavailable("Live needs the Workers runtime (npm run preview).");
  }
  const rooms = env.OVERLAY_ROOM;
  if (!rooms) throw new LiveUnavailable("Live isn't set up on this server yet.");
  const stub = rooms.get(rooms.idFromName(id));
  return stub.fetch(
    new Request(`https://overlay.internal/overlay/v1/rooms/${encodeURIComponent(id)}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${server}`, "content-type": "application/json", "x-overlay-room": id },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

export async function liveTree(id: string): Promise<LiveTree> {
  const response = await coordinator(id, "/tree", { method: "GET" });
  if (!response.ok) throw new Error(`coordinator /tree: ${response.status}`);
  return anonymize((await response.json()) as RoomSnapshot, LIVE_VIEWER_CAP);
}

export async function endLive(id: string): Promise<void> {
  const response = await coordinator(id, "/end", { method: "POST", body: { reason: "ended" } });
  if (!response.ok) throw new Error(`coordinator /end: ${response.status}`);
}

export const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The answer for a request Live cannot serve: 503 when it is not set up, 500 otherwise. */
export function failure(error: unknown): Response {
  if (error instanceof LiveUnavailable) return json(503, { error: error.message });
  console.error("live:", error);
  return json(500, { error: "Something went wrong. Try again." });
}
