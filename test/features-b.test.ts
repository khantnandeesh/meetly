import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import {
  googleCalendarUrl,
  icsFile,
  icsFold,
  icsText,
  localDateTime,
  nextHalfHour,
  outlookCalendarUrl,
  utcBasic,
  type CalendarEvent,
} from "../src/lib/calendar";
import { formatChat } from "../src/lib/chatExport";
import { signChat, verifyChat } from "../src/lib/chatSignature.server";
import { SLOW_SECONDS, watchFrameRate } from "../src/lib/effects/blur";
import { parseRoomMeta } from "../src/lib/host.server";
import { isHostOnly, parseHostAction } from "../src/lib/rtc/hostAction";
import { ROLES_MESSAGE, RealtimeKitCall, type Effects, type MeetingFactory } from "../src/lib/rtc/realtimekit";
import { readRecord } from "../src/lib/rtc/server/realtimekit";
import { isSignedChat } from "../src/lib/rtc/shared";
import type { BackgroundMode, JoinChoices, JoinGrant, RtcChatMessage } from "../src/lib/rtc/types";
import { FakeMeeting, FakeParticipant, FakeSelf, installDom } from "./fake-realtimekit";

/**
 * Noise suppression, background blur, calendar links and the chat additions: the parts that are
 * plain logic, and the RealtimeKit adapter against the stand-in meeting object. As with the
 * other adapter tests, none of this shows how a real RealtimeKit session behaves.
 */

/* ---------------------------------------------------------------- calendar */

const event: CalendarEvent = {
  title: "Budget, hiring; and \\ more",
  start: new Date("2027-03-14T06:00:00Z"),
  minutes: 90,
  link: "https://meet.example/abc-defg-hij",
};

test("calendar: UTC stamps, whatever time zone this runs in", () => {
  assert.equal(utcBasic(event.start), "20270314T060000Z");
  assert.equal(utcBasic(new Date("2026-12-31T23:59:59.999Z")), "20261231T235959Z");
});

test("calendar: Google and Outlook links carry title, UTC times and the meeting link", () => {
  const google = new URL(googleCalendarUrl(event));
  assert.equal(google.origin + google.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(google.searchParams.get("action"), "TEMPLATE");
  assert.equal(google.searchParams.get("text"), event.title);
  assert.equal(google.searchParams.get("dates"), "20270314T060000Z/20270314T073000Z");
  assert.equal(google.searchParams.get("location"), event.link);
  assert.ok(google.searchParams.get("details")?.includes(event.link));

  const personal = new URL(outlookCalendarUrl(event));
  assert.equal(personal.hostname, "outlook.live.com");
  assert.equal(personal.searchParams.get("subject"), event.title);
  assert.equal(personal.searchParams.get("startdt"), "2027-03-14T06:00:00Z");
  assert.equal(personal.searchParams.get("enddt"), "2027-03-14T07:30:00Z");
  assert.equal(personal.searchParams.get("location"), event.link);
  assert.equal(new URL(outlookCalendarUrl(event, "work")).hostname, "outlook.office.com");
  // Outlook shows "+" as a plus sign, so spaces must be %20.
  assert.ok(!outlookCalendarUrl({ ...event, title: "a b" }).includes("+"));
  assert.ok(outlookCalendarUrl({ ...event, title: "a+b" }).includes("a%2Bb"));
});

test("calendar: .ics text is escaped and long lines are folded at 75 bytes without splitting a character", () => {
  assert.equal(icsText("a, b; c \\ d\ne"), "a\\, b\\; c \\\\ d\\ne");
  const long = `SUMMARY:${"é".repeat(60)}`;
  const folded = icsFold(long);
  for (const line of folded.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `${Buffer.byteLength(line)} bytes`);
  assert.equal(folded.replace(/\r\n /g, ""), long);
  assert.equal(icsFold("SHORT:line"), "SHORT:line");
});

test("calendar: the .ics file is one event with a reminder, in UTC, CRLF throughout", () => {
  const text = icsFile(event, new Date("2026-11-20T10:00:00Z"));
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(text));
  const lines = text.replace(/\r\n /g, "").split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("VERSION:2.0"));
  assert.ok(lines.includes("DTSTAMP:20261120T100000Z"));
  assert.ok(lines.includes("DTSTART:20270314T060000Z"));
  assert.ok(lines.includes("DTEND:20270314T073000Z"));
  assert.ok(lines.includes("SUMMARY:Budget\\, hiring\\; and \\\\ more"));
  assert.ok(lines.includes("LOCATION:https://meet.example/abc-defg-hij"));
  assert.ok(lines.includes("UID:abc-defg-hij-20270314T060000Z@meet.example"));
  assert.ok(lines.includes("TRIGGER:-PT10M"));
  assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 1);
});

