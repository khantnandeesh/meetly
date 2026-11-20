import { randomUUID } from "node:crypto";
import { PASS_MAX_AGE_S, type Pass } from "../../pass.server";
import { DENIED, GONE, HOST_ONLY, NOT_THE_HOST, OWN_CONTROLS, isHostOnly, type HostActionResult } from "../hostAction";
import { webinarGate, type WebinarRefusal } from "../../webinarGate.server";
import type { CallMode, HostAction, JoinAccess, MeetingPeek } from "../types";
import { signSession, verifySession, type Session } from "./session";

/**
 * Server side of the RealtimeKit provider: Cloudflare's REST API, and the meeting's rules.
 *
 * Meeting codes map to RealtimeKit meetings by title. A browser cannot give itself a preset, so
 * "who is host" is decided here and nowhere else.
 *
 * Host, matching the LiveKit rule in src/lib/host.server.ts:
 *
 * - "New meeting" creates the RealtimeKit meeting and, in it, the host's participant record,
 *   before anyone joins. The creating browser is given that record's id as its host key (a
 *   signed cookie, see src/lib/pass.server.ts). Joining with the key re-uses the record with a
 *   fresh token, so the host is the same participant after a reload or a rejoin.
 * - A code somebody typed by hand has no meeting yet: the first person into it becomes host and
 *   gets the key then.
 * - Nobody else becomes host while that record stands. It lapses only when the meeting is empty
 *   and its host has not joined for as long as the key's cookie lasts; the next person in then
 *   starts afresh as host, and the old record is deleted, which revokes its token.
 * - A host action is authorised by the caller's Meetly session (see ./session.ts), and what the
 *   caller may do is read from the records at that moment, not from what the session says.
 *
 * The rest of the meeting's record is kept as participant records too, because that is the only
 * per-meeting storage RealtimeKit has: a record that nobody ever joins with, whose
 * `custom_participant_id` states one fact ("meetly-ban:<identity>", "meetly-cohost:<id>",
 * "meetly-access:locked"). Adding or deleting one is a single call, so two changes at once
 * cannot overwrite each other. Their tokens are thrown away as they are made.
 *
 * Known limit: two people asking for the very first token of a hand-typed code in the same
 * instant can both be made host.
 */

/** How long a host who has not joined keeps the role in an empty meeting: as long as their key. */
const HOST_KEEP_MS = PASS_MAX_AGE_S * 1000;
/** How long a join stays valid, for both the RealtimeKit token and our session. */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
/** Stop paging somewhere: a code that has been joined this often has bigger problems. */
const MAX_PAGES = 20;

const BAN = "meetly-ban:";
const COHOST = "meetly-cohost:";
const ACCESS = "meetly-access:";
/** "meetly-pin:<chat message id>": the message shown above the conversation. The newest one stands. */
const PIN = "meetly-pin:";
/** "meetly-poll-closed:<poll id>": a RealtimeKit poll the host or a co-host ended. RealtimeKit itself has no way to end one. */
const POLL_CLOSED = "meetly-poll-closed:";
/** "meetly-mode:webinar": "New webinar" made this meeting. Written once, before anyone joins, and never removed. */
const MODE = "meetly-mode:";
/** Polls are ended a handful at a time; past this, something other than a person is asking. */
const MAX_CLOSED_POLLS = 40;
/** "meetly-reactions:off": the host or a co-host turned reactions off. No statement means they are allowed. */
const REACTIONS_OFF = "meetly-reactions:off";
const isMarker = (p: Participant) => p.custom_participant_id.startsWith("meetly-");

type Config = {
  base: string;
  apiToken: string;
  hostPreset: string;
  guestPreset: string;
  /** Optional: a guest preset with the waiting room switched on. Without it there is no "ask to join". */
  knockPreset: string | null;
  /** Webinars: the host's preset and the audience's (see `missingWebinarEnv`). Without both there are no webinars. */
  webinarHostPreset: string | null;
  webinarViewerPreset: string | null;
  sessionSecret: string;
};

export const REALTIMEKIT_ENV = [
  "CLOUDFLARE_ACCOUNT_ID",
  "REALTIMEKIT_APP_ID",
  "REALTIMEKIT_HOST_PRESET",
  "REALTIMEKIT_GUEST_PRESET",
  "CLOUDFLARE_API_TOKEN",
  "MEETLY_SESSION_SECRET",
] as const;

