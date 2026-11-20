import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { RTKParticipant } from "@cloudflare/realtimekit";
import { Notifier, RtcEmitter } from "./emitter";
import type {
  ConnectionStatus,
  DeviceKind,
  DisconnectReason,
  JoinChoices,
  JoinGrant,
  LocalMedia,
  LocalSource,
  RtcCall,
  RtcChatMessage,
  RtcParticipant,
  RtcTile,
  RtcVideoTrack,
} from "./types";

type Meeting = RealtimeKitClient;
type Grant = Extract<JoinGrant, { provider: "realtimekit" }>;

/** How the meeting object is obtained. Tests pass a stand-in; the app loads the SDK. */
export type MeetingFactory = (options: {
  authToken: string;
  defaults: { audio: boolean; video: boolean };
}) => Promise<Meeting>;

/** Broadcast message type that carries a raised or lowered hand. RealtimeKit has no built-in one. */
export const HAND_MESSAGE = "meetly-hand";
/** Media scores run 0 to 10; below this the connection is shown as weak. */
export const WEAK_SCORE = 5;
/** The SDK accepts at most this many participants in its active set, you included. */
export const MAX_ACTIVE = 24;
/**
 * Kept subscribed beyond what is on screen. The SDK picks who is active (recent speakers first)
 * and the stage picks who is visible; a little headroom keeps the two from disagreeing.
 */
export const DEMAND_HEADROOM = 2;
/** How long after connecting a microphone that was asked for is given to start. */
const MIC_SETTLE_MS = 3000;

/** How long the SDK is given to start the microphone and camera before a device is switched. */
const STARTUP_MEDIA_MS = 5000;

/** A specific device, as opposed to "whatever the browser's default is". */
const isChoice = (deviceId: string) => !!deviceId && deviceId !== "default";

const SDK_KIND = { audioinput: "audio", videoinput: "video", audiooutput: "speaker" } as const;

function show(element: HTMLVideoElement, track: MediaStreamTrack | undefined): void {
  if (!track) {
    element.srcObject = null;
    return;
  }
  const current = element.srcObject instanceof MediaStream ? element.srcObject.getTracks()[0] : undefined;
  if (current?.id !== track.id) element.srcObject = new MediaStream([track]);
  element.play().catch(() => {});
}

function prepare(element: HTMLVideoElement): void {
  element.autoplay = true;
  element.playsInline = true;
  element.muted = true;
}

function sizeOf(track: MediaStreamTrack | undefined): { width: number; height: number } | undefined {
  const settings = track?.getSettings?.();
  return settings?.width && settings.height ? { width: settings.width, height: settings.height } : undefined;
}

/** A remote camera. The SDK's own element registration also picks the simulcast layer by size. */
class RemoteCamera implements RtcVideoTrack {
  private readonly peer: RTKParticipant;
  constructor(peer: RTKParticipant) {
    this.peer = peer;
  }
  get dimensions() {
    return sizeOf(this.peer.videoTrack);
  }
  attach(element: HTMLVideoElement) {
    prepare(element);
    this.peer.registerVideoElement(element);
    // The SDK hides the element inline when the camera is off; the tile decides that itself.
    element.style.removeProperty("display");
    element.play().catch(() => {});
    return () => {
      this.peer.deregisterVideoElement(element);
      element.style.removeProperty("display");
    };
  }
}

/** Any picture we place ourselves: your own camera, and screen shares. */
class DirectVideo implements RtcVideoTrack {
  private readonly track: () => MediaStreamTrack | undefined;
  private readonly watch: (onChange: () => void) => () => void;
  constructor(track: () => MediaStreamTrack | undefined, watch: (onChange: () => void) => () => void) {
    this.track = track;
    this.watch = watch;
  }
  get dimensions() {
    return sizeOf(this.track());
  }
  attach(element: HTMLVideoElement) {
    prepare(element);
    const sync = () => show(element, this.track());
    sync();
    const unwatch = this.watch(sync);
    return () => {
      unwatch();
      element.srcObject = null;
    };
  }
}

