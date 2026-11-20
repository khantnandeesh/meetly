import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, test } from "node:test";
import { readCallerToken, parseRoomMeta } from "../src/lib/host.server";
import { extendPass, passCookie, passCookieName, readPass, signPass, verifyPass, type Pass } from "../src/lib/pass.server";
import { addToLane, createReactionStore, describeReactions, LANE_LIMIT, REACTION_SHOW_MS } from "../src/lib/reactions";
import { isHostOnly, parseHostAction } from "../src/lib/rtc/hostAction";
import {
  ENDING_MESSAGE,
  LOWER_MESSAGE,
  ROLES_MESSAGE,
  RealtimeKitCall,
  type MeetingFactory,
} from "../src/lib/rtc/realtimekit";
import { readRecord } from "../src/lib/rtc/server/realtimekit";
import { REACTION_MESSAGE, createReactionLimits, isReaction, type HostApi } from "../src/lib/rtc/shared";
import type { JoinChoices, JoinGrant, RtcEventName, RtcParticipant } from "../src/lib/rtc/types";
import { FakeMeeting, FakeParticipant, FakeSelf, installDom } from "./fake-realtimekit";

/**
 * Host that survives a reload, reactions, host tools, ask to join: the parts that can be checked
 * without a call. The RealtimeKit adapter is run against the stand-in meeting object, with our
 * own /api/host replaced by a recorder; as in realtimekit.test.ts, that shows what the adapter
 * does with the SDK's events and methods, not that a real session behaves as assumed.
 */

/* ------------------------------------------------------------ the pass cookie */

const SECRET = "test-secret";
const CODE = "abc-defg-hij";
const request = (cookie?: string, url = "http://localhost:3000/api/token") =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });

test("a pass survives the round trip through a cookie", () => {
  const pass = { code: CODE, key: "host-key", ids: ["one", "two"] };
  const header = passCookie(request(), pass, SECRET);
  const cookie = header.split(";")[0];
  assert.ok(cookie.startsWith(`${passCookieName(CODE)}=`));
  assert.deepEqual(readPass(request(`other=1; ${cookie}; more=2`), CODE, SECRET), pass);
});

