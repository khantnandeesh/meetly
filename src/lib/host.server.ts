import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AccessToken, DataPacket_Kind, RoomServiceClient, TrackSource, type ParticipantInfo } from "livekit-server-sdk";
import { verifyChat } from "./chatSignature.server";
import type { Pass } from "./pass.server";
import {
  DENIED,
  GONE,
  HOST_ONLY,
  NOT_THE_HOST,
  OWN_CONTROLS,
  isHostOnly,
  type HostActionResult,
} from "./rtc/hostAction";
import { closeStoredPoll } from "./pollStore";
import { ADMIT_TOPIC, readStoredPolls, type StoredPoll } from "./rtc/shared";
import type { CallMode, HostAction, JoinAccess, MeetingPeek } from "./rtc/types";

/**
 * The meeting's record and its rules on LiveKit, enforced here on the server.
 *
 * Everything the server needs to remember about a meeting is the LiveKit room's metadata, which
 * only the API secret can write: who the host is, the id of the host key, the co-hosts, who may
 * join, and who was removed. There is no other storage.
 *
 * Host:
 * - "New meeting" creates the room before anyone joins and gives the creating browser the host
 *   key (a signed cookie, see ./pass.server.ts). Whoever joins with that key is host, every time:
 *   after a reload, after leaving and coming back, after the call was ended for everyone.
 * - A code somebody typed by hand has no record yet. The first person into it becomes host and
 *   gets the key then.
 * - Nobody else can become host, whatever order people arrive in and whoever leaves. A meeting
 *   whose host is away has no host until that browser comes back.
 * - A host action is authorised by the caller presenting the LiveKit token we signed for them;
 *   its identity is compared with the record. Nothing a browser can write counts: not its own
 *   metadata or attributes, not the request body.
 *
 * Known limits:
 * - The record lives as long as the room: a day after the last person leaves. After that the
 *   code is new again, and the first person in is its host.
 * - The record is read, changed and written back. Two changes at the same instant from two
 *   server instances can lose one of them; within one instance they are queued.
 * - Rooms that were not made here (no host key in the record) follow the older rule: the first
 *   person into an empty room becomes host once any earlier claim is over a minute old.
 */
export type RoomMeta = {
  host?: string;
  claimedAt?: number;
  /** Id of the host key. Public: what proves the host is our signature on the cookie that holds it. */
  kid?: string;
  cohosts?: string[];
  access?: JoinAccess;
  /** Identities the host removed. A browser that held one of them is not let back in. */
  banned?: string[];
  /**
   * The pinned chat message, whole: there is nowhere else to keep it, and someone who joins
   * later has to be able to read it. Only ever a message this server signed (see ./chat.server.ts).
   */
  pin?: { id: string; identity: string; name: string; ts: number; text: string };
  /** Polls and their votes (see ./polls.server.ts). */
  polls?: StoredPoll[];
  /** Set when "New webinar" made the record. It never changes for the life of the record (see ./webinar.server.ts). */
  mode?: "webinar";
  /**
   * The host or a co-host turned reactions off. Absent means they are allowed, which is how every
   * meeting starts. Each browser keeps to it; nothing here can stop a modified client sending one.
   */
  reactions?: false;
  /**
   * When the meeting now under way began: the moment our server let the first person into an
   * empty room (see `meetingAge`). The room itself is no guide: it is made before anyone joins
   * ("New meeting"), and kept for a day after the last person leaves.
   */
  startedAt?: number;
};

/** How many people Admit all and Deny all answer at the same moment: quick for a long list, gentle on LiveKit. */
const BULK_AT_ONCE = 8;

/** A host token minted for a room without a host key gets this long to connect. */
const CLAIM_WINDOW_MS = 60_000;
/** How long an empty room, and with it the meeting's record, is kept. Seconds. */
const KEEP_EMPTY_S = 24 * 60 * 60;
/**
 * Up to this many people in a room by LiveKit's own summary (which can trail a join or a leave by a
 * few seconds), who is there is listed live. Above it the meeting is plainly under way, and listing
 * everyone at every join would cost a webinar dearly.
 */
const LIVE_LIST_UP_TO = 10;
/** How long after it was issued a join token still proves who is calling /api/host. */
const CALLER_TOKEN_MS = 12 * 60 * 60 * 1000;
const MAX_BANNED = 200;
const MAX_COHOSTS = 25;