class Person implements RtcParticipant {
  readonly isLocal: boolean;
  readonly changes = new Notifier();
  readonly subscribe = this.changes.subscribe;
  weak = false;
  hand = false;
  camera?: RtcVideoTrack;
  screen?: RtcVideoTrack;
  private readonly read: () => { identity: string; name: string; micOn: boolean; camOn: boolean };
  private readonly isSpeaking: () => boolean;

  constructor(isLocal: boolean, read: Person["read"], isSpeaking: () => boolean) {
    this.isLocal = isLocal;
    this.read = read;
    this.isSpeaking = isSpeaking;
  }
  get identity() {
    return this.read().identity;
  }
  get name() {
    return this.read().name;
  }
  get micOn() {
    return this.read().micOn;
  }
  get camOn() {
    return this.read().camOn;
  }
  get handRaised() {
    return this.hand;
  }
  get speaking() {
    return this.isSpeaking();
  }
  get weakConnection() {
    return this.weak;
  }
}

/** Our server mints `customParticipantId`; it is the same for everyone and for the REST API. */
const identityOf = (peer: { customParticipantId?: string; userId: string; id: string }) =>
  peer.customParticipantId || peer.userId || peer.id;

export class RealtimeKitCall extends RtcEmitter implements RtcCall {
  readonly provider = "realtimekit" as const;

  private readonly grant: Grant;
  private readonly choices: JoinChoices;
  private readonly factory: MeetingFactory;

  private meeting: Meeting | null = null;
  private attempt = 0;
  private joined = false;
  private ended = false;
  /** Parts of the connection that are currently down: "socket", "send", "recv", "room". */
  private readonly broken = new Set<string>();
  private lastStatus: ConnectionStatus = "disconnected";

  private readonly self: Person;
  /** Keyed by peer id, the SDK's per-session id. */
  private readonly peers = new Map<string, { peer: RTKParticipant; person: Person; stop: () => void }>();
  private roster: RtcParticipant[] | null = null;
  private tileList: RtcTile[] | null = null;
  private media: LocalMedia | null = null;
  private messages: RtcChatMessage[] = [];
  private sending = false;
  private speaker: string | null = null;
  private lastHost: string | null = null;
  /** Remote cameras on screen, once the stage has said. Until then the preset's own size stands. */
  private demand: number | null = null;
  private blocked = false;
  private outputDevice: string | undefined;
  private readonly sounds = new Map<string, HTMLAudioElement>();
  private audioSink: HTMLElement | null = null;
  private teardown: (() => void)[] = [];
  /**
   * What your microphone was last reported as. It starts as what you asked for on the pre-join
   * screen: the SDK may still be starting the microphone when the call connects, and that first
   * "on" is not you (or the host) toggling anything.
   */
  private micWas: boolean;

  constructor(grant: Grant, choices: JoinChoices, factory: MeetingFactory) {
    super();
    this.grant = grant;
    this.choices = choices;
    this.factory = factory;
    this.micWas = choices.audioEnabled;
    this.self = new Person(
      true,
      () => {
        const me = this.meeting?.self;
        return {
          identity: me ? identityOf(me) : "",
          name: me?.name ?? this.choices.username,
          micOn: !!me?.audioEnabled,
          camOn: !!me?.videoEnabled,
        };
      },
      // The SDK's active-speaker signal only ever names other people.
      () => false,
    );
  }

  get native(): Meeting | null {
    return this.meeting;
  }

  /* -------------------------------------------------------------- connection */

  get status(): ConnectionStatus {
    return this.lastStatus;
  }

  private computeStatus(): ConnectionStatus {
    if (this.ended || this.attempt === 0) return "disconnected";
    if (!this.joined) return "connecting";
    return this.broken.size > 0 ? "reconnecting" : "connected";
  }

