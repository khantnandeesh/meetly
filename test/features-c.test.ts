import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { CLEAR_HOLD_MS, DISMISS_QUIET_MS, HEALTH_START, POOR_HOLD_MS, REPEAT_QUIET_MS, dismissHealth, stepHealth } from "../src/lib/callHealth";
import { parseRoomMeta } from "../src/lib/host.server";
import { miniTile } from "../src/lib/miniTile";
import { MAX_VOTERS, addStoredPoll, castStoredVote, closeStoredPoll, storedVotesOf, voterKey } from "../src/lib/pollStore";
import { isHostOnly, parseHostAction } from "../src/lib/rtc/hostAction";
import { DEMAND_HEADROOM, ROLES_MESSAGE, RealtimeKitCall, type Effects, type MeetingFactory } from "../src/lib/rtc/realtimekit";
import { readRecord } from "../src/lib/rtc/server/realtimekit";
import { SAVER_FPS, SAVER_HEIGHT, SAVER_WIDTH, checkNewPoll, readStoredPolls, tally, type StoredPoll } from "../src/lib/rtc/shared";
import { POLL_LIMITS, type JoinChoices, type JoinGrant, type NewPoll, type RtcParticipant, type RtcTile } from "../src/lib/rtc/types";
import { lengthBucket, sendUsageEvent, sizeBucket } from "../src/lib/usage";
import { FakeMeeting, FakeParticipant, FakeSelf, castFakeVote, installDom } from "./fake-realtimekit";

/**
 * The mini window, polls, call quality and the leave-screen rating: the parts that are plain
 * logic, and the RealtimeKit adapter against the stand-in meeting object. As with the other
 * adapter tests, none of this shows how a real RealtimeKit session behaves.
 */

/* --------------------------------------------------------- polls: the rules */

const lunch: NewPoll = { question: "Lunch?", options: ["Pizza", "Sushi"], anonymous: true };
const SECRET = "test-secret";
const ROOM = "abc-defg-hij";
const started = (polls: StoredPoll[] = [], poll: NewPoll = lunch, id = "p1") => addStoredPoll(polls, poll, "Maya", id, 1000) as StoredPoll[];
const vote = (polls: StoredPoll[], identity: string, option: unknown, earlier: string[] = [], pollId = "p1") =>
  castStoredVote(polls, pollId, option, { identity, earlier }, ROOM, SECRET);

test("a new poll is tidied and checked against the limits, with the reason when it fails", () => {
  assert.deepEqual(checkNewPoll({ question: "  Lunch? ", options: [" Pizza ", "", "Sushi"], anonymous: true }), lunch);
  assert.deepEqual(checkNewPoll({ question: "Q", options: ["A", "B"] }), { question: "Q", options: ["A", "B"], anonymous: false });
  assert.match(checkNewPoll({ question: " ", options: ["A", "B"] }) as string, /needs a question/);
  assert.match(checkNewPoll({ question: "x".repeat(POLL_LIMITS.question + 1), options: ["A", "B"] }) as string, /under 140/);
  assert.match(checkNewPoll({ question: "Q", options: ["A", " "] }) as string, /at least 2/);
  assert.match(checkNewPoll({ question: "Q", options: ["A", "a "] }) as string, /the same/);
  assert.match(checkNewPoll({ question: "Q", options: ["1", "2", "3", "4", "5", "6", "7"] }) as string, /at most 6/);
  assert.match(checkNewPoll({ question: "Q", options: ["A", "y".repeat(POLL_LIMITS.option + 1)] }) as string, /under 80/);
  for (const junk of [null, 5, "poll", [], { question: 5, options: "AB" }]) assert.equal(typeof checkNewPoll(junk), "string");
});

