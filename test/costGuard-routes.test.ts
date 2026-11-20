import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";
import { FakeRealtimeKitApi } from "./fake-realtimekit";

/**
 * The token route, the meeting route and the "roles" answer on a RealtimeKit build, against the
 * fake REST API: webinars switched off, and a webinar that reached its free time limit. Node runs
 * each test file in its own process, so the build's provider can be chosen here before the
 * routes are loaded.
 */

const ENV = {
  NEXT_PUBLIC_RTC_PROVIDER: "realtimekit",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  REALTIMEKIT_APP_ID: "app",
  REALTIMEKIT_HOST_PRESET: "meetly-host",
  REALTIMEKIT_GUEST_PRESET: "meetly-guest",
  REALTIMEKIT_WEBINAR_HOST_PRESET: "meetly-webinar-host",
  REALTIMEKIT_WEBINAR_VIEWER_PRESET: "meetly-webinar-viewer",
  CLOUDFLARE_API_TOKEN: "token",
  MEETLY_SESSION_SECRET: "a-long-random-test-secret-a-long-random-test-secret",
};
Object.assign(process.env, ENV);

type Route = { POST: (request: Request) => Promise<Response> };
let token: Route;
let meetingRoute: Route;
let host: Route;
let api: FakeRealtimeKitApi;
const realFetch = globalThis.fetch;

before(async () => {
  token = await import("../src/app/api/token/route");
  meetingRoute = await import("../src/app/api/meeting/route");
  host = await import("../src/app/api/host/route");
});

beforeEach(() => {
  api = new FakeRealtimeKitApi();
  globalThis.fetch = api.fetch as typeof fetch;
  delete process.env.MEETLY_WEBINARS_ENABLED;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MEETLY_WEBINARS_ENABLED;
});

const post = (route: Route, path: string, body: unknown, cookie?: string) =>
  route.POST(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );

/** A webinar made the way the home page makes one: its code, and the host browser's cookie. */
async function newWebinar(): Promise<{ code: string; cookie: string; meetingId: string }> {
  const made = await post(meetingRoute, "/api/meeting", { action: "create", mode: "webinar" });
  assert.equal(made.status, 200);
  const { code } = (await made.json()) as { code: string };
  const cookie = made.headers.get("set-cookie")!.split(";")[0];
  return { code, cookie, meetingId: api.meetings.find((m) => m.title === code)!.id };
}

const join = (code: string, name: string, cookie?: string) => post(token, "/api/token", { room: code, name }, cookie);

test("with webinars on, the host and a viewer get in", async () => {
  const { code, cookie } = await newWebinar();
  const hosted = await join(code, "Hana", cookie);
  assert.equal(hosted.status, 200);
  assert.equal(((await hosted.json()) as { role: string }).role, "host");
  const viewer = await join(code, "Vic");
  assert.equal(viewer.status, 200);
  assert.equal(((await viewer.json()) as { mode: string }).mode, "webinar");
});

test("switched off: a webinar cannot be started, the home page is told, and nobody gets a token, the host included", async () => {
  const { code, cookie, meetingId } = await newWebinar();
  process.env.MEETLY_WEBINARS_ENABLED = "0";

  const made = await post(meetingRoute, "/api/meeting", { action: "create", mode: "webinar" });
  assert.equal(made.status, 403);
  assert.deepEqual(await made.json(), { error: "Webinars are paused right now.", reason: "paused" });
  const offered = await post(meetingRoute, "/api/meeting", { action: "webinars" });
  assert.deepEqual(await offered.json(), { enabled: false });

  const before = api.records.get(meetingId)!.length;
  for (const response of [await join(code, "Vic"), await join(code, "Hana", cookie)]) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Webinars are paused right now.", reason: "paused" });
  }
  // Refused before anyone was added: no participant record, no token.
  assert.equal(api.records.get(meetingId)!.length, before);

  // Ordinary meetings carry on.
  const meeting = await post(meetingRoute, "/api/meeting", { action: "create" });
  const { code: meetingCode } = (await meeting.json()) as { code: string };
  assert.equal((await join(meetingCode, "Mo")).status, 200);

  process.env.MEETLY_WEBINARS_ENABLED = "1";
  assert.deepEqual(await (await post(meetingRoute, "/api/meeting", { action: "webinars" })).json(), { enabled: true });
  assert.equal((await join(code, "Vic")).status, 200);
});

test("after the limit: the link refuses everyone with the same sentence as the leave screen", async () => {
  const { code, cookie, meetingId } = await newWebinar();
  api.record(meetingId, "meetly-limit:session-1");
  for (const response of [await join(code, "Vic"), await join(code, "Hana", cookie)]) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "This webinar reached its free time limit.", reason: "limit" });
  }
  // A limit fact in an ordinary meeting's record means nothing: only webinars are limited.
  const meeting = await post(meetingRoute, "/api/meeting", { action: "create" });
  const { code: meetingCode } = (await meeting.json()) as { code: string };
  api.record(api.meetings.find((m) => m.title === meetingCode)!.id, "meetly-limit:session-2");
  assert.equal((await join(meetingCode, "Mo")).status, 200);
});

test("a removed client can ask why; only the host and co-hosts are given the warning", async () => {
  const { code, cookie, meetingId } = await newWebinar();
  const hostSession = ((await (await join(code, "Hana", cookie)).json()) as { session: string }).session;
  const viewerSession = ((await (await join(code, "Vic")).json()) as { session: string }).session;
  const roles = async (session: string) => (await (await post(host, "/api/host", { session, action: "roles" })).json()) as Record<string, unknown>;

  assert.equal((await roles(viewerSession)).stopped, undefined);
  api.record(meetingId, "meetly-limit-warning:session-1:1800000000000");
  assert.deepEqual((await roles(hostSession)).warning, { session: "session-1", endsAt: 1800000000000 });
  assert.equal((await roles(viewerSession)).warning, undefined);

  api.record(meetingId, "meetly-limit:session-1");
  assert.equal((await roles(viewerSession)).stopped, "limit");
  process.env.MEETLY_WEBINARS_ENABLED = "off";
  assert.equal((await roles(viewerSession)).stopped, "paused");
});