test("the pass cookie is HttpOnly and SameSite, and Secure exactly when served over https", () => {
  const pass = { code: CODE, ids: [] };
  const plain = passCookie(request(), pass, SECRET);
  assert.match(plain, /; HttpOnly/);
  assert.match(plain, /; SameSite=Lax/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(passCookie(request(undefined, "https://meetly.example/api/token"), pass, SECRET), /; Secure/);
  const proxied = new Request("http://internal/api/token", { headers: { "x-forwarded-proto": "https" } });
  assert.match(passCookie(proxied, pass, SECRET), /; Secure/);
});

test("a pass that was altered, forged, expired or made for another meeting counts for nothing", () => {
  const empty = { code: CODE, ids: [] };
  const signed = signPass({ code: CODE, key: "host-key", ids: ["one"] }, SECRET);
  const [payload, signature] = signed.split(".");
  // A guest writing themselves a host key.
  const forgedPayload = Buffer.from(JSON.stringify({ c: CODE, k: "host-key", i: [], x: 9999999999 })).toString("base64url");
  assert.deepEqual(verifyPass(`${forgedPayload}.${signature}`, CODE, SECRET), empty);
  assert.deepEqual(verifyPass(`${forgedPayload}.`, CODE, SECRET), empty);
  assert.deepEqual(verifyPass(`${payload}.${signature.slice(0, -2)}xx`, CODE, SECRET), empty);
  assert.deepEqual(verifyPass(signed, CODE, "another-secret"), empty);
  assert.deepEqual(verifyPass(signed, "zzz-zzzz-zzz", SECRET), { code: "zzz-zzzz-zzz", ids: [] });
  assert.deepEqual(verifyPass(signPass({ code: CODE, key: "k", ids: [] }, SECRET, 0), CODE, SECRET), empty);
  for (const junk of [undefined, null, 42, "", "a.b.c", "nodot"]) assert.deepEqual(verifyPass(junk, CODE, SECRET), empty);
  assert.deepEqual(verifyPass(signed, CODE, ""), empty);
});

test("joining again adds the new identity to the pass and keeps the host key", () => {
  const first = extendPass({ code: CODE, ids: [] }, "one", "host-key");
  assert.deepEqual(first, { code: CODE, key: "host-key", ids: ["one"] });
  const second = extendPass(first, "two");
  assert.deepEqual(second, { code: CODE, key: "host-key", ids: ["one", "two"] });
  assert.deepEqual(extendPass(second, "one").ids, ["two", "one"]);
  let many: Pass = second;
  for (let i = 0; i < 40; i++) many = extendPass(many, `id-${i}`);
  assert.equal(many.ids.length, 12);
  assert.equal(many.ids.at(-1), "id-39");
});

/* ----------------------------------------------------- LiveKit caller tokens */

function liveKitToken(claims: Record<string, unknown>, secret: string, alg = "HS256"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${encode({ alg, typ: "JWT" })}.${encode(claims)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

test("a caller is whoever a token we signed says, even after the token's short life is over", () => {
  const now = 1_800_000_000_000;
  const issued = Math.floor(now / 1000) - 3600; // an hour into the call: long past the 10-minute expiry
  const claims = { iss: "key", sub: "ada", nbf: issued, exp: issued + 600, video: { room: CODE, roomJoin: true } };
  assert.deepEqual(readCallerToken(liveKitToken(claims, "secret"), "key", "secret", now), { room: CODE, identity: "ada" });
});

test("a caller token that is forged, re-signed, from another key, unsigned or stale is nobody", () => {
  const now = 1_800_000_000_000;
  const issued = Math.floor(now / 1000) - 60;
  const claims = { iss: "key", sub: "guest", nbf: issued, exp: issued + 600, video: { room: CODE } };
  const good = liveKitToken(claims, "secret");
  const [head, body, signature] = good.split(".");
  // The guest swaps in the host's identity and keeps their own signature.
  const swapped = Buffer.from(JSON.stringify({ ...claims, sub: "host" })).toString("base64url");
  assert.equal(readCallerToken(`${head}.${swapped}.${signature}`, "key", "secret", now), null);
  assert.equal(readCallerToken(liveKitToken({ ...claims, sub: "host" }, "guessed"), "key", "secret", now), null);
  assert.equal(readCallerToken(liveKitToken(claims, "secret"), "other-key", "secret", now), null);
  assert.equal(readCallerToken(`${Buffer.from('{"alg":"none"}').toString("base64url")}.${body}.`, "key", "secret", now), null);
  assert.equal(readCallerToken(liveKitToken(claims, "secret", "none"), "key", "secret", now), null);
  assert.equal(readCallerToken(good, "key", "secret", now + 13 * 60 * 60 * 1000), null);
  assert.equal(readCallerToken(liveKitToken({ ...claims, video: {} }, "secret"), "key", "secret", now), null);
  for (const junk of ["", "a.b", "a.b.c", "not a token"]) assert.equal(readCallerToken(junk, "key", "secret", now), null);
});

test("room metadata that is missing, malformed or partly wrong reads as an open meeting with no host", () => {
  assert.deepEqual(parseRoomMeta(undefined), { host: undefined, claimedAt: undefined, kid: undefined, cohosts: [], access: "open", banned: [] });
  assert.deepEqual(parseRoomMeta("not json"), {});
  assert.deepEqual(parseRoomMeta('"a string"'), {});
  const meta = parseRoomMeta(JSON.stringify({ host: "a", kid: "k", cohosts: ["b", 7, null], access: "everyone", banned: "x" }));
  assert.deepEqual(meta, { host: "a", claimedAt: undefined, kid: "k", cohosts: ["b"], access: "open", banned: [] });
  assert.equal(parseRoomMeta(JSON.stringify({ access: "locked" })).access, "locked");
});

/* ------------------------------------------------------------ host requests */

test("a host request is read from the body, or refused if it is not one we know", () => {
  assert.deepEqual(parseHostAction({ action: "mute", identity: "x" }), { action: "mute", identity: "x" });
  assert.deepEqual(parseHostAction({ action: "remove", participantId: "x" }), { action: "remove", identity: "x" });
  assert.deepEqual(parseHostAction({ action: "muteAll", identity: "ignored" }), { action: "muteAll" });
  assert.deepEqual(parseHostAction({ action: "coHost", identity: "x", on: true }), { action: "coHost", identity: "x", on: true });
  assert.deepEqual(parseHostAction({ action: "access", access: "ask" }), { action: "access", access: "ask" });
  for (const bad of [
    {},
    { action: "mute" },
    { action: "mute", identity: "" },
    { action: "mute", identity: 5 },
    { action: "coHost", identity: "x" },
    { action: "coHost", identity: "x", on: "yes" },
    { action: "access", access: "everyone" },
    { action: "makeHost", identity: "x" },
    { action: "roles" },
  ]) {
    assert.equal(parseHostAction(bad), null, JSON.stringify(bad));
  }
});

test("only ending the call and choosing co-hosts are kept from co-hosts", () => {
  assert.equal(isHostOnly({ action: "end" }), true);
  assert.equal(isHostOnly({ action: "coHost", identity: "x", on: true }), true);
  for (const action of ["mute", "remove", "stopCamera", "lowerHand", "admit", "deny"] as const) {
    assert.equal(isHostOnly({ action, identity: "x" }), false);
  }
  assert.equal(isHostOnly({ action: "muteAll" }), false);
  assert.equal(isHostOnly({ action: "access", access: "locked" }), false);
});

/* --------------------------------------- the RealtimeKit meeting's record */

const record = (id: string, custom: string, preset = "meetly-guest") => ({
  id,
  custom_participant_id: custom,
  preset_name: preset,
  created_at: "2026-01-01T00:00:00Z",
});

test("the meeting's record is read out of its participant list, and marker records are not people", () => {
  const list = [
    record("p1", "m-host", "meetly-host"),
    record("p2", "m-ben"),
    record("p3", "m-cy"),
    record("x1", "meetly-cohost:p2"),
    record("x2", "meetly-ban:m-gone"),
    record("x3", "meetly-access:locked"),
  ];
  const read = readRecord(list, "meetly-host", false);
  assert.deepEqual(read.people.map((p) => p.id), ["p1", "p2", "p3"]);
  assert.deepEqual(read.hosts.map((p) => p.id), ["p1"]);
  assert.deepEqual([...read.coHostIds], ["p2"]);
  assert.deepEqual([...read.banned], ["m-gone"]);
  assert.equal(read.access, "locked");
});

test("asking to join only counts where the app has a preset for it, and the stricter statement wins", () => {
  const ask = [record("x1", "meetly-access:ask")];
  assert.equal(readRecord(ask, "meetly-host", true).access, "ask");
  assert.equal(readRecord(ask, "meetly-host", false).access, "open");
  assert.equal(readRecord([...ask, record("x2", "meetly-access:locked")], "meetly-host", true).access, "locked");
  assert.equal(readRecord([], "meetly-host", true).access, "open");
});

test("a marker record holding the host preset by mistake would still not be a host", () => {
  const read = readRecord([record("x1", "meetly-cohost:p9", "meetly-host")], "meetly-host", false);
  assert.equal(read.hosts.length, 0);
});

/* ---------------------------------------------------------------- reactions */

test("only the six reactions are reactions", () => {
  for (const emoji of ["👍", "❤️", "😂", "😮", "👏", "🎉"]) assert.equal(isReaction(emoji), true);
  for (const other of ["💩", "", "👍👍", "<b>", 1, null, undefined, {}]) assert.equal(isReaction(other), false);
});

test("you may send one reaction per 400 ms; each sender is shown at most one per 250 ms", () => {
  let now = 1000;
  const limits = createReactionLimits(() => now);
  assert.equal(limits.maySend(), true);
  now += 399;
  assert.equal(limits.maySend(), false);
  now += 1;
  assert.equal(limits.maySend(), true);
  assert.equal(limits.mayReceive("a"), true);
  assert.equal(limits.mayReceive("b"), true, "another sender is not held back by the first");
  now += 100;
  assert.equal(limits.mayReceive("a"), false);
  now += 150;
  assert.equal(limits.mayReceive("a"), true);
});

test("the lane takes twelve entries, then folds same-emoji reactions into a count", () => {
  let lane = [] as ReturnType<typeof addToLane>;
  for (let i = 0; i < LANE_LIMIT; i++) lane = addToLane(lane, { id: i, emoji: i % 2 ? "👏" : "🎉", name: `P${i}` });
  assert.equal(lane.length, LANE_LIMIT);
  lane = addToLane(lane, { id: 100, emoji: "👏", name: "Late" });
  lane = addToLane(lane, { id: 101, emoji: "👏", name: "Later" });
  assert.equal(lane.length, LANE_LIMIT);
  assert.deepEqual(lane.at(-1), { id: 11, emoji: "👏", name: "", count: 3 });
  // An emoji nobody in the lane is showing pushes the oldest entry out instead.
  lane = addToLane(lane, { id: 102, emoji: "😮", name: "New" });
  assert.equal(lane.length, LANE_LIMIT);
  assert.equal(lane[0].id, 1);
  assert.deepEqual(lane.at(-1), { id: 102, emoji: "😮", name: "New", count: 1 });
});

test("reactions are described for screen readers by who and, when they agree, what", () => {
  assert.equal(describeReactions([]), "");
  assert.equal(describeReactions([{ name: "Maya", emoji: "👏" }]), "Maya reacted 👏");
  assert.equal(describeReactions([{ name: "Maya", emoji: "👏" }, { name: "Sam", emoji: "🎉" }]), "Maya and Sam reacted");
  const five = ["Maya", "Sam", "Ada", "Ben", "Cy", "Maya"].map((name) => ({ name, emoji: "👏" }));
  assert.equal(describeReactions(five), "Maya and 4 others reacted 👏");
});

test("a reaction goes to the sender's tile if it is in view and to the lane if not, never both", () => {
  const timers: { run: () => void; ms: number }[] = [];
  const store = createReactionStore((run, ms) => timers.push({ run, ms }));
  let tileChanges = 0;
  let laneChanges = 0;
  store.subscribeTile("ben")(() => tileChanges++);
  store.subscribeLane(() => laneChanges++);
  store.add("ben", "Ben", "👏", true);
  assert.equal(store.tile("ben")?.emoji, "👏");
  assert.equal(store.lane().length, 0);
  assert.deepEqual([tileChanges, laneChanges], [1, 0]);
  store.add("cy", "Cy", "🎉", false);
  assert.equal(store.tile("cy"), undefined);
  assert.deepEqual(store.lane().map((entry) => [entry.emoji, entry.name]), [["🎉", "Cy"]]);
  assert.deepEqual([tileChanges, laneChanges], [1, 1]);
  // The tile's reaction is taken down after its time, unless a newer one replaced it.
  const takeDown = timers.find((timer) => timer.ms === REACTION_SHOW_MS)!;
  store.add("ben", "Ben", "❤️", true);
  takeDown.run();
  assert.equal(store.tile("ben")?.emoji, "❤️");
  timers.filter((timer) => timer.ms === REACTION_SHOW_MS).at(-1)!.run();
  assert.equal(store.tile("ben"), undefined);
});

test("screen readers hear one sentence per burst, not one per reaction", () => {
  const timers: { run: () => void; ms: number }[] = [];
  const store = createReactionStore((run, ms) => timers.push({ run, ms }));
  let spoken = 0;
  store.subscribeAnnouncement(() => spoken++);
  store.add("a", "Maya", "👏", true);
  store.add("b", "Sam", "👏", true);
  store.add("c", "Ada", "👏", false);
  assert.equal(store.announcement(), "");
  // The one timer that is not a tile's take-down is the announcement gathering the burst.
  const gathering = timers.filter((timer) => timer.ms !== REACTION_SHOW_MS);
  assert.equal(gathering.length, 1);
  gathering[0].run();
  assert.equal(store.announcement(), "Maya and 2 others reacted 👏");
  assert.equal(spoken, 1);
  // More arrive straight after: they wait for the next turn rather than interrupting.
  store.add("a", "Maya", "🎉", true);
  assert.equal(store.announcement(), "Maya and 2 others reacted 👏");
});

/* -------------------------------------- the RealtimeKit adapter's additions */

const grant: Extract<JoinGrant, { provider: "realtimekit" }> = {
  provider: "realtimekit",
  authToken: "not-a-real-token",
  session: "signed-session",
  participantId: "rest-participant-id",
  meetingId: "meeting-id",
  role: "guest",
  hostPreset: "meetly-host",
  coHosts: [],
  access: "open",
  canAsk: false,
};
const choices: JoinChoices = { username: "Ada", audioEnabled: true, videoEnabled: false, audioDeviceId: "default", videoDeviceId: "default" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  installDom();
});

type Setup = {
  grant?: Partial<typeof grant>;
  selfPreset?: string;
  before?: (meeting: FakeMeeting) => void;
  /** What our server answers; by default yes to everything. */
  server?: (body: Record<string, unknown>) => Record<string, unknown> | Error;
};

async function connected(setup: Setup = {}) {
  const self = new FakeSelf("self", "Ada", { presetName: setup.selfPreset ?? "meetly-guest" });
  self.audioEnabled = true;
  const meeting = new FakeMeeting(self);
  setup.before?.(meeting);
  const factory = (async () => meeting) as unknown as MeetingFactory;
  const requests: Record<string, unknown>[] = [];
  const api: HostApi = async (body) => {
    requests.push(body);
    const answer = setup.server?.(body) ?? {};
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const call = new RealtimeKitCall({ ...grant, ...setup.grant }, choices, factory, api);
  const seen: { event: RtcEventName; args: unknown[] }[] = [];
  const names: RtcEventName[] = ["status", "disconnected", "host", "access", "waiting", "reaction", "roster", "handRaised", "participantJoined"];
  for (const event of names) call.on(event, (...args: unknown[]) => seen.push({ event, args }));
  const count = (event: RtcEventName) => seen.filter((entry) => entry.event === event).length;
  const last = (event: RtcEventName) => seen.findLast((entry) => entry.event === event)?.args;
  call.connect();
  await tick();
  await tick();
  const sent = (type: string) => meeting.participants.broadcasts.filter((message) => message.type === type);
  /** A broadcast from somebody else's client, as the SDK delivers it. */
  const receive = (type: string, payload: Record<string, unknown>) =>
    meeting.participants.emit("broadcastedMessage", { type, payload, timestamp: Date.now() });
  return { call, meeting, self, seen, count, last, requests, sent, receive };
}

test("a reaction you send is shown to you at once and broadcast with who sent it", async () => {
  const { call, sent, last, count } = await connected();
  await call.sendReaction("👏");
  assert.deepEqual(sent(REACTION_MESSAGE).map((message) => message.payload), [{ peerId: "self", emoji: "👏" }]);
  assert.equal(count("reaction"), 1, "your own broadcast coming back is not shown twice");
  const [who, emoji] = last("reaction") as [RtcParticipant, string];
  assert.equal(who.isLocal, true);
  assert.equal(emoji, "👏");
});

test("reactions are throttled on the way out, and anything but the six is not sent at all", async () => {
  const { call, sent, count } = await connected();
  await call.sendReaction("👏");
  await call.sendReaction("🎉");
  await call.sendReaction("👏");
  assert.equal(sent(REACTION_MESSAGE).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 420));
  await call.sendReaction("💩");
  await call.sendReaction("<script>");
  assert.equal(sent(REACTION_MESSAGE).length, 1);
  await call.sendReaction("🎉");
  assert.equal(sent(REACTION_MESSAGE).length, 2);
  assert.equal(count("reaction"), 2);
});

test("someone else's reaction is attributed to them; unknown senders, other emoji and floods are dropped", async () => {
  const { meeting, receive, seen } = await connected();
  meeting.arrive(new FakeParticipant("p1", "Grace"));
  const shown = () => seen.filter((entry) => entry.event === "reaction").map((entry) => [(entry.args[0] as RtcParticipant).name, entry.args[1]]);
  receive(REACTION_MESSAGE, { peerId: "p1", emoji: "❤️" });
  assert.deepEqual(shown(), [["Grace", "❤️"]]);
  receive(REACTION_MESSAGE, { peerId: "p1", emoji: "❤️" });
  receive(REACTION_MESSAGE, { peerId: "p1", emoji: "👍" });
  assert.equal(shown().length, 1, "a second and third within the limit are dropped");
  receive(REACTION_MESSAGE, { peerId: "nobody", emoji: "❤️" });
  receive(REACTION_MESSAGE, { emoji: "❤️" });
  await new Promise((resolve) => setTimeout(resolve, 270));
  receive(REACTION_MESSAGE, { peerId: "p1", emoji: "💩" });
  receive(REACTION_MESSAGE, { peerId: "p1", emoji: 3 });
  assert.equal(shown().length, 1);
  receive(REACTION_MESSAGE, { peerId: "p1", emoji: "🎉" });
  assert.deepEqual(shown().at(-1), ["Grace", "🎉"]);
});

test("a reaction is not sent before the call is connected", async () => {
  const self = new FakeSelf("self", "Ada");
  const meeting = new FakeMeeting(self);
  const call = new RealtimeKitCall(grant, choices, (async () => meeting) as unknown as MeetingFactory, async () => ({}));
  await call.sendReaction("👏");
  assert.equal(meeting.participants.broadcasts.length, 0);
});

test("co-hosts and access start as the server said at joining", async () => {
  const { call } = await connected({ grant: { coHosts: ["m-p1"], access: "locked" } });
  assert.deepEqual(call.coHosts(), ["m-p1"]);
  assert.equal(call.access, "locked");
});

test("every moderation request goes to our server with the signed session, never just to the SDK", async () => {
  const { call, meeting, requests } = await connected({ selfPreset: "meetly-host", grant: { role: "host" } });
  meeting.arrive(new FakeParticipant("p1", "Grace"));
  await call.moderate({ action: "mute", identity: "m-p1" });
  await call.moderate({ action: "muteAll" });
  assert.deepEqual(requests, [
    { session: "signed-session", action: "mute", identity: "m-p1" },
    { session: "signed-session", action: "muteAll" },
  ]);
});

test("a request our server refuses is rejected with its message, and nothing is done in the SDK", async () => {
  const { call, meeting, sent } = await connected({
    server: () => new Error("Only the meeting host can do that."),
  });
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  grace.setVideo(true);
  meeting.participants.waitlisted.add(new FakeParticipant("w1", "Walt"));
  for (const action of [
    { action: "stopCamera", identity: "m-p1" },
    { action: "admit", identity: "w1" },
    { action: "deny", identity: "w1" },
    { action: "lowerAllHands" },
    { action: "coHost", identity: "m-p1", on: true },
    { action: "end" },
  ] as const) {
    await assert.rejects(call.moderate(action), /Only the meeting host/);
  }
  assert.equal(grace.videoStops, 0);
  assert.deepEqual(meeting.participants.accepted, []);
  assert.deepEqual(meeting.participants.rejected, []);
  assert.equal(sent(LOWER_MESSAGE).length, 0);
  assert.equal(sent(ROLES_MESSAGE).length, 0);
});

test("making a co-host asks the server, re-reads the roles, and tells the other clients to do the same", async () => {
  const { call, meeting, requests, sent, count } = await connected({
    selfPreset: "meetly-host",
    grant: { role: "host" },
    server: (body) => (body.action === "roles" ? { coHosts: ["m-p1"], access: "open" } : {}),
  });
  meeting.arrive(new FakeParticipant("p1", "Grace"));
  const hostEvents = count("host");
  await call.moderate({ action: "coHost", identity: "m-p1", on: true });
  assert.deepEqual(requests.map((body) => body.action), ["coHost", "roles"]);
  assert.deepEqual(call.coHosts(), ["m-p1"]);
  assert.equal(count("host"), hostEvents + 1);
  assert.equal(sent(ROLES_MESSAGE).length, 1);
});

test("told that roles changed, a client asks our server who they are; the message itself is not believed", async () => {
  let answer: Record<string, unknown> = { coHosts: [], access: "open" };
  const { call, receive, requests, count } = await connected({ server: () => answer });
  // A guest's client claims to be a co-host in the broadcast: the claim is ignored, the server is asked.
  receive(ROLES_MESSAGE, { peerId: "p9", coHosts: ["m-self"], access: "open" });
  await tick();
  assert.deepEqual(requests, [{ session: "signed-session", action: "roles" }]);
  assert.deepEqual(call.coHosts(), []);
  assert.equal(count("host"), 0);
  // When the server does say so, it is taken up, with one event per thing that changed.
  answer = { coHosts: ["m-self"], access: "locked" };
  receive(ROLES_MESSAGE, { peerId: "p9" });
  await tick();
  assert.deepEqual(call.coHosts(), ["m-self"]);
  assert.equal(call.access, "locked");
  assert.equal(count("host"), 1);
  assert.equal(count("access"), 1);
});

test("a roles answer that makes no sense leaves an open meeting with no co-hosts", async () => {
  const { call, receive } = await connected({ grant: { coHosts: ["m-p1"], access: "locked" }, server: () => ({ coHosts: "everyone", access: 7 }) });
  receive(ROLES_MESSAGE, { peerId: "p9" });
  await tick();
  assert.deepEqual(call.coHosts(), []);
  assert.equal(call.access, "open");
});

test("stopping a camera is done by the SDK on that participant, after the server agreed", async () => {
  const { call, meeting, requests } = await connected({ selfPreset: "meetly-host", grant: { role: "host" } });
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  const linus = meeting.arrive(new FakeParticipant("p2", "Linus"));
  grace.setVideo(true);
  linus.setVideo(true);
  await call.moderate({ action: "stopCamera", identity: "m-p1" });
  assert.equal(requests[0].action, "stopCamera");
  assert.equal(grace.videoStops, 1);
  assert.equal(linus.videoStops, 0);
  await assert.rejects(call.moderate({ action: "stopCamera", identity: "m-gone" }), /already left/);
});

test("what depends on presets is offered only when the preset allows it", async () => {
  const plain = await connected({ selfPreset: "meetly-host", grant: { role: "host" } });
  assert.deepEqual(plain.call.supports, { askToJoin: false, stopCamera: false, polls: false, createPolls: false });
  const able = await connected({
    selfPreset: "meetly-host",
    grant: { role: "host", canAsk: true },
    before: (meeting) => {
      meeting.self.permissions = { acceptWaitingRequests: true, canDisableParticipantVideo: true };
    },
  });
  assert.deepEqual(able.call.supports, { askToJoin: true, stopCamera: true, polls: false, createPolls: false });
  // The host may accept, but the app has no preset that makes anyone wait: still not offered.
  const noPreset = await connected({
    before: (meeting) => {
      meeting.self.permissions = { acceptWaitingRequests: true, canDisableParticipantVideo: false };
    },
  });
  assert.equal(noPreset.call.supports.askToJoin, false);
});

test("lowering one hand and all hands are messages; the people named lower their own", async () => {
  const host = await connected({ selfPreset: "meetly-host", grant: { role: "host" } });
  host.meeting.arrive(new FakeParticipant("p1", "Grace"));
  await host.call.moderate({ action: "lowerHand", identity: "m-p1" });
  assert.deepEqual(host.sent(LOWER_MESSAGE).at(-1)?.payload, { peerIds: ["p1"], peerId: "self" });
  await host.call.moderate({ action: "lowerAllHands" });
  assert.deepEqual(host.sent(LOWER_MESSAGE).at(-1)?.payload, { all: true, peerId: "self" });

  const guest = await connected();
  await guest.call.setHandRaised(true);
  guest.receive(LOWER_MESSAGE, { peerId: "host-peer", peerIds: ["someone-else"] });
  await tick();
  assert.equal(guest.call.local.handRaised, true, "a message about someone else's hand leaves yours up");
  guest.receive(LOWER_MESSAGE, { peerId: "host-peer", peerIds: ["self"] });
  await tick();
  assert.equal(guest.call.local.handRaised, false);
  await guest.call.setHandRaised(true);
  guest.receive(LOWER_MESSAGE, { peerId: "host-peer", all: true });
  await tick();
  assert.equal(guest.call.local.handRaised, false);
});

test("ending the call tells everyone first, then asks the server", async () => {
  const order: string[] = [];
  const { call, meeting } = await connected({
    selfPreset: "meetly-host",
    grant: { role: "host" },
    server: (body) => {
      order.push(`server:${String(body.action)}`);
      return {};
    },
  });
  const broadcast = meeting.participants.broadcastMessage.bind(meeting.participants);
  meeting.participants.broadcastMessage = async (type, payload, target) => {
    order.push(`broadcast:${type}`);
    return broadcast(type, payload, target);
  };
  await call.moderate({ action: "end" });
  assert.deepEqual(order, [`broadcast:${ENDING_MESSAGE}`, "server:end"]);
});

test("being disconnected just after the host said the call is ending counts as ended, not as removed", async () => {
  const ended = await connected();
  ended.receive(ENDING_MESSAGE, { peerId: "host-peer" });
  ended.meeting.leftAs("kicked");
  assert.deepEqual(ended.last("disconnected"), ["ended"]);
  const removed = await connected();
  removed.meeting.leftAs("kicked");
  assert.deepEqual(removed.last("disconnected"), ["removed"]);
  const sdkEnded = await connected();
  sdkEnded.meeting.leftAs("ended");
  assert.deepEqual(sdkEnded.last("disconnected"), ["ended"]);
});

test("joining a meeting with a waiting room reports waiting, then connected once a host lets you in", async () => {
  const { call, meeting, seen, count } = await connected({
    before: (m) => {
      m.waitingRoom = true;
    },
  });
  assert.equal(call.status, "waiting");
  assert.equal(count("participantJoined"), 0);
  assert.equal(count("disconnected"), 0);
  meeting.letIn();
  assert.equal(call.status, "connected");
  assert.deepEqual(seen.filter((entry) => entry.event === "status").length, 3, "connecting, waiting, connected");
});

test("being turned away from the waiting room ends the call as denied", async () => {
  const { call, meeting, last } = await connected({
    before: (m) => {
      m.waitingRoom = true;
    },
  });
  meeting.leftAs("rejected");
  assert.deepEqual(last("disconnected"), ["denied"]);
  assert.equal(call.status, "disconnected");
});

test("a host whose preset may answer the waiting room sees who is waiting; nobody else does", async () => {
  const guest = await connected();
  guest.meeting.participants.waitlisted.add(new FakeParticipant("w1", "Walt"));
  assert.deepEqual(guest.call.waiting(), []);
  assert.equal(guest.count("waiting"), 0);

  const host = await connected({
    selfPreset: "meetly-host",
    grant: { role: "host", canAsk: true },
    before: (meeting) => {
      meeting.self.permissions = { acceptWaitingRequests: true, canDisableParticipantVideo: false };
      meeting.participants.waitlisted.set("w0", new FakeParticipant("w0", "Early"));
    },
  });
  assert.deepEqual(host.call.waiting(), [{ id: "w0", name: "Early" }], "people already waiting when the host joined");
  host.meeting.participants.waitlisted.add(new FakeParticipant("w1", "Walt"));
  assert.deepEqual(host.call.waiting().map((person) => person.name), ["Early", "Walt"]);
  assert.equal(host.count("participantJoined"), 0, "someone waiting has not joined");
  assert.equal(host.call.participants().length, 1);
});

test("admit and deny answer the waiting room through the SDK, after the server agreed", async () => {
  const { call, meeting, requests } = await connected({
    selfPreset: "meetly-host",
    grant: { role: "host", canAsk: true },
    before: (m) => {
      m.self.permissions = { acceptWaitingRequests: true, canDisableParticipantVideo: false };
    },
  });
  meeting.participants.waitlisted.add(new FakeParticipant("w1", "Walt"));
  meeting.participants.waitlisted.add(new FakeParticipant("w2", "Wren"));
  await call.moderate({ action: "admit", identity: "w1" });
  await call.moderate({ action: "deny", identity: "w2" });
  assert.deepEqual(requests.map((body) => [body.action, body.identity]), [["admit", "w1"], ["deny", "w2"]]);
  assert.deepEqual(meeting.participants.accepted, ["w1"]);
  assert.deepEqual(meeting.participants.rejected, ["w2"]);
  assert.deepEqual(call.waiting(), []);
});

test("moderating before the call is connected is refused without asking anyone", async () => {
  const self = new FakeSelf("self", "Ada");
  const requests: unknown[] = [];
  const call = new RealtimeKitCall(grant, choices, (async () => new FakeMeeting(self)) as unknown as MeetingFactory, async (body) => {
    requests.push(body);
    return {};
  });
  await assert.rejects(call.moderate({ action: "muteAll" }), /Not connected/);
  assert.equal(requests.length, 0);
});
