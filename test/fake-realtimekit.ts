import { EventEmitter } from "node:events";

/**
 * A stand-in for the RealtimeKit meeting object, shaped after the SDK's type definitions
 * (@cloudflare/realtimekit 2.1.0, dist/index.d.ts) and limited to what the adapter touches.
 * Event names and payloads are the SDK's. It imitates the SDK; it is not the SDK, and nothing
 * here proves how a real session behaves.
 */

export type FakeTrack = { id: string; kind: "audio" | "video"; getSettings(): { width?: number; height?: number } };

let trackCount = 0;
export function track(kind: "audio" | "video", size?: { width: number; height: number }): FakeTrack {
  return { id: `track-${++trackCount}`, kind, getSettings: () => size ?? {} };
}

/** ParticipantMap: a Map that also emits participantJoined / participantLeft / participantsCleared. */
export class FakeParticipantMap extends Map<string, FakeParticipant> {
  private readonly events = new EventEmitter();
  on(event: string, listener: (...args: unknown[]) => void) {
    this.events.on(event, listener);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void) {
    this.events.off(event, listener);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    return this.events.emit(event, ...args);
  }
  listenerCount(event: string) {
    return this.events.listenerCount(event);
  }
  toArray() {
    return Array.from(this.values());
  }
  add(participant: FakeParticipant) {
    this.set(participant.id, participant);
    this.emit("participantJoined", participant);
    return this;
  }
  remove(id: string) {
    const participant = this.get(id);
    if (!participant) return;
    this.delete(id);
    this.emit("participantLeft", participant);
  }
}

export class FakeParticipant extends EventEmitter {
  id: string;
  userId: string;
  customParticipantId?: string;
  name: string;
  presetName?: string;
  audioEnabled = false;
  videoEnabled = false;
  screenShareEnabled = false;
  audioTrack?: FakeTrack;
  videoTrack?: FakeTrack;
  screenShareTracks: { audio?: FakeTrack; video?: FakeTrack } = {};
  registered: unknown[] = [];
  /** Times a host asked the SDK to stop this person's camera (RTKParticipant.disableVideo). */
  videoStops = 0;

  constructor(id: string, name: string, options: { presetName?: string; customParticipantId?: string } = {}) {
    super();
    this.id = id;
    this.userId = `user-${id}`;
    this.customParticipantId = options.customParticipantId ?? `m-${id}`;
    this.name = name;
    this.presetName = options.presetName ?? "meetly-guest";
  }
  registerVideoElement(element: unknown) {
    this.registered.push(element);
  }
  deregisterVideoElement(element: unknown) {
    this.registered = this.registered.filter((other) => other !== element);
  }
  /** RTKParticipant.disableVideo(): what a host with the permission calls on someone else. */
  async disableVideo() {
    this.videoStops++;
    this.setVideo(false);
  }
  /** What the SDK does when this person's microphone goes on or off. */
  setAudio(enabled: boolean) {
    this.audioEnabled = enabled;
    this.audioTrack = enabled ? track("audio") : undefined;
    this.emit("audioUpdate", { audioEnabled: enabled, audioTrack: this.audioTrack });
  }
  setVideo(enabled: boolean, received = true) {
    this.videoEnabled = enabled;
    this.videoTrack = enabled && received ? track("video", { width: 1280, height: 720 }) : undefined;
    this.emit("videoUpdate", { videoEnabled: enabled, videoTrack: this.videoTrack });
  }
  setScreenShare(enabled: boolean) {
    this.screenShareEnabled = enabled;
    this.screenShareTracks = enabled ? { video: track("video", { width: 1920, height: 1080 }) } : {};
    this.emit("screenShareUpdate", { screenShareEnabled: enabled, screenShareTracks: this.screenShareTracks });
  }
}

