import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeLiveKitServer } from "./fake-livekit-server";

/**
 * How long the meeting has been running: the timer's text, what it counts from, and where the
 * start comes from on LiveKit (the token route, once per join). LiveKit's room service is the
 * stand-in in ./fake-livekit-server.ts; the browser tests check the same against a real server.
 */
Object.assign(process.env, {
  NEXT_PUBLIC_RTC_PROVIDER: "livekit",
  LIVEKIT_URL: "http://livekit.test",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "secret-secret-secret-secret-secret",
});

const { elapsedSeconds, formatElapsed, meetingClock, spokenElapsed, startFromAnswer, timerName } = await import("../src/lib/meetingTime");
const { sessionAge } = await import("../src/lib/host.server");
const { POST: meetingRoute } = await import("../src/app/api/meeting/route");
const { POST: tokenRoute } = await import("../src/app/api/token/route");

/* ------------------------------------------------------------- the text */

test("timer text: mm:ss until an hour, then h:mm:ss", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(9), "0:09");
  assert.equal(formatElapsed(65), "1:05");
  assert.equal(formatElapsed(59 * 60 + 59), "59:59");
  assert.equal(formatElapsed(3600), "1:00:00");
  assert.equal(formatElapsed(3600 + 2 * 60 + 3), "1:02:03");
  assert.equal(formatElapsed(10 * 3600), "10:00:00");
  // Nothing odd leaks through: a start a moment in the future, or no number at all, is 0:00.
  assert.equal(formatElapsed(-4), "0:00");
  assert.equal(formatElapsed(Number.NaN), "0:00");
  assert.equal(formatElapsed(59.99), "0:59");
});

test("elapsed seconds are whole and never below zero", () => {
  assert.equal(elapsedSeconds(1_000, 4_999), 3);
  assert.equal(elapsedSeconds(5_000, 4_000), 0);
});

test("a screen reader hears whole minutes, so the name changes once a minute", () => {
  assert.equal(spokenElapsed("Meeting time", 0), "Meeting time, under a minute");
  assert.equal(spokenElapsed("Meeting time", 59), "Meeting time, under a minute");
  assert.equal(spokenElapsed("Meeting time", 60), "Meeting time, 1 minute");
  assert.equal(spokenElapsed("Meeting time", 23 * 60 + 15), "Meeting time, 23 minutes");
  assert.equal(spokenElapsed("Webinar time", 3600), "Webinar time, 1 hour");
  assert.equal(spokenElapsed("Webinar time", 2 * 3600 + 5 * 60 + 59), "Webinar time, 2 hours 5 minutes");
  assert.equal(spokenElapsed("Meeting time", 23 * 60), spokenElapsed("Meeting time", 23 * 60 + 59));
});

test("the timer is named for what it counts, and a webinar as a webinar", () => {
  assert.equal(timerName("meeting", true), "Meeting time");
  assert.equal(timerName("webinar", true), "Webinar time");
  assert.equal(timerName("meeting", false), "Time since you joined");
  assert.equal(timerName("webinar", false), "Time since you joined");
});

/* ------------------------------------------ start known vs since you joined */

test("start known: counted from when the meeting began, before or after you arrive", () => {
  assert.deepEqual(meetingClock(10_000, 70_000), { from: 10_000, known: true });
  // Known before you are even connected: the time is already right while the screen hands over.
  assert.deepEqual(meetingClock(10_000, null), { from: 10_000, known: true });
  // Two clocks a few milliseconds apart never put the start after you joined.
  assert.deepEqual(meetingClock(70_004, 70_000), { from: 70_000, known: true });
});

test('nobody was in ("now"): the meeting began as you joined, and it is still the meeting\'s time', () => {
  assert.deepEqual(meetingClock("now", 70_000), { from: 70_000, known: true });
  assert.equal(meetingClock("now", null), null, "not counted before you are in");
});

test("start not known: counted from when you joined, and labelled as such", () => {
  assert.deepEqual(meetingClock(null, 70_000), { from: 70_000, known: false });
  assert.equal(meetingClock(null, null), null);
  assert.deepEqual(meetingClock(Number.NaN, 70_000), { from: 70_000, known: false }, "a broken number is no start");
});