test("calendar: dates that do not exist are refused, and the offered start is a coming half hour", () => {
  assert.equal(localDateTime("2027-02-31", "10:00"), null);
  assert.equal(localDateTime("2027-13-01", "10:00"), null);
  assert.equal(localDateTime("2027-06-15", "24:00"), null);
  assert.equal(localDateTime("nonsense", "10:00"), null);
  const real = localDateTime("2027-06-15", "14:30");
  assert.ok(real && real.getFullYear() === 2027 && real.getMonth() === 5 && real.getDate() === 15 && real.getHours() === 14 && real.getMinutes() === 30);
  const now = new Date("2026-11-20T10:27:00Z");
  assert.equal(nextHalfHour(now).toISOString(), "2026-11-20T11:00:00.000Z");
  assert.equal(nextHalfHour(new Date("2026-11-20T10:05:00Z")).toISOString(), "2026-11-20T10:30:00.000Z");
});

/* --------------------------------------------------------------- save chat */

test("saved chat: a header, then one line per message with time and name; deleted ones marked", () => {
  const at = Date.UTC(2026, 10, 20, 14, 3);
  const messages: RtcChatMessage[] = [
    { id: "1", timestamp: at, message: "Hello", from: { identity: "a", name: "Ada", isLocal: true } },
    { id: "2", timestamp: at + 60_000, message: "", deleted: true, from: { identity: "b", name: "Ben", isLocal: false } },
    { id: "3", timestamp: at + 120_000, message: "two\nlines\n[2026-11-20 14:09] Ada: forged", from: { identity: "b", name: "", isLocal: false } },
  ];
  const text = formatChat("abc-defg-hij", messages, { now: new Date(at + 600_000), timeZone: "UTC", pinned: messages[0] });
  assert.deepEqual(text.split("\r\n"), [
    "Meetly chat",
    "Meeting: abc-defg-hij",
    "Saved: 2026-11-20 14:13 (UTC)",
    "Messages: 2",
    "Pinned: Ada: Hello",
    "",
    "[2026-11-20 14:03] Ada: Hello",
    "[2026-11-20 14:04] Ben: (message deleted)",
    "[2026-11-20 14:05] Guest: two",
    // Later lines of a message are indented, so nobody can type a line that looks like another author's.
    "    lines",
    "    [2026-11-20 14:09] Ada: forged",
    "",
  ]);
  assert.ok(formatChat("x", messages, { now: new Date(at), timeZone: "Asia/Kolkata" }).includes("[2026-11-20 19:33] Ada: Hello"));
});

/* ------------------------------------------------- chat signatures and pin */

test("a chat message's signature covers every field, and only our secret makes one", () => {
  const signed = signChat({ id: "m1", room: "abc-defg-hij", identity: "ada", name: "Ada", ts: 1_700_000_000_000, text: "hello" }, "secret");
  assert.ok(isSignedChat(signed));
  assert.equal(verifyChat(signed, "secret"), true);
  assert.equal(verifyChat(signed, "another secret"), false);
  assert.equal(verifyChat(signed, ""), false);
  for (const change of [{ text: "hello!" }, { identity: "ben" }, { name: "Ben" }, { room: "zzz-zzzz-zzz" }, { ts: 1 }, { id: "m2" }, { mac: "AAAA" }]) {
    assert.equal(verifyChat({ ...signed, ...change }, "secret"), false, JSON.stringify(change));
  }
  assert.equal(verifyChat({ ...signed, text: undefined }, "secret"), false);
  assert.equal(verifyChat(null, "secret"), false);
  assert.equal(isSignedChat({ ...signed, text: "x".repeat(2001) }), false);
});