export class FakeSelf extends FakeParticipant {
  roomJoined = false;
  /** Self.roomState: 'init' | 'joined' | 'waitlisted' | LeaveRoomState. */
  roomState = "init";
  /** The few PermissionPreset getters the adapter reads. */
  permissions: {
    acceptWaitingRequests: boolean;
    canDisableParticipantVideo: boolean;
    /** PermissionPreset.polls, from the preset. Left out here, it stands for a preset that allows none of it. */
    polls?: { canCreate: boolean; canVote: boolean; canView: boolean };
  } = { acceptWaitingRequests: false, canDisableParticipantVideo: false };
  /** RTKSelfMedia.updateVideoConstraints: what the running camera was asked to become. */
  videoConstraintCalls: unknown[] = [];
  async updateVideoConstraints(constraints: unknown) {
    // The SDK's own error (1610) when the camera is off.
    if (!this.videoTrack) throw new Error("No media track enabled!");
    this.videoConstraintCalls.push(constraints);
  }
  /** Set to make the next enable call fail the way a refused permission does: no change, no throw. */
  refuse = false;
  devices: { audio?: { deviceId: string }; video?: { deviceId: string }; speaker?: { deviceId: string } } = {};
  setDeviceCalls: { deviceId: string; kind: string }[] = [];
  /** RTKSelfMedia.addAudioMiddleware / addVideoMiddleware: what is installed right now. */
  audioMiddlewares: ((context: unknown) => Promise<unknown>)[] = [];
  videoMiddlewares: unknown[] = [];
  /** Set to make the SDK refuse the next video middleware, as its `{ success: false }` does. */
  refuseMiddleware = false;
  /** Constraints asked of the running microphone track. */
  constraintCalls: unknown[] = [];

  async addAudioMiddleware(middleware: (context: unknown) => Promise<unknown>) {
    this.audioMiddlewares.push(middleware);
    return { success: true, message: "" };
  }
  async removeAudioMiddleware(middleware: unknown) {
    this.audioMiddlewares = this.audioMiddlewares.filter((other) => other !== middleware);
    return { success: true, message: "" };
  }
  async addVideoMiddleware(middleware: unknown) {
    if (this.refuseMiddleware) return { success: false, message: "not supported" };
    this.videoMiddlewares.push(middleware);
    return { success: true, message: "" };
  }
  async removeVideoMiddleware(middleware: unknown) {
    this.videoMiddlewares = this.videoMiddlewares.filter((other) => other !== middleware);
    return { success: true, message: "" };
  }
  /** Gives the microphone a track that records what it is asked to change. */
  withMicrophone() {
    this.audioTrack = Object.assign(track("audio"), {
      applyConstraints: async (constraints: unknown) => void this.constraintCalls.push(constraints),
    });
    return this;
  }

  async enableAudio() {
    if (!this.refuse) this.setAudio(true);
  }
  async disableAudio() {
    this.setAudio(false);
  }
  async enableVideo() {
    if (!this.refuse) this.setVideo(true);
  }
  async disableVideo() {
    this.setVideo(false);
  }
  async enableScreenShare() {
    if (!this.refuse) this.setScreenShare(true);
  }
  async disableScreenShare() {
    this.setScreenShare(false);
  }
  getCurrentDevices() {
    return this.devices;
  }
  async getDeviceById(deviceId: string, kind: string) {
    return { deviceId, kind: kind === "audio" ? "audioinput" : kind === "video" ? "videoinput" : "audiooutput" };
  }
  async setDevice(device: { deviceId: string; kind: string }) {
    this.setDeviceCalls.push(device);
    const slot = device.kind === "audioinput" ? "audio" : device.kind === "videoinput" ? "video" : "speaker";
    this.devices[slot] = { deviceId: device.deviceId };
    this.emit("deviceUpdate", { device });
  }
}

export class FakeParticipants extends EventEmitter {
  joined = new FakeParticipantMap();
  active = new FakeParticipantMap();
  /** Participants.waitlisted: people in the waiting room. */
  waitlisted = new FakeParticipantMap();
  accepted: string[] = [];
  rejected: string[] = [];
  acceptWaitingRoomRequest(id: string) {
    this.accepted.push(id);
    this.waitlisted.remove(id);
  }
  async rejectWaitingRoomRequest(id: string) {
    this.rejected.push(id);
    this.waitlisted.remove(id);
  }
  lastActiveSpeaker = "";
  maxActiveParticipantsCount = 49;
  maxCalls: number[] = [];
  broadcasts: { type: string; payload: Record<string, unknown>; target?: unknown }[] = [];