function config() {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !serverUrl) return null;
  return { apiKey, apiSecret, httpUrl: serverUrl.replace(/^ws/, "http") };
}

export function roomService(): RoomServiceClient | null {
  const c = config();
  return c ? new RoomServiceClient(c.httpUrl, c.apiKey, c.apiSecret) : null;
}

/** What signs the browser's pass on LiveKit builds. */
export function liveKitPassSecret(): string {
  return process.env.LIVEKIT_API_SECRET ?? "";
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function parseRoomMeta(metadata: string | undefined): RoomMeta {
  try {
    const value = JSON.parse(metadata || "{}");
    if (typeof value !== "object" || value === null) return {};
    return {
      host: typeof value.host === "string" ? value.host : undefined,
      claimedAt: typeof value.claimedAt === "number" ? value.claimedAt : undefined,
      kid: typeof value.kid === "string" ? value.kid : undefined,
      cohosts: strings(value.cohosts),
      access: value.access === "ask" || value.access === "locked" ? value.access : "open",
      banned: strings(value.banned),
      ...(typeof value.pin === "object" && value.pin !== null && typeof value.pin.id === "string" && typeof value.pin.text === "string"
        ? {
            pin: {
              id: value.pin.id,
              identity: String(value.pin.identity ?? ""),
              name: String(value.pin.name ?? ""),
              ts: Number(value.pin.ts) || 0,
              text: value.pin.text,
            },
          }
        : {}),
      ...(Array.isArray(value.polls) && value.polls.length > 0 ? { polls: readStoredPolls(value.polls) } : {}),
      ...(value.mode === "webinar" ? { mode: "webinar" as const } : {}),
      ...(value.reactions === false ? { reactions: false as const } : {}),
      ...(typeof value.startedAt === "number" && Number.isFinite(value.startedAt) ? { startedAt: value.startedAt } : {}),
    };
  } catch {
    return {};
  }
}

/** One change to a room's record at a time (within this server instance). */
const queues = new Map<string, Promise<unknown>>();
function exclusive<T>(room: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(room) ?? Promise.resolve()).then(work, work);
  const settled = run.catch(() => {});
  queues.set(room, settled);
  void settled.then(() => {
    if (queues.get(room) === settled) queues.delete(room);
  });
  return run;
}

function createRoom(service: RoomServiceClient, room: string, meta: RoomMeta) {
  return service.createRoom({
    name: room,
    metadata: JSON.stringify(meta),
    emptyTimeout: KEEP_EMPTY_S,
    departureTimeout: KEEP_EMPTY_S,
  });
}

/**
 * Reads the record, applies `change`, writes it back. Returns the new record, or null if the room
 * is gone. A `change` that hands back the very record it was given writes nothing.
 */
export function updateMeta(service: RoomServiceClient, room: string, change: (meta: RoomMeta) => RoomMeta): Promise<RoomMeta | null> {
  return exclusive(room, async () => {
    const [existing] = await service.listRooms([room]);
    if (!existing) return null;
    const current = parseRoomMeta(existing.metadata);
    const next = change(current);
    if (next !== current) await service.updateRoomMetadata(room, JSON.stringify(next));
    return next;
  });
}

/* ------------------------------------------------------------------ joining */

/**
 * Makes the record for a brand-new meeting and returns its host key id, for the browser that
 * asked. Null if the code is already in use or LiveKit could not be reached: the meeting still
 * works, by the first-person-in rule.
 */
export async function createMeetingRecord(room: string, mode: CallMode = "meeting"): Promise<string | null> {
  const service = roomService();
  if (!service) return null;
  try {
    return await exclusive(room, async () => {
      const [existing] = await service.listRooms([room]);
      if (existing) return null;
      const kid = randomUUID();
      await createRoom(service, room, { kid, access: "open", ...(mode === "webinar" ? { mode } : {}) });
      return kid;
    });
  } catch (error) {
    console.error("Could not create the meeting record", error);
    return null;
  }
}

export type JoinDecision = {
  role: "host" | "guest";
  /** Set when this join made the browser host: the key id to keep in its pass. */
  key?: string;
  access: JoinAccess;
  /** The browser is not let in at all. */
  refused?: "removed" | "locked";
  /** The record says this is a webinar. */
  mode?: "webinar";
};

/**
 * Decides how `identity` joins: as host, as a guest, as a guest who has to ask first
 * (`access: "ask"`), or not at all. Never throws: when LiveKit cannot be asked, a guest.
 */
