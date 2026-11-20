import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { RoomEvent } from "livekit-client";
import { createCall as createLiveKitCall } from "../src/lib/rtc/livekit";
import { RealtimeKitCall, type MeetingFactory } from "../src/lib/rtc/realtimekit";
import { REACTION_MESSAGE, bulkError, bulkFailures, withSince, type HostApi } from "../src/lib/rtc/shared";
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

test("Admit all or Deny all that fails for some says once how many, and carries who", () => {
  const two = bulkError("admit", ["a", "c"]);
  assert.equal(two.message, "Couldn't admit 2 people. Try again.");
  assert.deepEqual(bulkFailures(two), ["a", "c"]);
  assert.equal(bulkError("deny", ["b"]).message, "Couldn't deny 1 person. Try again.");
  assert.deepEqual(bulkFailures(new Error("Check your connection and try again.")), []);
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

async function rtk(
  setup: {
    host?: boolean;
    refuse?: (body: Record<string, unknown>) => boolean;
    /** What our server says for `roles`. */
    roles?: () => Record<string, unknown>;
    grant?: Partial<typeof rtkGrant>;
  } = {},
) {
  const self = new FakeSelf("self", "Ada", { presetName: setup.host ? "meetly-host" : "meetly-guest" });
  self.permissions = { acceptWaitingRequests: !!setup.host, canDisableParticipantVideo: false };
  const meeting = new FakeMeeting(self);
  const requests: Record<string, unknown>[] = [];
  const api: HostApi = async (body) => {
    requests.push(body);
    if (setup.refuse?.(body)) throw new Error("That person may have already left.");
    return body.action === "roles" && setup.roles ? setup.roles() : {};
  };
  const call = new RealtimeKitCall(
    { ...rtkGrant, role: setup.host ? "host" : "guest", ...setup.grant },
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

test("rtk: Admit all and Deny all are one request to our server each, however many, and never ask who is in the meeting", async () => {
  const { call, meeting, requests } = await rtk({ host: true });
  const ids = Array.from({ length: 128 }, (_, i) => `w${i}`);
  for (const id of ids) meeting.participants.waitlisted.add(new FakeParticipant(id, id));
  await call.moderate({ action: "admitAll", identities: ids.slice(0, 100) });
  await call.moderate({ action: "denyAll", identities: ids.slice(100) });
  assert.deepEqual(
    requests.map((body) => [body.session, body.action, (body.identities as string[]).length]),
    [
      ["signed-session", "admitAll", 100],
      ["signed-session", "denyAll", 28],
    ],
  );
  // RealtimeKit's own bulk call lets everyone in with one message.
  assert.deepEqual(meeting.participants.acceptAllCalls, [ids.slice(0, 100)]);
  assert.deepEqual(meeting.participants.rejected, ids.slice(100));
  assert.deepEqual(call.waiting(), []);
  assert.equal(meeting.participants.joinedPeerCalls, 0);
});

test("rtk: somebody who stopped asking is skipped, not counted as a failure", async () => {
  const { call, meeting } = await rtk({ host: true });
  meeting.participants.waitlisted.add(new FakeParticipant("w1", "Walt"));
  await call.moderate({ action: "admitAll", identities: ["w1", "gone"] });
  assert.deepEqual(meeting.participants.acceptAllCalls, [["w1"]]);
});

test("rtk: Deny all answers everyone it can, then rejects once with who is still waiting", async () => {
  const { call, meeting } = await rtk({ host: true });
  for (const id of ["w1", "w2", "w3"]) meeting.participants.waitlisted.add(new FakeParticipant(id, id));
  meeting.participants.failReject.add("w2");
  const error = await call.moderate({ action: "denyAll", identities: ["w1", "w2", "w3"] }).catch((e) => e);
  assert.equal(error.message, "Couldn't deny 1 person. Try again.");
  assert.deepEqual(bulkFailures(error), ["w2"]);
  assert.deepEqual(meeting.participants.rejected, ["w1", "w3"]);
});

test("rtk: Admit all that RealtimeKit refuses leaves everyone it was given to try again", async () => {
  const { call, meeting } = await rtk({ host: true });
  for (const id of ["w1", "w2", "w3"]) meeting.participants.waitlisted.add(new FakeParticipant(id, id));
  meeting.participants.failAccept = true;
  const error = await call.moderate({ action: "admitAll", identities: ["w1", "w2", "w3"] }).catch((e) => e);
  assert.equal(error.message, "Couldn't admit 3 people. Try again.");
  assert.deepEqual(bulkFailures(error), ["w1", "w2", "w3"]);
});

test("rtk: Admit all refused by our server answers nobody", async () => {
  const { call, meeting } = await rtk({ host: true, refuse: (body) => body.action === "admitAll" });
  meeting.participants.waitlisted.add(new FakeParticipant("w1", "Walt"));
  await assert.rejects(call.moderate({ action: "admitAll", identities: ["w1"] }));
  assert.deepEqual(meeting.participants.acceptAllCalls, []);
});

test("rtk: the stage is refused as not available yet, without asking anyone", async () => {
  const { call, meeting, requests, stageEvents } = await rtk({ host: true });
  meeting.arrive(new FakeParticipant("p1", "Grace"));
  await assert.rejects(call.moderate({ action: "stage", identity: "m-p1", on: true }), /isn't available yet/);
  assert.equal(requests.length, 0);
  assert.deepEqual([meeting.stage.granted, meeting.stage.denied], [[], []]);
  assert.equal(stageEvents(), 0);
});

test("rtk: turning reactions off asks our server, re-reads the record, tells the others, and fires the event", async () => {
  let reactions = true;
  const { call, meeting, requests } = await rtk({ host: true, roles: () => ({ coHosts: [], access: "open", reactions }) });
  let fired = 0;
  call.on("reactionsAllowed", () => fired++);
  reactions = false;
  await call.moderate({ action: "reactions", allowed: false });
  assert.deepEqual(
    requests.map((body) => [body.action, body.allowed]),
    [
      ["reactions", false],
      ["roles", undefined],
    ],
  );
  assert.equal(call.reactionsAllowed, false);
  assert.equal(fired, 1);
  assert.ok(meeting.participants.broadcasts.some((b) => b.type === "meetly-roles"));
});

test("rtk: with reactions off, a guest's own and a forged reaction are dropped; the host's still arrive", async () => {
  const guest = await rtk({ grant: { reactions: false } });
  assert.equal(guest.call.reactionsAllowed, false);
  const seen: string[] = [];
  guest.call.on("reaction", (person, emoji) => seen.push(`${person.identity} ${emoji}`));
  guest.meeting.arrive(new FakeParticipant("p1", "Grace"));
  guest.meeting.arrive(new FakeParticipant("h", "Hal", { presetName: "meetly-host" }));
  await guest.call.sendReaction("👍");
  const deliver = (peerId: string) =>
    guest.meeting.participants.emit("broadcastedMessage", { type: REACTION_MESSAGE, payload: { peerId, emoji: "🎉" }, timestamp: Date.now() });
  deliver("p1");
  deliver("h");
  assert.deepEqual(seen, ["m-h 🎉"]);
  assert.equal(guest.meeting.participants.broadcasts.filter((b) => b.type === REACTION_MESSAGE).length, 0);
});

test("rtk: someone who joins after reactions were turned back on is told so by the record", async () => {
  const { call } = await rtk({ roles: () => ({ coHosts: [], access: "open", reactions: true }), grant: { reactions: false } });
  let fired = 0;
  call.on("reactionsAllowed", () => fired++);
  call.native!.participants.emit("broadcastedMessage", { type: "meetly-roles", payload: { peerId: "h" }, timestamp: Date.now() });
  await tick();
  assert.equal(call.reactionsAllowed, true);
  assert.equal(fired, 1);
});

/* ----------------------------------------------------------------- LiveKit */

function livekit() {
  const call = createLiveKitCall({ provider: "livekit", token: "signed-token", serverUrl: "ws://127.0.0.1:1" }, choices);
  const posted: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    posted.push(body);
    // Our server answers Admit all and Deny all with who it could not answer.
    if (Array.isArray(body.identities)) {
      const failed = body.identities.filter((id: string) => id.startsWith("refused"));
      return new Response(JSON.stringify({ ok: true, ...(failed.length ? { failed } : {}) }), { status: 200 });
    }
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

test("livekit: Admit all and Deny all are one request each, however many; failures come back as one error with who", async () => {
  const { call, posted, restore } = livekit();
  try {
    const ids = Array.from({ length: 128 }, (_, i) => `w${i}`);
    await call.moderate({ action: "admitAll", identities: ids });
    const error = await call.moderate({ action: "denyAll", identities: ["refused-1", "c", "refused-2"] }).catch((e) => e);
    assert.equal(error.message, "Couldn't deny 2 people. Try again.");
    assert.deepEqual(bulkFailures(error), ["refused-1", "refused-2"]);
    assert.deepEqual(
      posted.map((body) => [body.token, body.action, (body.identities as string[]).length]),
      [
        ["signed-token", "admitAll", 128],
        ["signed-token", "denyAll", 3],
      ],
    );
  } finally {
    restore();
  }
});

test("livekit: the stage is refused as not available yet, without asking our server", async () => {
  const { call, posted, restore } = livekit();
  try {
    const refused: HostAction[] = [{ action: "stage", identity: "m-grace", on: true }];
    for (const action of refused) await assert.rejects((call as RtcCall).moderate(action), /isn't available yet/);
    assert.equal(posted.length, 0);
  } finally {
    restore();
  }
});

/** Sets the room's record as our server would, and tells the call it changed. */
function setRecord(call: RtcCall, record: Record<string, unknown>, me = "m-ada") {
  const room = call.native as unknown as { localParticipant: { identity: string }; emit(event: string): void };
  room.localParticipant.identity = me;
  Object.defineProperty(room, "metadata", { configurable: true, get: () => JSON.stringify(record) });
  room.emit(RoomEvent.RoomMetadataChanged);
}

test("livekit: the reactions switch is a request to our server, and the record says whether they are allowed", async () => {
  const { call, posted, restore } = livekit();
  try {
    let fired = 0;
    call.on("reactionsAllowed", () => fired++);
    await call.moderate({ action: "reactions", allowed: false });
    assert.deepEqual(posted, [{ token: "signed-token", action: "reactions", allowed: false }]);
    setRecord(call, { host: "m-host", reactions: false });
    assert.equal(call.reactionsAllowed, false);
    setRecord(call, { host: "m-host", reactions: false, access: "ask" });
    assert.equal(fired, 1, "only a change fires");
    setRecord(call, { host: "m-host" });
    assert.equal(call.reactionsAllowed, true);
    assert.equal(fired, 2);
  } finally {
    restore();
  }
});

test("livekit: with reactions off, a forged reaction from a guest is dropped on arrival; the host's arrives", () => {
  const { call, restore } = livekit();
  try {
    setRecord(call, { host: "m-host", cohosts: ["m-co"], reactions: false });
    const seen: string[] = [];
    call.on("reaction", (person, emoji) => seen.push(`${person.identity} ${emoji}`));
    const room = call.native as unknown as { emit(event: string, ...args: unknown[]): void };
    const packet = new TextEncoder().encode(JSON.stringify({ emoji: "🎉" }));
    for (const identity of ["m-guest", "m-host", "m-co"]) {
      room.emit(RoomEvent.DataReceived, packet, { identity, name: identity, attributes: {} }, undefined, REACTION_MESSAGE);
    }
    assert.deepEqual(seen, ["m-host 🎉", "m-co 🎉"]);
  } finally {
    restore();
  }
});
