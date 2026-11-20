import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { RoomEvent } from "livekit-client";
import { createCall as createLiveKitCall } from "../src/lib/rtc/livekit";
import { RealtimeKitCall, type MeetingFactory } from "../src/lib/rtc/realtimekit";
import { answerEach, withSince, type HostApi } from "../src/lib/rtc/shared";
import type { HostAction, JoinChoices, JoinGrant, RtcCall } from "../src/lib/rtc/types";
import { FakeMeeting, FakeParticipant, FakeSelf, installDom } from "./fake-realtimekit";

/**
 * The parts of the call's interface that are there before what uses them: webinar roles and the
 * stage, the reactions switch, Admit all and Deny all, and when somebody started waiting. Until
 * they are built, both adapters behave as they did before these existed, and these tests say so.
 */

const choices: JoinChoices = { username: "Ada", audioEnabled: false, videoEnabled: false, audioDeviceId: "default", videoDeviceId: "default" };

const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  installDom();
});

/* ------------------------------------------------------------------ shared */

test("waiting since: the provider's time where it gives one, never later than this browser first saw them", () => {
  const seen = new Map<string, number>();
  assert.deepEqual(withSince([{ id: "a", name: "Ann" }], seen, 1000), [{ id: "a", name: "Ann", since: 1000 }]);
  // Seen again a minute on: still the first sighting.
  assert.deepEqual(withSince([{ id: "a", name: "Ann" }, { id: "b", name: "Bo", since: 500 }], seen, 61_000), [
    { id: "a", name: "Ann", since: 1000 },
    { id: "b", name: "Bo", since: 500 },
  ]);
  // A provider clock ahead of ours is capped at the first sighting.
  assert.equal(withSince([{ id: "c", name: "Cy", since: 99_000 }], seen, 62_000)[0].since, 62_000);
  // Someone who stopped asking is forgotten, and starts again if they ask again.
  assert.deepEqual([...seen.keys()], ["c"]);
  assert.equal(withSince([{ id: "a", name: "Ann" }], seen, 70_000)[0].since, 70_000);
});

test("answering everyone carries on past a failure, then says once how many could not be answered", async () => {
  const asked: string[] = [];
  const one = async (identity: string) => {
    asked.push(identity);
    if (identity !== "b") throw new Error("gone");
  };
  await assert.rejects(answerEach(["a", "b", "c"], "admit", one), { message: "Couldn't admit 2 people. Try again." });
  assert.deepEqual(asked, ["a", "b", "c"]);
  await assert.rejects(answerEach(["a"], "deny", one), { message: "Couldn't deny 1 person. Try again." });
  await answerEach([], "admit", one);
});

/* ------------------------------------------------------------- RealtimeKit */

const rtkGrant: Extract<JoinGrant, { provider: "realtimekit" }> = {
  provider: "realtimekit",
  authToken: "not-a-real-token",
  session: "signed-session",
  participantId: "rest-participant-id",
  meetingId: "meeting-id",
  role: "guest",
  hostPreset: "meetly-host",
  coHosts: [],
  access: "open",
  canAsk: true,
};

async function rtk(setup: { host?: boolean; refuse?: (body: Record<string, unknown>) => boolean } = {}) {
  const self = new FakeSelf("self", "Ada", { presetName: setup.host ? "meetly-host" : "meetly-guest" });
  self.permissions = { acceptWaitingRequests: !!setup.host, canDisableParticipantVideo: false };
  const meeting = new FakeMeeting(self);
  const requests: Record<string, unknown>[] = [];
  const api: HostApi = async (body) => {
    requests.push(body);
    if (setup.refuse?.(body)) throw new Error("That person may have already left.");
    return {};
  };
  const call = new RealtimeKitCall(
    { ...rtkGrant, role: setup.host ? "host" : "guest" },
    choices,
    (async () => meeting) as unknown as MeetingFactory,
    api,
  );
  let stage = 0;
  call.on("stage", () => stage++);
  call.connect();
  await tick();
  await tick();
  return { call, meeting, requests, stageEvents: () => stage };
}

test("rtk: a meeting, reactions allowed, nobody invited on stage", async () => {
  const { call } = await rtk();
  assert.equal(call.mode, "meeting");
  assert.equal(call.reactionsAllowed, true);
  assert.equal(call.local.stageInvite, false);
});

test("rtk: the host's role is host and everyone else's is speaker, and everyone has a tile", async () => {
  const host = await rtk({ host: true });
  host.meeting.arrive(new FakeParticipant("p1", "Grace"));
  assert.equal(host.call.local.role, "host");
  assert.equal(host.call.participant("m-p1")?.role, "speaker");
  assert.equal(host.call.tiles().length, 2);

  const guest = await rtk();
  guest.meeting.arrive(new FakeParticipant("h", "Hal", { presetName: "meetly-host" }));
  assert.equal(guest.call.local.role, "speaker");
  assert.equal(guest.call.participant("m-h")?.role, "host");
});

test("rtk: a viewer never has a tile", async () => {
  const { call, meeting } = await rtk();
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  const person = call.participant("m-p1")!;
  Object.defineProperty(person, "role", { get: () => "viewer" });
  grace.setScreenShare(true);
  assert.deepEqual(
    call.tiles().map((tile) => tile.participant.identity),
    ["m-self"],
  );
});