export async function decideJoin(room: string, identity: string, pass: Pass): Promise<JoinDecision> {
  const service = roomService();
  if (!service) return { role: "guest", access: "open" };
  try {
    return await exclusive(room, async (): Promise<JoinDecision> => {
      const now = Date.now();
      const [existing] = await service.listRooms([room]);
      if (!existing) {
        const kid = randomUUID();
        await createRoom(service, room, { host: identity, claimedAt: now, kid, access: "open" });
        return { role: "host", key: kid, access: "open" };
      }
      const meta = parseRoomMeta(existing.metadata);
      const access = meta.access ?? "open";
      const mode = meta.mode ? { mode: meta.mode } : {};
      const claim = (kid: string): Promise<unknown> =>
        service.updateRoomMetadata(room, JSON.stringify({ ...meta, host: identity, claimedAt: now, kid } satisfies RoomMeta));
      if (meta.kid) {
        if (pass.key === meta.kid) {
          await claim(meta.kid);
          return { role: "host", access, ...mode };
        }
      } else if (now - (meta.claimedAt ?? 0) >= CLAIM_WINDOW_MS) {
        // A room from before host keys, or one something else created. Hand it to the first
        // person into it, but only if it is genuinely empty (a live count: the summary lags).
        const present = await service.listParticipants(room);
        if (present.length === 0) {
          const kid = randomUUID();
          await claim(kid);
          return { role: "host", key: kid, access };
        }
      }
      if (meta.banned?.some((id) => pass.ids.includes(id))) return { role: "guest", access, refused: "removed" };
      if (access === "locked") return { role: "guest", access, refused: "locked" };
      return { role: "guest", access, ...mode };
    });
  } catch (error) {
    console.error("Could not read the meeting record", error);
    return { role: "guest", access: "open" };
  }
}

/**
 * How long ago the meeting under way began, from the record, or undefined if it has none. Someone
 * still in the room who arrived before the recorded moment means two people were let into an
 * empty room at once; the meeting began with the earlier of them. Exported for tests.
 */
export function sessionAge(recorded: number | undefined, earliest: number | null, now: number): number | undefined {
  if (recorded === undefined) return undefined;
  const began = earliest !== null && earliest < recorded ? earliest : recorded;
  return Math.max(0, now - began);
}

/**
 * How many milliseconds ago the meeting began, for its timer, or undefined if that cannot be known.
 * Asked once per join, by /api/token, after everything else has let this person in.
 *
 * Whoever is let into an empty room begins the meeting, and the moment is written into the record;
 * everyone after them is told the time since. `enters` is false for someone who waits in the lobby
 * (another room): they begin nothing, and in an empty meeting there is nothing to tell them.
 * Never throws: the timer then counts from when this person joined, and says so.
 */
export async function meetingAge(room: string, enters: boolean): Promise<number | undefined> {
  const service = roomService();
  if (!service) return undefined;
  try {
    return await exclusive(room, async () => {
      const now = Date.now();
      const [existing] = await service.listRooms([room]);
      if (!existing) return undefined;
      const meta = parseRoomMeta(existing.metadata);
      let count = existing.numParticipants;
      let earliest: number | null = null;
      if (count <= LIVE_LIST_UP_TO) {
        const present = await service.listParticipants(room);
        count = present.length;
        const joined = present.map((p) => Number(p.joinedAtMs) || Number(p.joinedAt) * 1000).filter((t) => t > 0);
        earliest = joined.length > 0 ? Math.min(...joined) : null;
      }
      if (count > 0) return sessionAge(meta.startedAt, earliest, now);
      if (!enters) return undefined;
      await service.updateRoomMetadata(room, JSON.stringify({ ...meta, startedAt: now } satisfies RoomMeta));
      return 0;
    });
  } catch (error) {
    console.error("Could not read when the meeting began", error);
    return undefined;
  }
}

/** What the pre-join screen may know before asking to join. */
export async function peekMeeting(room: string, pass: Pass): Promise<MeetingPeek> {
  const service = roomService();
  if (!service) return { access: "open", host: false, count: null };
  try {
    const [existing] = await service.listRooms([room]);
    if (!existing) return { access: "open", host: false, count: 0 };
    const meta = parseRoomMeta(existing.metadata);
    // The count comes with the room at no extra cost. It is LiveKit's own, and can trail a join
    // or a leave by a moment. People waiting in the lobby are in another room and not counted.
    return {
      access: meta.access ?? "open",
      host: !!meta.kid && pass.key === meta.kid,
      count: existing.numParticipants,
      ...(meta.mode ? { mode: meta.mode } : {}),
    };
  } catch {
    return { access: "open", host: false, count: null };
  }
}