export function missingRealtimeKitEnv(): string[] {
  return REALTIMEKIT_ENV.filter((name) => !process.env[name]);
}

/** Both preset names a webinar needs. They are optional for meetings, so they are checked only when a webinar is made or joined. */
export const REALTIMEKIT_WEBINAR_ENV = ["REALTIMEKIT_WEBINAR_HOST_PRESET", "REALTIMEKIT_WEBINAR_VIEWER_PRESET"] as const;

export function missingWebinarEnv(): string[] {
  return REALTIMEKIT_WEBINAR_ENV.filter((name) => !process.env[name]);
}

/** What signs the browser's pass on RealtimeKit builds. */
export function realtimeKitPassSecret(): string {
  return process.env.MEETLY_SESSION_SECRET ?? "";
}

function config(): Config | null {
  if (missingRealtimeKitEnv().length > 0) return null;
  const env = process.env as unknown as Record<(typeof REALTIMEKIT_ENV)[number], string>;
  return {
    base: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    hostPreset: env.REALTIMEKIT_HOST_PRESET,
    guestPreset: env.REALTIMEKIT_GUEST_PRESET,
    knockPreset: process.env.REALTIMEKIT_KNOCK_PRESET || null,
    webinarHostPreset: process.env.REALTIMEKIT_WEBINAR_HOST_PRESET || null,
    webinarViewerPreset: process.env.REALTIMEKIT_WEBINAR_VIEWER_PRESET || null,
    sessionSecret: env.MEETLY_SESSION_SECRET,
  };
}

type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; data: null };

