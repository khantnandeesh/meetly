import { readRecord } from "./rtc/server/realtimekit";
import type { CallMode, RtcProviderName } from "./rtc/types";
import {
  WARN_SHARE,
  limitFact,
  limitWarningFact,
  webinarMinuteLimit,
  webinarsEnabled,
  type LimitWarning,
} from "./webinarLimit";

/**
 * The webinar cost watchdog. Run once a minute by a Cloudflare Cron Trigger (the custom Worker
 * entry on the cloudflare-deploy branch calls `runScheduledCostGuard`).
 *
 * Webinars are free and anyone can start one, and every viewer is a billed RealtimeKit
 * participant-minute. So, for every live webinar session:
 *
 * - past `MEETLY_WEBINAR_MINUTE_LIMIT` participant-minutes (5,000 unless set), the session is
 *   ended: first the record says so ("meetly-limit:<session>"), then everyone is removed, so a
 *   removed client can find out why, and the link refuses joins from then on;
 * - at 80% of it, the host and co-hosts are told roughly how long is left, once;
 * - with `MEETLY_WEBINARS_ENABLED` off, it is ended straight away.
 *
 * Meetings that are not webinars are never touched: the record must say "webinar" (E5's
 * "meetly-mode:webinar", read through `readRecord(...).mode`).
 *
 * How minutes are measured. RealtimeKit's REST API, for a live session, gives:
 *
 * - `GET /sessions?status=LIVE`: every live session of the app, each with its meeting
 *   (`associated_id`), `started_at`, `live_participants`, `max_concurrent_participants` and
 *   `minutes_consumed` ("minutes consumed since the session started"; the docs do not say how
 *   often it is brought up to date while the session is live).
 * - `GET /sessions/{id}/participants?include_peer_events=true`: everyone who was in the session,
 *   with `joined_at`, `left_at`, `duration`, and every connection they made (a reload is a new
 *   one) as PEER_JOINING / PEER_LEAVING events with their times.
 *
 * The count is per participant and exact to the second: each connection from its PEER_JOINING
 * to its PEER_LEAVING, or to now while it is still open. Without events it falls back to
 * `joined_at` to `left_at` (or now), and never below RealtimeKit's own `duration`. The larger of
 * that sum and the session's `minutes_consumed` is used, so a counter that is up to date is
 * never undercut, and one that lags never hides the real number.
 *
 * What this costs. One call lists the live sessions. A session that cannot be near the limit is
 * left there: `max_concurrent_participants` times the minutes since it started is the most it
 * can have used, and most sessions are far below 80% of the limit by that measure. Only the
 * rest are looked at closely: their record (to see that they are webinars, and what was
 * already written), their participants, and at most two writes. Whether a meeting is a webinar
 * never changes, so it is remembered while this Worker instance lives. Nothing here ever joins
 * a session or makes a token anyone uses; the only records written are the two facts above,
 * which nobody joins with. A run never makes more than `MAX_CALLS` calls; what does not fit
 * waits for the next minute, as does anything that failed.
 */

/** The most REST calls one run makes: under 4% of RealtimeKit's 3,500 per five minutes. */
export const MAX_CALLS = 30;
const SESSION_PAGE = 100;
const MAX_SESSION_PAGES = 3;
const RECORD_PAGE = 100;
const MAX_RECORD_PAGES = 20;
/** The most the participants endpoint gives per page. A 250-person webinar is two pages. */
const PEOPLE_PAGE = 200;
const MAX_PEOPLE_PAGES = 5;
const MINUTE = 60_000;

export type CostGuardEnv = Readonly<Record<string, string | undefined>>;

export type CostGuardOptions = {
  env: CostGuardEnv;
  /** The build's media provider. On LiveKit there is no bill per minute and nothing to do. */
  provider: RtcProviderName;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};

export type CostGuardReport = {
  skipped?: "livekit" | "not-configured";
  /** REST calls made. */
  calls: number;
  /** Live sessions of any kind. */
  live: number;
  /** Webinar sessions whose minutes were counted. */
  counted: { session: string; meeting: string; minutes: number }[];
  warned: (LimitWarning & { meeting: string })[];
  ended: { session: string; meeting: string; reason: "limit" | "paused" }[];
  /** Sessions that needed a look but did not fit in this run's calls. */
  deferred: number;
  /** What went wrong. Nothing is thrown: the next run tries again. */
  errors: string[];
};

type Session = {
  id: string;
  associated_id?: string;
  status?: string;
  started_at?: string;
  created_at?: string;
  live_participants?: number;
  max_concurrent_participants?: number;
  minutes_consumed?: number;
};

type PeerEvent = { peer_id?: string; event_name?: string; created_at?: string };

