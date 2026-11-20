import { randomUUID } from "node:crypto";
import { signSession, verifySession, type Session } from "./session";

/**
 * Server side of the RealtimeKit provider: Cloudflare's REST API, and the host rule.
 *
 * Meeting codes map to RealtimeKit meetings by title. Whoever is let into a meeting that has no
 * host yet joins with the host preset; everyone else joins with the guest preset. A browser
 * cannot give itself a preset, so "who is host" is decided here and nowhere else.
 *
 * Host rule, matching the LiveKit one in src/lib/host.server.ts:
 *
 * - The first person into a meeting is its host.
 * - The role is handed on only when the meeting is empty (no live session) and the last host
 *   claim is over a minute old. Never while people are in the call: otherwise a guest could wait
 *   for the host to drop and rejoin as host. The previous host's participant records are deleted
 *   at that point, which revokes their tokens.
 * - A host action is authorised by the caller's Meetly session (see ./session.ts), and the
 *   caller's participant record must still carry the host preset.
 *
 * Known limit: two people asking for the very first token in the same instant can both be made
 * host. If the first person never connects, the next joiner inherits the role only once the
 * claim is over a minute old.
 */

/** A freshly minted host token gets this long to connect before the claim can be replaced. */
const CLAIM_WINDOW_MS = 60_000;
/** How long a join stays valid, for both the RealtimeKit token and our session. */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
/** Stop paging somewhere: a code that has been joined this often has bigger problems. */
const MAX_PAGES = 20;

type Config = {
  base: string;
  apiToken: string;
  hostPreset: string;
  guestPreset: string;
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

function config(): Config | null {
  if (missingRealtimeKitEnv().length > 0) return null;
  const env = process.env as unknown as Record<(typeof REALTIMEKIT_ENV)[number], string>;
  return {
    base: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    hostPreset: env.REALTIMEKIT_HOST_PRESET,
    guestPreset: env.REALTIMEKIT_GUEST_PRESET,
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
type Participant = { id: string; custom_participant_id: string; preset_name: string; created_at: string };
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

/** Decides whether the next person in becomes host, clearing out a stale host if so. */
async function claimHostIfFirst(c: Config, meeting: Meeting, created: boolean): Promise<boolean> {
  if (created) return true;
  try {
    const [participants, live] = await Promise.all([listParticipants(c, meeting.id), hasLiveSession(c, meeting.id)]);
    const hosts = participants.filter((p) => p.preset_name === c.hostPreset);
    if (hosts.length === 0) return !live;
    const claimedAt = Math.max(...hosts.map((p) => Date.parse(p.created_at)));
    if (live || Date.now() - claimedAt < CLAIM_WINDOW_MS) return false;
    await Promise.all(hosts.map((p) => api(c, "DELETE", `/meetings/${meeting.id}/participants/${p.id}`).catch(() => {})));
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
};

/** Lets `name` into the meeting for `code`. Throws if Cloudflare cannot be reached or refuses. */
export async function issueRealtimeKitJoin(code: string, name: string): Promise<RealtimeKitJoin> {
  const c = config();
  if (!c) throw new Error(`Server is missing ${missingRealtimeKitEnv().join(", ")}.`);
  const { meeting, created } = await findOrCreateMeeting(c, code);
  const host = await claimHostIfFirst(c, meeting, created);
  const role = host ? "host" : "guest";
  // Identity is always minted server-side so a client can't impersonate another participant.
  const identity = `m-${randomUUID()}`;
  const expires = Date.now() + TOKEN_TTL_MS;
  const added = await api<AddedParticipant>(c, "POST", `/meetings/${meeting.id}/participants`, {
    name,
    preset_name: host ? c.hostPreset : c.guestPreset,
    custom_participant_id: identity,
    token: { expires_on: new Date(expires).toISOString() },
  });
  if (!added.ok) throw new Error(`RealtimeKit would not add the participant (${added.status}).`);
  const session: Session = {
    meetingId: meeting.id,
    participantId: added.data.id,
    identity,
    role,
    exp: Math.floor(expires / 1000),
  };
  return {
    authToken: added.data.token,
    session: signSession(session, c.sessionSecret),
    participantId: added.data.id,
    meetingId: meeting.id,
    role,
    hostPreset: c.hostPreset,
  };
}

export type HostActionResult = { status: 200 } | { status: 400 | 403 | 404; error: string };

/**
 * Host-only moderation. `target` is the identity the host's browser knows the person by.
 * Everything about the caller comes from their signed session, nothing from the request.
 */
export async function realtimeKitHostAction(
  sessionToken: unknown,
  action: "mute" | "remove",
  target: string,
): Promise<HostActionResult> {
  const denied: HostActionResult = { status: 403, error: "Only the meeting host can do that." };
  const gone: HostActionResult = { status: 404, error: "That person may have already left." };
  const c = config();
  if (!c) return denied;
  const session = verifySession(sessionToken, c.sessionSecret);
  if (!session || session.role !== "host") return denied;
  if (target === session.identity || target === session.participantId) {
    return { status: 400, error: "Use your own controls for that." };
  }
  try {
    // The signature proves what we said when they joined; this proves it is still true (the
    // record is deleted when the role is handed on).
    const caller = await api<Participant>(c, "GET", `/meetings/${session.meetingId}/participants/${session.participantId}`);
    if (!caller.ok || caller.data.preset_name !== c.hostPreset) return denied;
    // The moderation endpoints take RealtimeKit's own participant ids, so look the person up.
    const everyone = await listParticipants(c, session.meetingId);
    const person = everyone.find((p) => p.custom_participant_id === target || p.id === target);
    if (!person) return gone;
    const path = action === "remove" ? "kick" : "mute";
    const done = await api(c, "POST", `/meetings/${session.meetingId}/active-session/${path}`, {
      participant_ids: [person.id],
    });
    return done.ok ? { status: 200 } : gone;
  } catch {
    return gone;
  }
}
