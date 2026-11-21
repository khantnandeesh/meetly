import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeRealtimeKitApi } from "./fake-realtimekit";

/**
 * Where the meeting timer's start comes from on RealtimeKit: the active session's `started_at`,
 * read once when someone joins (GET /meetings/{id}/active-session), and shared with the other
 * questions a join asks of that session, so a join costs no more REST calls than before.
 *
 * Cloudflare is the stand-in in ./fake-realtimekit.ts, shaped after the REST reference. It shows
 * what is asked and what is done with the answer, not how the real API answers.
 */
Object.assign(process.env, {
  NEXT_PUBLIC_RTC_PROVIDER: "realtimekit",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  REALTIMEKIT_APP_ID: "app",
  REALTIMEKIT_HOST_PRESET: "meetly-host",
  REALTIMEKIT_GUEST_PRESET: "meetly-guest",
  CLOUDFLARE_API_TOKEN: "not-a-real-token",
  MEETLY_SESSION_SECRET: "a-test-secret-a-test-secret",
});

const { POST: meetingRoute } = await import("../src/app/api/meeting/route");
const { POST: tokenRoute } = await import("../src/app/api/token/route");
const { sessionStarted } = await import("../src/lib/rtc/server/realtimekit");

let cf: FakeRealtimeKitApi;
const realFetch = globalThis.fetch;
beforeEach(() => {
  cf = new FakeRealtimeKitApi();
  globalThis.fetch = cf.fetch as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.REALTIMEKIT_KNOCK_PRESET;
});

const post = (body: unknown, cookie = "") =>
  new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} });
const join = async (code: string, name: string, cookie = "") => {
  const response = await tokenRoute(post({ room: code, name }, cookie));
  assert.equal(response.status, 200);
  return (await response.json()) as { started?: number | "now" };
};
const sessionReads = () => cf.calls.filter((c) => c.startsWith("GET /meetings/") && c.includes("/active-session")).length;

test("sessionStarted: started_at of a live session; 'now' with none; unknown when Cloudflare will not say", () => {
  const now = Date.parse("2026-11-21T10:00:00Z");
  const live = (data: Record<string, unknown>) => ({ ok: true as const, status: 200, data });
  assert.equal(sessionStarted(live({ status: "LIVE", live_participants: 4, started_at: "2026-11-21T09:36:45Z" }), now), 23 * 60_000 + 15_000);
  assert.equal(sessionStarted({ ok: false, status: 404, data: null }, now), "now");
  assert.equal(sessionStarted(live({ status: "ENDED", started_at: "2026-11-21T08:00:00Z" }), now), "now");
  assert.equal(sessionStarted(live({ status: "LIVE", live_participants: 0, started_at: "2026-11-21T08:00:00Z" }), now), "now");
  assert.equal(sessionStarted({ ok: false, status: 429, data: null }, now), undefined, "rate-limited: not known");
  assert.equal(sessionStarted(live({ status: "LIVE", live_participants: 2 }), now), undefined);
  assert.equal(sessionStarted(live({ status: "LIVE", started_at: "2026-11-21T10:00:05Z" }), now), 0, "a clock a little ahead is not a negative age");
});

test("RealtimeKit: a guest is told how long ago the session began, with one active-session read for the whole join", async () => {
  cf.meeting("meeting-1", "abc-defg-hij");
  cf.record("meeting-1", "m-host", "meetly-host", "Hana");
  cf.live("meeting-1", { minutesAgo: 23, people: 2 });
  const guest = await join("abc-defg-hij", "Gus");
  assert.equal(typeof guest.started, "number");
  assert.ok(Math.abs((guest.started as number) - 23 * 60_000) < 2_000, String(guest.started));
  assert.equal(sessionReads(), 1, "who is host and when it began share one read");
});

test("RealtimeKit: the host coming back is told too; nothing is under way, so it begins with them", async () => {
  const made = await meetingRoute(post({ action: "create" }));
  const { code } = (await made.json()) as { code: string };
  const cookie = (made.headers.get("set-cookie") ?? "").split(";")[0];
  cf.calls.length = 0;
  assert.equal((await join(code, "Hana", cookie)).started, "now");
  assert.equal(sessionReads(), 1);
  // In a session that started 40 minutes ago (they reloaded, say), the host is told so.
  cf.live(cf.meetings[0].id, { minutesAgo: 40, people: 1 });
  const back = await join(code, "Hana", cookie);
  assert.ok(Math.abs((back.started as number) - 40 * 60_000) < 2_000, String(back.started));
});

test("RealtimeKit: a code typed by hand, used for the first time, begins with its first person and asks nothing more", async () => {
  const first = await join("new-code-abc", "Fay");
  assert.equal(first.started, "now");
  assert.equal(sessionReads(), 0);
});

test("RealtimeKit: if the session cannot be read, the join still works and the start is simply not known", async () => {
  cf.meeting("meeting-1", "abc-defg-hij");
  cf.record("meeting-1", "m-host", "meetly-host", "Hana");
  cf.failing.push({ match: /active-session$/, status: 429 });
  const guest = await join("abc-defg-hij", "Gus");
  assert.equal(guest.started, undefined);
});

test("RealtimeKit: someone who has to ask, at an empty meeting, begins nothing and is told nothing", async () => {
  process.env.REALTIMEKIT_KNOCK_PRESET = "meetly-knock";
  cf.meeting("meeting-1", "abc-defg-hij");
  cf.record("meeting-1", "m-host", "meetly-host", "Hana");
  cf.record("meeting-1", "meetly-access:ask");
  assert.equal((await join("abc-defg-hij", "Kai")).started, undefined);
  cf.live("meeting-1", { minutesAgo: 5, people: 1 });
  assert.equal(typeof (await join("abc-defg-hij", "Kai")).started, "number");
});