test("polls: no more than five open at once; finished ones are kept, the oldest dropped", () => {
  let polls: StoredPoll[] = [];
  for (let n = 0; n < POLL_LIMITS.open; n++) polls = started(polls, lunch, `p${n}`);
  const sixth = addStoredPoll(polls, lunch, "Maya", "p9", 1000);
  assert.ok(!Array.isArray(sixth) && sixth.status === 409);
  // Ending one makes room, and the ended one stays to be looked at.
  polls = closeStoredPoll(polls, "p0")!;
  polls = started(polls, lunch, "p9");
  assert.deepEqual(polls.map((poll) => poll.id), ["p0", "p1", "p2", "p3", "p4", "p9"]);
  for (let n = 0; n < 8; n++) {
    polls = closeStoredPoll(polls, polls.find((poll) => !poll.c)!.id)!;
    polls = started(polls, lunch, `q${n}`);
  }
  assert.equal(polls.filter((poll) => poll.c).length, 5, "five finished polls are kept");
  assert.equal(polls.filter((poll) => !poll.c).length, POLL_LIMITS.open);
});

test("polls: one vote per identity; the same vote again changes nothing, a different one is refused", () => {
  let polls = started();
  const first = vote(polls, "ada", 1);
  assert.ok(first.status === 200 && first.polls);
  polls = first.polls;
  assert.deepEqual(tally(polls[0]), [0, 1]);
  const same = vote(polls, "ada", 1);
  assert.ok(same.status === 200 && same.polls === null, "asking again for the vote already counted writes nothing");
  assert.equal(vote(polls, "ada", 0).status, 409);
  const second = vote(polls, "ben", 0);
  assert.ok(second.status === 200 && second.polls);
  assert.deepEqual(tally(second.polls[0]), [1, 1]);
});

test("polls: a browser that held another identity before (its signed pass says so) has already voted", () => {
  const polls = (vote(started(), "old-identity", 0) as { polls: StoredPoll[] }).polls;
  assert.equal(vote(polls, "new-identity", 1, ["old-identity"]).status, 409);
  assert.equal(vote(polls, "new-identity", 0, ["old-identity"]).status, 409, "not even for the same option: it would count twice");
  assert.equal(vote(polls, "someone-else", 1, ["unrelated"]).status, 200);
  assert.deepEqual(storedVotesOf(polls, ["old-identity", "new-identity"], ROOM, SECRET), { p1: { option: 0, key: voterKey(polls[0], ROOM, "old-identity", SECRET) } });
  assert.deepEqual(storedVotesOf(polls, ["new-identity"], ROOM, SECRET), {});
});

test("polls: votes that are not votes are refused", () => {
  const polls = started();
  for (const option of [2, -1, 0.5, "0", null, undefined, NaN]) assert.equal(vote(polls, "ada", option).status, 400, String(option));
  assert.equal(vote(polls, "ada", 0, [], "nope").status, 404);
  const closed = closeStoredPoll(polls, "p1")!;
  assert.equal(vote(closed, "ada", 0).status, 409);
  assert.equal(closeStoredPoll(polls, "nope"), null);
});

test("polls: an anonymous poll's record does not say who voted; a named one does", () => {
  const anonymous = (vote(started(), "identity-of-ada", 1) as { polls: StoredPoll[] }).polls;
  assert.ok(!JSON.stringify(anonymous).includes("identity-of-ada"));
  const key = voterKey(anonymous[0], ROOM, "identity-of-ada", SECRET);
  assert.deepEqual(anonymous[0].v, { [key]: 1 });
  // The key depends on the secret, the meeting and the poll: it cannot be worked out by a client, or matched across polls.
  assert.notEqual(key, voterKey(anonymous[0], ROOM, "identity-of-ada", "another-secret"));
  assert.notEqual(key, voterKey(anonymous[0], "zzz-zzzz-zzz", "identity-of-ada", SECRET));
  assert.notEqual(key, voterKey({ id: "p2", a: 1 }, ROOM, "identity-of-ada", SECRET));
  const named = (castStoredVote(started([], { ...lunch, anonymous: false }), "p1", 1, { identity: "identity-of-ada", earlier: [] }, ROOM, SECRET) as { polls: StoredPoll[] }).polls;
  assert.deepEqual(named[0].v, { "identity-of-ada": 1 });
});