test("rtk: someone waiting carries when this browser first saw them asking", async () => {
  const { call, meeting } = await rtk({ host: true });
  const before = Date.now();
  meeting.participants.waitlisted.add(new FakeParticipant("w1", "Walt"));
  const first = call.waiting()[0];
  assert.ok(first.since >= before && first.since <= Date.now());
  meeting.participants.waitlisted.add(new FakeParticipant("w2", "Wren"));
  assert.equal(call.waiting()[0].since, first.since, "a later arrival does not move an earlier one");
});

test("rtk: Admit all and Deny all go through the one-person request for each, and never ask who is in the meeting", async () => {
  const { call, meeting, requests } = await rtk({ host: true });
  for (const id of ["w1", "w2", "w3", "w4"]) meeting.participants.waitlisted.add(new FakeParticipant(id, id));
  await call.moderate({ action: "admitAll", identities: ["w1", "w2"] });
  await call.moderate({ action: "denyAll", identities: ["w3", "w4"] });
  assert.deepEqual(
    requests.map((body) => [body.action, body.identity]),
    [["admit", "w1"], ["admit", "w2"], ["deny", "w3"], ["deny", "w4"]],
  );
  assert.deepEqual(meeting.participants.accepted, ["w1", "w2"]);
  assert.deepEqual(meeting.participants.rejected, ["w3", "w4"]);
  assert.deepEqual(call.waiting(), []);
  assert.equal(meeting.participants.joinedPeerCalls, 0);
});

test("rtk: Admit all lets in everyone it can, and says how many it could not", async () => {
  const { call, meeting } = await rtk({ host: true, refuse: (body) => body.identity === "w2" });
  for (const id of ["w1", "w2", "w3"]) meeting.participants.waitlisted.add(new FakeParticipant(id, id));
  await assert.rejects(call.moderate({ action: "admitAll", identities: ["w1", "w2", "w3"] }), {
    message: "Couldn't admit 1 person. Try again.",
  });
  assert.deepEqual(meeting.participants.accepted, ["w1", "w3"]);
});

test("rtk: the reactions switch and the stage are refused as not available yet, without asking anyone", async () => {
  const { call, meeting, requests, stageEvents } = await rtk({ host: true });
  meeting.arrive(new FakeParticipant("p1", "Grace"));
  await assert.rejects(call.moderate({ action: "reactions", allowed: false }), /isn't available yet/);
  await assert.rejects(call.moderate({ action: "stage", identity: "m-p1", on: true }), /isn't available yet/);
  assert.equal(requests.length, 0);
  assert.deepEqual([meeting.stage.granted, meeting.stage.denied], [[], []]);
  assert.equal(call.reactionsAllowed, true);
  assert.equal(stageEvents(), 0);
});

/* ----------------------------------------------------------------- LiveKit */

function livekit() {
  const call = createLiveKitCall({ provider: "livekit", token: "signed-token", serverUrl: "ws://127.0.0.1:1" }, choices);
  const posted: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    posted.push(body);
    const ok = body.identity !== "refused";
    return new Response(JSON.stringify(ok ? { ok } : { error: "That person may have already left." }), { status: ok ? 200 : 404 });
  }) as typeof fetch;
  return { call, posted, restore: () => (globalThis.fetch = realFetch) };
}

test("livekit: a meeting, reactions allowed, nobody invited on stage, and your own tile", () => {
  const { call, restore } = livekit();
  try {
    assert.equal(call.mode, "meeting");
    assert.equal(call.reactionsAllowed, true);
    assert.equal(call.local.stageInvite, false);
    assert.equal(call.local.role, "speaker", "nobody is host while that is unknown");
    assert.deepEqual(call.tiles().map((tile) => tile.participant), [call.local]);
  } finally {
    restore();
  }
});

test("livekit: whoever the room's record names as host has the host role", () => {
  const { call, restore } = livekit();
  try {
    const room = call.native as unknown as { localParticipant: { identity: string }; emit(event: string): void };
    room.localParticipant.identity = "m-ada";
    Object.defineProperty(room, "metadata", { get: () => JSON.stringify({ host: "m-ada" }) });
    room.emit(RoomEvent.RoomMetadataChanged);
    assert.equal(call.hostIdentity, "m-ada");
    assert.equal(call.local.role, "host");
  } finally {
    restore();
  }
});

test("livekit: a viewer never has a tile", () => {
  const { call, restore } = livekit();
  try {
    Object.defineProperty(call.local, "role", { get: () => "viewer" });
    assert.deepEqual(call.tiles(), []);
  } finally {
    restore();
  }
});

test("livekit: Admit all and Deny all are one request per person; a failure is counted, not fatal", async () => {
  const { call, posted, restore } = livekit();
  try {
    await call.moderate({ action: "admitAll", identities: ["a", "b"] });
    await assert.rejects(call.moderate({ action: "denyAll", identities: ["refused", "c"] }), {
      message: "Couldn't deny 1 person. Try again.",
    });
    assert.deepEqual(
      posted.map((body) => [body.token, body.action, body.identity]),
      [
        ["signed-token", "admit", "a"],
        ["signed-token", "admit", "b"],
        ["signed-token", "deny", "refused"],
        ["signed-token", "deny", "c"],
      ],
    );
  } finally {
    restore();
  }
});

test("livekit: the reactions switch and the stage are refused as not available yet, without asking our server", async () => {
  const { call, posted, restore } = livekit();
  try {
    const refused: HostAction[] = [
      { action: "reactions", allowed: false },
      { action: "stage", identity: "m-grace", on: true },
    ];
    for (const action of refused) await assert.rejects((call as RtcCall).moderate(action), /isn't available yet/);
    assert.equal(posted.length, 0);
  } finally {
    restore();
  }
});