  private statusChanged(): void {
    const next = this.computeStatus();
    if (next === this.lastStatus) return;
    this.lastStatus = next;
    this.emit("status");
  }

  private fail(error: unknown): void {
    this.emit("error", error instanceof Error ? error : new Error(String(error)));
  }

  connect(): void {
    const attempt = ++this.attempt;
    this.ended = false;
    this.joined = false;
    this.statusChanged();
    const current = () => attempt === this.attempt;
    (async () => {
      const { audioEnabled, videoEnabled } = this.choices;
      const meeting = await this.factory({
        authToken: this.grant.authToken,
        defaults: { audio: audioEnabled, video: videoEnabled },
      });
      if (!current()) {
        await meeting.leave().catch(() => {});
        return;
      }
      this.meeting = meeting;
      this.listen(meeting);
      const microphone = audioEnabled ? this.choices.audioDeviceId : "";
      const camera = videoEnabled ? this.choices.videoDeviceId : "";
      if (isChoice(microphone) || isChoice(camera)) {
        // init() returns before the SDK has started the microphone and camera, and switching
        // device while it is still doing so leaves the microphone off. So: let it finish first.
        await this.startupMedia(meeting, current);
        if (!current()) return void (await meeting.leave().catch(() => {}));
        await this.preferDevice("audioinput", microphone);
        await this.preferDevice("videoinput", camera);
      }
      await meeting.join();
      if (!current()) {
        await meeting.leave().catch(() => {});
        return;
      }
      this.onJoined();
    })().catch((error) => {
      if (!current()) return;
      // The call ends first, so the reason is still on screen once the "left" page is up.
      this.finish("dropped");
      this.fail(error);
    });
  }

  async disconnect(): Promise<void> {
    const meeting = this.meeting;
    if (!meeting || this.ended) {
      // Still starting up: abandon the attempt; connect() leaves once the SDK is ready.
      this.attempt++;
      this.ended = true;
      this.statusChanged();
      return;
    }
    // The SDK answers with `roomLeft`, which is what ends the call for the interface.
    await meeting.leave();
    this.finish("left");
  }