async function api<T>(c: Config, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const response = await fetch(`${c.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.apiToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await response.json().catch(() => null)) as { success?: boolean; data?: T } | null;
  if (!response.ok || !json?.success) return { ok: false, status: response.status, data: null };
  return { ok: true, status: response.status, data: json.data as T };
}

type Meeting = { id: string; title: string; status?: string; created_at: string };
type Participant = {
  id: string;
  custom_participant_id: string;
  preset_name: string;
  created_at: string;
  updated_at?: string;
};
type AddedParticipant = Participant & { token: string };

const oldestFirst = (a: { created_at: string }, b: { created_at: string }) =>
  Date.parse(a.created_at) - Date.parse(b.created_at);

/** The meeting for this code: the oldest active one titled exactly `code`. */
async function findMeeting(c: Config, code: string): Promise<Meeting | null> {
  // Search matches substrings (and ids), so the exact title is checked here.
  const found = await api<Meeting[]>(c, "GET", `/meetings?search=${encodeURIComponent(code)}&per_page=${PAGE_SIZE}`);
  if (!found.ok) throw new Error(`RealtimeKit meeting search failed (${found.status}).`);
  return found.data.filter((m) => m.title === code && m.status !== "INACTIVE").sort(oldestFirst)[0] ?? null;
}

async function findOrCreateMeeting(c: Config, code: string): Promise<{ meeting: Meeting; created: boolean }> {
  const existing = await findMeeting(c, code);
  if (existing) return { meeting: existing, created: false };
  const made = await api<Meeting>(c, "POST", "/meetings", { title: code });
  if (!made.ok) throw new Error(`RealtimeKit meeting could not be created (${made.status}).`);
  // Two people opening a new code at once would each create a meeting. Everyone agrees on the
  // oldest, so look again; the loser's meeting is switched off and never used.
  const agreed = await findMeeting(c, code).catch(() => null);
  if (agreed && agreed.id !== made.data.id) {
    await api(c, "PATCH", `/meetings/${made.data.id}`, { status: "INACTIVE" }).catch(() => {});
    return { meeting: agreed, created: false };
  }
  return { meeting: made.data, created: true };
}

async function listParticipants(c: Config, meetingId: string): Promise<Participant[]> {
  const all: Participant[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await api<Participant[]>(c, "GET", `/meetings/${meetingId}/participants?per_page=${PAGE_SIZE}&page_no=${page}`);
    if (!result.ok) throw new Error(`RealtimeKit participants could not be listed (${result.status}).`);
    all.push(...result.data);
    if (result.data.length < PAGE_SIZE) break;
  }
  return all;
}

/** The presets whose holders are the host: the meeting host's, and the webinar host's where there is one. */
const hostPresetsOf = (c: Config) => (c.webinarHostPreset ? [c.hostPreset, c.webinarHostPreset] : [c.hostPreset]);

/** Whether anyone is connected right now. No session at all answers 404. */
async function hasLiveSession(c: Config, meetingId: string): Promise<boolean> {
  const result = await api<{ status?: string; live_participants?: number }>(c, "GET", `/meetings/${meetingId}/active-session`);
  if (!result.ok) {
    if (result.status === 404) return false;
    // Not knowing is treated as "someone is there": the role is never handed on by accident.
    return true;
  }
  return result.data.status !== "ENDED" && (result.data.live_participants ?? 1) > 0;
}

/* ---------------------------------------------------------------- the record */

type MeetingRecord = {
  /** Real people's records (not markers). */
  people: Participant[];
  hosts: Participant[];
  /** Record ids of co-hosts. */
  coHostIds: Set<string>;
  /** Identities the host removed. */
  banned: Set<string>;
  access: JoinAccess;
  /** Id of the pinned chat message. */
  pin: string | null;
  /** Ids of RealtimeKit polls that were ended. */
  closedPolls: string[];
  /** A webinar's record says so; anything else is a meeting. */
  mode: CallMode;
  /** People may send reactions. */
  reactions: boolean;
  markers: Participant[];
};

/** Reads the meeting's record out of its participant list. Exported for tests. */
export function readRecord(participants: Participant[], hostPreset: string | readonly string[], canAsk: boolean): MeetingRecord {
  const hostPresets: readonly string[] = typeof hostPreset === "string" ? [hostPreset] : hostPreset;
  const markers = participants.filter(isMarker);
  const people = participants.filter((p) => !isMarker(p));
  const tagged = (prefix: string) =>
    markers.filter((m) => m.custom_participant_id.startsWith(prefix)).map((m) => m.custom_participant_id.slice(prefix.length));
  const stated = tagged(ACCESS);
  // The stricter statement wins if two were ever written at once.
  const access: JoinAccess = stated.includes("locked") ? "locked" : stated.includes("ask") && canAsk ? "ask" : "open";
  // Pinning writes the new statement before removing the old, so for a moment there can be two.
  const pins = markers.filter((m) => m.custom_participant_id.startsWith(PIN)).sort(oldestFirst);
  return {
    people,
    hosts: people.filter((p) => hostPresets.includes(p.preset_name)),
    coHostIds: new Set(tagged(COHOST)),
    banned: new Set(tagged(BAN)),
    access,
    pin: pins.length > 0 ? pins[pins.length - 1].custom_participant_id.slice(PIN.length) : null,
    closedPolls: Array.from(new Set(tagged(POLL_CLOSED))),
    mode: tagged(MODE).includes("webinar") ? "webinar" : "meeting",
    reactions: !markers.some((m) => m.custom_participant_id === REACTIONS_OFF),
    markers,
  };
}

function addMarker(c: Config, meetingId: string, fact: string): Promise<ApiResult<AddedParticipant>> {
  return api<AddedParticipant>(c, "POST", `/meetings/${meetingId}/participants`, {
    name: "Meetly record",
    preset_name: c.guestPreset,
    custom_participant_id: fact,
  });
}

/** Deletes the matching statements. False if any of them is still standing afterwards. */
async function removeMarkers(c: Config, meetingId: string, record: MeetingRecord, matches: (fact: string) => boolean): Promise<boolean> {
  const gone = record.markers.filter((m) => matches(m.custom_participant_id));
  const results = await Promise.all(
    gone.map((m) =>
      api(c, "DELETE", `/meetings/${meetingId}/participants/${m.id}`).then(
        // Already gone is as good as deleted.
        (result) => result.ok || result.status === 404,
        () => false,
      ),
    ),
  );
  return results.every(Boolean);
}

const UNREACHABLE = { status: 502, error: "Couldn't connect to the meeting. Try again in a moment." } as const;

const coHostIdentities = (record: MeetingRecord) =>
  record.people.filter((p) => record.coHostIds.has(p.id)).map((p) => p.custom_participant_id);

/* ------------------------------------------------------------------ joining */

/** Decides whether the next person in becomes host, clearing out a lapsed host if so. */
async function claimHostIfFirst(c: Config, meeting: Meeting, record: MeetingRecord): Promise<boolean> {
  try {
    const live = await hasLiveSession(c, meeting.id);
    if (record.hosts.length === 0) return !live;
    const lastSeen = Math.max(...record.hosts.map((p) => Date.parse(p.updated_at ?? p.created_at)));
    if (live || Date.now() - lastSeen < HOST_KEEP_MS) return false;
    await Promise.all(record.hosts.map((p) => api(c, "DELETE", `/meetings/${meeting.id}/participants/${p.id}`).catch(() => {})));
    return true;
  } catch (error) {
    // Joining must not depend on this: when in doubt, a guest.
    console.error("Could not work out the meeting host", error);
    return false;
  }
}

export type RealtimeKitJoin = {
  authToken: string;
  session: string;
  participantId: string;
  meetingId: string;
  role: "host" | "guest";
  hostPreset: string;
  coHosts: string[];
  access: JoinAccess;
  canAsk: boolean;
  pin: string | null;
  closedPolls: string[];
  mode: CallMode;
  /** Reactions allowed at the moment of joining. */
  reactions: boolean;
};

export type RealtimeKitJoinOutcome =
  | { refused: "removed" | "locked" | WebinarRefusal }
  | {
      refused?: undefined;
      join: RealtimeKitJoin;
      /** What every client knows this person as; noted in the browser's pass. */
      identity: string;
      /** Set when this join made the browser host: the key to keep in its pass. */
      key?: string;
    };

function grant(
  c: Config,
  meeting: Meeting,
  record: MeetingRecord | null,
  person: { id: string; identity: string; token: string },
  role: "host" | "guest",
  expires: number,
): RealtimeKitJoin {
  const webinar = record?.mode === "webinar";
  const session: Session = {
    meetingId: meeting.id,
    participantId: person.id,
    identity: person.identity,
    role,
    exp: Math.floor(expires / 1000),
  };
  return {
    authToken: person.token,
    session: signSession(session, c.sessionSecret),
    participantId: person.id,
    meetingId: meeting.id,
    role,
    // In a webinar the host is whoever holds the webinar host's preset; clients look for that name.
    hostPreset: webinar ? (c.webinarHostPreset ?? c.hostPreset) : c.hostPreset,
    coHosts: record ? coHostIdentities(record) : [],
    access: record?.access ?? "open",
    // The audience's preset has no waiting room, so a webinar has no "ask to join".
    canAsk: c.knockPreset !== null && !webinar,
    pin: record?.pin ?? null,
    closedPolls: record?.closedPolls ?? [],
    mode: webinar ? "webinar" : "meeting",
    reactions: record?.reactions ?? true,
  };
}

/**
 * Lets `name` into the meeting for `code`, or says why not. `pass` is what the browser's signed
 * cookie says about it. Throws if Cloudflare cannot be reached or refuses.
 */
export async function issueRealtimeKitJoin(code: string, name: string, pass: Pass): Promise<RealtimeKitJoinOutcome> {
  const c = config();
  if (!c) throw new Error(`Server is missing ${missingRealtimeKitEnv().join(", ")}.`);
  const { meeting, created } = await findOrCreateMeeting(c, code);
  const record = readRecord(created ? [] : await listParticipants(c, meeting.id), hostPresetsOf(c), c.knockPreset !== null);
  const expires = Date.now() + TOKEN_TTL_MS;
  const webinar = record.mode === "webinar";
  if (webinar && (!c.webinarHostPreset || !c.webinarViewerPreset)) {
    throw new Error(`Server is missing ${missingWebinarEnv().join(", ")}, which webinars need.`);
  }

  // The host coming back: the same participant, with a fresh token and today's name.
  const mine = pass.key ? record.hosts.find((p) => p.id === pass.key) : undefined;
  if (mine) {
    // The host passes the same gate as everyone else, so a rule for webinars is never skipped by a rejoin.
    const refused = webinar ? await webinarGate({ host: true, watching: () => liveCount(c, meeting.id) }) : null;
    if (refused) return { refused };
    const base = `/meetings/${meeting.id}/participants/${mine.id}`;
    // Renaming also marks the record as used, which is what keeps the role from lapsing.
    await api(c, "PATCH", base, { name }).catch(() => {});
    const fresh = await api<{ token: string }>(c, "POST", `${base}/token`);
    if (!fresh.ok) throw new Error(`RealtimeKit would not renew the host's token (${fresh.status}).`);
    const identity = mine.custom_participant_id;
    return { join: grant(c, meeting, record, { id: mine.id, identity, token: fresh.data.token }, "host", expires), identity };
  }

  const host = created || (await claimHostIfFirst(c, meeting, record));
  if (!host) {
    if (pass.ids.some((id) => record.banned.has(id))) return { refused: "removed" };
    if (record.access === "locked") return { refused: "locked" };
  }
  if (webinar) {
    const refused = await webinarGate({ host, watching: () => liveCount(c, meeting.id) });
    if (refused) return { refused };
  }
  const role = host ? "host" : "guest";
  // Identity is always minted server-side so a client can't impersonate another participant.
  const identity = `m-${randomUUID()}`;
  const preset = webinar
    ? host
      ? c.webinarHostPreset!
      : c.webinarViewerPreset!
    : host
      ? c.hostPreset
      : record.access === "ask" && c.knockPreset
        ? c.knockPreset
        : c.guestPreset;
  const added = await api<AddedParticipant>(c, "POST", `/meetings/${meeting.id}/participants`, {
    name,
    preset_name: preset,
    custom_participant_id: identity,
    token: { expires_on: new Date(expires).toISOString() },
  });
  if (!added.ok) throw new Error(`RealtimeKit would not add the participant (${added.status}).`);
  return {
    join: grant(c, meeting, record, { id: added.data.id, identity, token: added.data.token }, role, expires),
    identity,
    key: host ? added.data.id : undefined,
  };
}

