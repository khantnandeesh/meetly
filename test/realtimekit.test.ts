import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { HAND_MESSAGE, RealtimeKitCall, type MeetingFactory } from "../src/lib/rtc/realtimekit";
import type { JoinChoices, JoinGrant, RtcEventName } from "../src/lib/rtc/types";
import { FakeElement, FakeMeeting, FakeParticipant, FakeSelf, installDom } from "./fake-realtimekit";

/**
 * The RealtimeKit adapter against a stand-in meeting object. These check that the adapter turns
 * the SDK events it listens for into the right neutral state and events. They do not, and
 * cannot, check that a real RealtimeKit session emits those events as assumed.
 */

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
const choices: JoinChoices = {
  username: "Ada",
  audioEnabled: true,
  videoEnabled: false,
  audioDeviceId: "default",
  videoDeviceId: "default",
};

let body: FakeElement;
beforeEach(() => {
  body = installDom();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

type Setup = { role?: "host" | "guest"; selfPreset?: string; before?: (meeting: FakeMeeting) => void; choices?: JoinChoices };

async function connected(setup: Setup = {}) {
  const self = new FakeSelf("self", "Ada", { presetName: setup.selfPreset ?? "meetly-guest" });
  self.audioEnabled = true;
  const meeting = new FakeMeeting(self);
  setup.before?.(meeting);
  const options: unknown[] = [];
  const factory = (async (given: unknown) => {
    options.push(given);
    return meeting;
  }) as unknown as MeetingFactory;
  const call = new RealtimeKitCall({ ...grant, role: setup.role ?? "guest" }, setup.choices ?? choices, factory);
  const seen: { event: RtcEventName; args: unknown[] }[] = [];
  const names: RtcEventName[] = [
    "status", "disconnected", "error", "roster", "participantJoined", "participantLeft", "tiles", "speakers",
    "handRaised", "screenShare", "localMedia", "localMic", "device", "chat", "host", "audio",
  ];
  for (const event of names) call.on(event, (...args: unknown[]) => seen.push({ event, args }));
  const count = (event: RtcEventName) => seen.filter((entry) => entry.event === event).length;
  const last = (event: RtcEventName) => seen.findLast((entry) => entry.event === event)?.args;
  call.connect();
  const statusWhileConnecting = call.status;
  await tick();
  await tick();
  return { call, meeting, self, seen, count, last, options, statusWhileConnecting };
}

const audioElements = () => body.children.flatMap((sink) => sink.children).filter((el) => el.tagName === "audio");

/* ------------------------------------------------------------------ connect */

test("connecting initialises the SDK with the join choices, joins, and reports connected once", async () => {
  const { call, meeting, options, statusWhileConnecting, count } = await connected();
  assert.equal(statusWhileConnecting, "connecting");
  assert.deepEqual(options, [{ authToken: "not-a-real-token", defaults: { audio: true, video: false } }]);
  assert.equal(meeting.joinCalls, 1);
  assert.equal(call.status, "connected");
  assert.equal(call.provider, "realtimekit");
  assert.equal(call.native, meeting);
  // "connecting", then "connected": nothing in between, nothing repeated.
  assert.equal(count("status"), 2);
});

test("you are identified by the id our server minted, and listed first", async () => {
  const { call } = await connected({
    before: (meeting) => meeting.participants.joined.set("p1", new FakeParticipant("p1", "Grace")),
  });
  assert.equal(call.local.identity, "m-self");
  assert.equal(call.local.isLocal, true);
  assert.equal(call.local.name, "Ada");
  assert.deepEqual(call.participants().map((p) => p.name), ["Ada", "Grace"]);
  assert.deepEqual(call.remoteIds(), ["m-p1"]);
  assert.equal(call.participant("m-p1")?.name, "Grace");
  assert.equal(call.participant("m-self"), call.local);
  assert.equal(call.participant("nobody"), undefined);
});

test("a participant without a custom id falls back to the SDK's user id", async () => {
  const { call, meeting } = await connected();
  const peer = new FakeParticipant("p9", "Old client");
  peer.customParticipantId = undefined;
  meeting.arrive(peer);
  assert.deepEqual(call.remoteIds(), ["user-p9"]);
});

test("a failed start is reported as an error and ends the call as dropped", async () => {
  installDom();
  const factory = (async () => {
    throw new Error("Invalid auth token");
  }) as unknown as MeetingFactory;
  const call = new RealtimeKitCall(grant, choices, factory);
  const errors: string[] = [];
  const ends: string[] = [];
  call.on("error", (error) => errors.push(error.message));
  call.on("disconnected", (reason) => ends.push(reason));
  call.connect();
  await tick();
  assert.deepEqual(errors, ["Invalid auth token"]);
  assert.deepEqual(ends, ["dropped"]);
  assert.equal(call.status, "disconnected");
});

test("hanging up while still starting never joins the meeting", async () => {
  const self = new FakeSelf("self", "Ada");
  const meeting = new FakeMeeting(self);
  let release: (meeting: FakeMeeting) => void = () => {};
  const factory = (() => new Promise((resolve) => (release = resolve))) as unknown as MeetingFactory;
  const call = new RealtimeKitCall(grant, choices, factory);
  call.connect();
  await call.disconnect();
  release(meeting);
  await tick();
  assert.equal(meeting.joinCalls, 0);
  assert.equal(meeting.leaveCalls, 1);
  assert.equal(call.status, "disconnected");
});

test("the device chosen before joining is selected before the room is joined", async () => {
  const { self, meeting } = await connected({
    choices: { ...choices, audioDeviceId: "mic-2", videoEnabled: true, videoDeviceId: "cam-2" },
    before: (m) => (m.self.videoEnabled = true),
  });
  assert.deepEqual(self.setDeviceCalls, [
    { deviceId: "mic-2", kind: "audioinput" },
    { deviceId: "cam-2", kind: "videoinput" },
  ]);
  assert.equal(meeting.joinCalls, 1);
});

test("a chosen device is only switched to once the SDK has finished starting its own media", async () => {
  // Seen with the real SDK: init() resolves with the microphone still off, it comes on a moment
  // later without any event, and a setDevice() in between leaves it off for good.
  const self = new FakeSelf("self", "Ada");
  self.audioEnabled = false;
  const meeting = new FakeMeeting(self);
  const order: string[] = [];
  const setDevice = self.setDevice.bind(self);
  self.setDevice = async (device) => {
    order.push(`setDevice while microphone ${self.audioEnabled ? "on" : "off"}`);
    return setDevice(device);
  };
  const join = meeting.join.bind(meeting);
  meeting.join = async () => {
    order.push("join");
    return join();
  };
  const call = new RealtimeKitCall(grant, { ...choices, audioDeviceId: "mic-2" }, (async () => meeting) as unknown as MeetingFactory);
  const mic: boolean[] = [];
  call.on("localMic", (on) => mic.push(on));
  call.connect();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(order, [], "nothing is touched while the SDK is still starting the microphone");
  self.audioEnabled = true; // silently, as the SDK does
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(order, ["setDevice while microphone on", "join"]);
  assert.equal(call.status, "connected");
  assert.equal(call.localMedia().microphone, true);
  assert.deepEqual(mic, [], "none of this is reported as a microphone toggle");
});

test("a microphone that the SDK finishes starting after the call connects is not a toggle", async () => {
  const { call, self, seen } = await connected({ before: (m) => (m.self.audioEnabled = false) });
  assert.equal(call.localMedia().microphone, false);
  self.setAudio(true);
  assert.equal(call.localMedia().microphone, true);
  assert.equal(seen.filter((e) => e.event === "localMic").length, 0);
  // From here on it is a toggle like any other.
  self.setAudio(false);
  assert.deepEqual(seen.filter((e) => e.event === "localMic").map((e) => e.args), [[false]]);
});

test("startup media that comes up without an audio or video event is picked up from the SDK's other events", async () => {
  const { call, self, count } = await connected({
    choices: { ...choices, videoEnabled: true },
    before: (m) => (m.self.audioEnabled = false),
  });
  const ownTile = () => call.tiles().find((t) => t.participant.isLocal && t.source === "camera")!;
  assert.equal(ownTile().track, undefined);
  const before = count("localMedia");
  self.audioEnabled = true;
  self.videoEnabled = true;
  self.videoTrack = { id: "own-camera", kind: "video", getSettings: () => ({ width: 1280, height: 720 }) };
  self.emit("deviceUpdate", { device: { kind: "audiooutput", deviceId: "default" } });
  assert.deepEqual(call.localMedia(), { microphone: true, camera: true, screenShare: false });
  assert.equal(count("localMedia"), before + 1);
  assert.ok(ownTile().track, "your own tile gets its picture");
});

/* ------------------------------------------------------- joining and leaving */

test("someone joining and leaving updates the roster and announces them once each", async () => {
  const { call, meeting, count, last } = await connected();
  const before = call.participants();
  const rosterBefore = count("roster");

  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  assert.equal(count("participantJoined"), 1);
  const joined = last("participantJoined")?.[0];
  assert.equal(joined, call.participant("m-p1"));
  assert.notEqual(call.participants(), before, "a roster change must produce a new array");
  assert.equal(call.participants().length, 2);
  assert.equal(count("roster"), rosterBefore + 1);
  assert.equal(call.tiles().filter((tile) => tile.source === "camera").length, 2);

  // The SDK announcing the same peer twice must not duplicate them.
  meeting.participants.joined.emit("participantJoined", grace);
  assert.equal(count("participantJoined"), 1);

  meeting.depart("p1");
  assert.equal(count("participantLeft"), 1);
  assert.equal(last("participantLeft")?.[0], joined, "the same object that joined is the one that leaves");
  assert.deepEqual(call.remoteIds(), []);
  assert.equal(call.participant("m-p1"), undefined);
  assert.equal(grace.listenerCount("audioUpdate"), 0, "listeners on someone who left are removed");
});

test("the SDK clearing its participant map removes everyone", async () => {
  const { call, meeting, count } = await connected();
  meeting.arrive(new FakeParticipant("p1", "Grace"));
  meeting.arrive(new FakeParticipant("p2", "Linus"));
  meeting.participants.joined.emit("participantsCleared");
  assert.deepEqual(call.remoteIds(), []);
  assert.equal(count("participantLeft"), 2);
});

/* ------------------------------------------------------- microphone, camera */

test("a remote microphone going on and off is reflected, heard, and notified per person", async () => {
  const { call, meeting } = await connected();
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  const linus = meeting.arrive(new FakeParticipant("p2", "Linus"));
  const person = call.participant("m-p1")!;
  let graceChanges = 0;
  let linusChanges = 0;
  person.subscribe(() => graceChanges++);
  call.participant("m-p2")!.subscribe(() => linusChanges++);

  assert.equal(person.micOn, false);
  grace.setAudio(true);
  assert.equal(person.micOn, true);
  assert.equal(graceChanges, 1);
  assert.equal(linusChanges, 0, "one person's change must not notify another's subscribers");

  // Remote audio is played by us: one <audio> per track, carrying that track.
  const [element] = audioElements();
  assert.ok(element, "an audio element is created for the remote microphone");
  assert.equal(element.autoplay, true);
  assert.deepEqual((element.srcObject as { getTracks(): unknown[] }).getTracks(), [grace.audioTrack]);
  assert.equal(element.plays, 1);

  grace.setAudio(false);
  assert.equal(person.micOn, false);
  assert.equal(audioElements().length, 0, "the element goes when the microphone does");
  linus.setAudio(true);
  assert.equal(audioElements().length, 1);
  meeting.depart("p2");
  assert.equal(audioElements().length, 0, "and when the person leaves");
});

test("a remote camera has a picture only while the SDK is actually receiving it", async () => {
  const { call, meeting, count } = await connected();
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  const tile = () => call.tiles().find((t) => t.participant.identity === "m-p1" && t.source === "camera")!;
  assert.equal(tile().track, undefined);

  const tilesBefore = count("tiles");
  grace.setVideo(true);
  assert.equal(call.participant("m-p1")!.camOn, true);
  assert.ok(tile().track, "camera on and received: there is a picture");
  assert.ok(count("tiles") > tilesBefore);
  assert.deepEqual(tile().track!.dimensions, { width: 1280, height: 720 });
  const sameTrack = tile().track;

  // Attaching goes through the SDK's own element registration.
  const video = new FakeElement("video");
  const detach = tile().track!.attach(video as unknown as HTMLVideoElement);
  assert.deepEqual(grace.registered, [video]);
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  detach();
  assert.deepEqual(grace.registered, []);

  // Camera on but outside the SDK's active set: on, but nothing to show.
  grace.setVideo(true, false);
  assert.equal(call.participant("m-p1")!.camOn, true);
  assert.equal(tile().track, undefined);
  grace.setVideo(true);
  assert.equal(tile().track, sameTrack, "the track handle is stable, so tiles do not remount");

  grace.setVideo(false);
  assert.equal(call.participant("m-p1")!.camOn, false);
  assert.equal(tile().track, undefined);
});

test("your own microphone, camera and screen go through the SDK and are reported", async () => {
  const { call, self, count } = await connected();
  assert.deepEqual(call.localMedia(), { microphone: true, camera: false, screenShare: false });
  const snapshot = call.localMedia();
  assert.equal(call.localMedia(), snapshot, "unchanged media is the same object");

  await call.setEnabled("camera", true);
  assert.equal(self.videoEnabled, true);
  assert.deepEqual(call.localMedia(), { microphone: true, camera: true, screenShare: false });
  assert.equal(call.local.camOn, true);
  assert.equal(count("localMedia") >= 2, true);
  const own = call.tiles().find((t) => t.participant.isLocal && t.source === "camera")!;
  const video = new FakeElement("video");
  const detach = own.track!.attach(video as unknown as HTMLVideoElement);
  assert.deepEqual((video.srcObject as { getTracks(): unknown[] }).getTracks(), [self.videoTrack]);
  detach();
  assert.equal(video.srcObject, null);

  await call.setEnabled("screen_share", true);
  assert.equal(count("screenShare"), 1);
  assert.equal(call.tiles().filter((t) => t.source === "screen_share").length, 1);
  await call.setEnabled("screen_share", false);
  assert.equal(count("screenShare"), 2);
  assert.equal(call.tiles().filter((t) => t.source === "screen_share").length, 0);
});

test("a device that would not start rejects, so the interface can say so", async () => {
  const { call, self } = await connected();
  self.refuse = true;
  await assert.rejects(call.setEnabled("camera", true), /Could not start your camera/);
  await assert.rejects(call.setEnabled("screen_share", true), /Could not start your screen share/);
});

test("someone sharing a screen adds a tile and is announced; stopping removes it", async () => {
  const { call, meeting, count, last } = await connected();
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  grace.setScreenShare(true);
  const screens = call.tiles().filter((t) => t.source === "screen_share");
  assert.equal(screens.length, 1);
  assert.equal(screens[0].participant.identity, "m-p1");
  assert.deepEqual(screens[0].track!.dimensions, { width: 1920, height: 1080 });
  assert.deepEqual(last("screenShare"), [true]);
  // A repeated update for the same state is not a second start.
  grace.emit("screenShareUpdate", { screenShareEnabled: true, screenShareTracks: grace.screenShareTracks });
  assert.equal(count("screenShare"), 1);
  grace.setScreenShare(false);
  assert.deepEqual(last("screenShare"), [false]);
  assert.equal(call.tiles().filter((t) => t.source === "screen_share").length, 0);
});

/* ----------------------------------------------------------- active speaker */

test("the single active-speaker signal becomes the speaker list and the speaking flag", async () => {
  const { call, meeting, count } = await connected();
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  const linus = meeting.arrive(new FakeParticipant("p2", "Linus"));
  grace.setAudio(true);
  linus.setAudio(true);
  assert.deepEqual(call.activeSpeakers(), []);

  let graceChanges = 0;
  call.participant("m-p1")!.subscribe(() => graceChanges++);
  const before = count("speakers");
  meeting.participants.speak("p1");
  assert.deepEqual(call.activeSpeakers(), ["m-p1"]);
  assert.equal(call.participant("m-p1")!.speaking, true);
  assert.equal(call.participant("m-p2")!.speaking, false);
  assert.equal(count("speakers"), before + 1);
  assert.equal(graceChanges, 1);

  // The SDK only reports changes, but a repeat must be harmless.
  meeting.participants.speak("p1");
  assert.equal(count("speakers"), before + 1);

  meeting.participants.speak("p2");
  assert.deepEqual(call.activeSpeakers(), ["m-p2"]);
  assert.equal(call.participant("m-p1")!.speaking, false);
  assert.equal(graceChanges, 2, "the previous speaker is told they stopped");
  assert.equal(call.local.speaking, false, "the signal never names you");
});

test("the active speaker stops counting as speaking when they mute or leave", async () => {
  const { call, meeting, count } = await connected();
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  grace.setAudio(true);
  meeting.participants.speak("p1");
  const before = count("speakers");
  grace.setAudio(false);
  assert.deepEqual(call.activeSpeakers(), []);
  assert.equal(call.participant("m-p1")!.speaking, false);
  assert.equal(count("speakers"), before + 1);
  grace.setAudio(true);
  assert.deepEqual(call.activeSpeakers(), ["m-p1"], "still the last speaker the SDK named");
  meeting.depart("p1");
  assert.deepEqual(call.activeSpeakers(), []);
  assert.equal(count("speakers"), before + 3);
});

test("whoever the SDK last named as speaker before you joined is picked up", async () => {
  const { call } = await connected({
    before: (meeting) => {
      const grace = new FakeParticipant("p1", "Grace");
      grace.audioEnabled = true;
      meeting.participants.joined.set("p1", grace);
      meeting.participants.lastActiveSpeaker = "p1";
    },
  });
  assert.deepEqual(call.activeSpeakers(), ["m-p1"]);
});

/* --------------------------------------------------------------------- chat */

test("chat messages are received in order with who sent them", async () => {
  const { call, meeting, self, count } = await connected();
  const grace = meeting.arrive(new FakeParticipant("p1", "Grace"));
  assert.deepEqual(call.chatMessages(), []);
  const empty = call.chatMessages();
  meeting.chat.receive(grace, "hello", 1_700_000_000_000);
  assert.equal(count("chat"), 1);
  assert.notEqual(call.chatMessages(), empty, "a new message produces a new array");
  assert.deepEqual(call.chatMessages(), [
    {
      id: "msg-1",
      timestamp: 1_700_000_000_000,
      message: "hello",
      from: { identity: "m-p1", name: "Grace", isLocal: false },
    },
  ]);
  meeting.chat.receive(self, "hi Grace", 1_700_000_001_000);
  assert.deepEqual(call.chatMessages()[1].from, { identity: "m-self", name: "Ada", isLocal: true });
});

test("anything that is not a text message is left out", async () => {
  const { call, meeting } = await connected();
  meeting.chat.messages = [{ type: "image", id: "img-1", userId: "user-p1", displayName: "Grace", link: "x", time: new Date() }];
  meeting.chat.emit("chatUpdate", {});
  assert.deepEqual(call.chatMessages(), []);
});

test("sending a message is flagged while in flight, and a failure is thrown", async () => {
  const { call, meeting } = await connected();
  const sending = call.sendChat("on my way");
  assert.equal(call.chatSending, true);
  await sending;
  assert.equal(call.chatSending, false);
  assert.equal(call.chatMessages().at(-1)?.message, "on my way");
  assert.equal(call.chatMessages().at(-1)?.from?.isLocal, true);

  meeting.chat.failNext = true;
  await assert.rejects(call.sendChat("again"), /rate limited/);
  assert.equal(call.chatSending, false);
});

/* -------------------------------------------------------------------- hands */

test("someone raising and lowering a hand is reflected and announced on the way up only", async () => {
  const { call, meeting, count, last } = await connected();
  meeting.arrive(new FakeParticipant("p1", "Grace"));
  const person = call.participant("m-p1")!;
  let changes = 0;
  person.subscribe(() => changes++);
  const rosterBefore = count("roster");

  meeting.participants.emit("broadcastedMessage", { type: HAND_MESSAGE, payload: { peerId: "p1", raised: true }, timestamp: 1 });
  assert.equal(person.handRaised, true);
  assert.equal(changes, 1);
  assert.equal(count("handRaised"), 1);
  assert.equal(last("handRaised")?.[0], person);
  assert.equal(count("roster"), rosterBefore + 1, "the hands list is part of the roster");

  meeting.participants.emit("broadcastedMessage", { type: HAND_MESSAGE, payload: { peerId: "p1", raised: false }, timestamp: 2 });
  assert.equal(person.handRaised, false);
  assert.equal(count("handRaised"), 1);

  // Other applications' messages, and messages about people who are not here, are ignored.
  meeting.participants.emit("broadcastedMessage", { type: "something-else", payload: { peerId: "p1", raised: true }, timestamp: 3 });
  meeting.participants.emit("broadcastedMessage", { type: HAND_MESSAGE, payload: { peerId: "ghost", raised: true }, timestamp: 4 });
  assert.equal(person.handRaised, false);
});

test("raising your own hand tells everyone, and a late joiner is told again", async () => {
  const { call, meeting, count } = await connected();
  await call.setHandRaised(true);
  assert.equal(call.local.handRaised, true);
  assert.deepEqual(meeting.participants.broadcasts, [
    { type: HAND_MESSAGE, payload: { peerId: "self", raised: true }, target: undefined },
  ]);
  assert.equal(count("handRaised"), 1, "your own broadcast coming back is not a second raise");

  meeting.arrive(new FakeParticipant("p7", "Late"));
  assert.deepEqual(meeting.participants.broadcasts[1], {
    type: HAND_MESSAGE,
    payload: { peerId: "self", raised: true },
    target: { participantIds: ["p7"] },
  });

  await call.setHandRaised(false);
  assert.equal(call.local.handRaised, false);
  assert.deepEqual(meeting.participants.broadcasts[2].payload, { peerId: "self", raised: false });
  meeting.arrive(new FakeParticipant("p8", "Later"));
  assert.equal(meeting.participants.broadcasts.length, 3, "a lowered hand is not re-announced");
});

/* --------------------------------------------------------------------- host */

test("the host is whoever joined with the host preset", async () => {
  const guest = await connected();
  assert.equal(guest.call.hostIdentity, null);
  const before = guest.count("host");
  guest.meeting.arrive(new FakeParticipant("p1", "Grace", { presetName: "meetly-host" }));
  assert.equal(guest.call.hostIdentity, "m-p1");
  assert.equal(guest.count("host"), before + 1);
  guest.meeting.depart("p1");
  assert.equal(guest.call.hostIdentity, null);

  const host = await connected({ role: "host", selfPreset: "meetly-host" });
  assert.equal(host.call.hostIdentity, "m-self");
});

test("being muted by the host is reported as your microphone going off", async () => {
  const { call, self, seen } = await connected();
  assert.equal(seen.filter((e) => e.event === "localMic").length, 0, "joining with the microphone on is not a toggle");
  // What the SDK does when the host mutes you: your audio is disabled and audioUpdate fires.
  self.setAudio(false);
  assert.deepEqual(seen.filter((e) => e.event === "localMic").map((e) => e.args), [[false]]);
  assert.equal(call.localMedia().microphone, false);
  assert.equal(call.local.micOn, false);
  await call.setEnabled("microphone", true);
  assert.deepEqual(seen.filter((e) => e.event === "localMic").map((e) => e.args), [[false], [true]]);
});

/* ------------------------------------------------------------ ending a call */

test("being removed by the host ends the call as removed, once", async () => {
  const { call, meeting, self, seen } = await connected();
  meeting.arrive(new FakeParticipant("p1", "Grace")).setAudio(true);
  self.emit("roomLeft", { state: "kicked" });
  assert.deepEqual(seen.filter((e) => e.event === "disconnected").map((e) => e.args), [["removed"]]);
  assert.equal(call.status, "disconnected");
  assert.deepEqual(call.remoteIds(), []);
  assert.equal(audioElements().length, 0);
  assert.equal(body.children.length, 0, "the audio container is removed");
  assert.equal(self.listenerCount("roomLeft"), 0, "the adapter lets go of the SDK");
  self.emit("roomLeft", { state: "kicked" });
  assert.equal(seen.filter((e) => e.event === "disconnected").length, 1);
});

test("leaving yourself ends the call as left", async () => {
  const { call, meeting, seen } = await connected();
  await call.disconnect();
  assert.equal(meeting.leaveCalls, 1);
  assert.deepEqual(seen.filter((e) => e.event === "disconnected").map((e) => e.args), [["left"]]);
  assert.equal(call.status, "disconnected");
});

test("a lost connection shows as reconnecting, then connected again, without ending the call", async () => {
  const { call, meeting, self, seen } = await connected();
  self.emit("roomLeft", { state: "disconnected" });
  assert.equal(call.status, "reconnecting");
  self.emit("roomJoined", { reconnected: true });
  assert.equal(call.status, "connected");

  meeting.meta.emit("socketConnectionUpdate", { state: "reconnecting", reconnected: false, reconnectionAttempt: 1 });
  assert.equal(call.status, "reconnecting");
  meeting.meta.emit("mediaConnectionUpdate", { transport: "recv", state: "disconnected" });
  meeting.meta.emit("socketConnectionUpdate", { state: "connected", reconnected: true, reconnectionAttempt: 1 });
  assert.equal(call.status, "reconnecting", "still down until the media transport is back too");
  meeting.meta.emit("mediaConnectionUpdate", { transport: "recv", state: "connected" });
  assert.equal(call.status, "connected");
  assert.equal(seen.filter((e) => e.event === "disconnected").length, 0);
});

test("a connection that cannot be recovered ends the call as dropped", async () => {
  const { self, seen } = await connected();
  self.emit("roomLeft", { state: "disconnected" });
  self.emit("roomLeft", { state: "failed" });
  assert.deepEqual(seen.filter((e) => e.event === "disconnected").map((e) => e.args), [["dropped"]]);
});

/* ------------------------------------------------------- demand and devices */

test("video demand sizes the SDK's active set: what is on screen, you, some headroom, at most 24", async () => {
  const { call, meeting } = await connected();
  assert.deepEqual(meeting.participants.maxCalls, [], "nothing is changed until the stage has reported");
  call.setVideoDemand(["a", "b", "c", "d", "e"]);
  assert.deepEqual(meeting.participants.maxCalls, [8]);
  call.setVideoDemand(["a", "b", "c", "d", "e"]);
  assert.deepEqual(meeting.participants.maxCalls, [8], "an unchanged demand is not sent again");
  call.setVideoDemand(Array.from({ length: 48 }, (_, i) => `p${i}`));
  assert.deepEqual(meeting.participants.maxCalls, [8, 24], "never above what the SDK accepts");
  call.setVideoDemand([]);
  assert.deepEqual(meeting.participants.maxCalls, [8, 24, 3]);
});

test("demand reported before the call is connected is applied on joining", async () => {
  const self = new FakeSelf("self", "Ada");
  const meeting = new FakeMeeting(self);
  const call = new RealtimeKitCall(grant, choices, (async () => meeting) as unknown as MeetingFactory);
  call.setVideoDemand(["a", "b"]);
  call.connect();
  await tick();
  await tick();
  assert.deepEqual(meeting.participants.maxCalls, [5]);
});

test("switching microphone goes through the SDK; switching speaker re-routes our audio elements", async () => {
  const { call, meeting, self, seen } = await connected();
  meeting.arrive(new FakeParticipant("p1", "Grace")).setAudio(true);
  await call.setDevice("audioinput", "mic-3");
  assert.deepEqual(self.setDeviceCalls.at(-1), { deviceId: "mic-3", kind: "audioinput" });
  assert.equal(call.activeDevice("audioinput"), "mic-3");

  await call.setDevice("audiooutput", "speaker-2");
  assert.equal(call.activeDevice("audiooutput"), "speaker-2");
  assert.equal(audioElements()[0].sinkId, "speaker-2");
  meeting.arrive(new FakeParticipant("p2", "Linus")).setAudio(true);
  assert.equal(audioElements()[1].sinkId, "speaker-2", "people who unmute later use the chosen speaker too");
  assert.ok(seen.some((e) => e.event === "device" && e.args[0] === "audiooutput"));
});

test("blocked autoplay is surfaced, and one click lifts it", async () => {
  const { call, meeting, count } = await connected();
  FakeElement.blockPlayback = true;
  meeting.arrive(new FakeParticipant("p1", "Grace")).setAudio(true);
  await tick();
  assert.equal(call.audioBlocked, true);
  assert.equal(count("audio"), 1);
  FakeElement.blockPlayback = false;
  await call.startAudio();
  assert.equal(call.audioBlocked, false);
  assert.equal(count("audio"), 2);
});