  /** Resolves once the devices asked for on the pre-join screen are running, or after a while. */
  private async startupMedia(meeting: Meeting, current: () => boolean): Promise<void> {
    const { audioEnabled, videoEnabled } = this.choices;
    const deadline = Date.now() + STARTUP_MEDIA_MS;
    // The SDK announces none of this with an event, so it is polled.
    while (current() && Date.now() < deadline) {
      if ((!audioEnabled || meeting.self.audioEnabled) && (!videoEnabled || meeting.self.videoEnabled)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The device chosen before joining. A missing or renamed device is not worth failing over. */
  private async preferDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    if (!isChoice(deviceId) || !this.meeting) return;
    try {
      const self = this.meeting.self;
      if (self.getCurrentDevices()[SDK_KIND[kind]]?.deviceId === deviceId) return;
      const device = await self.getDeviceById(deviceId, SDK_KIND[kind]);
      if (device) await self.setDevice(device);
    } catch {
      // Stay on whatever the SDK picked.
    }
  }

  private onJoined(): void {
    const meeting = this.meeting;
    if (!meeting || this.joined) return;
    this.joined = true;
    this.broken.clear();
    for (const peer of meeting.participants.joined.toArray()) this.addPeer(peer, false);
    const last = meeting.participants.lastActiveSpeaker;
    if (last && this.peers.has(last)) this.speaker = last;
    this.media = this.readMedia();
    this.readChat();
    this.applyDemand();
    // If the microphone never came up (no permission, no device), stop expecting it to.
    const settle = setTimeout(() => {
      this.micWas = !!meeting.self.audioEnabled;
      this.mediaSettled();
    }, MIC_SETTLE_MS);
    (settle as { unref?: () => void }).unref?.();
    this.teardown.push(() => clearTimeout(settle));
    this.self.changes.notify();
    this.statusChanged();
    this.rosterChanged();
    this.tilesChanged();
    this.emit("localMedia");
    this.emit("speakers");
  }

  /**
   * The SDK starts the microphone and camera in the background and does not always say when
   * they are up. Called at the moments that is likely to have happened.
   */
  private mediaSettled(): void {
    const next = this.readMedia();
    const last = this.media;
    if (last && last.microphone === next.microphone && last.camera === next.camera && last.screenShare === next.screenShare) return;
    this.media = next;
    this.self.changes.notify();
    this.emit("localMedia");
    this.tilesChanged();
  }

  private finish(reason: DisconnectReason): void {
    if (this.ended) return;
    this.ended = true;
    this.joined = false;
    this.attempt++;
    this.teardown.forEach((stop) => stop());
    this.teardown = [];
    this.peers.forEach((entry) => entry.stop());
    this.peers.clear();
    this.sounds.forEach((element) => element.remove());
    this.sounds.clear();
    this.audioSink?.remove();
    this.audioSink = null;
    this.speaker = null;
    this.statusChanged();
    this.rosterChanged();
    this.tilesChanged();
    this.emit("disconnected", reason);
  }

  /* ------------------------------------------------------------------ people */

  get local(): RtcParticipant {
    return this.self;
  }

  participants(): RtcParticipant[] {
    this.roster ??= [this.self, ...Array.from(this.peers.values(), (entry) => entry.person)];
    return this.roster;
  }

  remoteIds(): string[] {
    return Array.from(this.peers.values(), (entry) => entry.person.identity);
  }

  participant(identity: string): RtcParticipant | undefined {
    if (!identity) return undefined;
    if (identity === this.self.identity) return this.self;
    for (const entry of this.peers.values()) if (entry.person.identity === identity) return entry.person;
    return undefined;
  }

  /**
   * The host is whoever joined with the host preset, which only our server can hand out.
   * /api/host checks the caller's signed session again before acting on it.
   */
  get hostIdentity(): string | null {
    const meeting = this.meeting;
    if (!meeting) return null;
    const preset = this.grant.hostPreset;
    if (meeting.self.presetName ? meeting.self.presetName === preset : this.grant.role === "host") {
      return this.self.identity || null;
    }
    for (const { peer, person } of this.peers.values()) if (peer.presetName === preset) return person.identity;
    return null;
  }

  private rosterChanged(): void {
    this.roster = null;
    this.emit("roster");
    const host = this.hostIdentity;
    if (host !== this.lastHost) {
      this.lastHost = host;
      this.emit("host");
    }
  }

  private addPeer(peer: RTKParticipant, announce: boolean): void {
    if (this.peers.has(peer.id)) return;
    const person = new Person(
      false,
      () => ({
        identity: identityOf(peer),
        name: peer.name ?? "",
        micOn: !!peer.audioEnabled,
        camOn: !!peer.videoEnabled,
      }),
      () => this.speaker === peer.id && !!peer.audioEnabled,
    );
    person.camera = new RemoteCamera(peer);
    person.screen = new DirectVideo(
      () => peer.screenShareTracks?.video,
      (onChange) => {
        peer.on("screenShareUpdate", onChange);
        return () => {
          peer.off("screenShareUpdate", onChange);
        };
      },
    );

    let sharing = !!peer.screenShareEnabled;
    const onAudio = () => {
      this.playPeer(peer);
      person.changes.notify();
      if (this.speaker === peer.id) this.emit("speakers");
    };
    const onVideo = () => {
      person.changes.notify();
      this.tilesChanged();
    };
    const onScreen = () => {
      this.playPeer(peer);
      this.tilesChanged();
      const now = !!peer.screenShareEnabled;
      if (now !== sharing) {
        sharing = now;
        this.emit("screenShare", now);
      }
    };
    const onScore = ({ score }: { score: number }) => {
      const weak = score < WEAK_SCORE;
      if (weak === person.weak) return;
      person.weak = weak;
      person.changes.notify();
    };
    peer.on("audioUpdate", onAudio);
    peer.on("videoUpdate", onVideo);
    peer.on("screenShareUpdate", onScreen);
    peer.on("mediaScoreUpdate", onScore);
    const stop = () => {
      peer.off("audioUpdate", onAudio);
      peer.off("videoUpdate", onVideo);
      peer.off("screenShareUpdate", onScreen);
      peer.off("mediaScoreUpdate", onScore);
      this.stopSound(peer.id);
      this.stopSound(`screen:${peer.id}`);
    };
    this.peers.set(peer.id, { peer, person, stop });
    this.playPeer(peer);

    if (!announce) return;
    this.rosterChanged();
    this.tilesChanged();
    this.emit("participantJoined", person);
    // Someone who arrives later has not heard that your hand is up.
    if (this.self.hand) this.sendHand(true, [peer.id]).catch(() => {});
  }

  private removePeer(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    entry.stop();
    this.peers.delete(peerId);
    const wasSpeaker = this.speaker === peerId;
    if (wasSpeaker) this.speaker = null;
    this.rosterChanged();
    this.tilesChanged();
    if (wasSpeaker) this.emit("speakers");
    this.emit("participantLeft", entry.person);
  }

  /* ---------------------------------------------------------------- pictures */

  tiles(): RtcTile[] {
    if (this.tileList) return this.tileList;
    const meeting = this.meeting;
    const cameras: RtcTile[] = [];
    const screens: RtcTile[] = [];
    if (meeting) {
      const me = meeting.self;
      this.self.camera ??= new DirectVideo(
        () => this.meeting?.self.videoTrack,
        (onChange) => this.onSelf("videoUpdate", onChange),
      );
      this.self.screen ??= new DirectVideo(
        () => this.meeting?.self.screenShareTracks?.video,
        (onChange) => this.onSelf("screenShareUpdate", onChange),
      );
      cameras.push({
        participant: this.self,
        source: "camera",
        track: me.videoEnabled && me.videoTrack ? this.self.camera : undefined,
      });
      if (me.screenShareEnabled) screens.push({ participant: this.self, source: "screen_share", track: this.self.screen });
    } else {
      cameras.push({ participant: this.self, source: "camera" });
    }
    for (const { peer, person } of this.peers.values()) {
      // No track means the SDK is not receiving this camera (it is outside the active set), or
      // it is off. Either way the tile shows the avatar.
      cameras.push({
        participant: person,
        source: "camera",
        track: peer.videoEnabled && peer.videoTrack ? person.camera : undefined,
      });
      if (peer.screenShareEnabled) screens.push({ participant: person, source: "screen_share", track: person.screen });
    }
    return (this.tileList = [...cameras, ...screens]);
  }

  private tilesChanged(): void {
    this.tileList = null;
    this.emit("tiles");
  }

  /**
   * RealtimeKit streams video only for its "active" set and unsubscribes everyone else, so
   * demand is expressed as the size of that set: what is on screen, you, and a little headroom.
   * Who fills it is the SDK's choice (recent speakers, then join order). Audio is unaffected.
   */
  setVideoDemand(visibleRemoteIdentities: string[]): void {
    this.demand = visibleRemoteIdentities.length;
    this.applyDemand();
  }

  private applyDemand(): void {
    const meeting = this.meeting;
    if (!meeting || !this.joined || this.demand === null) return;
    const wanted = Math.min(MAX_ACTIVE, Math.max(2, this.demand + 1 + DEMAND_HEADROOM));
    try {
      if (meeting.participants.maxActiveParticipantsCount !== wanted) {
        meeting.participants.setMaxActiveParticipantsCount(wanted);
      }
    } catch {
      // The SDK's own default stays in force.
    }
  }

  /* ------------------------------------------------------------------- sound */

  /** RealtimeKit reports one active speaker at a time, and only when it changes. */
  activeSpeakers(): string[] {
    const entry = this.speaker ? this.peers.get(this.speaker) : undefined;
    return entry && entry.peer.audioEnabled ? [entry.person.identity] : [];
  }

  get audioBlocked(): boolean {
    return this.blocked;
  }

  async startAudio(): Promise<void> {
    await Promise.all(Array.from(this.sounds.values(), (element) => element.play()));
    this.setBlocked(false);
  }

  private setBlocked(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    this.emit("audio");
  }

  /** The SDK hands over tracks, not sound: each one needs an element of its own to be heard. */
  private playPeer(peer: RTKParticipant): void {
    this.playSound(peer.id, peer.audioEnabled ? peer.audioTrack : undefined);
    this.playSound(`screen:${peer.id}`, peer.screenShareEnabled ? peer.screenShareTracks?.audio : undefined);
  }

  private playSound(key: string, track: MediaStreamTrack | undefined): void {
    if (!track) return this.stopSound(key);
    let element = this.sounds.get(key);
    if (!element) {
      if (!this.audioSink) {
        this.audioSink = document.createElement("div");
        this.audioSink.style.display = "none";
        this.audioSink.dataset.callAudio = "";
        document.body.append(this.audioSink);
      }
      element = document.createElement("audio");
      element.autoplay = true;
      if (this.outputDevice) this.routeSound(element, this.outputDevice);
      this.audioSink.append(element);
      this.sounds.set(key, element);
    }
    const current = element.srcObject instanceof MediaStream ? element.srcObject.getTracks()[0] : undefined;
    if (current?.id === track.id) return;
    element.srcObject = new MediaStream([track]);
    element.play().catch((error: unknown) => {
      if (error instanceof Error && error.name === "NotAllowedError") this.setBlocked(true);
    });
  }

  private stopSound(key: string): void {
    const element = this.sounds.get(key);
    if (!element) return;
    element.srcObject = null;
    element.remove();
    this.sounds.delete(key);
  }

  private routeSound(element: HTMLAudioElement, deviceId: string): void {
    const sink = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    sink.setSinkId?.(deviceId).catch(() => {});
  }

  /* ------------------------------------------------------------ your devices */

  private readMedia(): LocalMedia {
    const me = this.meeting?.self;
    return { microphone: !!me?.audioEnabled, camera: !!me?.videoEnabled, screenShare: !!me?.screenShareEnabled };
  }

  localMedia(): LocalMedia {
    return (this.media ??= this.readMedia());
  }

  async setEnabled(source: LocalSource, enabled: boolean): Promise<void> {
    const me = this.meeting?.self;
    if (!me || !this.joined) throw new Error("Not connected.");
    if (source === "microphone") await (enabled ? me.enableAudio() : me.disableAudio());
    else if (source === "camera") await (enabled ? me.enableVideo() : me.disableVideo());
    else await (enabled ? me.enableScreenShare() : me.disableScreenShare());
    // The SDK reports a refused permission as an event, not a rejection: check what happened.
    const now = this.readMedia();
    const actual = source === "microphone" ? now.microphone : source === "camera" ? now.camera : now.screenShare;
    if (actual !== enabled) throw new Error(`Could not ${enabled ? "start" : "stop"} your ${source.replace("_", " ")}.`);
  }

  activeDevice(kind: DeviceKind): string | undefined {
    if (kind === "audiooutput" && this.outputDevice) return this.outputDevice;
    try {
      return this.meeting?.self.getCurrentDevices()[SDK_KIND[kind]]?.deviceId || undefined;
    } catch {
      return undefined;
    }
  }

  async setDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    const me = this.meeting?.self;
    if (!me) throw new Error("Not connected.");
    if (kind === "audiooutput") {
      // Sound comes out of our own elements, so they are what has to be re-routed.
      this.outputDevice = deviceId;
      this.sounds.forEach((element) => this.routeSound(element, deviceId));
      this.emit("device", kind);
      return;
    }
    const device = await me.getDeviceById(deviceId, SDK_KIND[kind]);
    if (!device) throw new Error("That device is no longer available.");
    await me.setDevice(device);
    this.emit("device", kind);
  }

  /* ---------------------------------------------------------- chat and hands */

  private readChat(): void {
    const meeting = this.meeting;
    if (!meeting) return;
    const me = meeting.self;
    const people = new Map<string, string>();
    for (const { peer, person } of this.peers.values()) people.set(peer.userId, person.identity);
    const messages: RtcChatMessage[] = [];
    for (const message of meeting.chat.messages) {
      // Images and files cannot be sent from Meetly; anything that is not plain text is skipped.
      const text = (message as { message?: unknown }).message;
      if ((message.type as string) !== "text" || typeof text !== "string") continue;
      const own = message.userId === me.userId;
      messages.push({
        id: message.id,
        timestamp: message.timeMs ?? new Date(message.time).getTime(),
        message: text,
        from: {
          identity: own ? this.self.identity : (people.get(message.userId) ?? message.userId),
          name: message.displayName ?? "",
          isLocal: own,
        },
      });
    }
    this.messages = messages;
  }

  chatMessages(): RtcChatMessage[] {
    return this.messages;
  }

  get chatSending(): boolean {
    return this.sending;
  }

  async sendChat(text: string): Promise<void> {
    const meeting = this.meeting;
    if (!meeting || !this.joined) throw new Error("Not connected.");
    this.sending = true;
    this.emit("chat");
    try {
      await meeting.chat.sendTextMessage(text);
    } finally {
      this.sending = false;
      this.emit("chat");
    }
  }

  private sendHand(raised: boolean, to?: string[]): Promise<void> {
    const meeting = this.meeting;
    if (!meeting || !this.joined) return Promise.reject(new Error("Not connected."));
    const payload = { peerId: meeting.self.id, raised };
    return meeting.participants.broadcastMessage(HAND_MESSAGE, payload, to && { participantIds: to });
  }

  async setHandRaised(raised: boolean): Promise<void> {
    if (raised !== this.self.hand) {
      this.self.hand = raised;
      this.self.changes.notify();
      this.rosterChanged();
      if (raised) this.emit("handRaised", this.self);
    }
    await this.sendHand(raised);
  }

  /* ------------------------------------------------------------------ events */

  private onSelf(event: "videoUpdate" | "screenShareUpdate", listener: () => void): () => void {
    const me = this.meeting?.self;
    if (!me) return () => {};
    me.on(event, listener);
    return () => {
      me.off(event, listener);
    };
  }

  private listen(meeting: Meeting): void {
    const { self, participants, chat, meta } = meeting;
    const stops = this.teardown;
    // The SDK's emitters are typed per class; this keeps one subscribe-and-remember helper for all.
    type Handler = (...args: never[]) => void;
    type Source = { on(event: string, fn: Handler): unknown; off(event: string, fn: Handler): unknown };
    const on = <A extends unknown[]>(source: unknown, event: string, fn: (...args: A) => void) => {
      const handler = fn as unknown as Handler;
      (source as Source).on(event, handler);
      stops.push(() => (source as Source).off(event, handler));
    };

    const part = (name: string, down: boolean) => {
      if (down) this.broken.add(name);
      else this.broken.delete(name);
      this.statusChanged();
    };

    on(self, "roomJoined", () => {
      this.broken.delete("room");
      if (this.joined) this.statusChanged();
      else if (this.meeting === meeting && !this.ended) this.onJoined();
    });
    on(self, "roomLeft", ({ state }: { state: string }) => {
      // "disconnected" is the SDK losing the room while it keeps trying to get back in.
      if (state === "disconnected") return part("room", true);
      this.finish(state === "kicked" ? "removed" : state === "left" ? "left" : "dropped");
    });
    on(meta, "socketConnectionUpdate", ({ state }: { state: string }) => {
      if (state === "connected") part("socket", false);
      else if (state === "reconnecting" || state === "disconnected") part("socket", true);
    });
    on(meta, "mediaConnectionUpdate", ({ transport, state }: { transport: string; state: string }) => {
      if (state === "connected") part(transport, false);
      else if (state === "reconnecting" || state === "disconnected" || state === "failed") part(transport, true);
    });

    let sharing = !!self.screenShareEnabled;
    const mediaChanged = () => {
      const next = this.readMedia();
      const last = this.media;
      if (last && last.microphone === next.microphone && last.camera === next.camera && last.screenShare === next.screenShare) return;
      this.media = next;
      this.self.changes.notify();
      this.emit("localMedia");
    };
    on(self, "audioUpdate", () => {
      mediaChanged();
      const now = !!self.audioEnabled;
      if (now === this.micWas) return;
      this.micWas = now;
      // Joining with the microphone on is not a toggle; nothing before `joined` is reported.
      if (this.joined) this.emit("localMic", now);
    });
    on(self, "videoUpdate", () => {
      mediaChanged();
      this.tilesChanged();
    });
    on(self, "screenShareUpdate", () => {
      mediaChanged();
      this.tilesChanged();
      const now = !!self.screenShareEnabled;
      if (now === sharing) return;
      sharing = now;
      this.emit("screenShare", now);
    });
    on(self, "deviceUpdate", ({ device }: { device: MediaDeviceInfo }) => {
      if (device.kind !== "audiooutput") this.emit("device", device.kind);
      this.mediaSettled();
    });
    on(self, "mediaPermissionUpdate", () => this.mediaSettled());
    on(self, "mediaScoreUpdate", ({ score }: { score: number }) => {
      const weak = score < WEAK_SCORE;
      if (weak === this.self.weak) return;
      this.self.weak = weak;
      this.self.changes.notify();
    });

    on(participants.joined, "participantJoined", (peer: RTKParticipant) => {
      if (this.joined) this.addPeer(peer, true);
    });
    on(participants.joined, "participantLeft", (peer: RTKParticipant) => this.removePeer(peer.id));
    on(participants.joined, "participantsCleared", () => {
      for (const peerId of Array.from(this.peers.keys())) this.removePeer(peerId);
    });
    // Entering or leaving the active set is when a camera starts or stops being received.
    on(participants.active, "participantJoined", () => this.tilesChanged());
    on(participants.active, "participantLeft", () => this.tilesChanged());

    on(participants, "activeSpeaker", ({ peerId }: { peerId: string }) => {
      if (peerId === this.speaker) return;
      const previous = this.speaker ? this.peers.get(this.speaker) : undefined;
      this.speaker = this.peers.has(peerId) ? peerId : null;
      previous?.person.changes.notify();
      this.peers.get(peerId)?.person.changes.notify();
      this.emit("speakers");
    });
    on(participants, "broadcastedMessage", ({ type, payload }: { type: string; payload: Record<string, unknown> }) => {
      if (type !== HAND_MESSAGE) return;
      const entry = typeof payload.peerId === "string" ? this.peers.get(payload.peerId) : undefined;
      const raised = payload.raised === true;
      if (!entry || entry.person.hand === raised) return;
      entry.person.hand = raised;
      entry.person.changes.notify();
      this.rosterChanged();
      if (raised) this.emit("handRaised", entry.person);
    });

    on(chat, "chatUpdate", () => {
      this.readChat();
      this.emit("chat");
    });
  }
}

export function createCall(grant: JoinGrant, choices: JoinChoices): RtcCall {
  if (grant.provider !== "realtimekit") throw new Error("This build is set up for RealtimeKit.");
  return new RealtimeKitCall(grant, choices, async (options) => {
    const { default: RealtimeKit } = await import("@cloudflare/realtimekit");
    return RealtimeKit.init(options);
  });
}