/* ------------------------------------------------------------ who is asking */

export type Caller = { room: string; identity: string; role: "host" | "cohost" | "guest"; meta: RoomMeta };

/**
 * The room and identity inside a LiveKit token that we signed, or null. Expiry is not what is
 * checked here: join tokens are short-lived so that a removed person's token is soon useless
 * for connecting, while the same token keeps proving who is calling for the length of a call.
 */
export function readCallerToken(
  token: string,
  apiKey: string,
  apiSecret: string,
  now: number = Date.now(),
): { room: string; identity: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header?.alg !== "HS256") return null;
    const expected = createHmac("sha256", apiSecret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const issuedAt = typeof claims.nbf === "number" ? claims.nbf : typeof claims.iat === "number" ? claims.iat : null;
    if (claims.iss !== apiKey || issuedAt === null || issuedAt * 1000 > now + 60_000) return null;
    if (now - issuedAt * 1000 > CALLER_TOKEN_MS) return null;
    const room = claims.video?.room;
    const identity = claims.sub;
    if (typeof room !== "string" || !room || typeof identity !== "string" || !identity) return null;
    return { room, identity };
  } catch {
    return null;
  }
}

/**
 * Who is calling, for something any participant may do (chat): the token says who they are, and
 * the room confirms they are in it right now, under which name. Null otherwise.
 */
export async function liveKitCaller(token: string): Promise<{ room: string; identity: string; name: string; canPublish: boolean } | null> {
  const c = config();
  const service = roomService();
  if (!c || !service) return null;
  const who = readCallerToken(token, c.apiKey, c.apiSecret);
  if (!who) return null;
  try {
    const person = await service.getParticipant(who.room, who.identity);
    return { ...who, name: person.name, canPublish: !!person.permission?.canPublish };
  } catch {
    return null;
  }
}

/** Takes the pinned message down if it is the one with this id. */
export async function clearPinIfIs(room: string, messageId: string): Promise<void> {
  const service = roomService();
  if (!service) return;
  const [existing] = await service.listRooms([room]);
  if (!existing || parseRoomMeta(existing.metadata).pin?.id !== messageId) return;
  await updateMeta(service, room, (current) => (current.pin?.id === messageId ? { ...current, pin: undefined } : current));
}

/** Resolves the caller from their LiveKit token and looks up what they are in their room. */
export async function verifyCaller(token: string): Promise<Caller | null> {
  const c = config();
  const service = roomService();
  if (!c || !service) return null;
  const who = readCallerToken(token, c.apiKey, c.apiSecret);
  if (!who) return null;
  try {
    const [info] = await service.listRooms([who.room]);
    if (!info) return null;
    const meta = parseRoomMeta(info.metadata);
    const role = meta.host === who.identity ? "host" : meta.cohosts?.includes(who.identity) ? "cohost" : "guest";
    return { ...who, role, meta };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- moderation */

/**
 * Asking to join. People who have to ask are not connected to the meeting's room at all: they
 * wait in a second room, the lobby, with a token that can neither publish nor subscribe, so
 * nothing of the meeting reaches them (not its picture or sound, and not its chat, people or
 * record either). The host and co-hosts watch the lobby through a hidden connection of their
 * own. Letting someone in sends them, and only them, a token for the meeting itself; turning
 * them away removes them from the lobby.
 */
export const lobbyOf = (room: string) => `${room}.lobby`;

/** "viewer": a webinar's audience, in the meeting's room but unable to publish (see ./webinar.server.ts). */
export type JoinTokenKind = "member" | "viewer" | "asking" | "lobby-watch";

/** Signs a LiveKit token. `room` is always the meeting's code; the kind decides which room it opens. */
export async function mintJoinToken(room: string, identity: string, name: string, kind: JoinTokenKind): Promise<string> {
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity,
    name,
    // Long enough to connect. LiveKit renews the token of everyone who is connected, so this is
    // also about how long a token outlives its owner being removed.
    ttl: "10m",
  });
  if (kind === "member" || kind === "viewer") {
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: kind === "member",
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true, // lets a participant raise/lower their own hand
    });
  } else {
    token.addGrant({
      room: lobbyOf(room),
      roomJoin: true,
      canPublish: false,
      canSubscribe: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      // The people waiting are not shown who is watching.
      hidden: kind === "lobby-watch",
    });
  }
  return token.toJwt();
}

