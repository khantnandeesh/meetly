import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { RoomEvent, type Room } from "livekit-client";
import { POST as chatRoute } from "../src/app/api/chat/route";
import { POST as hostRoute } from "../src/app/api/host/route";
import { POST as meetingRoute } from "../src/app/api/meeting/route";
import { POST as tokenRoute } from "../src/app/api/token/route";
import { createCall as createLiveKitCall } from "../src/lib/rtc/livekit";
import { RealtimeKitCall, type MeetingFactory } from "../src/lib/rtc/realtimekit";
import type { HostApi } from "../src/lib/rtc/shared";
import { DEFAULT_VIEWER_CAP, STAGE_ATTRIBUTE, STAGE_INVITED, audienceOrder, viewerCap } from "../src/lib/rtc/stage";
import type { JoinChoices, JoinGrant, RtcCall, RtcParticipant } from "../src/lib/rtc/types";
import { WEBINAR_FULL, webinarGate } from "../src/lib/webinarGate.server";
import { FakeLiveKitServer } from "./fake-livekit-server";
import { FakeMeeting, FakeParticipant, FakeSelf, installDom } from "./fake-realtimekit";

/**
 * Webinars: making one, joining it as host or audience, the audience limit, and bringing someone
 * on stage, on both providers. The servers here are stand-ins (./fake-livekit-server.ts, and
 * RealtimeKit's REST API in ./webinar-rtk.test.ts); the browser tests in test/e2e/webinar.cjs
 * run the LiveKit half against a real LiveKit server.
 */

const choices: JoinChoices = { username: "Ada", audioEnabled: false, videoEnabled: false, audioDeviceId: "", videoDeviceId: "" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------- the limit */

test("the audience limit is 250 unless MEETLY_WEBINAR_VIEWER_CAP is a positive whole number", () => {
  assert.equal(DEFAULT_VIEWER_CAP, 250);
  assert.equal(viewerCap(undefined), 250);
  assert.equal(viewerCap(""), 250);
  assert.equal(viewerCap("40"), 40);
  for (const wrong of ["0", "-3", "2.5", "many"]) assert.equal(viewerCap(wrong), 250, wrong);
});

test("the gate lets the host in whatever the count, turns the audience away at the limit, and stays open when the count is unknown", async () => {
  let asked = 0;
  const count = (n: number | null) => async () => (asked++, n);
  assert.equal(await webinarGate({ host: true, watching: count(10_000) }), null);
  assert.equal(asked, 0, "the host's join costs no count");
  assert.equal(await webinarGate({ host: false, watching: count(249) }), null);
  assert.deepEqual(await webinarGate({ host: false, watching: count(250) }), WEBINAR_FULL);
  assert.equal(await webinarGate({ host: false, watching: count(null) }), null);
  assert.equal(await webinarGate({ host: false, watching: async () => Promise.reject(new Error("down")) }), null);
  assert.equal(WEBINAR_FULL.message, "This webinar is full. Try again in a few minutes.");
});

/* -------------------------------------------- LiveKit: server and routes */

let lk: FakeLiveKitServer;
const env = { LIVEKIT_URL: "http://livekit.test", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret" };

beforeEach(() => {
  installDom();
  Object.assign(process.env, env);
  delete process.env.MEETLY_WEBINAR_VIEWER_CAP;
  lk = new FakeLiveKitServer().install();
});
afterEach(() => lk.restore());

const post = (body: unknown, cookie = "") =>
  new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} });
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));

/** Makes a webinar as its host would, from the home page. Returns its code and the host's cookie. */
async function newWebinar(mode: "webinar" | "meeting" = "webinar") {
  const response = await meetingRoute(post({ action: "create", ...(mode === "webinar" ? { mode } : {}) }));
  assert.equal(response.status, 200);
  const { code } = (await response.json()) as { code: string };
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  return { code, cookie };
}

async function joinAs(code: string, name: string, cookie = "") {
  const response = await tokenRoute(post({ room: code, name }, cookie));
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body, grant: typeof body.token === "string" ? claims(body.token) : null };
}