  setMaxActiveParticipantsCount(limit: number) {
    // The SDK's own check (error 1203).
    if (limit < 0 || limit > 24) throw new Error("0 <= Max active participants count limit <= 24");
    this.maxActiveParticipantsCount = limit;
    this.maxCalls.push(limit);
  }
  async broadcastMessage(type: string, payload: Record<string, unknown>, target?: unknown) {
    this.broadcasts.push({ type, payload, target });
    // With no target the SDK delivers to everyone, the sender included.
    if (!target) this.emit("broadcastedMessage", { type, payload, timestamp: Date.now() });
  }
  /** What the SDK emits when its most prominent speaker changes. `volume` is always 1. */
  speak(peerId: string) {
    this.lastActiveSpeaker = peerId;
    this.emit("activeSpeaker", { peerId, volume: 1 });
  }
  /**
   * Participants.getAllJoinedPeers: a page of who is in the meeting, asked of the server.
   * RealtimeKit allows 10 calls a minute, so the calls are counted. Only the fields the SDK's
   * type names that this stand-in can fill are given.
   */
  joinedPeerCalls = 0;
  async getAllJoinedPeers(_searchQuery: string, limit: number, offset: number) {
    this.joinedPeerCalls++;
    return this.joined
      .toArray()
      .slice(offset, offset + limit)
      .map((p) => ({ id: p.id, userId: p.userId, name: p.name, displayName: p.name, customParticipantId: p.customParticipantId ?? "", waitlisted: false }));
  }
}

/**
 * RTKStage, for webinars: who may be on stage is changed by user id. Only the calls are
 * recorded; this stand-in does not imitate the stage-request states.
 */
export class FakeStage extends EventEmitter {
  granted: string[][] = [];
  denied: string[][] = [];
  async grantAccess(userIds: string[]) {
    this.granted.push(userIds);
  }
  async denyAccess(userIds: string[]) {
    this.denied.push(userIds);
  }
}

export class FakeChat extends EventEmitter {
  messages: Record<string, unknown>[] = [];
  private readonly self: FakeSelf;
  private count = 0;
  failNext = false;
  constructor(self: FakeSelf) {
    super();
    this.self = self;
  }
  receive(from: { userId: string; name: string }, text: string, timeMs = Date.now()) {
    const message = {
      type: "text",
      id: `msg-${++this.count}`,
      userId: from.userId,
      displayName: from.name,
      message: text,
      time: new Date(timeMs),
      timeMs,
    };
    this.messages = [...this.messages, message];
    this.emit("chatUpdate", { action: "add", message, messages: this.messages });
  }
  /** RTKChat.deleteMessage: the message leaves `messages` and `chatUpdate` says which it was. */
  deleted: string[] = [];
  async deleteMessage(id: string) {
    this.deleted.push(id);
    const message = this.messages.find((entry) => entry.id === id);
    if (!message) return;
    this.messages = this.messages.filter((entry) => entry.id !== id);
    this.emit("chatUpdate", { action: "delete", message, messages: this.messages });
  }
  async sendTextMessage(text: string) {
    await Promise.resolve();
    if (this.failNext) {
      this.failNext = false;
      throw new Error("rate limited");
    }
    this.receive(this.self, text);
  }
}

/** A poll as the SDK's `Poll` type has it. */
export type FakePoll = {
  id: string;
  question: string;
  options: { text: string; votes: { id: string; name: string }[]; count: number }[];
  anonymous: boolean;
  hideVotes: boolean;
  createdBy: string;
  createdByUserId: string;
  voted: string[];
};

/**
 * RTKPolls: `items`, `create`, `vote` and the `pollsUpdate` event. As in the SDK, `create` and
 * `vote` return without a word when the preset does not allow them, and neither says whether
 * the server did anything: the answer is a `pollsUpdate`. What Cloudflare's server does with a
 * second vote from the same person is not known; this stand-in counts whatever it is sent.
 */
export class FakePolls extends EventEmitter {
  items: FakePoll[] = [];
  createCalls: unknown[][] = [];
  voteCalls: [string, number][] = [];
  /** Set to make the server never answer a vote. */
  deaf = false;
  private count = 0;
  private readonly self: FakeSelf;
  constructor(self: FakeSelf) {
    super();
    this.self = self;
  }
  /** A poll arriving from the server: new, or an update to one already held. */
  receive(poll: FakePoll) {
    const at = this.items.findIndex((entry) => entry.id === poll.id);
    if (at >= 0) this.items[at] = poll;
    else this.items = [...this.items, poll];
    this.emit("pollsUpdate", { polls: this.items, newPoll: at < 0 });
  }
  make(question: string, options: string[], anonymous = false, createdBy = "Host"): FakePoll {
    return {
      id: `poll-${++this.count}`,
      question,
      options: options.map((text) => ({ text, votes: [], count: 0 })),
      anonymous,
      hideVotes: false,
      createdBy,
      createdByUserId: "user-host",
      voted: [],
    };
  }
  async create(question: string, options: string[], anonymous = false, hideVotes = false) {
    this.createCalls.push([question, options, anonymous, hideVotes]);
    if (!this.self.permissions.polls?.canCreate) return;
    this.receive({ ...this.make(question, options, anonymous, this.self.name), createdByUserId: this.self.userId });
  }
  async vote(id: string, index: number) {
    this.voteCalls.push([id, index]);
    const poll = this.items.find((entry) => entry.id === id);
    if (!this.self.permissions.polls?.canVote || !poll || this.deaf) return;
    this.receive(castFakeVote(poll, index, { id: this.self.userId, name: this.self.name }));
  }
}