/** A token with which a host or co-host can see who is waiting. Null for anyone else. */
export async function lobbyWatchToken(caller: Caller): Promise<string | null> {
  if (caller.role === "guest") return null;
  return mintJoinToken(caller.room, caller.identity, "", "lobby-watch");
}

/** Sends someone in the lobby, and only them, their way into the meeting. */
async function letIn(
  service: RoomServiceClient,
  room: string,
  person: { identity: string; name: string },
  /** A webinar lets people in to its audience. */
  kind: "member" | "viewer",
): Promise<void> {
  const token = await mintJoinToken(room, person.identity, person.name, kind);
  await service.sendData(lobbyOf(room), new TextEncoder().encode(JSON.stringify({ token })), DataPacket_Kind.RELIABLE, {
    destinationIdentities: [person.identity],
    topic: ADMIT_TOPIC,
  });
}

/** LiveKit's answer when the room or the person in it is not there (any more). */
const isGone = (error: unknown) => (error as { status?: number } | null)?.status === 404;

/** Runs `work` on every item, at most `limit` at a time. Never rejects: `work` deals with its own failures. */
async function inBatches<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * Admit all and Deny all: one request from the host, however many are waiting. Returns who is
 * still waiting because answering them went wrong, in the order they were given. Anyone who is
 * no longer in the lobby has stopped asking, which is not a failure.
 */
async function answerLobby(
  service: RoomServiceClient,
  room: string,
  verb: "admit" | "deny",
  identities: string[],
  kind: "member" | "viewer",
): Promise<string[]> {
  let present: Map<string, ParticipantInfo>;
  try {
    present = new Map((await service.listParticipants(lobbyOf(room))).map((person) => [person.identity, person]));
  } catch (error) {
    // No lobby at all means nobody is waiting. Anything else, and nobody was answered.
    return isGone(error) ? [] : identities;
  }
  const failed = new Set<string>();
  await inBatches(
    identities.filter((identity) => present.has(identity)),
    BULK_AT_ONCE,
    async (identity) => {
      try {
        if (verb === "admit") await letIn(service, room, present.get(identity)!, kind);
        else await service.removeParticipant(lobbyOf(room), identity);
      } catch (error) {
        if (!isGone(error)) failed.add(identity);
      }
    },
  );
  return identities.filter((identity) => failed.has(identity));
}

async function muteSource(service: RoomServiceClient, room: string, person: ParticipantInfo, source: TrackSource): Promise<void> {
  const live = person.tracks.filter((track) => track.source === source && !track.muted);
  await Promise.all(live.map((track) => service.mutePublishedTrack(room, person.identity, track.sid, true)));
}

/**
 * Carries out a moderation request. `caller` came from a token we signed and the room's record,
 * never from the request; this is where "may they?" is answered.
 */