test("livekit: New webinar writes the type into the meeting's record, once", async () => {
  const { code } = await newWebinar();
  assert.equal(lk.meta(code).mode, "webinar");
  const meeting = await newWebinar("meeting");
  assert.equal(lk.meta(meeting.code).mode, undefined, "a meeting is a meeting");
  const peek = await meetingRoute(post({ action: "peek", code }));
  assert.equal(((await peek.json()) as { mode?: string }).mode, "webinar");
});

test("livekit: a webinar is not handed out when its record could not be made", async () => {
  lk.restore();
  globalThis.fetch = (async () => Promise.reject(new Error("unreachable"))) as typeof fetch;
  const failed = await meetingRoute(post({ action: "create", mode: "webinar" }));
  assert.equal(failed.status, 502);
  assert.match(((await failed.json()) as { error: string }).error, /Couldn't start the webinar/);
  // A meeting still gets its code: the first person in becomes host.
  assert.equal((await meetingRoute(post({ action: "create" }))).status, 200);
});

test("livekit: the host's token can publish, a viewer's cannot, and both say it is a webinar", async () => {
  const { code, cookie } = await newWebinar();
  const host = await joinAs(code, "Hana", cookie);
  assert.equal(host.status, 200);
  assert.equal(host.body.mode, "webinar");
  assert.equal(host.grant.video.canPublish, true);
  const viewer = await joinAs(code, "Vic");
  assert.equal(viewer.status, 200);
  assert.equal(viewer.body.mode, "webinar");
  assert.equal(viewer.grant.video.room, code);
  assert.equal(viewer.grant.video.canPublish, false);
  assert.equal(viewer.grant.video.canSubscribe, true);
  assert.equal(viewer.grant.video.canPublishData, true, "reactions");
  assert.equal(viewer.grant.video.canUpdateOwnMetadata, true, "raising a hand");
  // In a meeting nothing changes.
  const meeting = await newWebinar("meeting");
  const guest = await joinAs(meeting.code, "Gus");
  assert.equal(guest.body.mode, undefined);
  assert.equal(guest.grant.video.canPublish, true);
});

test("livekit: at the limit the audience is told the webinar is full, and the host still gets in", async () => {
  process.env.MEETLY_WEBINAR_VIEWER_CAP = "2";
  const { code, cookie } = await newWebinar();
  lk.join(code, "host", { canPublish: true, canSubscribe: true });
  lk.join(code, "speaker", { canPublish: true, canSubscribe: true });
  lk.join(code, "v1", { canSubscribe: true });
  assert.equal((await joinAs(code, "Vic")).status, 200, "the stage does not count against the audience");
  lk.join(code, "v2", { canSubscribe: true });
  const full = await joinAs(code, "Wendy");
  assert.equal(full.status, 403);
  assert.deepEqual(full.body, { error: "This webinar is full. Try again in a few minutes.", reason: "full" });
  assert.equal((await joinAs(code, "Hana", cookie)).status, 200);
});

/** Puts a host and a viewer in a webinar and returns tokens that prove who they are to /api/host. */
async function webinarWithViewer() {
  const { code, cookie } = await newWebinar();
  const host = await joinAs(code, "Hana", cookie);
  const viewer = await joinAs(code, "Vic");
  lk.join(code, host.grant.sub, { canPublish: true, canSubscribe: true }, "Hana");
  const person = lk.join(code, viewer.grant.sub, { canSubscribe: true, canPublishData: true, canUpdateMetadata: true }, "Vic");
  return { code, host: { token: String(host.body.token), id: host.grant.sub }, viewer: { token: String(viewer.body.token), id: viewer.grant.sub }, person };
}

const stage = async (token: string, identity: string, on: boolean) => {
  const response = await hostRoute(post({ token, action: "stage", identity, on }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

test("livekit: inviting someone on stage gives them the right to publish and marks them invited, through RoomService", async () => {
  const { host, viewer, person } = await webinarWithViewer();
  assert.equal((await stage(host.token, viewer.id, true)).status, 200);
  assert.equal(person.permission.canPublish, true);
  assert.equal(person.attributes[STAGE_ATTRIBUTE], STAGE_INVITED);
  assert.ok(lk.calls.some((call) => call.method === "UpdateParticipant"));
  // Back to audience, from the host's side: the right goes, and the mark with it.
  assert.equal((await stage(host.token, viewer.id, false)).status, 200);
  assert.equal(person.permission.canPublish ?? false, false);
  assert.equal(person.attributes[STAGE_ATTRIBUTE], undefined);
});

test("livekit: nobody is ever seen with the right to publish and no invitation mark, on the way in or out", async () => {
  const { host, viewer } = await webinarWithViewer();
  const updates = () =>
    lk.calls
      .filter((call) => call.method === "UpdateParticipant")
      .map((call) => (call.body.permission ? `publish:${!!(call.body.permission as { canPublish?: boolean }).canPublish}` : `mark:${(call.body.attributes as Record<string, string>)[STAGE_ATTRIBUTE]}`));
  await stage(host.token, viewer.id, true);
  assert.deepEqual(updates(), [`mark:${STAGE_INVITED}`, "publish:true"]);
  await stage(host.token, viewer.id, false);
  assert.deepEqual(updates().slice(2), ["publish:false", "mark:"]);
});

test("livekit: a viewer can step down by themselves but cannot invite anyone, themselves included, or move the host", async () => {
  const { host, viewer, person } = await webinarWithViewer();
  assert.equal((await stage(viewer.token, viewer.id, true)).status, 400, "nobody puts themselves on stage");
  assert.equal((await stage(viewer.token, host.id, false)).status, 403);
  assert.equal(person.permission.canPublish ?? false, false);
  await stage(host.token, viewer.id, true);
  assert.equal((await stage(viewer.token, viewer.id, false)).status, 200, "Not now, and Back to audience, are theirs to say");
  assert.equal(person.permission.canPublish ?? false, false);
  const self = await stage(host.token, host.id, false);
  assert.deepEqual(self, { status: 400, body: { error: "The host stays on stage." } });
});

test("livekit: the audience reads the chat but cannot write in it; the host and the stage can", async () => {
  const { host, viewer } = await webinarWithViewer();
  const send = async (token: string) => (await chatRoute(post({ token, action: "send", text: "Hello" }))).status;
  const refused = await chatRoute(post({ token: viewer.token, action: "send", text: "Hello" }));
  assert.deepEqual([refused.status, await refused.json()], [403, { error: "Only speakers and hosts can send messages." }]);
  assert.equal(await send(host.token), 200);
  await stage(host.token, viewer.id, true);
  assert.equal(await send(viewer.token), 200, "on stage, or invited");
});

test("livekit: a co-host chats from the audience; a speaker sent back to the audience cannot", async () => {
  const { code, host, viewer } = await webinarWithViewer();
  const meta = lk.meta(code);
  const send = async (token: string) => (await chatRoute(post({ token, action: "send", text: "Hello" }))).status;
  lk.rooms.get(code)!.metadata = JSON.stringify({ ...meta, cohosts: [viewer.id] });
  assert.equal(await send(viewer.token), 200, "a co-host off stage");
  lk.rooms.get(code)!.metadata = JSON.stringify({ ...meta, cohosts: [] });
  await stage(host.token, viewer.id, true);
  assert.equal(await send(viewer.token), 200, "on stage");
  await stage(host.token, viewer.id, false);
  assert.equal(await send(viewer.token), 403, "back in the audience, a forced send is refused");
});

test("livekit: someone whose role changed gets a fresh token for the same identity, keeping what they may publish", async () => {
  const { host, viewer } = await webinarWithViewer();
  const rejoin = async (token: string) => {
    const response = await hostRoute(post({ token, action: "rejoin" }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const off = await rejoin(viewer.token);
  assert.equal(off.status, 200);
  assert.deepEqual([claims(String(off.body.token)).sub, claims(String(off.body.token)).video.canPublish], [viewer.id, false]);
  await stage(host.token, viewer.id, true);
  const on = await rejoin(viewer.token);
  assert.equal(claims(String(on.body.token)).video.canPublish, true, "on stage stays on stage");
  assert.equal((await rejoin(host.token)).status, 400, "the host is not switched anywhere");
});

test("livekit: a meeting has no stage", async () => {
  const { code, cookie } = await newWebinar("meeting");
  const host = await joinAs(code, "Hana", cookie);
  const guest = await joinAs(code, "Gus");
  lk.join(code, guest.grant.sub, { canPublish: true });
  const refused = await stage(String(host.body.token), guest.grant.sub, true);
  assert.deepEqual(refused, { status: 400, body: { error: "Only a webinar has a stage." } });
});

test("livekit: someone let in from the lobby of a webinar gets a viewer's token", async () => {
  const { code, cookie } = await newWebinar();
  const host = await joinAs(code, "Hana", cookie);
  lk.join(code, host.grant.sub, { canPublish: true }, "Hana");
  const meta = lk.meta(code);
  lk.rooms.get(code)!.metadata = JSON.stringify({ ...meta, access: "ask" });
  const asking = await joinAs(code, "Asa");
  assert.equal(asking.body.lobby, true);
  lk.rooms.set(`${code}.lobby`, { name: `${code}.lobby`, metadata: "", participants: new Map() });
  lk.join(`${code}.lobby`, asking.grant.sub, {}, "Asa");
  const admitted = await hostRoute(post({ token: host.body.token, action: "admit", identity: asking.grant.sub }));
  assert.equal(admitted.status, 200);
  const [sent] = lk.sent;
  assert.equal(sent?.room, `${code}.lobby`);
  const way = claims(JSON.parse(sent.text).token);
  assert.deepEqual([way.video.room, way.video.canPublish], [code, false]);
});

/* ----------------------------------------------------- LiveKit: the adapter */

type Local = Room["localParticipant"];
function liveKitWebinar() {
  const call = createLiveKitCall({ provider: "livekit", token: "signed", serverUrl: "ws://127.0.0.1:1", mode: "webinar" }, choices);
  const room = call.native as Room;
  const local = room.localParticipant as Local & { permissions?: unknown };
  local.identity = "m-vic";
  let attributes: Record<string, string> = {};
  Object.defineProperty(local, "attributes", { get: () => attributes, configurable: true });
  const written: Record<string, string>[] = [];
  local.setAttributes = async (next: Record<string, string>) => void written.push(next);
  let stageEvents = 0;
  call.on("stage", () => stageEvents++);
  /** What our server's RoomService call does to this client: new permissions, then the attribute. */
  const serverSets = (canPublish: boolean, mark: string) => {
    local.permissions = { canPublish, canSubscribe: true, canPublishData: true } as never;
    room.emit(RoomEvent.ParticipantPermissionsChanged, undefined, local);
    attributes = mark ? { [STAGE_ATTRIBUTE]: mark } : {};
    room.emit(RoomEvent.ParticipantAttributesChanged, { [STAGE_ATTRIBUTE]: mark }, local);
  };
  serverSets(false, "");
  return { call, room, local, written, serverSets, stageEvents: () => stageEvents };
}

test("livekit: a viewer is a viewer, has no tile of their own, and is not invited", () => {
  const { call } = liveKitWebinar();
  assert.equal(call.mode, "webinar");
  assert.equal(call.local.role, "viewer");
  assert.equal(call.local.stageInvite, false);
  assert.deepEqual(call.tiles(), []);
});

test("livekit: invited → still a viewer with no tile until they say yes; yes clears the mark; then a speaker with a tile", async () => {
  const { call, written, serverSets, stageEvents } = liveKitWebinar();
  const before = stageEvents();
  serverSets(true, STAGE_INVITED);
  assert.ok(stageEvents() > before, "the stage event fires");
  assert.equal(call.local.stageInvite, true);
  assert.equal(call.local.role, "viewer");
  assert.deepEqual(call.tiles(), []);
  await call.moderate({ action: "stage", identity: "m-vic", on: true });
  assert.deepEqual(written, [{ [STAGE_ATTRIBUTE]: "" }], "saying yes is the viewer's own client clearing the mark");
  serverSets(true, "");
  assert.equal(call.local.role, "speaker");
  assert.equal(call.local.stageInvite, false);
  assert.deepEqual(call.tiles().map((tile) => tile.participant), [call.local]);
});

test("livekit: saying yes without an invitation is refused; Not now and inviting others go to our server", async () => {
  const { call, written } = liveKitWebinar();
  await assert.rejects(call.moderate({ action: "stage", identity: "m-vic", on: true }), { message: "The invitation to speak has been withdrawn." });
  assert.deepEqual(written, []);
  lk.restore();
  const posted: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body));
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  await call.moderate({ action: "stage", identity: "m-vic", on: false });
  await call.moderate({ action: "stage", identity: "m-ann", on: true });
  assert.deepEqual(posted, [
    { token: "signed", action: "stage", identity: "m-vic", on: false },
    { token: "signed", action: "stage", identity: "m-ann", on: true },
  ]);
});

/* ------------------------------------------------- RealtimeKit: the adapter */

const rtkGrant: Extract<JoinGrant, { provider: "realtimekit" }> = {
  provider: "realtimekit",
  authToken: "not-a-real-token",
  session: "signed-session",
  participantId: "rest-id",
  meetingId: "meeting-id",
  role: "guest",
  hostPreset: "meetly-webinar-host",
  coHosts: [],
  access: "open",
  canAsk: false,
  mode: "webinar",
};

async function rtkWebinar(setup: { host?: boolean; canStage?: boolean } = {}) {
  const self = new FakeSelf("self", "Vic", { presetName: setup.host ? "meetly-webinar-host" : "meetly-webinar-viewer" });
  const canStage = setup.canStage ?? !!setup.host;
  self.permissions = { acceptWaitingRequests: false, canDisableParticipantVideo: false, acceptStageRequests: canStage, canChangeParticipantPermissions: canStage };
  const meeting = new FakeMeeting(self);
  meeting.stage.direct = !!setup.host;
  if (setup.host) meeting.stage.status = "ACCEPTED_TO_JOIN_STAGE";
  const requests: Record<string, unknown>[] = [];
  const api: HostApi = async (body) => (requests.push(body), {});
  const call: RtcCall = new RealtimeKitCall({ ...rtkGrant, role: setup.host ? "host" : "guest" }, choices, (async () => meeting) as unknown as MeetingFactory, api);
  let stageEvents = 0;
  call.on("stage", () => stageEvents++);
  call.connect();
  await tick();
  await tick();
  return { call, meeting, requests, stageEvents: () => stageEvents };
}

test("rtk: the host goes straight on stage on joining, and is the host", async () => {
  const { call, meeting } = await rtkWebinar({ host: true });
  assert.equal(meeting.stage.joinCalls, 1);
  assert.equal(meeting.stage.status, "ON_STAGE");
  assert.equal(call.local.role, "host");
  assert.equal(call.local.stageInvite, false);
});

test("rtk: viewers are viewers with no tile; people on stage are speakers with tiles; the host is the host", async () => {
  const { call, meeting } = await rtkWebinar();
  assert.equal(meeting.stage.joinCalls, 0, "nobody in the audience joins the stage by themselves");
  const host = new FakeParticipant("h", "Hana", { presetName: "meetly-webinar-host" });
  host.stageStatus = "ON_STAGE";
  meeting.arrive(host);
  const other = meeting.arrive(new FakeParticipant("o", "Otto", { presetName: "meetly-webinar-viewer" }));
  assert.equal(call.local.role, "viewer");
  assert.equal(call.participant("m-h")?.role, "host");
  assert.equal(call.participant("m-o")?.role, "viewer");
  assert.deepEqual(call.tiles().map((tile) => tile.participant.identity), ["m-h"]);
  other.setStage("ON_STAGE");
  assert.equal(call.participant("m-o")?.role, "speaker");
  assert.deepEqual(call.tiles().map((tile) => tile.participant.identity), ["m-h", "m-o"]);
  assert.equal(meeting.participants.joinedPeerCalls, 0, "the roster comes from events, never from asking");
});

test("rtk: an invitation is ACCEPTED_TO_JOIN_STAGE; Join stage joins it and makes a speaker with a tile", async () => {
  const { call, meeting, stageEvents } = await rtkWebinar();
  meeting.stage.invite();
  assert.equal(call.local.stageInvite, true);
  assert.equal(call.local.role, "viewer");
  assert.equal(stageEvents(), 1);
  await call.moderate({ action: "stage", identity: call.local.identity, on: true });
  assert.equal(meeting.stage.status, "ON_STAGE");
  assert.equal(call.local.role, "speaker");
  assert.equal(call.local.stageInvite, false);
  assert.deepEqual(call.tiles().map((tile) => tile.participant), [call.local]);
});

test("rtk: Not now leaves the invitation unanswered for good, and Back to audience stops what was being sent", async () => {
  const { call, meeting } = await rtkWebinar();
  meeting.stage.invite();
  await call.moderate({ action: "stage", identity: call.local.identity, on: false });
  assert.equal(call.local.stageInvite, false);
  assert.equal(meeting.stage.leaveCalls, 1);
  await assert.rejects(call.moderate({ action: "stage", identity: call.local.identity, on: true }), /withdrawn/);

  meeting.stage.invite();
  await call.moderate({ action: "stage", identity: call.local.identity, on: true });
  await meeting.self.enableAudio();
  await meeting.self.enableVideo();
  await call.moderate({ action: "stage", identity: call.local.identity, on: false });
  assert.equal(call.local.role, "viewer");
  assert.equal(meeting.self.audioEnabled, false);
  assert.equal(meeting.self.videoEnabled, false);
  assert.deepEqual(call.tiles(), []);
});

test("rtk: when the host sends a speaker back, their microphone and camera go off", async () => {
  const { call, meeting } = await rtkWebinar();
  meeting.stage.invite();
  await call.moderate({ action: "stage", identity: call.local.identity, on: true });
  await meeting.self.enableAudio();
  meeting.stage.removed();
  await tick();
  assert.equal(call.local.role, "viewer");
  assert.equal(meeting.self.audioEnabled, false);
});

test("rtk: the host invites with grantAccess, sends a speaker back with kick, and withdraws an invitation with denyAccess, after asking our server", async () => {
  const { call, meeting, requests } = await rtkWebinar({ host: true });
  const vic = meeting.arrive(new FakeParticipant("v", "Vic", { presetName: "meetly-webinar-viewer" }));
  await call.moderate({ action: "stage", identity: "m-v", on: true });
  assert.deepEqual(meeting.stage.granted, [[vic.userId]]);
  await call.moderate({ action: "stage", identity: "m-v", on: false });
  assert.deepEqual(meeting.stage.denied, [[vic.userId]], "not on stage yet: the invitation is withdrawn");
  vic.setStage("ON_STAGE");
  await call.moderate({ action: "stage", identity: "m-v", on: false });
  assert.deepEqual(meeting.stage.kicked, [[vic.userId]]);
  assert.deepEqual(
    requests.map((body) => [body.session, body.action, body.identity, body.on]),
    [
      ["signed-session", "stage", "m-v", true],
      ["signed-session", "stage", "m-v", false],
      ["signed-session", "stage", "m-v", false],
    ],
  );
  await assert.rejects(call.moderate({ action: "stage", identity: "m-gone", on: true }), /already left/);
});

const chatOn = { chat: { public: { canSend: true, text: true } } };
const chatOff = { chat: { public: { canSend: false, text: false } } };

test("rtk: inviting turns the speaker's chat on with the stage; sending back turns it off; never one without the other", async () => {
  const { call, meeting } = await rtkWebinar({ host: true });
  const vic = meeting.arrive(new FakeParticipant("v", "Vic", { presetName: "meetly-webinar-viewer" }));
  await call.moderate({ action: "stage", identity: "m-v", on: true });
  assert.deepEqual(meeting.participants.permissionCalls, [{ ids: ["v"], patch: chatOn }]);
  assert.deepEqual(meeting.stage.granted, [[vic.userId]]);
  vic.setStage("ON_STAGE");
  await call.moderate({ action: "stage", identity: "m-v", on: false });
  assert.deepEqual(meeting.participants.permissionCalls.at(-1), { ids: ["v"], patch: chatOff });
  assert.deepEqual(meeting.stage.kicked, [[vic.userId]]);
});

test("rtk: a stage grant that fails takes the chat back; a chat change that fails grants nothing", async () => {
  const { call, meeting } = await rtkWebinar({ host: true });
  const vic = meeting.arrive(new FakeParticipant("v", "Vic", { presetName: "meetly-webinar-viewer" }));
  meeting.stage.failNext = "grant";
  await assert.rejects(call.moderate({ action: "stage", identity: "m-v", on: true }), /grant refused/);
  assert.deepEqual(meeting.participants.permissionCalls.map((c) => c.patch), [chatOn, chatOff], "rolled back");
  assert.deepEqual(meeting.stage.granted, []);
  meeting.participants.failPermissions = true;
  await assert.rejects(call.moderate({ action: "stage", identity: "m-v", on: true }));
  assert.deepEqual(meeting.stage.granted, [], "no stage without chat");
  // On stage, a kick that fails leaves them a full speaker: chat back on.
  await call.moderate({ action: "stage", identity: "m-v", on: true });
  vic.setStage("ON_STAGE");
  meeting.stage.failNext = "kick";
  await assert.rejects(call.moderate({ action: "stage", identity: "m-v", on: false }), /kick refused/);
  assert.deepEqual(meeting.participants.permissionCalls.slice(-2).map((c) => c.patch), [chatOff, chatOn]);
});

test("rtk: someone who leaves the stage by themselves has their chat turned off by whoever invited them", async () => {
  const { call, meeting } = await rtkWebinar({ host: true });
  const vic = meeting.arrive(new FakeParticipant("v", "Vic", { presetName: "meetly-webinar-viewer" }));
  await call.moderate({ action: "stage", identity: "m-v", on: true });
  vic.setStage("ACCEPTED_TO_JOIN_STAGE");
  vic.setStage("ON_STAGE");
  assert.equal(meeting.participants.permissionCalls.length, 1);
  vic.setStage("OFF_STAGE");
  await tick();
  assert.deepEqual(meeting.participants.permissionCalls.at(-1), { ids: ["v"], patch: chatOff });
});

test("rtk: a co-host whose preset cannot change someone's chat is not offered the stage", async () => {
  const self = new FakeSelf("self", "Cy", { presetName: "meetly-webinar-cohost" });
  self.permissions = { acceptWaitingRequests: true, canDisableParticipantVideo: true, acceptStageRequests: true, canChangeParticipantPermissions: false };
  const meeting = new FakeMeeting(self);
  const call = new RealtimeKitCall(rtkGrant, choices, (async () => meeting) as unknown as MeetingFactory, async () => ({}));
  call.connect();
  await tick();
  await tick();
  assert.equal(call.supports.stage, false);
  meeting.arrive(new FakeParticipant("v", "Vic", { presetName: "meetly-webinar-viewer" }));
  await assert.rejects(call.moderate({ action: "stage", identity: "m-v", on: true }), /Only the host/);
  assert.deepEqual([meeting.participants.permissionCalls, meeting.stage.granted], [[], []]);
});

test("rtk: made co-host, the client rejoins with a fresh token for the same person, saying so, without ending the call", async () => {
  const presets = { viewer: "meetly-webinar-viewer", cohost: "meetly-webinar-cohost" };
  const first = new FakeMeeting(new FakeSelf("self", "Cy", { presetName: presets.viewer }));
  const second = new FakeMeeting(new FakeSelf("self", "Cy", { presetName: presets.cohost }));
  const tokens: string[] = [];
  const factory = (async (options: { authToken: string }) => {
    tokens.push(options.authToken);
    return tokens.length === 1 ? first : second;
  }) as unknown as MeetingFactory;
  const asked: Record<string, unknown>[] = [];
  const api: HostApi = async (body) => {
    asked.push(body);
    if (body.action === "roles") return { coHosts: ["m-self"], access: "open" };
    if (body.action === "rejoin") return { authToken: "co-host-token" };
    return {};
  };
  const call = new RealtimeKitCall({ ...rtkGrant, webinarPresets: presets }, choices, factory, api);
  const seen: string[] = [];
  call.on("status", () => seen.push(`${call.status}/${call.switching}`));
  let ended = false;
  call.on("disconnected", () => (ended = true));
  call.connect();
  await tick();
  await tick();
  // Someone (the host) says the co-hosts changed.
  first.participants.emit("broadcastedMessage", { type: "meetly-roles", payload: { peerId: "host" } });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(tokens, ["not-a-real-token", "co-host-token"]);
  assert.equal(first.leaveCalls, 1);
  assert.equal(ended, false, "not the call ending");
  assert.ok(seen.includes("connecting/cohost"), seen.join());
  assert.equal(call.switching, null);
  assert.equal(call.status, "connected");
  assert.equal(call.native, second);
  assert.deepEqual(asked.map((body) => body.action), ["roles", "rejoin"]);
});

test("rtk: a co-host whose preset cannot change the stage is told so, and nothing is asked", async () => {
  const { call, meeting, requests } = await rtkWebinar({ canStage: false });
  meeting.arrive(new FakeParticipant("v", "Otto", { presetName: "meetly-webinar-viewer" }));
  await assert.rejects(call.moderate({ action: "stage", identity: "m-v", on: true }), {
    message: "Only the host can invite people to speak in this webinar.",
  });
  assert.deepEqual([requests.length, meeting.stage.granted.length], [0, 0]);
});

test("rtk: in a meeting the stage is never touched and everyone is a speaker", async () => {
  const self = new FakeSelf("self", "Ada", { presetName: "meetly-guest" });
  const meeting = new FakeMeeting(self);
  const call = new RealtimeKitCall({ ...rtkGrant, mode: undefined, hostPreset: "meetly-host" }, choices, (async () => meeting) as unknown as MeetingFactory, async () => ({}));
  call.connect();
  await tick();
  await tick();
  const grace = meeting.arrive(new FakeParticipant("g", "Grace"));
  grace.setStage("OFF_STAGE");
  assert.equal(call.mode, "meeting");
  assert.equal(call.local.role, "speaker");
  assert.equal(call.participant("m-g")?.role, "speaker");
  assert.equal(meeting.stage.joinCalls, 0);
});

/* ------------------------------------------------------- for the interface */

test("supports.stage: any webinar on LiveKit; on RealtimeKit only where the preset can change the stage", async () => {
  const lkWebinar = createLiveKitCall({ provider: "livekit", token: "t", serverUrl: "ws://127.0.0.1:1", mode: "webinar" }, choices);
  const lkMeeting = createLiveKitCall({ provider: "livekit", token: "t", serverUrl: "ws://127.0.0.1:1" }, choices);
  assert.deepEqual([lkWebinar.supports.stage, lkMeeting.supports.stage], [true, false]);
  const host = await rtkWebinar({ host: true });
  const coHost = await rtkWebinar({ canStage: false });
  assert.deepEqual([host.call.supports.stage, coHost.call.supports.stage], [true, false]);
});

test("rtk: the host is shown who has an invitation out, and it clears when they answer", async () => {
  const { call, meeting } = await rtkWebinar({ host: true });
  const vic = meeting.arrive(new FakeParticipant("v", "Vic", { presetName: "meetly-webinar-viewer" }));
  assert.equal(call.participant("m-v")?.stageInvite, false);
  vic.setStage("ACCEPTED_TO_JOIN_STAGE");
  assert.deepEqual([call.participant("m-v")?.stageInvite, call.participant("m-v")?.role], [true, "viewer"]);
  vic.setStage("ON_STAGE");
  assert.deepEqual([call.participant("m-v")?.stageInvite, call.participant("m-v")?.role], [false, "speaker"]);
});

test("livekit: someone else's invitation is seen too, from their permissions and mark", () => {
  const { call, local, serverSets } = liveKitWebinar();
  serverSets(true, STAGE_INVITED);
  // The local participant stands in for anyone: the same reading applies to every participant.
  assert.equal(call.participant(local.identity)?.stageInvite, true);
});

test("the audience is listed with raised hands first, in the order they went up, then A–Z", () => {
  const person = (name: string, handRaised = false) => ({ identity: `m-${name}`, name, handRaised }) as unknown as RtcParticipant;
  const zed = person("Zed");
  const amy = person("Amy");
  const bo = person("Bo", true);
  const cy = person("Cy", true);
  // Bo's hand went up first; Cy's after.
  assert.deepEqual(audienceOrder([zed, bo, amy]).map((p) => p.name), ["Bo", "Amy", "Zed"]);
  assert.deepEqual(audienceOrder([zed, cy, bo, amy]).map((p) => p.name), ["Bo", "Cy", "Amy", "Zed"]);
});
