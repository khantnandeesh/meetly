import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

/**
 * Webinars on a RealtimeKit build, server side: making one, the presets people are given, the
 * audience limit and who may change the stage. Cloudflare's REST API is a stand-in below, shaped
 * after the API reference (rtk docs api_*.txt); nothing here calls Cloudflare.
 *
 * The provider is fixed when the routes load, so this file sets it first and loads them after.
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
const WEBINAR_PRESETS = {
  REALTIMEKIT_WEBINAR_HOST_PRESET: "meetly-webinar-host",
  REALTIMEKIT_WEBINAR_VIEWER_PRESET: "meetly-webinar-viewer",
  REALTIMEKIT_WEBINAR_COHOST_PRESET: "meetly-webinar-cohost",
};

const { POST: meetingRoute } = await import("../src/app/api/meeting/route");
const { POST: tokenRoute } = await import("../src/app/api/token/route");
const { readRecord, realtimeKitHostAction } = await import("../src/lib/rtc/server/realtimekit");

type Participant = { id: string; custom_participant_id: string; preset_name: string; name: string; created_at: string };
type Meeting = { id: string; title: string; created_at: string; participants: Participant[]; live: number | null };

/** Cloudflare's RealtimeKit REST API, as far as Meetly's server uses it. */
class FakeCloudflare {
  meetings: Meeting[] = [];
  calls: string[] = [];
  private count = 0;
  private real: typeof fetch | null = null;
  install() {
    this.real = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      assert.equal(url.host, "api.cloudflare.com");
      const path = url.pathname.replace("/client/v4/accounts/acct/realtime/kit/app", "");
      const method = init?.method ?? "GET";
      this.calls.push(`${method} ${path}`);
      return this.answer(method, path, url.searchParams, JSON.parse(String(init?.body ?? "{}")));
    }) as typeof fetch;
    return this;
  }
  restore() {
    if (this.real) globalThis.fetch = this.real;
  }
  private answer(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Response {
    const ok = (data: unknown) => Response.json({ success: true, data });
    const now = new Date(Date.UTC(2026, 10, 20, 0, 0, this.count)).toISOString();
    const parts = path.split("/").filter(Boolean);
    if (method === "GET" && path === "/meetings") return ok(this.meetings.filter((m) => m.title.includes(query.get("search") ?? "")));
    if (method === "POST" && path === "/meetings") {
      const meeting = { id: `mtg-${++this.count}`, title: String(body.title), created_at: now, participants: [], live: null };
      this.meetings.push(meeting);
      return ok(meeting);
    }
    const meeting = this.meetings.find((m) => m.id === parts[1]);
    if (!meeting) return Response.json({ success: false }, { status: 404 });
    if (parts[2] === "active-session") {
      return meeting.live === null ? Response.json({ success: false }, { status: 404 }) : ok({ status: "LIVE", live_participants: meeting.live });
    }
    if (parts[2] === "participants" && method === "GET") return ok(query.get("page_no") === "1" ? meeting.participants : []);
    if (parts[2] === "participants" && method === "POST" && parts.length === 3) {
      const person = {
        id: `p-${++this.count}`,
        custom_participant_id: String(body.custom_participant_id),
        preset_name: String(body.preset_name),
        name: String(body.name),
        created_at: now,
      };
      meeting.participants.push(person);
      return ok({ ...person, token: `token-${person.id}` });
    }
    return ok({});
  }
}

let cf: FakeCloudflare;
beforeEach(() => {
  Object.assign(process.env, WEBINAR_PRESETS);
  delete process.env.MEETLY_WEBINAR_VIEWER_CAP;
  cf = new FakeCloudflare().install();
});
afterEach(() => cf.restore());

const post = (body: unknown, cookie = "") =>
  new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} });