/**
 * Creates the meeting for a brand-new code together with its host's record, and returns the host
 * key for the browser that asked. Null if the code is already in use or Cloudflare could not be
 * reached: the meeting still works, by the first-person-in rule.
 */
export async function createRealtimeKitMeeting(code: string, mode: CallMode = "meeting"): Promise<{ key: string; identity: string } | null> {
  const c = config();
  if (!c) return null;
  const webinar = mode === "webinar";
  if (webinar && (!c.webinarHostPreset || !c.webinarViewerPreset)) return null;
  try {
    const { meeting, created } = await findOrCreateMeeting(c, code);
    if (!created) return null;
    // Written before anyone can join: the code is a webinar from its first moment, or not at all.
    if (webinar && !(await addMarker(c, meeting.id, `${MODE}webinar`)).ok) return null;
    const identity = `m-${randomUUID()}`;
    const added = await api<AddedParticipant>(c, "POST", `/meetings/${meeting.id}/participants`, {
      name: "Host",
      preset_name: webinar ? c.webinarHostPreset : c.hostPreset,
      custom_participant_id: identity,
    });
    return added.ok ? { key: added.data.id, identity } : null;
  } catch (error) {
    console.error("Could not create the RealtimeKit meeting", error);
    return null;
  }
}

/**
 * How many people are connected to the meeting right now, from the active session's own count,
 * or null if Cloudflare would not say. No session answers 404, which means nobody is there.
 *
 * This is one REST call, made once per pre-join screen, never repeated while it is open. It is
 * not the SDK's `getAllJoinedPeers()`, which is limited to 10 calls a minute per participant.
 */