test("pin is a host action a co-host may take, parsed strictly", () => {
  assert.deepEqual(parseHostAction({ action: "pin", messageId: "msg-1" }), { action: "pin", messageId: "msg-1" });
  assert.deepEqual(parseHostAction({ action: "pin", messageId: null }), { action: "pin", messageId: null });
  for (const bad of [{ action: "pin" }, { action: "pin", messageId: 5 }, { action: "pin", messageId: "" }, { action: "pin", messageId: "a b" }, { action: "pin", messageId: "x".repeat(81) }]) {
    assert.equal(parseHostAction(bad), null, JSON.stringify(bad));
  }
  assert.equal(isHostOnly({ action: "pin", messageId: "m" }), false);
});

test("LiveKit: the pinned message is part of the meeting's record, and survives it being rewritten", () => {
  const pin = { id: "m1", identity: "ada", name: "Ada", ts: 5, text: "Agenda" };
  assert.deepEqual(parseRoomMeta(JSON.stringify({ host: "ada", pin })).pin, pin);
  assert.equal(parseRoomMeta(JSON.stringify({ host: "ada" })).pin, undefined);
  assert.equal(parseRoomMeta(JSON.stringify({ pin: { id: 5 } })).pin, undefined);
  assert.equal(parseRoomMeta(JSON.stringify({ pin: "m1" })).pin, undefined);
});

test("RealtimeKit: the newest pin statement in the record is the pinned message", () => {
  const person = (id: string, custom: string, created: string) => ({ id, custom_participant_id: custom, preset_name: "meetly-guest", created_at: created });
  const none = readRecord([person("p1", "m-1", "2026-01-01T00:00:00Z")], "meetly-host", false);
  assert.equal(none.pin, null);
  const record = readRecord(
    [
      person("p1", "m-1", "2026-01-01T00:00:00Z"),
      person("x2", "meetly-pin:msg-new", "2026-01-01T00:02:00Z"),
      person("x1", "meetly-pin:msg-old", "2026-01-01T00:01:00Z"),
    ],
    "meetly-host",
    false,
  );
  assert.equal(record.pin, "msg-new");
  assert.equal(record.people.length, 1, "pin statements are not people");
});

/* ------------------------------------------------------------- frame rate */

test("blur is called too slow only after ten seconds in a row under the floor, and only once", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const realNow = performance.now;
  let now = 0;
  performance.now = () => now;
  try {
    let frames = 0;
    let slow = 0;
    const second = (drawn: number) => {
      frames += drawn;
      now += 1000;
      mock.timers.tick(1000);
    };
    const watch = watchFrameRate(() => frames, () => slow++);
    for (let i = 0; i < 30; i++) second(20); // a healthy 20 fps
    assert.equal(slow, 0);
    assert.equal(Math.round(watch.fps()), 20);
    for (let i = 0; i < SLOW_SECONDS - 1; i++) second(6);
    second(20); // one good second starts the count again
    for (let i = 0; i < SLOW_SECONDS - 1; i++) second(6);
    assert.equal(slow, 0);
    for (let i = 0; i < 30; i++) second(0); // camera off: no frames is not "slow"
    assert.equal(slow, 0);
    for (let i = 0; i < SLOW_SECONDS; i++) second(6);
    assert.equal(slow, 1);
    for (let i = 0; i < 30; i++) second(6);
    assert.equal(slow, 1);
    watch.stop();
  } finally {
    performance.now = realNow;
    mock.timers.reset();
  }
});