async function newWebinar() {
  const response = await meetingRoute(post({ action: "create", mode: "webinar" }));
  const body = (await response.json()) as { code?: string; error?: string };
  return { status: response.status, body, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

async function join(code: string, name: string, cookie = "") {
  const response = await tokenRoute(post({ room: code, name }, cookie));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("rtk: without both webinar presets, New webinar fails with a clear error and nothing is made", async () => {
  delete process.env.REALTIMEKIT_WEBINAR_VIEWER_PRESET;
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    const made = await newWebinar();
    assert.deepEqual([made.status, made.body], [500, { error: "Webinars aren't set up on this server yet." }]);
    assert.match(String(errors[0]), /REALTIMEKIT_WEBINAR_VIEWER_PRESET/, "the missing name is logged for whoever runs the site");
    assert.deepEqual(cf.calls, []);
  } finally {
    console.error = log;
  }
  // Meetings carry on without them.
  assert.equal((await meetingRoute(post({ action: "create" }))).status, 200);
});

test("rtk: New webinar marks the meeting a webinar before its host's record exists, with the webinar host's preset", async () => {
  const made = await newWebinar();
  assert.equal(made.status, 200);
  const [meeting] = cf.meetings;
  assert.equal(meeting.title, made.body.code);
  assert.deepEqual(
    meeting.participants.map((p) => [p.custom_participant_id.startsWith("m-") ? "host" : p.custom_participant_id, p.preset_name]),
    [
      ["meetly-mode:webinar", "meetly-guest"],
      ["host", "meetly-webinar-host"],
    ],
  );
  const record = readRecord(meeting.participants, ["meetly-host", "meetly-webinar-host"], false);
  assert.equal(record.mode, "webinar");
  assert.equal(record.hosts.length, 1);
  assert.equal(readRecord([], "meetly-host", false).mode, "meeting");
  const peek = await meetingRoute(post({ action: "peek", code: made.body.code }, made.cookie));
  assert.deepEqual(await peek.json(), { access: "open", host: true, count: 0, mode: "webinar" });
});

test("rtk: the host rejoins as host on the webinar host preset; the audience gets the viewer preset and no ask to join", async () => {
  const { body, cookie } = await newWebinar();
  const code = String(body.code);
  const host = await join(code, "Hana", cookie);
  assert.equal(host.status, 200);
  assert.deepEqual([host.body.role, host.body.mode, host.body.hostPreset], ["host", "webinar", "meetly-webinar-host"]);
  const viewer = await join(code, "Vic");
  assert.equal(viewer.status, 200);
  assert.deepEqual([viewer.body.role, viewer.body.mode, viewer.body.hostPreset, viewer.body.canAsk], ["guest", "webinar", "meetly-webinar-host", false]);
  const record = cf.meetings[0].participants.find((p) => p.name === "Vic");
  assert.equal(record?.preset_name, "meetly-webinar-viewer");
});

test("rtk: at the limit the audience is told the webinar is full, counted from the active session, and the host still gets in", async () => {
  process.env.MEETLY_WEBINAR_VIEWER_CAP = "3";
  const { body, cookie } = await newWebinar();
  const code = String(body.code);
  cf.meetings[0].live = 2;
  assert.equal((await join(code, "Vic")).status, 200);
  cf.meetings[0].live = 3;
  const full = await join(code, "Wendy");
  assert.deepEqual([full.status, full.body], [403, { error: "This webinar is full. Try again in a few minutes.", reason: "full" }]);
  assert.equal((await join(code, "Hana", cookie)).status, 200);
  assert.ok(cf.calls.every((call) => !call.includes("joined")), "no peer listing");
});

test("rtk: only the host or a co-host may change someone's place on stage, and only in a webinar", async () => {
  const { body, cookie } = await newWebinar();
  const code = String(body.code);
  const host = await join(code, "Hana", cookie);
  const vic = await join(code, "Vic");
  const wes = await join(code, "Wes");
  const vicId = cf.meetings[0].participants.find((p) => p.name === "Vic")!.custom_participant_id;
  const stage = { action: "stage" as const, identity: vicId, on: true };
  assert.equal((await realtimeKitHostAction(host.body.session, stage)).status, 200);
  assert.equal((await realtimeKitHostAction(wes.body.session, stage)).status, 403, "a viewer cannot invite someone else");
  assert.equal((await realtimeKitHostAction(vic.body.session, stage)).status, 403, "nor themselves: taking up an invitation is the stage's, not the server's");
  const hostId = cf.meetings[0].participants.find((p) => p.preset_name === "meetly-webinar-host")!.custom_participant_id;
  assert.equal((await realtimeKitHostAction(host.body.session, { ...stage, identity: "m-nobody" })).status, 404);
  assert.equal((await realtimeKitHostAction(host.body.session, { ...stage, identity: hostId })).status, 400);

  // A meeting has no stage.
  const meeting = await meetingRoute(post({ action: "create" }));
  const meetingCookie = (meeting.headers.get("set-cookie") ?? "").split(";")[0];
  const meetingCode = ((await meeting.json()) as { code: string }).code;
  const meetingHost = await join(meetingCode, "Hal", meetingCookie);
  const guest = await join(meetingCode, "Gus");
  assert.equal(guest.body.mode, "meeting");
  const guestId = cf.meetings[1].participants.find((p) => p.name === "Gus")!.custom_participant_id;
  const refused = await realtimeKitHostAction(meetingHost.body.session, { action: "stage", identity: guestId, on: true });
  assert.deepEqual(refused, { status: 400, error: "Only a webinar has a stage." });
});