export type SessionParticipant = {
  joined_at?: string;
  left_at?: string;
  duration?: number;
  peer_events?: PeerEvent[];
};

type Record_ = { id: string; custom_participant_id: string; preset_name: string; created_at: string };

class OutOfCalls extends Error {}

/** Whether the record says webinar. E5's record: the "meetly-mode:webinar" marker, read by `readRecord`. */
export function isWebinarMeeting(record: { mode: CallMode }): boolean {
  return record.mode === "webinar";
}

/** Meetings this Worker instance already knows the kind of. The kind of a link never changes. */
const knownModes = new Map<string, CallMode>();
const MAX_KNOWN = 1000;

/** For tests: start each one with nothing remembered. */
export function forgetKnownModes(): void {
  knownModes.clear();
}

const time = (value: string | undefined): number => (value ? Date.parse(value) : NaN);

/**
 * Participant-minutes one person used in the session up to `now`: each connection from joining
 * to leaving, or to now while it is open.
 */
export function participantMinutes(person: SessionParticipant, now: number): number {
  const peers = new Map<string, { joined?: number; left?: number }>();
  for (const event of person.peer_events ?? []) {
    const at = time(event.created_at);
    if (!event.peer_id || Number.isNaN(at)) continue;
    const peer = peers.get(event.peer_id) ?? {};
    if (event.event_name === "PEER_JOINING") peer.joined = Math.min(peer.joined ?? at, at);
    if (event.event_name === "PEER_LEAVING") peer.left = Math.max(peer.left ?? at, at);
    peers.set(event.peer_id, peer);
  }
  let ms = 0;
  for (const { joined, left } of peers.values()) {
    // A connection that never got past the setup screen was never in the session.
    if (joined !== undefined) ms += Math.max(0, (left !== undefined && left >= joined ? left : now) - joined);
  }
  if (peers.size === 0) {
    const joined = time(person.joined_at);
    const left = time(person.left_at);
    if (!Number.isNaN(joined)) ms = Math.max(0, (!Number.isNaN(left) && left >= joined ? left : now) - joined);
  }
  return Math.max(ms / MINUTE, person.duration ?? 0);
}