export async function liveKitHostAction(
  caller: Caller,
  request: HostAction,
  /** For `pin`: the message to pin, as this server signed it when it was sent. */
  signedMessage?: unknown,
): Promise<HostActionResult> {
  const service = roomService();
  if (!service || caller.role === "guest") return DENIED;
  if (isHostOnly(request) && caller.role !== "host") return HOST_ONLY;
  const { room, meta } = caller;
  const protectedIds = new Set([meta.host, ...(meta.cohosts ?? []), caller.identity]);

  try {
    if ("identity" in request) {
      const { identity } = request;
      if (identity === caller.identity) return OWN_CONTROLS;
      if (identity === meta.host) return NOT_THE_HOST;
      switch (request.action) {
        case "mute":
          await muteSource(service, room, await service.getParticipant(room, identity), TrackSource.MICROPHONE);
          return { status: 200 };
        case "stopCamera":
          await muteSource(service, room, await service.getParticipant(room, identity), TrackSource.CAMERA);
          return { status: 200 };
        case "lowerHand":
          await service.updateParticipant(room, identity, { attributes: { hand: "" } });
          return { status: 200 };
        case "remove": {
          // Noted before they are disconnected, so an instant retry is already refused.
          await updateMeta(service, room, (current) => ({
            ...current,
            banned: [...(current.banned ?? []).filter((id) => id !== identity), identity].slice(-MAX_BANNED),
            cohosts: (current.cohosts ?? []).filter((id) => id !== identity),
          }));
          // Where the LiveKit server supports it, this also revokes the token they joined with.
          await service.removeParticipant(room, identity, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 1) });
          return { status: 200 };
        }
        case "admit": {
          // Throws, and so answers "may have left", unless they are in the lobby right now.
          const person = await service.getParticipant(lobbyOf(room), identity);
          await letIn(service, room, person, meta.mode === "webinar" ? "viewer" : "member");
          return { status: 200 };
        }
        case "deny":
          await service.removeParticipant(lobbyOf(room), identity);
          return { status: 200 };
        case "coHost": {
          // Throws unless they are in the call.
          if (request.on) await service.getParticipant(room, identity);
          const next = await updateMeta(service, room, (current) => {
            const others = (current.cohosts ?? []).filter((id) => id !== identity);
            return { ...current, cohosts: request.on ? [...others, identity].slice(-MAX_COHOSTS) : others };
          });
          return next ? { status: 200 } : GONE;
        }
      }
    }

    switch (request.action) {
      case "admitAll":
      case "denyAll": {
        const kind = meta.mode === "webinar" ? "viewer" : "member";
        const failed = await answerLobby(service, room, request.action === "admitAll" ? "admit" : "deny", request.identities, kind);
        return failed.length > 0 ? { status: 200, failed } : { status: 200 };
      }
      case "reactions": {
        const next = await updateMeta(service, room, (current) => {
          if ((current.reactions !== false) === request.allowed) return current;
          const changed: RoomMeta = { ...current, reactions: false };
          if (request.allowed) delete changed.reactions;
          return changed;
        });
        return next ? { status: 200 } : GONE;
      }
      case "muteAll": {
        const everyone = await service.listParticipants(room);
        const targets = everyone.filter((person) => !protectedIds.has(person.identity));
        await Promise.allSettled(targets.map((person) => muteSource(service, room, person, TrackSource.MICROPHONE)));
        return { status: 200 };
      }
      case "lowerAllHands": {
        const everyone = await service.listParticipants(room);
        const raised = everyone.filter((person) => person.attributes.hand === "1");
        await Promise.allSettled(raised.map((person) => service.updateParticipant(room, person.identity, { attributes: { hand: "" } })));
        return { status: 200 };
      }
      case "access": {
        const next = await updateMeta(service, room, (current) => ({ ...current, access: request.access }));
        return next ? { status: 200 } : GONE;
      }
      case "pin": {
        if (request.messageId === null) {
          const next = await updateMeta(service, room, (current) => ({ ...current, pin: undefined }));
          return next ? { status: 200 } : GONE;
        }
        // Only what was really said in this meeting can be pinned: our own signature says so.
        // A host cannot put words in anyone's mouth by pinning a message that was never sent.
        const secret = process.env.LIVEKIT_API_SECRET ?? "";
        if (!verifyChat(signedMessage, secret) || signedMessage.room !== room || signedMessage.id !== request.messageId) {
          return { status: 400, error: "That message can't be pinned." };
        }
        const { id, identity, name, ts, text } = signedMessage;
        const next = await updateMeta(service, room, (current) => ({ ...current, pin: { id, identity, name, ts, text } }));
        return next ? { status: 200 } : GONE;
      }
      case "closePoll": {
        let found = false;
        const next = await updateMeta(service, room, (current) => {
          const closed = closeStoredPoll(current.polls ?? [], request.pollId);
          found = closed !== null;
          return closed ? { ...current, polls: closed } : current;
        });
        if (!next) return GONE;
        return found ? { status: 200 } : { status: 404, error: "That poll is no longer there." };
      }
      case "end": {
        // Deleting the room disconnects everyone with "the room was closed". The record is put
        // straight back, without the co-hosts: the meeting can be used again, by the same host.
        await exclusive(room, async () => {
          const [existing] = await service.listRooms([room]);
          const current = existing ? parseRoomMeta(existing.metadata) : meta;
          await service.deleteRoom(room);
          // Anyone still asking to join is told the same thing.
          await service.deleteRoom(lobbyOf(room)).catch(() => {});
          await createRoom(service, room, { ...current, cohosts: [], pin: undefined, polls: undefined, startedAt: undefined }).catch((error) =>
            console.error("Could not keep the meeting record after ending the call", error),
          );
        });
        return { status: 200 };
      }
    }
    return { status: 400, error: "Invalid request." };
  } catch {
    return GONE;
  }
}
