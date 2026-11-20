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
  /** Set to make the next enable call fail the way a refused permission does: no change, no throw. */
  refuse = false;
  devices: { audio?: { deviceId: string }; video?: { deviceId: string }; speaker?: { deviceId: string } } = {};
  setDeviceCalls: { deviceId: string; kind: string }[] = [];

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
  async sendTextMessage(text: string) {
    await Promise.resolve();
    if (this.failNext) {
      this.failNext = false;
      throw new Error("rate limited");
    }
    this.receive(this.self, text);
  }
}

export class FakeMeeting {
  self: FakeSelf;
  participants = new FakeParticipants();
  meta = new EventEmitter();
  chat: FakeChat;
  joinCalls = 0;
  leaveCalls = 0;

  constructor(self: FakeSelf) {
    this.self = self;
    this.chat = new FakeChat(self);
  }
  async join() {
    this.joinCalls++;
    this.self.roomJoined = true;
    this.self.emit("roomJoined", { reconnected: false });
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