test("polls: ending one keeps the counts and drops the voters", () => {
  let polls = started();
  polls = (vote(polls, "ada", 1) as { polls: StoredPoll[] }).polls;
  polls = (vote(polls, "ben", 1) as { polls: StoredPoll[] }).polls;
  const closed = closeStoredPoll(polls, "p1")!;
  assert.deepEqual(closed[0].c, [0, 2]);
  assert.equal(closed[0].v, undefined);
  assert.deepEqual(tally(closed[0]), [0, 2]);
  assert.equal(closeStoredPoll(closed, "p1"), closed, "ending it twice changes nothing");
});

test("polls: a poll takes a limited number of votes, and a full record stays well inside LiveKit's 64 kB of metadata", () => {
  const six = { question: "q".repeat(POLL_LIMITS.question), options: Array.from({ length: 6 }, (_, n) => `${n}`.padEnd(POLL_LIMITS.option, "o")), anonymous: false };
  let polls: StoredPoll[] = [];
  for (let n = 0; n < POLL_LIMITS.open; n++) polls = started(polls, six, `poll-id-${n}`.padEnd(12, "x"));
  for (const poll of polls) {
    for (let n = 0; n < MAX_VOTERS; n++) {
      // Identities are UUIDs: 36 characters.
      polls = (castStoredVote(polls, poll.id, n % 6, { identity: `${String(n).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`, earlier: [] }, ROOM, SECRET) as { polls: StoredPoll[] }).polls;
    }
  }
  assert.equal(vote(polls, "one-more", 0, [], polls[0].id).status, 409);
  const record = JSON.stringify({ host: "h".repeat(36), kid: "k".repeat(36), cohosts: Array(25).fill("c".repeat(36)), banned: Array(200).fill("b".repeat(36)), polls });
  assert.ok(record.length < 60_000, `${record.length} bytes`);
});

test("polls: what the record holds is read back strictly", () => {
  const good = { id: "p1", q: "Lunch?", o: ["A", "B"], a: 1, by: "Maya", at: 5, v: { k1: 0, k2: 1, k3: 7, k4: "1" } };
  const read = readStoredPolls([good, { id: "bad id!", q: "x", o: ["A", "B"] }, { id: "p2", q: "x", o: ["only one"] }, { id: "p3", q: "x", o: ["A", 5] }, "junk", null]);
  assert.equal(read.length, 1);
  assert.deepEqual(read[0].v, { k1: 0, k2: 1 }, "votes for options that do not exist are not votes");
  assert.deepEqual(readStoredPolls([{ id: "p1", q: "x", o: ["A", "B"], c: [3, "x"] }])[0].c, [3, 0]);
  assert.deepEqual(readStoredPolls("nope"), []);
  const meta = parseRoomMeta(JSON.stringify({ host: "ada", polls: [good] }));
  assert.equal(meta.polls?.[0].q, "Lunch?");
  assert.equal(parseRoomMeta(JSON.stringify({ host: "ada" })).polls, undefined);
});

test("ending a poll is a host action a co-host may take, parsed strictly", () => {
  assert.deepEqual(parseHostAction({ action: "closePoll", pollId: "abc123" }), { action: "closePoll", pollId: "abc123" });
  for (const pollId of ["", "has space", "x".repeat(65), 5, null, undefined]) assert.equal(parseHostAction({ action: "closePoll", pollId }), null);
  assert.equal(isHostOnly({ action: "closePoll", pollId: "abc123" }), false);
});

test("RealtimeKit: polls that were ended are statements in the meeting's record", () => {
  const person = (id: string, custom: string) => ({ id, custom_participant_id: custom, preset_name: "meetly-guest", created_at: "2026-01-01T00:00:00Z" });
  const record = readRecord([person("p1", "m-1"), person("x1", "meetly-poll-closed:poll-a"), person("x2", "meetly-poll-closed:poll-b"), person("x3", "meetly-poll-closed:poll-a")], "meetly-host", false);
  assert.deepEqual(record.closedPolls, ["poll-a", "poll-b"]);
  assert.equal(record.people.length, 1);
  assert.deepEqual(readRecord([person("p1", "m-1")], "meetly-host", false).closedPolls, []);
});