/** The poll with one more vote in it, as the server would send it back. */
export function castFakeVote(poll: FakePoll, index: number, voter: { id: string; name: string }): FakePoll {
  return {
    ...poll,
    voted: [...poll.voted, voter.id],
    options: poll.options.map((option, at) =>
      at === index ? { ...option, count: option.count + 1, votes: poll.anonymous ? [] : [...option.votes, voter] } : option,
    ),
  };
}

export class FakeMeeting {
  polls: FakePolls;
  self: FakeSelf;
  participants = new FakeParticipants();
  stage = new FakeStage();
  /** RTKMeta, with the one property the adapter reads. */
  meta: EventEmitter & { meetingStartedTimestamp?: Date } = new EventEmitter();
  chat: FakeChat;
  joinCalls = 0;
  leaveCalls = 0;
  /** Set to make join() put you in the waiting room, as a preset with one switched on does. */
  waitingRoom = false;

  constructor(self: FakeSelf) {
    this.self = self;
    this.chat = new FakeChat(self);
    this.polls = new FakePolls(self);
  }
  async join() {
    this.joinCalls++;
    if (this.waitingRoom) {
      this.self.roomState = "waitlisted";
      this.self.emit("waitlisted");
      return;
    }
    this.letIn();
  }
  /** A host accepted you (or there was no waiting room). */
  letIn() {
    this.self.roomJoined = true;
    this.self.roomState = "joined";
    this.self.emit("roomJoined", { reconnected: false });
  }
  /** The SDK's `roomLeft` with any of its states: "rejected", "kicked", "ended", … */
  leftAs(state: string) {
    this.self.roomJoined = false;
    this.self.roomState = state;
    this.self.emit("roomLeft", { state });
  }
  async leave() {
    this.leaveCalls++;
    this.self.roomJoined = false;
    this.self.emit("roomLeft", { state: "left" });
  }
  /** A remote participant arrives the way the SDK reports it. */
  arrive(participant: FakeParticipant) {
    this.participants.joined.add(participant);
    return participant;
  }
  depart(id: string) {
    this.participants.active.remove(id);
    this.participants.joined.remove(id);
  }
}

/** Just enough of the DOM for the adapter's audio elements and video attachment. */
export class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { removeProperty(name: string): void };
  dataset: Record<string, string> = {};
  srcObject: unknown = null;
  autoplay = false;
  playsInline = false;
  muted = false;
  sinkId = "";
  plays = 0;
  /** Set to make play() fail the way a browser's autoplay policy does. */
  static blockPlayback = false;

  constructor(tagName: string) {
    this.tagName = tagName;
    const style = { removeProperty: (name: string) => void delete (style as Record<string, unknown>)[name] };
    this.style = style as FakeElement["style"];
  }
  append(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((other) => other !== this);
    this.parent = null;
  }
  async play() {
    this.plays++;
    if (FakeElement.blockPlayback) {
      const error = new Error("play() failed because the user didn't interact with the document first");
      error.name = "NotAllowedError";
      throw error;
    }
  }
  async setSinkId(id: string) {
    this.sinkId = id;
  }
}

export class FakeMediaStream {
  private readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

/** Installs the DOM stand-ins on the global object. Returns the fake `document.body`. */
export function installDom(): FakeElement {
  const body = new FakeElement("body");
  const target = globalThis as Record<string, unknown>;
  target.document = { body, createElement: (tag: string) => new FakeElement(tag) };
  target.MediaStream = FakeMediaStream;
  FakeElement.blockPlayback = false;
  return body;
}
