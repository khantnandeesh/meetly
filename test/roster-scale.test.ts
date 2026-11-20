import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { HAND_MESSAGE, RealtimeKitCall, type MeetingFactory } from "../src/lib/rtc/realtimekit";
import type { JoinChoices, JoinGrant } from "../src/lib/rtc/types";
import { FakeMeeting, FakeParticipant, FakeSelf, installDom } from "./fake-realtimekit";

/**
 * The RealtimeKit roster at the size of a large meeting, against the stand-in meeting object.
 * RealtimeKit allows `getAllJoinedPeers()` 10 times a minute, so the roster must come from the
 * SDK's join and leave events and never from asking the server who is here. These check what
 * the adapter does with those events; they cannot check that a real session sends them as assumed.
 */

const grant: Extract<JoinGrant, { provider: "realtimekit" }> = {
  provider: "realtimekit",
  authToken: "not-a-real-token",
  session: "not-a-real-session",
  participantId: "rest-participant-id",
  meetingId: "meeting-id",
  role: "host",
  hostPreset: "meetly-host",
  coHosts: [],
  access: "open",
  canAsk: true,
};
const choices: JoinChoices = { username: "Ada", audioEnabled: false, videoEnabled: false, audioDeviceId: "default", videoDeviceId: "default" };

beforeEach(() => {
  installDom();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function connected() {
  const self = new FakeSelf("self", "Ada", { presetName: "meetly-host" });
  self.permissions = { acceptWaitingRequests: true, canDisableParticipantVideo: false };
  const meeting = new FakeMeeting(self);
  const call = new RealtimeKitCall(grant, choices, (async () => meeting) as unknown as MeetingFactory, async () => ({}));
  call.connect();
  await tick();
  await tick();
  return { call, meeting };
}

const MINUTE = 60_000;

test("roster: a meeting of 1,200 with people coming, going, raising hands and knocking for 10 minutes never asks who is here more than once a minute", async () => {
  const { call, meeting } = await connected();
  // Every timer the adapter could poll with runs on a clock this test moves by hand.
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: Date.now() });
  try {
    let next = 0;
    let oldest = 0;
    const arrive = () => meeting.arrive(new FakeParticipant(`p${next}`, `Person ${next++}`));
    for (let i = 0; i < 1200; i++) arrive();
    assert.equal(call.remoteIds().length, 1200);
    for (let minute = 1; minute <= 10; minute++) {
      for (let second = 0; second < 60; second++) {
        arrive();
        meeting.depart(`p${oldest++}`);
        meeting.participants.emit("broadcastedMessage", { type: HAND_MESSAGE, payload: { peerId: `p${next - 1}`, raised: true } });
        if (second % 10 === 0) meeting.participants.waitlisted.add(new FakeParticipant(`w${minute}-${second}`, "Walt"));
        mock.timers.tick(1000);
      }
      assert.ok(
        meeting.participants.joinedPeerCalls <= minute,
        `${meeting.participants.joinedPeerCalls} calls to getAllJoinedPeers in ${minute} minute(s)`,
      );
    }
    mock.timers.tick(10 * MINUTE);
    // Event-driven: the count is not merely under the limit, it is zero.
    assert.equal(meeting.participants.joinedPeerCalls, 0);
    assert.equal(call.remoteIds().length, 1200);
    assert.equal(call.participants().filter((p) => p.handRaised).length, 600);
  } finally {
    mock.timers.reset();
  }
});

test("roster: each arrival in a meeting of 2,000 changes the roster once and the tiles once, and the list is rebuilt only when read", async () => {
  const { call, meeting } = await connected();
  for (let i = 0; i < 2000; i++) meeting.arrive(new FakeParticipant(`p${i}`, `Person ${i}`));
  let roster = 0;
  let tiles = 0;
  call.on("roster", () => roster++);
  call.on("tiles", () => tiles++);
  const before = call.participants();
  assert.equal(call.participants(), before, "an unchanged roster is the same list, not a copy");
  meeting.arrive(new FakeParticipant("late", "Late"));
  assert.equal(roster, 1);
  assert.equal(tiles, 1);
  assert.notEqual(call.participants(), before);
  assert.equal(call.participants().length, 2002);
});

test("roster: the SDK clearing a list of 3,000 changes the roster and the tiles once, and everyone still leaves", async () => {
  const { call, meeting } = await connected();
  for (let i = 0; i < 3000; i++) meeting.arrive(new FakeParticipant(`p${i}`, `Person ${i}`));
  let roster = 0;
  let tiles = 0;
  let left = 0;
  // A reader that rebuilds the whole list on every roster change, as a React store does.
  call.on("roster", () => {
    roster++;
    call.participants();
  });
  call.on("tiles", () => {
    tiles++;
    call.tiles();
  });
  call.on("participantLeft", () => left++);
  const started = performance.now();
  meeting.participants.joined.emit("participantsCleared");
  const took = performance.now() - started;
  assert.equal(roster, 1);
  assert.equal(tiles, 1);
  assert.equal(left, 3000);
  assert.deepEqual(call.remoteIds(), []);
  assert.equal(call.participants().length, 1);
  assert.equal(call.tiles().length, 1);
  // Generous: the point is that it is not quadratic (which took seconds at this size).
  assert.ok(took < 1000, `clearing 3,000 people took ${Math.round(took)} ms`);
});