/* ---------------------------------------------- the weak-connection notice */

/** Runs the state through `seconds` of a connection that is poor (or not), a second at a time. */
function run(state: typeof HEALTH_START, from: number, seconds: number, poor: boolean) {
  const shown: boolean[] = [];
  for (let s = 0; s <= seconds; s++) {
    state = stepHealth(state, from + s * 1000, poor);
    shown.push(state.shown);
  }
  return { state, shown, at: from + seconds * 1000 };
}

test("weak connection: nothing is said until it has been poor for ten seconds without a break", () => {
  const nine = run(HEALTH_START, 0, POOR_HOLD_MS / 1000 - 1, true);
  assert.ok(nine.shown.every((shown) => !shown));
  assert.equal(stepHealth(nine.state, POOR_HOLD_MS, true).shown, true);
  // A break starts the count again.
  const blip = stepHealth(nine.state, 9500, false);
  const after = run(blip, 10_000, 9, true);
  assert.ok(after.shown.every((shown) => !shown));
  assert.equal(stepHealth(after.state, 20_000, true).shown, true);
});

test("weak connection: it is one notice for as long as it lasts, and goes a few seconds after things improve", () => {
  const up = run(HEALTH_START, 0, 60, true);
  assert.equal(up.shown.filter((shown, index) => shown && !up.shown[index - 1]).length, 1, "shown once, not once every few seconds");
  const better = run(up.state, up.at, CLEAR_HOLD_MS / 1000 - 1, false);
  assert.ok(better.shown.every(Boolean), "a moment of improvement does not take it down");
  // Poor again before it cleared: still the same notice.
  assert.equal(stepHealth(better.state, better.at + 500, true).shown, true);
  const cleared = stepHealth(better.state, up.at + CLEAR_HOLD_MS, false);
  assert.equal(cleared.shown, false);
});

test("weak connection: after it went, a relapse is not announced for two minutes; after a dismissal, for ten", () => {
  const up = run(HEALTH_START, 0, 12, true);
  const cleared = run(up.state, up.at, 6, false);
  assert.equal(cleared.state.shown, false);
  const relapse = run(cleared.state, cleared.at, 100, true);
  assert.ok(relapse.shown.every((shown) => !shown));
  const later = run(relapse.state, relapse.at, 30, true);
  assert.equal(later.state.shown, true, "still poor once the quiet time is over: it is said again, once");
  assert.ok(later.at - cleared.at >= REPEAT_QUIET_MS);

  const dismissed = dismissHealth(up.at);
  assert.equal(dismissed.shown, false);
  const nagging = run(dismissed, up.at, DISMISS_QUIET_MS / 1000 - 1, true);
  assert.ok(nagging.shown.every((shown) => !shown));
  assert.equal(stepHealth(nagging.state, up.at + DISMISS_QUIET_MS, true).shown, true);
});

/* ------------------------------------------------------------ mini window */

test("the mini window shows what the stage would, except your own shared screen", () => {
  const person = (identity: string, isLocal = false) => ({ identity, isLocal }) as RtcParticipant;
  const tile = (participant: RtcParticipant, source: RtcTile["source"] = "camera"): RtcTile => ({ participant, source });
  const me = person("me", true);
  const ben = tile(person("ben"));
  const benScreen = tile(person("ben"), "screen_share");
  const mine = tile(me);
  const myScreen = tile(me, "screen_share");
  assert.equal(miniTile(ben, [mine]), ben);
  assert.equal(miniTile(benScreen, [ben, mine]), benScreen, "somebody else's screen is shown");
  assert.equal(miniTile(myScreen, [undefined, ben, mine]), ben, "your own screen is not: the speaker is");
  assert.equal(miniTile(myScreen, [undefined, undefined, mine]), mine, "alone, it is your camera");
  assert.equal(miniTile(undefined, []), undefined);
});

