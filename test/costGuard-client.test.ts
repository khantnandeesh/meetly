import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { LIMIT_POLL_MS, RealtimeKitCall, type MeetingFactory } from "../src/lib/rtc/realtimekit";
import type { DisconnectReason, JoinChoices, JoinGrant } from "../src/lib/rtc/types";
import { FakeMeeting, FakeSelf, installDom } from "./fake-realtimekit";

/**
 * The RealtimeKit adapter's side of the webinar cost watchdog: the host and co-hosts are told
 * when the free limit is near, and someone removed from a webinar is told why. Against the
 * stand-in meeting object and a stand-in for our server's /api/host.
 */

const grant: Extract<JoinGrant, { provider: "realtimekit" }> = {
  provider: "realtimekit",
  authToken: "not-a-real-token",
  session: "not-a-real-session",
  participantId: "rest-participant-id",
  meetingId: "meeting-id",
  role: "guest",
  hostPreset: "meetly-webinar-host",
  coHosts: [],
  access: "open",
  canAsk: false,
  mode: "webinar",
};
const choices: JoinChoices = { username: "Ada", audioEnabled: false, videoEnabled: false, audioDeviceId: "default", videoDeviceId: "default" };

beforeEach(() => {
  installDom();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

type Answer = Record<string, unknown> | Error | "never";

async function connected({ host = false, mode = "webinar", answer = {} as Answer, session = "session-1" } = {}) {
  const self = new FakeSelf("self", "Ada", { presetName: host ? "meetly-webinar-host" : "meetly-webinar-viewer" });
  const meeting = new FakeMeeting(self);
  meeting.meta.sessionId = session;
  const asked: Record<string, unknown>[] = [];
  const state = { answer };
  const api = async (body: Record<string, unknown>) => {
    asked.push(body);
    const now = state.answer;
    if (now === "never") return new Promise<Record<string, unknown>>(() => {});
    if (now instanceof Error) throw now;
    return now;
  };
  const factory = (async () => meeting) as unknown as MeetingFactory;
  const call = new RealtimeKitCall({ ...grant, role: host ? "host" : "guest", mode: mode as "webinar" | "meeting" }, choices, factory, api);
  const ended: DisconnectReason[] = [];
  call.on("disconnected", (reason) => ended.push(reason));
  let warnings = 0;
  call.on("limitWarning", () => warnings++);
  call.connect();
  await tick();
  await tick();
  return { call, meeting, self, asked, ended, state, warnings: () => warnings };
}

test("removed from a webinar that reached its limit: the call ends as \"limit\", having asked our server why", async () => {
  const { self, asked, ended } = await connected({ answer: { stopped: "limit" } });
  self.emit("roomLeft", { state: "kicked" });
  assert.deepEqual(ended, [], "not until the server has answered");
  await tick();
  await tick();
  assert.deepEqual(ended, ["limit"]);
  assert.deepEqual(asked, [{ session: "not-a-real-session", action: "why" }]);
});

test("removed from a webinar while webinars are switched off: \"paused\"", async () => {
  const { self, ended } = await connected({ answer: { stopped: "paused" } });
  self.emit("roomLeft", { state: "kicked" });
  await tick();
  await tick();
  assert.deepEqual(ended, ["paused"]);
});

test("removed from a webinar for no such reason, or when our server cannot say: the host removed you", async () => {
  const plain = await connected({ answer: {} });
  plain.self.emit("roomLeft", { state: "kicked" });
  await tick();
  await tick();
  assert.deepEqual(plain.ended, ["removed"]);

  const failing = await connected({ answer: new Error("offline") });
  failing.self.emit("roomLeft", { state: "kicked" });
  await tick();
  await tick();
  assert.deepEqual(failing.ended, ["removed"]);
});

test("a meeting never asks: being removed is the host's doing", async () => {
  const { self, asked, ended } = await connected({ mode: "meeting", answer: { stopped: "limit" } });
  self.emit("roomLeft", { state: "kicked" });
  assert.deepEqual(ended, ["removed"]);
  assert.deepEqual(asked, []);
});

/** Lets the minute between two questions to our server pass. */
async function aMinute(t: { mock: { timers: { tick(ms: number): void } } }) {
  t.mock.timers.tick(LIMIT_POLL_MS);
  await tick();
  await tick();
}

test("the host of a webinar is given the warning for this session within a minute", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const endsAt = Date.now() + 3 * 60_000;
  const { call, asked, warnings } = await connected({ host: true, answer: { warning: { session: "session-1", endsAt } } });
  assert.equal(asked.length, 0, "not on joining");
  await aMinute(t);
  assert.equal(asked.length, 1);
  assert.deepEqual(call.limitWarning, { endsAt });
  assert.equal(warnings(), 1);
  // Asked again, the same warning is not news.
  await aMinute(t);
  assert.equal(warnings(), 1);
});

test("a warning from an earlier session of the same link is not this one's", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { call, asked, warnings } = await connected({ host: true, answer: { warning: { session: "session-0", endsAt: Date.now() + 60_000 } } });
  await aMinute(t);
  assert.equal(asked.length, 1);
  assert.equal(call.limitWarning, null);
  assert.equal(warnings(), 0);
});

test("the audience does not ask: the warning is for those who can act on it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { call, asked } = await connected({ host: false, answer: { warning: { session: "session-1", endsAt: Date.now() + 60_000 } } });
  await aMinute(t);
  await aMinute(t);
  assert.deepEqual(asked, []);
  assert.equal(call.limitWarning, null);
});

test("the host asks once a minute while in the webinar, and stops on leaving", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { call, asked } = await connected({ host: true, answer: {} });
  await aMinute(t);
  await aMinute(t);
  assert.equal(asked.length, 2);
  await call.disconnect();
  t.mock.timers.tick(LIMIT_POLL_MS * 3);
  await tick();
  assert.equal(asked.length, 2);
});