async function liveCount(c: Config, meetingId: string): Promise<number | null> {
  const result = await api<{ status?: string; live_participants?: number }>(c, "GET", `/meetings/${meetingId}/active-session`);
  if (!result.ok) return result.status === 404 ? 0 : null;
  if (result.data.status === "ENDED") return 0;
  const count = result.data.live_participants;
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

/**
 * What the pre-join screen may know before asking to join. The participant records say who may
 * join, not who is there, so how many are there comes from the active session (see `liveCount`).
 */
export async function peekRealtimeKitMeeting(code: string, pass: Pass): Promise<MeetingPeek> {
  const c = config();
  try {
    const meeting = c ? await findMeeting(c, code) : null;
    if (!c) return { access: "open", host: false, count: null };
    // A code nobody has used yet is an empty meeting.
    if (!meeting) return { access: "open", host: false, count: 0 };
    const [participants, count] = await Promise.all([
      listParticipants(c, meeting.id),
      liveCount(c, meeting.id).catch(() => null),
    ]);
    const record = readRecord(participants, hostPresetsOf(c), c.knockPreset !== null);
    return {
      access: record.access,
      host: !!pass.key && record.hosts.some((p) => p.id === pass.key),
      count,
      ...(record.mode === "webinar" ? { mode: "webinar" as const } : {}),
    };
  } catch {
    return { access: "open", host: false, count: null };
  }
}

/* --------------------------------------------------------------- moderation */

export type RealtimeKitRoles = {
  coHosts: string[];
  access: JoinAccess;
  pin: string | null;
  closedPolls: string[];
  reactions: boolean;
};

/**
 * Moderation, and `roles`: the one thing here any participant may ask, since RealtimeKit has no
 * way for our server to tell clients who the co-hosts are.
 *
 * Everything about the caller comes from their signed session and the records, nothing from the
 * request. Some requests are only authorised here and then carried out by the caller's own
 * client, because RealtimeKit has no REST call for them: letting someone in from the waiting
 * room and stopping a camera are enforced by RealtimeKit against the caller's preset; lowering
 * a hand is a courtesy between clients, as raising one is.
 */
export async function realtimeKitHostAction(
  sessionToken: unknown,
  request: HostAction | { action: "roles" },
): Promise<HostActionResult & { data?: RealtimeKitRoles }> {
  const c = config();
  if (!c) return DENIED;
  const session = verifySession(sessionToken, c.sessionSecret);
  if (!session) return DENIED;
  try {
    // The signature proves what we said when they joined; the records say what is true now.
    const record = readRecord(await listParticipants(c, session.meetingId), hostPresetsOf(c), c.knockPreset !== null);
    const me = record.people.find((p) => p.id === session.participantId);
    if (!me) return DENIED;
    if (request.action === "roles") {
      return {
        status: 200,
        data: {
          coHosts: coHostIdentities(record),
          access: record.access,
          pin: record.pin,
          closedPolls: record.closedPolls,
          reactions: record.reactions,
        },
      };
    }
    const role = record.hosts.includes(me) ? "host" : record.coHostIds.has(me.id) ? "cohost" : "guest";
    if (role === "guest") return DENIED;
    if (isHostOnly(request) && role !== "host") return HOST_ONLY;
    const session_ = `/meetings/${session.meetingId}/active-session`;

    if ("identity" in request) {
      const target = request.identity;
      if (target === session.identity || target === session.participantId) return OWN_CONTROLS;
      // The moderation endpoints take RealtimeKit's own participant ids, so look the person up.
      const person = record.people.find((p) => p.custom_participant_id === target || p.id === target);
      if (person && record.hosts.includes(person)) return NOT_THE_HOST;
      switch (request.action) {
        case "admit":
        case "deny":
        case "stopCamera":
        case "lowerHand":
          return { status: 200 };
        // Inviting someone on stage, or sending them back, is done by the caller's client
        // (`stage.grantAccess`, `denyAccess`, `kick`), which RealtimeKit checks against the
        // caller's preset. What is decided here is that the caller is the host or a co-host, and
        // that this is a webinar. Stepping down yourself needs no one's leave and never comes here.
        case "stage":
          if (record.mode !== "webinar") return { status: 400, error: "Only a webinar has a stage." };
          return person ? { status: 200 } : GONE;
        case "mute": {
          if (!person) return GONE;
          const done = await api(c, "POST", `${session_}/mute`, { participant_ids: [person.id] });
          return done.ok ? { status: 200 } : GONE;
        }
        case "remove": {
          if (!person) return GONE;
          // Noted first, so that a browser that held this identity is refused from this moment.
          const banned = await addMarker(c, session.meetingId, `${BAN}${person.custom_participant_id}`);
          if (!banned.ok) return UNREACHABLE;
          const kicked = await api(c, "POST", `${session_}/kick`, { participant_ids: [person.id] });
          // Whether or not they were connected, the record goes, which revokes their token.
          await api(c, "DELETE", `/meetings/${session.meetingId}/participants/${person.id}`).catch(() => {});
          await removeMarkers(c, session.meetingId, record, (fact) => fact === `${COHOST}${person.id}`);
          return kicked.ok ? { status: 200 } : GONE;
        }
        case "coHost": {
          if (!person) return GONE;
          if (!request.on) {
            const removed = await removeMarkers(c, session.meetingId, record, (fact) => fact === `${COHOST}${person.id}`);
            return removed ? { status: 200 } : UNREACHABLE;
          }
          if (record.coHostIds.has(person.id)) return { status: 200 };
          const added = await addMarker(c, session.meetingId, `${COHOST}${person.id}`);
          return added.ok ? { status: 200 } : UNREACHABLE;
        }
      }
    }

    switch (request.action) {
      case "lowerAllHands":
        return { status: 200 };
      // One request however many are waiting. As with one person, the caller's own client then
      // answers the waiting room, and RealtimeKit checks the caller's preset for it.
      case "admitAll":
      case "denyAll":
        return { status: 200 };
      case "reactions": {
        if (request.allowed === record.reactions) return { status: 200 };
        if (!request.allowed) {
          const added = await addMarker(c, session.meetingId, REACTIONS_OFF);
          return added.ok ? { status: 200 } : UNREACHABLE;
        }
        const cleared = await removeMarkers(c, session.meetingId, record, (fact) => fact === REACTIONS_OFF);
        return cleared ? { status: 200 } : UNREACHABLE;
      }
      case "muteAll": {
        const done = await api(c, "POST", `${session_}/mute-all`, { allow_unmute: true });
        return done.ok ? { status: 200 } : { status: 404, error: "Nobody is in the meeting." };
      }
      case "end": {
        const done = await api(c, "POST", `${session_}/kick-all`);
        return done.ok ? { status: 200 } : { status: 404, error: "Nobody is in the meeting." };
      }
      case "pin": {
        // Only the id is kept: every client reads the message itself from RealtimeKit's chat,
        // so what is shown as pinned is always something that was really said.
        const wanted = request.messageId === null ? null : `${PIN}${request.messageId}`;
        if (wanted && record.pin !== request.messageId) {
          const added = await addMarker(c, session.meetingId, wanted);
          if (!added.ok) return UNREACHABLE;
        }
        const cleared = await removeMarkers(c, session.meetingId, record, (fact) => fact.startsWith(PIN) && fact !== wanted);
        return cleared ? { status: 200 } : UNREACHABLE;
      }
      case "closePoll": {
        // RealtimeKit keeps the poll and counts its votes but has no way to end one, so that it
        // has ended is one more statement in the record. Clients stop offering it; see the note
        // on `closedPolls` in src/lib/rtc/realtimekit.ts for what that does and does not stop.
        if (record.closedPolls.includes(request.pollId)) return { status: 200 };
        const added = await addMarker(c, session.meetingId, `${POLL_CLOSED}${request.pollId}`);
        if (!added.ok) return UNREACHABLE;
        // A link used for call after call does not collect these for ever: the oldest go.
        const old = record.markers
          .filter((m) => m.custom_participant_id.startsWith(POLL_CLOSED))
          .sort(oldestFirst)
          .slice(0, Math.max(0, record.closedPolls.length + 1 - MAX_CLOSED_POLLS))
          .map((m) => m.custom_participant_id);
        if (old.length > 0) await removeMarkers(c, session.meetingId, record, (fact) => old.includes(fact));
        return { status: 200 };
      }
      case "access": {
        if (request.access === "ask" && !c.knockPreset) {
          return { status: 400, error: "Ask to join isn't available for this meeting." };
        }
        // The new statement is written before the old one is removed: never open by accident.
        if (request.access !== "open" && record.access !== request.access) {
          const added = await addMarker(c, session.meetingId, `${ACCESS}${request.access}`);
          if (!added.ok) return UNREACHABLE;
        }
        const cleared = await removeMarkers(
          c,
          session.meetingId,
          record,
          (fact) => fact.startsWith(ACCESS) && fact !== `${ACCESS}${request.access}`,
        );
        return cleared ? { status: 200 } : UNREACHABLE;
      }
    }
    return { status: 400, error: "Invalid request." };
  } catch {
    return GONE;
  }
}