/* ------------------------------------------------------ RealtimeKit adapter */

const grant: Extract<JoinGrant, { provider: "realtimekit" }> = {
  provider: "realtimekit",
  authToken: "not-a-real-token",
  session: "not-a-real-session",
  participantId: "rest-participant-id",
  meetingId: "meeting-id",
  role: "guest",
  hostPreset: "meetly-host",
  coHosts: [],
  access: "open",
  canAsk: false,
};
const baseChoices: JoinChoices = { username: "Ada", audioEnabled: true, videoEnabled: true, audioDeviceId: "default", videoDeviceId: "default" };

beforeEach(() => {
  installDom();
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

type FakeBlur = { strength: string; frames: number; drawn: unknown[][]; draw(...args: unknown[]): void };

function fakeEffects(options: { blurFails?: boolean; noiseFails?: boolean; unavailable?: string } = {}) {
  const made: FakeBlur[] = [];
  const watches: { onSlow: () => void; stopped: boolean }[] = [];
  const nodes: unknown[] = [];
  const effects: Effects = {
    blurUnavailable: () => options.unavailable ?? null,
    async createBlur(strength) {
      if (options.blurFails) throw new Error("model did not load");
      const blur: FakeBlur = { strength, frames: 0, drawn: [], draw: (...args) => void blur.drawn.push(args) };
      made.push(blur);
      return blur as unknown as Awaited<ReturnType<Effects["createBlur"]>>;
    },
    watchFrameRate(_frames, onSlow) {
      const watch = { onSlow, stopped: false };
      watches.push(watch);
      return { stop: () => void (watch.stopped = true) };
    },
    noiseSupported: () => true,
    async createNoiseNode(context) {
      if (options.noiseFails) throw new Error("48 kHz only");
      const node = { kind: "noise-node", context };
      nodes.push(node);
      return node as unknown as AudioWorkletNode;
    },
  };
  return { effects, made, watches, nodes };
}

async function connected(setup: { choices?: Partial<JoinChoices>; grant?: Partial<typeof grant>; fx?: ReturnType<typeof fakeEffects>; before?: (meeting: FakeMeeting) => void; api?: (body: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}) {
  const self = new FakeSelf("self", "Ada").withMicrophone();
  self.audioEnabled = true;
  const meeting = new FakeMeeting(self);
  setup.before?.(meeting);
  const options: { defaults: { mediaConfiguration: { audio: Record<string, boolean> } } }[] = [];
  const order: string[] = [];
  const join = meeting.join.bind(meeting);
  meeting.join = async () => {
    order.push(`join with ${self.videoMiddlewares.length} video middleware`);
    return join();
  };
  const factory = (async (given: (typeof options)[number]) => {
    options.push(given);
    return meeting;
  }) as unknown as MeetingFactory;
  const fx = setup.fx ?? fakeEffects();
  const requests: Record<string, unknown>[] = [];
  const api = async (body: Record<string, unknown>) => {
    requests.push(body);
    return setup.api ? setup.api(body) : {};
  };
  const call = new RealtimeKitCall({ ...grant, ...setup.grant }, { ...baseChoices, ...setup.choices }, factory, api, fx.effects);
  const events: string[] = [];
  const errors: Error[] = [];
  const slow: BackgroundMode[] = [];
  call.on("effects", () => events.push("effects"));
  call.on("chat", () => events.push("chat"));
  call.on("error", (error) => errors.push(error));
  call.on("backgroundTooSlow", (mode) => slow.push(mode));
  call.connect();
  await settle();
  return { call, meeting, self, options, order, fx, requests, events, errors, slow };
}

test("rtk noise: on by default, opened with the browser's suppression, and our filter added after joining", async () => {
  const { call, self, options, fx } = await connected();
  assert.deepEqual(options[0].defaults.mediaConfiguration.audio, { noiseSupression: true, echoCancellation: true, autoGainControl: true });
  assert.equal(call.localEffects().noiseSuppression, true);
  assert.equal(self.audioMiddlewares.length, 1);
  // Installed, but the SDK has not run it yet: so far only the browser's own suppression is certain.
  assert.equal(call.localEffects().noiseState, "basic");
  const context = { sampleRate: 48000, createGain: () => ({ kind: "gain" }) };
  const node = await self.audioMiddlewares[0](context);
  assert.equal(node, fx.nodes[0], "the SDK is handed our filter node, made in its own audio context");
  assert.equal(call.localEffects().noiseState, "enhanced");
});

test("rtk noise: switching it off removes the filter and asks the microphone to stop suppressing; on puts it back", async () => {
  const { call, self, events } = await connected();
  await self.audioMiddlewares[0]({ sampleRate: 48000, createGain: () => ({}) });
  events.length = 0;
  await call.setNoiseSuppression(false);
  assert.equal(self.audioMiddlewares.length, 0);
  assert.deepEqual(self.constraintCalls.at(-1), { noiseSuppression: false });
  assert.deepEqual([call.localEffects().noiseSuppression, call.localEffects().noiseState], [false, "off"]);
  assert.ok(events.includes("effects"));
  await call.setNoiseSuppression(true);
  assert.equal(self.audioMiddlewares.length, 1);
  assert.deepEqual(self.constraintCalls.at(-1), { noiseSuppression: true });
});

test("rtk noise: chosen off before joining, the microphone is opened without suppression and no filter is added", async () => {
  const { call, self, options } = await connected({ choices: { noiseSuppression: false } });
  assert.equal(options[0].defaults.mediaConfiguration.audio.noiseSupression, false);
  assert.equal(self.audioMiddlewares.length, 0);
  assert.equal(call.localEffects().noiseState, "off");
});

test("rtk noise: if our filter cannot run in the SDK's audio context, sound passes through and the state says basic", async () => {
  const { call, self } = await connected({ fx: fakeEffects({ noiseFails: true }) });
  const gain = { kind: "gain" };
  const node = await self.audioMiddlewares[0]({ sampleRate: 44100, createGain: () => gain });
  assert.equal(node, gain, "never an exception inside the SDK's audio path");
  assert.equal(call.localEffects().noiseState, "basic");
});

test("rtk blur: off by default; turning it on installs a per-frame middleware that draws through our renderer", async () => {
  const { call, self, fx, events } = await connected();
  assert.deepEqual([call.localEffects().background, call.localEffects().backgroundState], ["none", "off"]);
  assert.equal(self.videoMiddlewares.length, 0);
  events.length = 0;
  await call.setBackground("blur");
  assert.equal(self.videoMiddlewares.length, 1);
  assert.deepEqual([call.localEffects().background, call.localEffects().backgroundState], ["blur", "on"]);
  assert.ok(events.includes("effects"));
  // What the SDK does with it: call it once for a painter, then the painter for every frame.
  const paint = await (self.videoMiddlewares[0] as () => Promise<(canvas: unknown, context: unknown) => Promise<void>>)();
  const canvas = { width: 640, height: 360 };
  const context = { the: "context" };
  await paint(canvas, context);
  assert.deepEqual(fx.made[0].drawn, [[canvas, 640, 360, context]]);

  await call.setBackground("light");
  assert.equal(self.videoMiddlewares.length, 1, "changing strength does not reinstall anything");
  assert.equal(fx.made[0].strength, "light");
  await call.setBackground("none");
  assert.equal(self.videoMiddlewares.length, 0);
  assert.equal(call.localEffects().backgroundState, "off");
  assert.equal(fx.watches[0].stopped, true);
});

test("rtk blur: chosen before joining, it is in place before the meeting is joined", async () => {
  const { call, order, errors } = await connected({ choices: { background: "blur" } });
  assert.deepEqual(order, ["join with 1 video middleware"]);
  assert.equal(call.localEffects().backgroundState, "on");
  assert.equal(errors.length, 0);
});

test("rtk blur: chosen before joining but unable to start, the camera is turned off rather than sent unblurred", async () => {
  const { call, self, errors, meeting } = await connected({ choices: { background: "blur" }, fx: fakeEffects({ blurFails: true }), before: (m) => m.self.setVideo(true) });
  assert.equal(self.videoEnabled, false);
  assert.equal(meeting.joinCalls, 1, "the call is still joined");
  assert.match(errors[0].message, /camera was left off/);
  assert.deepEqual([call.localEffects().background, call.localEffects().backgroundState], ["none", "off"]);
});

test("rtk blur: a failure in the call rejects with a message, leaves the camera alone and resets the setting", async () => {
  const { call, self } = await connected({ fx: fakeEffects({ blurFails: true }), before: (m) => m.self.setVideo(true) });
  await assert.rejects(call.setBackground("blur"), /Your camera is unchanged/);
  assert.equal(self.videoEnabled, true);
  assert.deepEqual([call.localEffects().background, call.localEffects().backgroundState], ["none", "off"]);
  const refused = await connected();
  refused.self.refuseMiddleware = true;
  await assert.rejects(refused.call.setBackground("blur"), /Your camera is unchanged/);
  assert.equal(refused.call.localEffects().background, "none");
});

test("rtk blur: where the browser cannot do it, it is refused with the reason and never chosen", async () => {
  const { call, self } = await connected({ choices: { background: "blur" }, fx: fakeEffects({ unavailable: "This browser can't blur the background." }) });
  assert.equal(call.localEffects().background, "none");
  assert.equal(call.localEffects().backgroundUnavailable, "This browser can't blur the background.");
  await assert.rejects(call.setBackground("blur"), /can't blur/);
  assert.equal(self.videoMiddlewares.length, 0);
});

test("rtk blur: too slow for the device, it is taken off and the interface is told what was on", async () => {
  const { call, self, fx, slow } = await connected();
  await call.setBackground("light");
  fx.watches[0].onSlow();
  await settle();
  assert.deepEqual(slow, ["light"]);
  assert.equal(self.videoMiddlewares.length, 0);
  assert.deepEqual([call.localEffects().background, call.localEffects().backgroundState], ["none", "off"]);
});

test("rtk chat: what was there before you joined is marked earlier; what arrives afterwards is not", async () => {
  const grace = new FakeParticipant("p1", "Grace");
  const { call, meeting } = await connected({
    before: (m) => {
      m.participants.joined.set("p1", grace);
      m.chat.receive(grace, "before you came", 1_700_000_000_000);
    },
  });
  meeting.chat.receive(grace, "after", 1_700_000_100_000);
  assert.deepEqual(call.chatMessages().map((m) => [m.message, !!m.earlier]), [["before you came", true], ["after", false]]);
});

test("rtk chat: a link's earlier calls are not this call's conversation", async () => {
  const grace = new FakeParticipant("p1", "Grace");
  const { call } = await connected({
    before: (m) => {
      m.meta.meetingStartedTimestamp = new Date(1_700_000_050_000);
      m.chat.receive(grace, "last week's call", 1_700_000_000_000);
      m.chat.receive(grace, "this call", 1_700_000_060_000);
    },
  });
  assert.deepEqual(call.chatMessages().map((m) => m.message), ["this call"]);
});

test("rtk chat: deleting your own message asks the SDK, and everyone keeps a place-holder without the text", async () => {
  const grace = new FakeParticipant("p1", "Grace");
  const { call, meeting, self, events } = await connected({ before: (m) => m.participants.joined.set("p1", grace) });
  meeting.chat.receive(self, "mine", 1_700_000_000_000);
  meeting.chat.receive(grace, "hers", 1_700_000_001_000);
  const [mine, hers] = call.chatMessages();
  await assert.rejects(call.deleteChatMessage(hers.id), /only delete your own/);
  await assert.rejects(call.deleteChatMessage("no-such-message"), /only delete your own/);
  assert.deepEqual(meeting.chat.deleted, [], "the SDK is never asked to delete somebody else's message");
  events.length = 0;
  await call.deleteChatMessage(mine.id);
  assert.deepEqual(meeting.chat.deleted, [mine.id]);
  assert.ok(events.includes("chat"));
  assert.deepEqual(call.chatMessages().map((m) => [m.message, !!m.deleted, m.from?.name]), [["", true, "Ada"], ["hers", false, "Grace"]]);
  await assert.rejects(call.deleteChatMessage(mine.id), /only delete your own/);
  // Somebody else deleting theirs arrives the same way.
  await meeting.chat.deleteMessage(hers.id);
  assert.deepEqual(call.chatMessages().map((m) => !!m.deleted), [true, true]);
});

test("rtk chat: the pinned message is the one our server names, read from the conversation itself", async () => {
  const grace = new FakeParticipant("p1", "Grace");
  const { call, meeting } = await connected({
    grant: { pin: "msg-1" },
    before: (m) => {
      m.participants.joined.set("p1", grace);
      m.chat.receive(grace, "Agenda", 1_700_000_000_000);
    },
  });
  assert.equal(call.pinnedMessage()?.message, "Agenda");
  assert.equal(call.pinnedMessage()?.from?.name, "Grace");
  await meeting.chat.deleteMessage("msg-1");
  assert.equal(call.pinnedMessage(), null, "a deleted message is not shown as pinned");
  const unknown = await connected({ grant: { pin: "never-sent" } });
  assert.equal(unknown.call.pinnedMessage(), null, "an id that is not in the conversation shows nothing");
});

test("rtk chat: pinning goes to our server, then everyone is told to ask it again", async () => {
  const grace = new FakeParticipant("p1", "Grace");
  let pin: string | null = null;
  const { call, meeting, requests, events } = await connected({
    grant: { role: "host" },
    before: (m) => m.participants.joined.set("p1", grace),
    api: async (body) => {
      if (body.action === "pin") pin = body.messageId as string | null;
      return { coHosts: [], access: "open", pin };
    },
  });
  meeting.chat.receive(grace, "Agenda", 1_700_000_000_000);
  events.length = 0;
  await call.moderate({ action: "pin", messageId: "msg-1" });
  assert.deepEqual(requests[0], { session: "not-a-real-session", action: "pin", messageId: "msg-1" });
  assert.equal(requests[1].action, "roles");
  assert.equal(call.pinnedMessage()?.message, "Agenda");
  assert.ok(events.includes("chat"));
  assert.equal(meeting.participants.broadcasts.at(-1)?.type, ROLES_MESSAGE);
  await call.moderate({ action: "pin", messageId: null });
  assert.equal(call.pinnedMessage(), null);
});

test("rtk chat: a refused pin changes nothing, and a client told the roles changed learns the pin from the server", async () => {
  const grace = new FakeParticipant("p1", "Grace");
  let allow = false;
  const { call, meeting } = await connected({
    before: (m) => m.participants.joined.set("p1", grace),
    api: async (body) => {
      if (body.action === "pin" && !allow) throw new Error("Only the meeting host can do that.");
      return { coHosts: [], access: "open", pin: allow ? "msg-1" : null };
    },
  });
  meeting.chat.receive(grace, "Agenda", 1_700_000_000_000);
  await assert.rejects(call.moderate({ action: "pin", messageId: "msg-1" }), /Only the meeting host/);
  assert.equal(call.pinnedMessage(), null);
  assert.equal(meeting.participants.broadcasts.filter((b) => b.type === ROLES_MESSAGE).length, 0);
  // A broadcast is only a nudge: whatever it says, the pin comes from our server's answer.
  allow = true;
  meeting.participants.emit("broadcastedMessage", { type: ROLES_MESSAGE, payload: { peerId: "p1", pin: "something-else" } });
  await settle();
  assert.equal(call.pinnedMessage()?.id, "msg-1");
});