/* ------------------------------------------------------------------ usage */

test("usage events are coarse buckets, and sending one does nothing at all", (t) => {
  assert.deepEqual([1, 2, 3, 5, 6, 12, 13, 49, 50, 300].map(sizeBucket), ["1", "2", "3-5", "3-5", "6-12", "6-12", "13-49", "13-49", "50+", "50+"]);
  assert.deepEqual([0, 1, 9, 10, 29, 30, 59, 60, 500].map(lengthBucket), ["under-1m", "1-10m", "1-10m", "10-30m", "10-30m", "30-60m", "30-60m", "over-60m", "over-60m"]);
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) => t.mock.method(console, level, () => {}));
  sendUsageEvent({ kind: "call-rating", rating: "good", size: "3-5", length: "10-30m", device: "desktop" });
  sendUsageEvent({ kind: "feature", feature: "mini-window", size: "2", device: "phone" });
  assert.equal(fetched.mock.callCount(), 0);
  assert.ok(logged.every((method) => method.mock.callCount() === 0));
});

/* ------------------------------------------------- the RealtimeKit adapter */

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
const choices: JoinChoices = { username: "Ada", audioEnabled: true, videoEnabled: false, audioDeviceId: "default", videoDeviceId: "default", noiseSuppression: false };
const effects: Effects = {
  blurUnavailable: () => "not in this test",
  createBlur: async () => {
    throw new Error("not in this test");
  },
  watchFrameRate: () => ({ stop() {} }),
  noiseSupported: () => false,
  createNoiseNode: async () => {
    throw new Error("not in this test");
  },
};

beforeEach(() => void installDom());
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

