import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

/**
 * POST /api/meeting { action: "peek" } on a RealtimeKit build. How many people are in the meeting
 * comes from the active session's `live_participants`: one REST call per pre-join screen. The
 * SDK's `getAllJoinedPeers()` (10 calls a minute) is never involved. Cloudflare's API is stood in
 * for at `fetch`, so this shows what is asked, not how the real API answers.
 */

// The provider is fixed when the app loads; this file runs in a process of its own.
process.env.NEXT_PUBLIC_RTC_PROVIDER = "realtimekit";
const { POST } = await import("../src/app/api/meeting/route");

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  process.env.REALTIMEKIT_APP_ID = "app";
  process.env.REALTIMEKIT_HOST_PRESET = "meetly-host";
  process.env.REALTIMEKIT_GUEST_PRESET = "meetly-guest";
  process.env.CLOUDFLARE_API_TOKEN = "token";
  process.env.MEETLY_SESSION_SECRET = "session-secret-session-secret";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
});

const CODE = "abc-defg-hij";
const peek = async () => {
  const response = await POST(new Request("http://meetly.test/api/meeting", { method: "POST", body: JSON.stringify({ action: "peek", code: CODE }) }));
  return { status: response.status, body: await response.json() };
};

/** Cloudflare, with a meeting for CODE (unless `noMeeting`) and the given active session answer. */
function cloudflare(session: { status: number; data?: Record<string, unknown> }, noMeeting = false) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: URL | string) => {
    const path = String(url).replace(/^.*\/realtime\/kit\/app/, "").replace(/\?.*$/, "");
    asked.push(path);
    const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
    if (path === "/meetings") return ok(noMeeting ? [] : [{ id: "meeting-1", title: CODE, created_at: "2026-11-20T10:00:00Z" }]);
    if (path === "/meetings/meeting-1/participants") return ok([]);
    if (path === "/meetings/meeting-1/active-session") {
      return session.status === 200 ? ok(session.data) : new Response(JSON.stringify({ success: false }), { status: session.status });
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return asked;
}

test("peek (RealtimeKit): the count is the active session's live participants, asked once", async () => {
  const asked = cloudflare({ status: 200, data: { status: "LIVE", live_participants: 9 } });
  assert.deepEqual(await peek(), { status: 200, body: { access: "open", host: false, count: 9 } });
  assert.deepEqual(asked.sort(), ["/meetings", "/meetings/meeting-1/active-session", "/meetings/meeting-1/participants"]);
});

test("peek (RealtimeKit): no session, an ended one, or no meeting at all means nobody is there", async () => {
  cloudflare({ status: 404 });
  assert.equal((await peek()).body.count, 0);
  cloudflare({ status: 200, data: { status: "ENDED", live_participants: 4 } });
  assert.equal((await peek()).body.count, 0);
  const asked = cloudflare({ status: 200 }, true);
  assert.equal((await peek()).body.count, 0);
  assert.deepEqual(asked, ["/meetings"]);
});

test("peek (RealtimeKit): when Cloudflare will not say, the count is unknown and the rest still answers", async () => {
  cloudflare({ status: 500 });
  assert.deepEqual((await peek()).body, { access: "open", host: false, count: null });
  cloudflare({ status: 200, data: { status: "LIVE" } });
  assert.equal((await peek()).body.count, null);
  delete process.env.CLOUDFLARE_API_TOKEN;
  assert.equal((await peek()).body.count, null);
});