test("the server's answer is turned into this browser's clock, never trusted beyond that", () => {
  assert.equal(startFromAnswer(90_000, 1_000_000), 910_000);
  assert.equal(startFromAnswer(0, 1_000_000), 1_000_000);
  assert.equal(startFromAnswer("now", 1_000_000), "now");
  for (const odd of [undefined, null, -5, "soon", Number.POSITIVE_INFINITY, {}]) assert.equal(startFromAnswer(odd, 1_000_000), null, String(odd));
});

test("LiveKit's record: someone present from before the recorded start means the earlier one began it", () => {
  assert.equal(sessionAge(undefined, 1_000, 9_000), undefined);
  assert.equal(sessionAge(5_000, null, 9_000), 4_000);
  assert.equal(sessionAge(5_000, 6_000, 9_000), 4_000, "people who came later change nothing");
  assert.equal(sessionAge(5_000, 2_000, 9_000), 7_000);
  assert.equal(sessionAge(9_500, null, 9_000), 0);
});

/* ---------------------------------------------------- LiveKit, end to end */

let lk: FakeLiveKitServer;
beforeEach(() => {
  lk = new FakeLiveKitServer().install();
});
afterEach(() => lk.restore());

const post = (body: unknown, cookie = "") =>
  new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body), headers: cookie ? { cookie } : {} });

async function newMeeting() {
  const response = await meetingRoute(post({ action: "create" }));
  const { code } = (await response.json()) as { code: string };
  return { code, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

async function join(code: string, name: string, cookie = "") {
  const response = await tokenRoute(post({ room: code, name }, cookie));
  return (await response.json()) as { started?: number; lobby?: boolean };
}

test("LiveKit: the first person into the empty room begins the meeting; later people are told how long ago", async () => {
  const { code, cookie } = await newMeeting();
  // "New meeting" makes the room before anyone joins: that is not when the meeting begins.
  assert.equal(lk.meta(code).startedAt, undefined);
  const before = Date.now();
  const host = await join(code, "Hana", cookie);
  assert.equal(host.started, 0);
  const recorded = lk.meta(code).startedAt as number;
  assert.ok(recorded >= before && recorded <= Date.now());
  lk.join(code, "hana", {}, "Hana", recorded + 800);

  // Ten seconds on, by the record's clock.
  lk.rooms.get(code)!.metadata = JSON.stringify({ ...lk.meta(code), startedAt: recorded - 10_000 });
  const guest = await join(code, "Gus");
  assert.ok(guest.started! >= 10_000 && guest.started! < 11_000, String(guest.started));
});

test("LiveKit: the start is asked for once per join, and never written over while people are in", async () => {
  const { code, cookie } = await newMeeting();
  await join(code, "Hana", cookie);
  const first = lk.meta(code).startedAt;
  lk.join(code, "hana", {}, "Hana");
  lk.calls.length = 0;
  await join(code, "Gus");
  assert.equal(lk.meta(code).startedAt, first);
  assert.equal(lk.calls.filter((c) => c.method === "UpdateRoomMetadata").length, 0);
  assert.equal(lk.calls.filter((c) => c.method === "ListParticipants").length, 1);
});

test("LiveKit: once everyone has left, the next person begins a new meeting on the same link", async () => {
  const { code, cookie } = await newMeeting();
  await join(code, "Hana", cookie);
  lk.rooms.get(code)!.metadata = JSON.stringify({ ...lk.meta(code), startedAt: Date.now() - 3 * 3_600_000 });
  // Nobody is in the room any more.
  const back = await join(code, "Hana", cookie);
  assert.equal(back.started, 0);
  assert.ok(Date.now() - (lk.meta(code).startedAt as number) < 1_000);
});

test("LiveKit: someone asking to join an empty meeting begins nothing and is told nothing", async () => {
  const { code, cookie } = await newMeeting();
  lk.rooms.get(code)!.metadata = JSON.stringify({ ...lk.meta(code), access: "ask" });
  const asking = await join(code, "Kai");
  assert.equal(asking.lobby, true);
  assert.equal(asking.started, undefined);
  assert.equal(lk.meta(code).startedAt, undefined);
  // With the host in, someone asking is told the meeting's time: it is what they will see once let in.
  await join(code, "Hana", cookie);
  lk.join(code, "hana", {}, "Hana");
  assert.equal(typeof (await join(code, "Kai")).started, "number");
});

test("LiveKit: a meeting that began before the start was recorded says it does not know", async () => {
  const { code } = await newMeeting();
  lk.join(code, "someone", {}, "Someone", Date.now() - 600_000);
  assert.equal((await join(code, "Gus")).started, undefined);
});