type Polls = { canCreate?: boolean; canVote?: boolean; canView?: boolean };
async function connected(setup: { grant?: Partial<typeof grant>; polls?: Polls; before?: (meeting: FakeMeeting) => void; api?: (body: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}) {
  const self = new FakeSelf("self", "Ada");
  self.audioEnabled = true;
  self.permissions.polls = { canCreate: false, canVote: true, canView: true, ...setup.polls };
  const meeting = new FakeMeeting(self);
  setup.before?.(meeting);
  const requests: Record<string, unknown>[] = [];
  const api = async (body: Record<string, unknown>) => {
    requests.push(body);
    return setup.api ? setup.api(body) : {};
  };
  const call = new RealtimeKitCall({ ...grant, ...setup.grant }, choices, (async () => meeting) as unknown as MeetingFactory, api, effects);
  const events: string[] = [];
  call.on("polls", () => events.push("polls"));
  call.on("quality", () => events.push("quality"));
  call.connect();
  await settle();
  return { call, meeting, self, requests, events };
}

test("rtk polls: what the preset allows is what is offered", async () => {
  const guest = await connected();
  assert.deepEqual({ polls: guest.call.supports.polls, create: guest.call.supports.createPolls }, { polls: true, create: false });
  const host = await connected({ polls: { canCreate: true } });
  assert.equal(host.call.supports.createPolls, true);
  // A preset that may not view polls: there are none, whatever the SDK holds.
  const blind = await connected({ polls: { canView: false, canVote: false }, before: (m) => void (m.polls.items = [m.polls.make("Hidden?", ["A", "B"])]) });
  assert.equal(blind.call.supports.polls, false);
  assert.deepEqual(blind.call.polls(), []);
});

test("rtk polls: polls that were there before you joined are there when you join", async () => {
  const { call } = await connected({
    before: (m) => {
      const poll = castFakeVote(castFakeVote(m.polls.make("Lunch?", ["Pizza", "Sushi"], false, "Maya"), 1, { id: "user-p1", name: "Grace" }), 1, { id: "user-p2", name: "" });
      m.polls.items = [poll];
    },
  });
  assert.deepEqual(call.polls(), [
    {
      id: "poll-1",
      question: "Lunch?",
      createdBy: "Maya",
      anonymous: false,
      open: true,
      options: [
        { text: "Pizza", votes: 0, voters: [] },
        { text: "Sushi", votes: 2, voters: ["Grace", "Guest"] },
      ],
      total: 2,
      voted: false,
    },
  ]);
});

test("rtk polls: starting one checks our limits and the preset, then asks RealtimeKit", async () => {
  const guest = await connected();
  await assert.rejects(guest.call.createPoll(lunch), /Only the host and co-hosts can start a poll/);
  assert.equal(guest.meeting.polls.createCalls.length, 0, "the SDK would have dropped it without a word; it is not even asked");

  const { call, meeting, events } = await connected({ polls: { canCreate: true } });
  await assert.rejects(call.createPoll({ question: "Q", options: ["only one"], anonymous: false }), /at least 2 options/);
  assert.equal(meeting.polls.createCalls.length, 0);
  await call.createPoll({ question: " Lunch? ", options: ["Pizza", "Sushi", " "], anonymous: true });
  assert.deepEqual(meeting.polls.createCalls, [["Lunch?", ["Pizza", "Sushi"], true, false]]);
  assert.equal(call.polls().length, 1);
  assert.ok(call.polls()[0].anonymous && call.polls()[0].open);
  assert.ok(events.includes("polls"));
  for (let n = 0; n < POLL_LIMITS.open - 1; n++) await call.createPoll({ ...lunch, question: `Q${n}` });
  await assert.rejects(call.createPoll(lunch), /already 5 polls open/);
});

test("rtk polls: a vote counts when RealtimeKit says so, and only once from this client", async () => {
  const { call, meeting } = await connected({ before: (m) => void (m.polls.items = [m.polls.make("Lunch?", ["Pizza", "Sushi"], true)]) });
  await call.votePoll("poll-1", 1);
  assert.deepEqual(meeting.polls.voteCalls, [["poll-1", 1]]);
  const [poll] = call.polls();
  assert.deepEqual({ voted: poll.voted, myVote: poll.myVote, total: poll.total, counts: poll.options.map((o) => o.votes) }, { voted: true, myVote: 1, total: 1, counts: [0, 1] });
  assert.deepEqual(poll.options.flatMap((o) => o.voters), [], "an anonymous poll names nobody");
  await assert.rejects(call.votePoll("poll-1", 0), /already voted/);
  await assert.rejects(call.votePoll("nope", 0), /no longer there/);
  assert.equal(meeting.polls.voteCalls.length, 1, "nothing more was sent");
  // Somebody else's vote arrives as an update.
  meeting.polls.receive(castFakeVote(meeting.polls.items[0], 0, { id: "user-p1", name: "Grace" }));
  assert.deepEqual(call.polls()[0].options.map((o) => o.votes), [1, 1]);
  assert.equal(call.polls()[0].myVote, 1);
});

test("rtk polls: in a named poll your vote is read from the poll itself, and bad votes are not sent", async () => {
  const { call, meeting, self } = await connected({ before: (m) => void (m.polls.items = [m.polls.make("Who?", ["Ada", "Ben"])]) });
  await assert.rejects(call.votePoll("poll-1", 2), /isn't one of the options/);
  await assert.rejects(call.votePoll("poll-1", 0.5), /isn't one of the options/);
  self.permissions.polls!.canVote = false;
  await assert.rejects(call.votePoll("poll-1", 0), /can't vote/);
  assert.equal(meeting.polls.voteCalls.length, 0);
  self.permissions.polls!.canVote = true;
  await call.votePoll("poll-1", 0);
  assert.deepEqual(call.polls()[0].options[0].voters, ["Ada"]);
  assert.equal(call.polls()[0].myVote, 0);
});

test("rtk polls: a vote RealtimeKit never confirms is reported as not counted", async () => {
  const { call, meeting } = await connected({ before: (m) => void (m.polls.items = [m.polls.make("Lunch?", ["Pizza", "Sushi"], true)]) });
  meeting.polls.deaf = true;
  await assert.rejects(call.votePoll("poll-1", 1), /wasn't counted/);
  assert.deepEqual({ voted: call.polls()[0].voted, myVote: call.polls()[0].myVote }, { voted: false, myVote: undefined });
});

test("rtk polls: ending one goes to our server, everyone is told to ask it again, and ended polls take no votes here", async () => {
  let closedPolls: string[] = [];
  const { call, meeting, requests } = await connected({
    grant: { role: "host", closedPolls: ["poll-0"] },
    polls: { canCreate: true },
    before: (m) => void (m.polls.items = [m.polls.make("Lunch?", ["Pizza", "Sushi"])]),
    api: async (body) => {
      if (body.action === "closePoll") closedPolls = [...closedPolls, body.pollId as string];
      return { coHosts: [], access: "open", pin: null, closedPolls };
    },
  });
  assert.equal(call.polls()[0].open, true);
  await call.moderate({ action: "closePoll", pollId: "poll-1" });
  assert.deepEqual(requests[0], { session: "not-a-real-session", action: "closePoll", pollId: "poll-1" });
  assert.equal(requests[1].action, "roles");
  assert.equal(meeting.participants.broadcasts.at(-1)?.type, ROLES_MESSAGE);
  assert.equal(call.polls()[0].open, false);
  await assert.rejects(call.votePoll("poll-1", 0), /has ended/);
  assert.equal(meeting.polls.voteCalls.length, 0);
});

test("rtk polls: which polls have ended comes from the join grant and from our server, never from a broadcast", async () => {
  let closedPolls: string[] = [];
  const { call, meeting } = await connected({
    grant: { closedPolls: ["poll-1"] },
    before: (m) => void (m.polls.items = [m.polls.make("One?", ["A", "B"]), m.polls.make("Two?", ["A", "B"])]),
    api: async () => ({ coHosts: [], access: "open", pin: null, closedPolls }),
  });
  assert.deepEqual(call.polls().map((poll) => poll.open), [false, true], "ended before you joined");
  closedPolls = ["poll-1", "poll-2"];
  meeting.participants.emit("broadcastedMessage", { type: ROLES_MESSAGE, payload: { peerId: "p1", closedPolls: [] } });
  await settle();
  assert.deepEqual(call.polls().map((poll) => poll.open), [false, false]);
});

test("rtk polls: a refused request to end a poll changes nothing", async () => {
  const { call, meeting } = await connected({
    before: (m) => void (m.polls.items = [m.polls.make("Lunch?", ["Pizza", "Sushi"])]),
    api: async (body) => {
      if (body.action === "closePoll") throw new Error("Only the meeting host can do that.");
      return {};
    },
  });
  await assert.rejects(call.moderate({ action: "closePoll", pollId: "poll-1" }), /Only the meeting host/);
  assert.equal(call.polls()[0].open, true);
  assert.equal(meeting.participants.broadcasts.filter((b) => b.type === ROLES_MESSAGE).length, 0);
});

test("rtk quality: your connection is the worse of your microphone's and camera's scores", async () => {
  const { call, self, events } = await connected();
  assert.deepEqual(call.quality(), { connection: "unknown", dataSaver: false });
  const score = (kind: string, value: number, extra: Record<string, unknown> = {}) =>
    self.emit("mediaScoreUpdate", { kind, isScreenshare: false, score: value, participantId: "self", scoreStats: { score: value, ...extra } });
  score("audio", 10, { bitrate: 22_000, packetsLostPercentage: 0 });
  assert.equal(call.quality().connection, "good");
  score("video", 6, { bitrate: 576_000, packetsLostPercentage: 1.26, frameWidth: 640, frameHeight: 480, framesPerSecond: 24 });
  assert.equal(call.quality().connection, "fair");
  score("video", 3);
  assert.equal(call.quality().connection, "poor");
  assert.equal(call.local.weakConnection, true);
  const changes = events.filter((event) => event === "quality").length;
  score("video", 3);
  score("video", 2);
  assert.equal(events.filter((event) => event === "quality").length, changes, "no event when nothing changed");
  // A shared screen's score is not your connection's.
  self.emit("mediaScoreUpdate", { kind: "video", isScreenshare: true, score: 10, scoreStats: {} });
  assert.equal(call.quality().connection, "poor");
  // A camera that is switched off has no say any more.
  self.setVideo(true);
  self.setVideo(false);
  assert.equal(call.quality().connection, "good");
});

test("rtk quality: the numbers are RealtimeKit's own, and null where it gives none", async () => {
  const grace = new FakeParticipant("p1", "Grace");
  const { call, self } = await connected({ before: (m) => m.participants.joined.set("p1", grace) });
  assert.deepEqual(await call.stats(), { sentKbps: null, receivedKbps: null, roundTripMs: null, lossPercent: null, sentVideo: null });
  self.emit("mediaScoreUpdate", { kind: "audio", isScreenshare: false, score: 10, scoreStats: { bitrate: 22_452, packetsLostPercentage: 0 } });
  self.emit("mediaScoreUpdate", { kind: "video", isScreenshare: false, score: 9, scoreStats: { bitrate: 576_195, packetsLostPercentage: 1.26, frameWidth: 640, frameHeight: 480, framesPerSecond: 24 } });
  grace.emit("mediaScoreUpdate", { kind: "video", isScreenshare: false, score: 9, scoreStats: { bitrate: 300_000 } });
  grace.emit("mediaScoreUpdate", { kind: "audio", isScreenshare: false, score: 9, scoreStats: { bitrate: 20_000 } });
  assert.deepEqual(await call.stats(), { sentKbps: 599, receivedKbps: 320, roundTripMs: null, lossPercent: 1.3, sentVideo: { width: 640, height: 480, fps: 24 } });
});

test("rtk less data: the camera is asked for a smaller, slower picture, and for what it had when switched off again", async () => {
  const { call, self, events } = await connected();
  self.setVideo(true);
  await call.setDataSaver(true);
  assert.deepEqual(call.quality(), { connection: "unknown", dataSaver: true });
  assert.ok(events.includes("quality"));
  assert.deepEqual(self.videoConstraintCalls, [{ width: { ideal: SAVER_WIDTH }, height: { ideal: SAVER_HEIGHT }, frameRate: { ideal: SAVER_FPS } }]);
  await call.setDataSaver(true);
  assert.equal(self.videoConstraintCalls.length, 1, "asked once per camera, not every time");
  await call.setDataSaver(false);
  assert.deepEqual(self.videoConstraintCalls[1], { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
  assert.equal(call.quality().dataSaver, false);
});

test("rtk less data: a camera that is off is left alone, and one that comes on later starts small", async () => {
  const { call, self } = await connected();
  await call.setDataSaver(true);
  assert.equal(self.videoConstraintCalls.length, 0);
  self.setVideo(true);
  await settle();
  assert.equal(self.videoConstraintCalls.length, 1);
  // Restarted (a new track): asked again.
  self.setVideo(false);
  self.setVideo(true);
  await settle();
  assert.equal(self.videoConstraintCalls.length, 2);
});

test("rtk less data: no pictures are kept flowing beyond the ones on screen", async () => {
  const { call, meeting } = await connected();
  call.setVideoDemand(["a", "b", "c", "d"]);
  assert.equal(meeting.participants.maxActiveParticipantsCount, 4 + 1 + DEMAND_HEADROOM);
  await call.setDataSaver(true);
  // The interface now shows one picture (see `withheld` in the stage), and says so.
  call.setVideoDemand(["a"]);
  assert.equal(meeting.participants.maxActiveParticipantsCount, 2);
  await call.setDataSaver(false);
  call.setVideoDemand(["a", "b", "c", "d"]);
  assert.equal(meeting.participants.maxActiveParticipantsCount, 4 + 1 + DEMAND_HEADROOM);
});