/** One run of the watchdog. Never throws. */
export async function runCostGuard(options: CostGuardOptions): Promise<CostGuardReport> {
  const report: CostGuardReport = { calls: 0, live: 0, counted: [], warned: [], ended: [], deferred: 0, errors: [] };
  if (options.provider !== "realtimekit") return { ...report, skipped: "livekit" };
  const { env } = options;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const app = env.REALTIMEKIT_APP_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  const guestPreset = env.REALTIMEKIT_GUEST_PRESET;
  if (!account || !app || !token || !guestPreset) return { ...report, skipped: "not-configured" };
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/realtime/kit/${app}`;
  const now = (options.now ?? Date.now)();
  const enabled = webinarsEnabled(env.MEETLY_WEBINARS_ENABLED);
  const limit = webinarMinuteLimit(env.MEETLY_WEBINAR_MINUTE_LIMIT);
  const warnAt = limit * WARN_SHARE;

  /** One REST call, counted. Resolves to null when Cloudflare says no; throws only when out of calls. */
  async function api<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    if (report.calls >= MAX_CALLS) throw new OutOfCalls();
    report.calls++;
    try {
      const response = await options.fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await response.json().catch(() => null)) as { success?: boolean; data?: T } | null;
      if (!response.ok || !json?.success) {
        report.errors.push(`${method} ${path.split("?")[0]}: ${response.status}`);
        return null;
      }
      return (json.data ?? null) as T | null;
    } catch (error) {
      report.errors.push(`${method} ${path.split("?")[0]}: ${error instanceof Error ? error.message : "failed"}`);
      return null;
    }
  }

  async function paged<T>(path: (page: number) => string, pick: (data: unknown) => T[] | undefined, size: number, pages: number): Promise<T[] | null> {
    const all: T[] = [];
    for (let page = 1; page <= pages; page++) {
      const data = await api<unknown>("GET", path(page));
      const items = data === null ? undefined : pick(data);
      if (!items) return null;
      all.push(...items);
      if (items.length < size) break;
    }
    return all;
  }

  // 1. Every live session of the app, in one call (a few more only past 100 at once).
  let sessions: Session[];
  try {
    const found = await paged<Session>(
      (page) => `/sessions?status=LIVE&per_page=${SESSION_PAGE}&page_no=${page}`,
      (data) => (data as { sessions?: Session[] }).sessions,
      SESSION_PAGE,
      MAX_SESSION_PAGES,
    );
    if (!found) return report;
    sessions = found.filter((s) => s.status === undefined || s.status === "LIVE");
  } catch {
    // Out of calls before the list was read: cannot happen with MAX_CALLS above the pages.
    return report;
  }
  report.live = sessions.length;

  // 2. Which could need anything doing. With webinars off, every live one; otherwise only those
  // that could already be at the warning, by the most they can have used.
  const most = (s: Session) => {
    const started = time(s.started_at ?? s.created_at);
    const minutes = Number.isNaN(started) ? Infinity : Math.max(0, now - started) / MINUTE;
    const people = Math.max(s.max_concurrent_participants ?? 0, s.live_participants ?? 0);
    return Math.max(minutes * people, s.minutes_consumed ?? 0);
  };
  const candidates = sessions
    .filter((s) => s.associated_id && knownModes.get(s.associated_id) !== "meeting")
    .filter((s) => (enabled ? most(s) >= warnAt : (s.live_participants ?? 1) > 0))
    // Known webinars first, then the closest to the limit.
    .sort((a, b) => Number(knownModes.has(b.associated_id!)) - Number(knownModes.has(a.associated_id!)) || most(b) - most(a));

  const endAll = async (s: Session, meeting: string, reason: "limit" | "paused") => {
    // Nobody left to remove (the session ends shortly after its last person leaves).
    if ((s.live_participants ?? 1) === 0) return;
    if ((await api("POST", `/meetings/${meeting}/active-session/kick-all`)) !== null) report.ended.push({ session: s.id, meeting, reason });
  };
  const write = async (meeting: string, fact: string) =>
    (await api("POST", `/meetings/${meeting}/participants`, { name: "Meetly record", preset_name: guestPreset, custom_participant_id: fact })) !== null;

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    const meeting = s.associated_id!;
    try {
      // 3. The record: is it a webinar, and what was written already.
      const records = await paged<Record_>(
        (page) => `/meetings/${meeting}/participants?per_page=${RECORD_PAGE}&page_no=${page}`,
        (data) => data as Record_[],
        RECORD_PAGE,
        MAX_RECORD_PAGES,
      );
      if (!records) continue;
      const record = readRecord(records, [], false);
      if (knownModes.size >= MAX_KNOWN) knownModes.clear();
      knownModes.set(meeting, record.mode);
      if (!isWebinarMeeting(record)) continue;

      if (!enabled) {
        await endAll(s, meeting, "paused");
        continue;
      }
      // Already over the limit (a removal that failed, or someone in on an old token): remove
      // again. The fact is not written twice.
      if (record.limit.limited.length > 0) {
        await endAll(s, meeting, "limit");
        continue;
      }

      // 4. The minutes, per participant.
      const people = await paged<SessionParticipant>(
        (page) => `/sessions/${s.id}/participants?include_peer_events=true&per_page=${PEOPLE_PAGE}&page_no=${page}`,
        (data) => (data as { participants?: SessionParticipant[] }).participants,
        PEOPLE_PAGE,
        MAX_PEOPLE_PAGES,
      );
      if (!people) continue;
      const counted = people.reduce((sum, person) => sum + participantMinutes(person, now), 0);
      const minutes = Math.max(counted, s.minutes_consumed ?? 0);
      report.counted.push({ session: s.id, meeting, minutes });

      if (minutes > limit) {
        // Marked first, so that whoever is removed can find out why. If that fails, nobody is
        // removed this minute: an ending nobody can explain is worse than a minute more.
        if (await write(meeting, limitFact(s.id))) await endAll(s, meeting, "limit");
        continue;
      }
      if (minutes >= warnAt && !record.limit.warnings.some((w) => w.session === s.id)) {
        // At the current rate: everyone connected now uses a minute a minute.
        const rate = Math.max(1, s.live_participants ?? 1);
        const warning = { session: s.id, endsAt: now + ((limit - minutes) / rate) * MINUTE };
        if (await write(meeting, limitWarningFact(warning))) report.warned.push({ ...warning, meeting });
      }
    } catch (error) {
      if (error instanceof OutOfCalls) {
        report.deferred = candidates.length - i;
        break;
      }
      report.errors.push(`session ${s.id}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  return report;
}

/**
 * What the Cron Trigger calls. `env` is the Worker's: its vars and secrets. RealtimeKit only:
 * the Worker is built for it (`.env.production` on the cloudflare-deploy branch).
 */
export async function runScheduledCostGuard(env: CostGuardEnv): Promise<CostGuardReport> {
  const report = await runCostGuard({ env, provider: "realtimekit", fetch: (url, init) => fetch(url, init) });
  // One line a minute in the Worker's logs; more only when something happened.
  const busy = report.warned.length + report.ended.length + report.errors.length + report.deferred > 0;
  (busy ? console.warn : console.log)(`cost guard: ${JSON.stringify(report)}`);
  return report;
}
