import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { AudioMiddleware, RTKParticipant, StageStatus, VideoMiddleware } from "@cloudflare/realtimekit";
import { BlurRenderer, blurUnavailable, watchFrameRate, type BlurStrength } from "../effects/blur";
import { createNoiseNode, noiseFilterSupported } from "../effects/noise";
import { Notifier, RtcEmitter } from "./emitter";
import { VoiceMeter } from "./voice";
import {
  REACTION_MESSAGE,
  SAVER_FPS,
  SAVER_HEIGHT,
  SAVER_WIDTH,
  bulkError,
  checkNewPoll,
  createReactionLimits,
  isReaction,
  postHost,
  withSince,
  type HostApi,
  notice,
} from "./shared";
import { RealtimeKitStage, stageRole } from "./stage.realtimekit";
import { POLL_LIMITS } from "./types";
import type {
  BackgroundMode,
  CallMode,
  CallQuality,
  CallStats,
  ConnectionStatus,
  DeviceKind,
  DisconnectReason,
  HostAction,
  JoinAccess,
  JoinChoices,
  JoinGrant,
  LocalEffects,
  LocalMedia,
  LocalSource,
  NewPoll,
  ParticipantRole,
  RtcCall,
  RtcChatMessage,
  RtcLocalParticipant,
  RtcParticipant,
  RtcPoll,
  RtcTile,
  RtcVideoTrack,
  RtcWaiter,
} from "./types";

type Meeting = RealtimeKitClient;
type Grant = Extract<JoinGrant, { provider: "realtimekit" }>;

/** How the meeting object is obtained. Tests pass a stand-in; the app loads the SDK. */
export type MeetingFactory = (options: {
  authToken: string;
  defaults: {
    audio: boolean;
    video: boolean;
    /** How the microphone is opened. The spelling is the SDK's. */
    mediaConfiguration: { audio: { noiseSupression: boolean; echoCancellation: boolean; autoGainControl: boolean } };
  };
}) => Promise<Meeting>;

/** A frame painter: what `BlurRenderer` (src/lib/effects/blur.ts) looks like from here. */
type Blur = {
  strength: BlurStrength;
  frames: number;
  draw(source: CanvasImageSource, width: number, height: number, target: CanvasRenderingContext2D): void;
};

/**
 * Noise suppression and background blur, which run in the browser and belong to no provider
 * (src/lib/effects). Tests pass stand-ins; the app uses the real ones.
 */
export type Effects = {
  blurUnavailable(): string | null;
  createBlur(strength: BlurStrength): Promise<Blur>;
  watchFrameRate(frames: () => number, onSlow: () => void): { stop(): void };
  noiseSupported(): boolean;
  createNoiseNode(context: AudioContext): Promise<AudioWorkletNode>;
};

const browserEffects: Effects = {
  blurUnavailable: () => (typeof document === "undefined" ? "This browser can't blur the background." : blurUnavailable()),
  createBlur: (strength) => BlurRenderer.create(strength),
  watchFrameRate,
  noiseSupported: noiseFilterSupported,
  createNoiseNode,
};

/** Broadcast message type that carries a raised or lowered hand. RealtimeKit has no built-in one. */
export const HAND_MESSAGE = "meetly-hand";
/**
 * Broadcasts between Meetly clients about moderation. RealtimeKit does not say who sent a
 * broadcast, so none of these is taken as proof of anything: the first only makes clients ask
 * our server again, the second concerns hands, which are a courtesy between clients already, and
 * the third only chooses the wording of the goodbye screen.
 */
/** Co-hosts, join access or the pinned chat message changed: ask the server what they are now. */
export const ROLES_MESSAGE = "meetly-roles";
/** A host lowered hands: `{ all: true }` or `{ peerIds: [...] }`. */
export const LOWER_MESSAGE = "meetly-lower-hands";
/** The host is about to end the call for everyone. */
export const ENDING_MESSAGE = "meetly-ending";
/** How long after that message being disconnected counts as the call having been ended. */
const ENDING_WINDOW_MS = 15_000;
/** Media scores run 0 to 10; below this the connection is shown as weak. */
export const WEAK_SCORE = 5;
/** The SDK accepts at most this many participants in its active set, you included. */
export const MAX_ACTIVE = 24;
/**
 * Kept subscribed beyond what is on screen. The SDK picks who is active (recent speakers first)
 * and the stage picks who is visible; a little headroom keeps the two from disagreeing.
 */
export const DEMAND_HEADROOM = 2;
/** Below this (and at or above `WEAK_SCORE`) your own connection is "fair" rather than "good". */
export const FAIR_SCORE = 7;
/** How long RealtimeKit is given to say a vote was counted before the voter is told it was not. */
const VOTE_WAIT_MS = 6000;

/** What comes with a media score. The fields are the SDK's; which are present depends on the kind of stream. */
type ScoreStats = {
  bitrate?: number;
  packetsLostPercentage?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
};
/** The payload of `mediaScoreUpdate`, on yourself and on other people. */
type ScoreUpdate = { kind: string; isScreenshare?: boolean; score: number; scoreStats?: ScoreStats };

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

class Person implements RtcLocalParticipant {
  readonly isLocal: boolean;
  readonly changes = new Notifier();
  readonly subscribe = this.changes.subscribe;
  weak = false;
  hand = false;
  camera?: RtcVideoTrack;
  screen?: RtcVideoTrack;
  private readonly read: () => { identity: string; name: string; micOn: boolean; camOn: boolean };
  private readonly isSpeaking: () => boolean;
  /** The call's `hostIdentity`, as last announced. */
  private readonly hostOf: () => string | null;
  /** Webinars: their stage status, and (for you) whether an invitation is waiting for an answer. */
  private readonly stage: { mode: CallMode; status: () => StageStatus | undefined; invited?: () => boolean };

  constructor(isLocal: boolean, read: Person["read"], isSpeaking: () => boolean, hostOf: () => string | null, stage: Person["stage"]) {
    this.isLocal = isLocal;
    this.read = read;
    this.isSpeaking = isSpeaking;
    this.hostOf = hostOf;
    this.stage = stage;
  }
  /** In a meeting everyone but the host is a speaker; in a webinar, see src/lib/rtc/stage.realtimekit.ts. */
  get role(): ParticipantRole {
    const identity = this.identity;
    return identity && identity === this.hostOf() ? "host" : stageRole(this.stage.mode, this.stage.status());
  }
  get stageInvite(): boolean {
    return this.stage.invited?.() ?? false;
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
/** The voice meter's key for your own microphone; peer ids are the keys for everyone else. */
const SELF_VOICE = "self";

const identityOf = (peer: { customParticipantId?: string; userId: string; id: string }) =>
  peer.customParticipantId || peer.userId || peer.id;

export class RealtimeKitCall extends RtcEmitter implements RtcCall {
  readonly provider = "realtimekit" as const;
  readonly mode: CallMode;

  private readonly grant: Grant;
  private readonly choices: JoinChoices;
  private readonly factory: MeetingFactory;
  private readonly api: HostApi;
  private readonly effects: Effects;
  private readonly limits = createReactionLimits();
  private fx: LocalEffects;
  private blur: Blur | null = null;
  private blurMiddleware: VideoMiddleware | null = null;
  private blurWatch: { stop(): void } | null = null;
  private noiseMiddleware: AudioMiddleware | null = null;
  /** Our filter is in the SDK's audio path right now (as opposed to having been asked for). */
  private noiseFiltering = false;
  /** Changes to the effects run one after another, never interleaved. */
  private effectsQueue: Promise<void> = Promise.resolve();
  /** Id of the pinned chat message, as our server recorded it. */
  private pinId: string | null;
  private pinned: RtcChatMessage | null = null;
  /** Messages that were already there when you joined. */
  private history = new Set<string>();
  /** What is left of messages deleted while you were here, by id. */
  private readonly removed = new Map<string, RtcChatMessage>();
  private cohosts: string[];
  private gate: JoinAccess;
  /** Reactions allowed, as our server recorded it: at the moment of joining, and again whenever a client says it changed. */
  private reactionsOn: boolean;
  /** You asked to join and are in RealtimeKit's waiting room. */
  private waitlisted = false;
  private waiters: RtcWaiter[] = [];
  /** When this browser first saw each person in `waiters` asking. RealtimeKit does not say when they started. */
  private readonly knocks = new Map<string, number>();
  private endingAt = -Infinity;

  private meeting: Meeting | null = null;
  private attempt = 0;
  private joined = false;
  private ended = false;
  /** Parts of the connection that are currently down: "socket", "send", "recv", "room". */
  private readonly broken = new Set<string>();
  private lastStatus: ConnectionStatus = "disconnected";

  private readonly self: Person;
  /** Webinars: RealtimeKit's stage (see ./stage.realtimekit.ts). */
  private readonly stage: RealtimeKitStage;
  /** Keyed by peer id, the SDK's per-session id. */
  private readonly peers = new Map<string, { peer: RTKParticipant; person: Person; stop: () => void }>();
  private roster: RtcParticipant[] | null = null;
  private tileList: RtcTile[] | null = null;
  private media: LocalMedia | null = null;
  private messages: RtcChatMessage[] = [];
  private sending = false;
  private speaker: string | null = null;
  /**
   * Who is talking, heard from the tracks themselves. The SDK's own signal names one person,
   * only when that changes, and never you, so it is the fallback where audio cannot be analysed.
   */
  private voice: VoiceMeter | null = null;
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
  /**
   * Polls a host or co-host ended, as our server recorded it. RealtimeKit has no such thing: it
   * goes on accepting votes for as long as the meeting lasts. This client stops offering an ended
   * poll and stops sending votes for it; it cannot stop somebody else's modified client sending
   * one, and Cloudflare would count it.
   */
  private closedPolls: Set<string>;
  private pollList: RtcPoll[] = [];
  private pollsSeen = "[]";
  /** What you chose, kept for anonymous polls, where RealtimeKit says that you voted but not for what. */
  private readonly myChoices = new Map<string, number>();
  private health: CallQuality = { connection: "unknown", dataSaver: false };
  private saver = false;
  /** The latest scores RealtimeKit gave your own microphone and camera (0 to 10), and what came with them. */
  private scores: { audio?: number; video?: number } = {};
  private sent: { audio?: ScoreStats; video?: ScoreStats } = {};
  /** Bits a second arriving, per stream, as last reported. */
  private readonly receiving = new Map<string, number>();
  /** What the camera was capturing before "use less data" made it smaller, and which track that was done to. */
  private fullCapture: { width: number; height: number; frameRate: number } | null = null;
  private savedTrack: string | null = null;

  constructor(
    grant: Grant,
    choices: JoinChoices,
    factory: MeetingFactory,
    api: HostApi = postHost,
    effects: Effects = browserEffects,
  ) {
    super();
    this.grant = grant;
    this.choices = choices;
    this.factory = factory;
    this.api = api;
    this.effects = effects;
    this.mode = grant.mode ?? "meeting";
    this.cohosts = grant.coHosts ?? [];
    this.gate = grant.access ?? "open";
    this.pinId = grant.pin ?? null;
    this.closedPolls = new Set(grant.closedPolls ?? []);
    this.reactionsOn = grant.reactions !== false;
    const unavailable = effects.blurUnavailable();
    this.fx = {
      noiseSuppression: choices.noiseSuppression !== false,
      noiseState: "off",
      background: unavailable ? "none" : (choices.background ?? "none"),
      backgroundState: "off",
      ...(unavailable ? { backgroundUnavailable: unavailable } : {}),
    };
    this.micWas = choices.audioEnabled;
    this.stage = new RealtimeKitStage(this.mode, () => this.stageChanged());
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
      () => !!this.meeting?.self.audioEnabled && !!this.voice?.speaking(SELF_VOICE),
      () => this.lastHost,
      {
        mode: this.mode,
        status: () => this.meeting?.stage?.status,
        invited: () => this.stage.invited(this.meeting, this.isHost()),
      },
    );
  }

  /** You hold the host's preset (or, before the SDK says, our server made you host). */
  private isHost(): boolean {
    const me = this.meeting?.self;
    return me?.presetName ? me.presetName === this.grant.hostPreset : this.grant.role === "host";
  }

  /** Webinars: somebody's stage status, or your invitation, changed. */
  private stageChanged(): void {
    if (this.mode !== "webinar") return;
    this.self.changes.notify();
    this.rosterChanged();
    this.tilesChanged();
    this.emit("stage");
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
    if (!this.joined) return this.waitlisted ? "waiting" : "connecting";
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
        defaults: {
          audio: audioEnabled,
          video: videoEnabled,
          // The browser's own noise suppression, underneath ours. It is fixed when the
          // microphone is opened, so it follows what was chosen before joining.
          mediaConfiguration: {
            audio: { noiseSupression: this.fx.noiseSuppression, echoCancellation: true, autoGainControl: true },
          },
        },
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
      if (this.fx.background !== "none" && videoEnabled) {
        // Before joining, so the room never sees a frame of what was meant to be hidden. If blur
        // cannot start, the camera goes off rather than out as it is.
        await this.queued(() => this.syncBackground()).catch(async () => {
          await Promise.resolve(meeting.self.disableVideo()).catch(() => {});
          this.fail(notice("Background blur couldn't start, so your camera was left off. Turn it on to be seen without blur."));
        });
        if (!current()) return void (await meeting.leave().catch(() => {}));
      }
      await meeting.join();
      if (!current()) {
        await meeting.leave().catch(() => {});
        return;
      }
      // With a waiting room, join() can leave you outside: `roomJoined` follows once a host lets you in.
      if (meeting.self.roomState === "waitlisted") this.onWaitlisted();
      else this.onJoined();
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

  private onWaitlisted(): void {
    if (this.joined || this.waitlisted) return;
    this.waitlisted = true;
    this.statusChanged();
  }

  private onJoined(): void {
    const meeting = this.meeting;
    if (!meeting || this.joined) return;
    this.joined = true;
    this.waitlisted = false;
    this.broken.clear();
    if (VoiceMeter.available()) this.voice ??= new VoiceMeter(this.voiceChanged);
    for (const peer of meeting.participants.joined.toArray()) this.addPeer(peer, false);
    const last = meeting.participants.lastActiveSpeaker;
    if (last && this.peers.has(last)) this.speaker = last;
    this.listenToSelf();
    this.media = this.readMedia();
    this.history = new Set(meeting.chat.messages.map((message) => message.id));
    this.removed.clear();
    this.readChat();
    // After joining, so that loading the filter never holds the call up.
    void this.queued(() => this.syncNoise());
    this.applyDemand();
    this.readWaiters();
    this.readPolls();
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
    // Webinars: the host takes the stage. Failing to is said, since nobody would see or hear them.
    this.stage.joined(meeting, this.isHost()).catch(() => this.fail(notice("Couldn't put you on stage. Leave and rejoin the webinar.")));
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
    this.waitlisted = false;
    this.waiters = [];
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
    this.voice?.stop();
    this.voice = null;
    // The SDK drops its middlewares with the meeting; the conversation is kept for the goodbye screen.
    this.blurWatch?.stop();
    this.blurWatch = null;
    this.blur = null;
    this.blurMiddleware = null;
    this.noiseMiddleware = null;
    this.noiseFiltering = false;
    this.setFx({ noiseState: "off", backgroundState: "off" });
    this.scores = {};
    this.sent = {};
    this.receiving.clear();
    this.fullCapture = null;
    this.savedTrack = null;
    this.readQuality();
    this.statusChanged();
    this.rosterChanged();
    this.tilesChanged();
    this.emit("disconnected", reason);
  }

  /* ------------------------------------------------------------------ people */

  get local(): RtcLocalParticipant {
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
    if (this.isHost()) return this.self.identity || null;
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

  /** As our server recorded them: at the moment of joining, and again whenever a client says they changed. */
  coHosts(): string[] {
    return this.cohosts;
  }

  get access(): JoinAccess {
    return this.gate;
  }

  /**
   * Both depend on the presets the app was given: letting people in from the waiting room and
   * stopping a camera are done by RealtimeKit itself, for participants whose preset allows it.
   */
  get supports(): { askToJoin: boolean; stopCamera: boolean; polls: boolean; createPolls: boolean } {
    const permissions = this.meeting?.self.permissions;
    return {
      askToJoin: !!this.grant.canAsk && !!permissions?.acceptWaitingRequests,
      stopCamera: !!permissions?.canDisableParticipantVideo,
      // RealtimeKit's own polls: each preset says whether its holders see them, vote and start them.
      polls: !!permissions?.polls?.canView,
      createPolls: !!permissions?.polls?.canCreate,
    };
  }

  waiting(): RtcWaiter[] {
    return this.waiters;
  }

  get reactionsAllowed(): boolean {
    return this.reactionsOn;
  }

  /** While reactions are off, the host and co-hosts can still send them. */
  private maySendReactions(identity: string): boolean {
    return this.reactionsOn || (!!identity && (identity === this.hostIdentity || this.cohosts.includes(identity)));
  }

  /** RealtimeKit's waiting room, as far as your preset lets you answer it. */
  private readWaiters(): void {
    const meeting = this.meeting;
    const allowed = !!meeting && this.joined && !!meeting.self.permissions?.acceptWaitingRequests;
    const asking = allowed ? meeting.participants.waitlisted.toArray().map((p) => ({ id: p.id, name: p.name ?? "" })) : [];
    const next = withSince(asking, this.knocks);
    if (next.length === 0 && this.waiters.length === 0) return;
    this.waiters = next;
    this.emit("waiting");
  }

  private async refreshRoles(): Promise<void> {
    const data = await this.api({ session: this.grant.session, action: "roles" });
    const coHosts = Array.isArray(data.coHosts) ? data.coHosts.filter((id): id is string => typeof id === "string") : [];
    const access: JoinAccess = data.access === "ask" || data.access === "locked" ? data.access : "open";
    const pin = typeof data.pin === "string" ? data.pin : null;
    const closed = Array.isArray(data.closedPolls) ? data.closedPolls.filter((id): id is string => typeof id === "string") : [];
    const reactions = data.reactions !== false;
    if (reactions !== this.reactionsOn) {
      this.reactionsOn = reactions;
      this.emit("reactionsAllowed");
    }
    if (closed.slice().sort().join() !== Array.from(this.closedPolls).sort().join()) {
      this.closedPolls = new Set(closed);
      this.readPolls();
    }
    if (pin !== this.pinId) {
      this.pinId = pin;
      this.readChat();
      this.emit("chat");
    }
    if (coHosts.join() !== this.cohosts.join()) {
      this.cohosts = coHosts;
      this.emit("host");
    }
    if (access !== this.gate) {
      this.gate = access;
      this.emit("access");
    }
  }

  private tell(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const meeting = this.meeting;
    if (!meeting || !this.joined) return Promise.resolve();
    return meeting.participants.broadcastMessage(type, { ...payload, peerId: meeting.self.id }).catch(() => {});
  }

  private peerOf(identity: string): RTKParticipant | undefined {
    for (const { peer, person } of this.peers.values()) if (person.identity === identity) return peer;
    return undefined;
  }

  /**
   * Our server decides whether the caller may (it reads the caller's role from the records, not
   * from this client), and carries out what Cloudflare's REST API can do: mute, remove, mute
   * all, end, co-hosts, access. The rest has no REST call and is done from here once the server
   * has said yes: RealtimeKit checks the caller's preset for the waiting room and for stopping a
   * camera; lowering hands is a message between clients, as raising one is.
   */
  async moderate(action: HostAction): Promise<void> {
    const meeting = this.meeting;
    if (!meeting || !this.joined) throw new Error("You're not connected right now. Try again in a moment.");
    if (action.action === "stage") {
      return this.stage.act(meeting, action, {
        self: this.self.identity,
        peerOf: (identity) => this.peerOf(identity),
        authorize: () => this.api({ session: this.grant.session, ...action }),
      });
    }
    if (action.action === "admitAll" || action.action === "denyAll") {
      // One request to our server however many are waiting; then the waiting room is answered
      // from here. Anyone who stopped asking in the meantime is left out: that is not a failure.
      await this.api({ session: this.grant.session, ...action });
      const present = new Set(meeting.participants.waitlisted.toArray().map((p) => p.id));
      const asking = action.identities.filter((id) => present.has(id));
      if (asking.length === 0) return;
      if (action.action === "admitAll") {
        // RealtimeKit lets everyone in with one message; it does not say who, if anyone, it missed.
        // Some builds of the SDK return nothing here rather than a promise; `await` takes either.
        try {
          await meeting.participants.acceptAllWaitingRoomRequest(asking);
        } catch {
          throw bulkError("admit", asking);
        }
        return;
      }
      const failed: string[] = [];
      for (const id of asking) await meeting.participants.rejectWaitingRoomRequest(id).catch(() => failed.push(id));
      if (failed.length > 0) throw bulkError("deny", failed);
      return;
    }
    // Sent first: afterwards there is nobody left to tell.
    if (action.action === "end") await this.tell(ENDING_MESSAGE);
    await this.api({ session: this.grant.session, ...action });
    switch (action.action) {
      case "coHost":
      case "access":
      case "remove":
      case "pin":
      case "closePoll":
      case "reactions":
        await this.refreshRoles().catch(() => {});
        await this.tell(ROLES_MESSAGE);
        break;
      case "lowerHand": {
        const peer = this.peerOf(action.identity);
        if (peer) await this.tell(LOWER_MESSAGE, { peerIds: [peer.id] });
        break;
      }
      case "lowerAllHands":
        await this.tell(LOWER_MESSAGE, { all: true });
        break;
      case "stopCamera": {
        const peer = this.peerOf(action.identity);
        if (!peer) throw new Error("That person may have already left.");
        await peer.disableVideo();
        break;
      }
      case "admit":
        meeting.participants.acceptWaitingRoomRequest(action.identity);
        break;
      case "deny":
        await meeting.participants.rejectWaitingRoomRequest(action.identity);
        break;
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
      () => !!peer.audioEnabled && (this.voice ? this.voice.speaking(peer.id) : this.speaker === peer.id),
      () => this.lastHost,
      { mode: this.mode, status: () => peer.stageStatus },
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
    const onScore = ({ kind, isScreenshare, score, scoreStats }: ScoreUpdate) => {
      const bitrate = scoreStats?.bitrate;
      if (typeof bitrate === "number") this.receiving.set(`${peer.id}:${kind}:${!!isScreenshare}`, bitrate);
      const weak = score < WEAK_SCORE;
      if (weak === person.weak) return;
      person.weak = weak;
      person.changes.notify();
    };
    peer.on("audioUpdate", onAudio);
    peer.on("videoUpdate", onVideo);
    peer.on("screenShareUpdate", onScreen);
    peer.on("mediaScoreUpdate", onScore);
    // Webinars: coming on stage, or going back to the audience. Statuses arrive with the
    // participant and with this event; nobody is asked who is on stage.
    const onStage = () => this.stageChanged();
    if (this.mode === "webinar") peer.on("stageStatusUpdate", onStage);
    const stop = () => {
      peer.off("stageStatusUpdate", onStage);
      peer.off("audioUpdate", onAudio);
      peer.off("videoUpdate", onVideo);
      peer.off("screenShareUpdate", onScreen);
      peer.off("mediaScoreUpdate", onScore);
      this.stopSound(peer.id);
      this.stopSound(`screen:${peer.id}`);
      this.voice?.set(peer.id, undefined);
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
    for (const key of Array.from(this.receiving.keys())) if (key.startsWith(`${peerId}:`)) this.receiving.delete(key);
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
    return (this.tileList = [...cameras, ...screens].filter((tile) => tile.participant.role !== "viewer"));
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
    // While saving data nothing extra is kept flowing just in case.
    const wanted = Math.min(MAX_ACTIVE, Math.max(2, this.demand + 1 + (this.saver ? 0 : DEMAND_HEADROOM)));
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
    if (this.voice) {
      const me = this.meeting?.self;
      return this.voice
        .loudest()
        .map((key) => (key === SELF_VOICE ? (me?.audioEnabled ? this.self.identity : undefined) : this.peers.get(key)?.person.identity))
        .filter((identity): identity is string => !!identity);
    }
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

  /** Your own microphone is metered too, so your tile shows when you are heard. */
  private listenToSelf(): void {
    const me = this.meeting?.self;
    this.voice?.set(SELF_VOICE, this.joined && me?.audioEnabled ? me.audioTrack : undefined);
  }

  private readonly voiceChanged = (key: string): void => {
    (key === SELF_VOICE ? this.self : this.peers.get(key)?.person)?.changes.notify();
    this.emit("speakers");
  };

  /** The SDK hands over tracks, not sound: each one needs an element of its own to be heard. */
  private playPeer(peer: RTKParticipant): void {
    const voice = peer.audioEnabled ? peer.audioTrack : undefined;
    this.playSound(peer.id, voice);
    this.voice?.set(peer.id, voice);
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
    if (!me || !this.joined) throw new Error("You're not connected right now. Try again in a moment.");
    if (source === "microphone") await (enabled ? me.enableAudio() : me.disableAudio());
    else if (source === "camera") await (enabled ? me.enableVideo() : me.disableVideo());
    else await (enabled ? me.enableScreenShare() : me.disableScreenShare());
    // The SDK reports a refused permission as an event, not a rejection: check what happened.
    const now = this.readMedia();
    const actual = source === "microphone" ? now.microphone : source === "camera" ? now.camera : now.screenShare;
    if (actual !== enabled) throw new Error(`Couldn't ${enabled ? "start" : "stop"} ${source === "screen_share" ? "sharing your screen" : `your ${source}`}.`);
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
    if (!me) throw new Error("You're not connected right now. Try again in a moment.");
    if (kind === "audiooutput") {
      // Sound comes out of our own elements, so they are what has to be re-routed.
      this.outputDevice = deviceId;
      this.sounds.forEach((element) => this.routeSound(element, deviceId));
      this.emit("device", kind);
      return;
    }
    const device = await me.getDeviceById(deviceId, SDK_KIND[kind]);
    if (!device) throw new Error("That device is no longer available. Choose another one.");
    await me.setDevice(device);
    this.emit("device", kind);
  }

  /* ----------------------------------------------------------------- effects */

  localEffects(): LocalEffects {
    return this.fx;
  }

  private setFx(patch: Partial<LocalEffects>): void {
    const next = { ...this.fx, ...patch };
    const keys = Object.keys(next) as (keyof LocalEffects)[];
    if (keys.every((key) => next[key] === this.fx[key])) return;
    this.fx = next;
    this.emit("effects");
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const run = this.effectsQueue.then(work, work);
    this.effectsQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async setNoiseSuppression(on: boolean): Promise<void> {
    this.setFx({ noiseSuppression: on });
    await this.queued(() => this.syncNoise());
  }

  /**
   * Our filter goes in as an SDK audio middleware: the SDK hands over its AudioContext and puts
   * the node we return between the microphone and what it sends. The browser's own suppression
   * was chosen when the microphone was opened (see connect()); a running track is asked to
   * change it, which some browsers do and some ignore.
   */
  private async syncNoise(): Promise<void> {
    const me = this.meeting?.self;
    if (!me || !this.joined) return;
    const want = this.fx.noiseSuppression;
    try {
      await me.audioTrack?.applyConstraints?.({ noiseSuppression: want });
    } catch {
      // It stays as it was opened.
    }
    try {
      if (want && !this.noiseMiddleware && this.effects.noiseSupported()) {
        const middleware: AudioMiddleware = async (context) => {
          try {
            const node = await this.effects.createNoiseNode(context);
            this.noiseFiltering = true;
            return node;
          } catch {
            // Nothing may fail inside the SDK's audio path: the sound passes through untouched.
            this.noiseFiltering = false;
            return context.createGain() as unknown as AudioWorkletNode;
          } finally {
            this.reportNoise();
          }
        };
        const added = await me.addAudioMiddleware(middleware);
        if (added?.success !== false) this.noiseMiddleware = middleware;
      } else if (!want && this.noiseMiddleware) {
        const middleware = this.noiseMiddleware;
        this.noiseMiddleware = null;
        this.noiseFiltering = false;
        await me.removeAudioMiddleware(middleware);
      }
    } catch {
      // The microphone carries on with whatever was running.
    }
    this.reportNoise();
  }

  private reportNoise(): void {
    const want = this.fx.noiseSuppression;
    this.setFx({ noiseState: !want ? "off" : this.noiseFiltering && this.noiseMiddleware ? "enhanced" : "basic" });
  }

  async setBackground(mode: BackgroundMode): Promise<void> {
    if (mode !== "none" && this.fx.backgroundUnavailable) throw new Error(this.fx.backgroundUnavailable);
    if (!this.meeting) throw new Error("You're not connected right now. Try again in a moment.");
    this.setFx({ background: mode });
    await this.queued(() => this.syncBackground());
  }

  /**
   * Blur goes in as an SDK video middleware: the SDK draws each camera frame on a canvas and
   * calls us to change it in place before it is sent (and shown to you).
   */
  private async syncBackground(): Promise<void> {
    const me = this.meeting?.self;
    if (!me) return;
    const mode = this.fx.background;
    if (mode === "none") {
      const middleware = this.blurMiddleware;
      this.blurWatch?.stop();
      this.blurWatch = null;
      this.blur = null;
      this.blurMiddleware = null;
      if (middleware) await me.removeVideoMiddleware(middleware);
      return void this.setFx({ backgroundState: "off" });
    }
    if (this.blur) {
      this.blur.strength = mode;
      return void this.setFx({ backgroundState: "on" });
    }
    this.setFx({ backgroundState: "starting" });
    try {
      const blur = await this.effects.createBlur(mode);
      const middleware: VideoMiddleware = async () => async (canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
        blur.draw(canvas, canvas.width, canvas.height, context);
      };
      const added = await me.addVideoMiddleware(middleware);
      if (added?.success === false) throw new Error(added.message);
      this.blur = blur;
      this.blurMiddleware = middleware;
      this.blurWatch = this.effects.watchFrameRate(
        () => blur.frames,
        () => this.blurTooSlow(blur),
      );
      this.setFx({ backgroundState: "on" });
    } catch {
      this.setFx({ background: "none", backgroundState: "off" });
      throw new Error("Your camera is unchanged.");
    }
  }

  /** The device cannot blur and keep a usable frame rate: blur goes, and the interface is told so it can say why. */
  private blurTooSlow(blur: Blur): void {
    void this.queued(async () => {
      const mode = this.fx.background;
      if (this.blur !== blur || mode === "none") return;
      this.setFx({ background: "none" });
      await this.syncBackground().catch(() => {});
      this.emit("backgroundTooSlow", mode);
    });
  }

  /* ---------------------------------------------------------- chat and hands */

  /**
   * RealtimeKit keeps the conversation, so someone who joins late is handed it by Cloudflare.
   * A link can be used for one call after another, though, and this call's conversation is not
   * the last one's: anything from before this session started is left out.
   */
  private readChat(): void {
    const meeting = this.meeting;
    if (!meeting) return;
    const me = meeting.self;
    const people = new Map<string, string>();
    for (const { peer, person } of this.peers.values()) people.set(peer.userId, person.identity);
    const started = meeting.meta?.meetingStartedTimestamp;
    const since = started instanceof Date && started.getTime() > 0 ? started.getTime() : 0;
    const messages: RtcChatMessage[] = [];
    for (const message of meeting.chat.messages) {
      // Images and files cannot be sent from Meetly; anything that is not plain text is skipped.
      const text = (message as { message?: unknown }).message;
      if ((message.type as string) !== "text" || typeof text !== "string") continue;
      const timestamp = message.timeMs ?? new Date(message.time).getTime();
      if (timestamp < since || this.removed.has(message.id)) continue;
      const own = message.userId === me.userId;
      messages.push({
        id: message.id,
        timestamp,
        message: text,
        from: {
          identity: own ? this.self.identity : (people.get(message.userId) ?? message.userId),
          name: message.displayName ?? "",
          isLocal: own,
        },
        ...(this.history.has(message.id) ? { earlier: true } : {}),
      });
    }
    if (this.removed.size > 0) {
      messages.push(...this.removed.values());
      messages.sort((a, b) => a.timestamp - b.timestamp);
    }
    this.messages = messages;
    this.pinned = (this.pinId && messages.find((message) => message.id === this.pinId && !message.deleted)) || null;
  }

  pinnedMessage(): RtcChatMessage | null {
    return this.pinned;
  }

  /**
   * RealtimeKit removes the message for everyone. Whether it would also do so for a message
   * that is not the caller's is Cloudflare's rule, not ours: nothing in the SDK or its
   * documentation says, and this adapter never asks it to.
   */
  async deleteChatMessage(id: string): Promise<void> {
    const meeting = this.meeting;
    if (!meeting || !this.joined) throw new Error("You're not connected right now. Try again in a moment.");
    const message = this.messages.find((entry) => entry.id === id);
    if (!message?.from?.isLocal || message.deleted) throw new Error("You can only delete your own messages.");
    await meeting.chat.deleteMessage(id);
  }

  chatMessages(): RtcChatMessage[] {
    return this.messages;
  }

  get chatSending(): boolean {
    return this.sending;
  }

  async sendChat(text: string): Promise<void> {
    const meeting = this.meeting;
    if (!meeting || !this.joined) throw new Error("You're not connected right now. Try again in a moment.");
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
    if (!meeting || !this.joined) return Promise.reject(new Error("You're not connected right now. Try again in a moment."));
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

  async sendReaction(emoji: string): Promise<void> {
    const meeting = this.meeting;
    if (!isReaction(emoji) || !meeting || !this.joined) return;
    if (!this.maySendReactions(this.self.identity) || !this.limits.maySend()) return;
    this.emit("reaction", this.self, emoji);
    await meeting.participants.broadcastMessage(REACTION_MESSAGE, { peerId: meeting.self.id, emoji });
  }

  /* ------------------------------------------------------------------- polls */

  /**
   * RealtimeKit's own polls. Cloudflare keeps them, counts the votes and hands both to whoever
   * joins later; each participant's preset says whether they may see polls, vote and start one,
   * and Cloudflare is who enforces that. What Meetly adds is its limits on a new poll (checked
   * here, so only as good as this client) and ending one (see `closedPolls`).
   */
  polls(): RtcPoll[] {
    return this.pollList;
  }

  /** Every id RealtimeKit might file you under: its documentation says "participant ID" and no more. */
  private myIds(): string[] {
    const me = this.meeting?.self;
    return me ? [me.userId, me.id, me.customParticipantId].filter((id): id is string => !!id) : [];
  }

  private readPolls(): void {
    const meeting = this.meeting;
    const items = meeting && this.joined && meeting.self.permissions?.polls?.canView ? (meeting.polls?.items ?? []) : [];
    const mine = this.myIds();
    const next = items.map((poll): RtcPoll => {
      const options = poll.options ?? [];
      const named = options.findIndex((option) => option.votes?.some((vote) => mine.includes(vote.id)));
      const remembered = this.myChoices.get(poll.id);
      const myVote = named >= 0 ? named : remembered;
      const counts = options.map((option) => (typeof option.count === "number" ? option.count : (option.votes?.length ?? 0)));
      return {
        id: poll.id,
        question: poll.question,
        createdBy: poll.createdBy ?? "",
        anonymous: !!poll.anonymous,
        open: !this.closedPolls.has(poll.id),
        options: options.map((option, index) => ({
          text: option.text,
          votes: counts[index],
          voters: poll.anonymous ? [] : (option.votes ?? []).map((vote) => vote.name || "Guest"),
        })),
        total: counts.reduce((sum, count) => sum + count, 0),
        voted: named >= 0 || !!poll.voted?.some((id) => mine.includes(id)),
        ...(myVote !== undefined ? { myVote } : {}),
      };
    });
    const signature = JSON.stringify(next);
    if (signature === this.pollsSeen) return;
    this.pollsSeen = signature;
    this.pollList = next;
    this.emit("polls");
  }

  async createPoll(poll: NewPoll): Promise<void> {
    const checked = checkNewPoll(poll);
    if (typeof checked === "string") throw new Error(checked);
    const meeting = this.meeting;
    if (!meeting || !this.joined) throw new Error("You're not connected right now. Try again in a moment.");
    // The SDK drops the request without a word if the preset does not allow it.
    if (!meeting.self.permissions?.polls?.canCreate) throw new Error("Only the host and co-hosts can start a poll.");
    if (this.pollList.filter((existing) => existing.open).length >= POLL_LIMITS.open) {
      throw new Error(`There are already ${POLL_LIMITS.open} polls open. End one first.`);
    }
    await meeting.polls.create(checked.question, checked.options, checked.anonymous, false);
  }

  /**
   * The SDK sends the vote and says nothing back; that it counted is known when the poll comes
   * round again with you among its voters. If that does not happen, the vote is reported as not
   * counted rather than assumed.
   */
  async votePoll(pollId: string, option: number): Promise<void> {
    const meeting = this.meeting;
    if (!meeting || !this.joined) throw new Error("You're not connected right now. Try again in a moment.");
    const poll = this.pollList.find((entry) => entry.id === pollId);
    if (!poll) throw new Error("That poll is no longer there.");
    if (!poll.open) throw new Error("That poll has ended.");
    if (poll.voted) throw new Error("You've already voted in this poll.");
    if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) throw new Error("That isn't one of the options.");
    if (!meeting.self.permissions?.polls?.canVote) throw new Error("You can't vote in this meeting's polls.");
    const counted = new Promise<boolean>((resolve) => {
      const seen = () => !!this.pollList.find((entry) => entry.id === pollId)?.voted;
      const stop = this.on("polls", () => {
        if (!seen()) return;
        clearTimeout(timer);
        stop();
        resolve(true);
      });
      const timer = setTimeout(() => {
        stop();
        resolve(seen());
      }, VOTE_WAIT_MS);
    });
    this.myChoices.set(pollId, option);
    await meeting.polls.vote(pollId, option);
    this.readPolls();
    if (await counted) return;
    this.myChoices.delete(pollId);
    this.readPolls();
    throw new Error("Your vote wasn't counted. Try again.");
  }

  /* ------------------------------------------------------ how the call is doing */

  quality(): CallQuality {
    return this.health;
  }

  /**
   * RealtimeKit scores what you send, microphone and camera separately, from 0 to 10. The worse
   * of the two stands for your connection; a device that is off has no say.
   */
  private readQuality(): void {
    const known = [this.scores.audio, this.scores.video].filter((score): score is number => typeof score === "number");
    const worst = known.length > 0 ? Math.min(...known) : null;
    const connection =
      worst === null || !this.joined ? "unknown" : worst < WEAK_SCORE ? "poor" : worst < FAIR_SCORE ? "fair" : "good";
    if (connection === this.health.connection && this.saver === this.health.dataSaver) return;
    this.health = { connection, dataSaver: this.saver };
    this.emit("quality");
  }

  private forgetScore(kind: "audio" | "video"): void {
    if (this.scores[kind] === undefined) return;
    delete this.scores[kind];
    delete this.sent[kind];
    this.readQuality();
  }

  async setDataSaver(on: boolean): Promise<void> {
    this.saver = on;
    this.readQuality();
    // Fewer pictures are kept flowing "just in case" (see applyDemand).
    this.applyDemand();
    await this.queued(() => this.syncSaver());
  }

  /**
   * "Use less data", the sending half: the camera is asked for a small, slow picture, and for
   * what it had before when the switch goes off again. (The receiving half is the interface
   * showing fewer pictures, which `setVideoDemand` turns into a smaller active set.)
   */
  private async syncSaver(): Promise<void> {
    const me = this.meeting?.self;
    const track = me?.videoEnabled ? me.videoTrack : undefined;
    if (!me || !track) return;
    try {
      if (this.saver) {
        if (this.savedTrack === track.id) return;
        const now = track.getSettings?.() ?? {};
        this.fullCapture = { width: now.width || 1280, height: now.height || 720, frameRate: now.frameRate || 30 };
        this.savedTrack = track.id;
        await me.updateVideoConstraints({
          width: { ideal: SAVER_WIDTH },
          height: { ideal: SAVER_HEIGHT },
          frameRate: { ideal: SAVER_FPS },
        });
      } else if (this.fullCapture && this.savedTrack === track.id) {
        const full = this.fullCapture;
        this.fullCapture = null;
        this.savedTrack = null;
        await me.updateVideoConstraints({
          width: { ideal: full.width },
          height: { ideal: full.height },
          frameRate: { ideal: full.frameRate },
        });
      } else {
        this.fullCapture = null;
        this.savedTrack = null;
      }
    } catch {
      // The camera carries on as it was.
    }
  }

  async stats(): Promise<CallStats> {
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const { audio, video } = this.sent;
    const sentBits = [audio?.bitrate, video?.bitrate].map(number).filter((bits): bits is number => bits !== null);
    const losses = [audio?.packetsLostPercentage, video?.packetsLostPercentage].map(number).filter((loss): loss is number => loss !== null);
    const width = number(video?.frameWidth);
    const height = number(video?.frameHeight);
    let received = 0;
    this.receiving.forEach((bits) => (received += bits));
    return {
      sentKbps: sentBits.length > 0 ? Math.round(sentBits.reduce((sum, bits) => sum + bits, 0) / 1000) : null,
      receivedKbps: this.receiving.size > 0 ? Math.round(received / 1000) : null,
      // RealtimeKit's scores do not include it.
      roundTripMs: null,
      lossPercent: losses.length > 0 ? Math.round(Math.max(...losses) * 10) / 10 : null,
      sentVideo: width && height ? { width, height, fps: number(video?.framesPerSecond) } : null,
    };
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
    on(self, "waitlisted", () => {
      if (this.meeting === meeting && !this.ended) this.onWaitlisted();
    });
    on(self, "roomLeft", ({ state }: { state: string }) => {
      // "disconnected" is the SDK losing the room while it keeps trying to get back in.
      if (state === "disconnected") return part("room", true);
      // Ending the call for everyone reaches each person as being removed; the host's client
      // says so just before (see ENDING_MESSAGE), which is what tells the two apart.
      const ending = Date.now() - this.endingAt < ENDING_WINDOW_MS;
      this.finish(
        state === "rejected"
          ? "denied"
          : state === "ended" || (state === "kicked" && ending)
            ? "ended"
            : state === "kicked"
              ? "removed"
              : state === "left"
                ? "left"
                : "dropped",
      );
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
      this.listenToSelf();
      if (!self.audioEnabled) this.forgetScore("audio");
      const now = !!self.audioEnabled;
      if (now === this.micWas) return;
      this.micWas = now;
      // Joining with the microphone on is not a toggle; nothing before `joined` is reported.
      if (this.joined) this.emit("localMic", now);
    });
    on(self, "videoUpdate", () => {
      mediaChanged();
      this.tilesChanged();
      if (!self.videoEnabled) this.forgetScore("video");
      // A camera that was (re)started comes back at full size.
      if (this.saver) void this.queued(() => this.syncSaver());
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
    on(self, "mediaScoreUpdate", (update: ScoreUpdate) => {
      const { kind, isScreenshare, score } = update;
      if (!isScreenshare && (kind === "audio" || kind === "video")) {
        this.scores[kind] = score;
        this.sent[kind] = update.scoreStats;
        this.readQuality();
      }
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

    this.stage.watch(meeting, () => this.isHost(), on);

    on(participants, "activeSpeaker", ({ peerId }: { peerId: string }) => {
      if (peerId === this.speaker) return;
      const previous = this.speaker ? this.peers.get(this.speaker) : undefined;
      this.speaker = this.peers.has(peerId) ? peerId : null;
      previous?.person.changes.notify();
      this.peers.get(peerId)?.person.changes.notify();
      this.emit("speakers");
    });
    for (const event of ["participantJoined", "participantLeft", "participantsCleared"]) {
      on(participants.waitlisted, event, () => this.readWaiters());
    }
    on(participants, "broadcastedMessage", ({ type, payload }: { type: string; payload: Record<string, unknown> }) => {
      // The SDK also hands you your own broadcasts.
      const own = payload.peerId === self.id;
      if (type === REACTION_MESSAGE) {
        const sender = typeof payload.peerId === "string" ? this.peers.get(payload.peerId) : undefined;
        // Off means off: a reaction from somebody who may not send one is dropped, whatever sent it.
        // RealtimeKit does not say who sent a broadcast, so this trusts the `peerId` it names.
        if (!sender || !isReaction(payload.emoji) || !this.maySendReactions(sender.person.identity)) return;
        if (this.limits.mayReceive(payload.peerId as string)) {
          this.emit("reaction", sender.person, payload.emoji);
        }
        return;
      }
      if (type === ROLES_MESSAGE) {
        if (!own) this.refreshRoles().catch(() => {});
        return;
      }
      if (type === ENDING_MESSAGE) {
        this.endingAt = Date.now();
        return;
      }
      if (type === LOWER_MESSAGE) {
        const mine = payload.all === true || (Array.isArray(payload.peerIds) && payload.peerIds.includes(self.id));
        if (mine && this.self.hand) this.setHandRaised(false).catch(() => {});
        return;
      }
      if (type !== HAND_MESSAGE) return;
      const entry = typeof payload.peerId === "string" ? this.peers.get(payload.peerId) : undefined;
      const raised = payload.raised === true;
      if (!entry || entry.person.hand === raised) return;
      entry.person.hand = raised;
      entry.person.changes.notify();
      this.rosterChanged();
      if (raised) this.emit("handRaised", entry.person);
    });

    // Absent only in a build of the SDK without polls; a preset that may not view them simply gets none.
    if (meeting.polls) on(meeting.polls, "pollsUpdate", () => this.readPolls());

    on(chat, "chatUpdate", (update?: { action?: string; message?: { id?: unknown } }) => {
      // A message taken back leaves the SDK's list. What it was is kept, without its text, so
      // the conversation keeps its shape for the people who saw it.
      const id = update?.action === "delete" ? update.message?.id : undefined;
      const gone = typeof id === "string" ? this.messages.find((message) => message.id === id) : undefined;
      if (gone && !gone.deleted) this.removed.set(gone.id, { ...gone, message: "", deleted: true });
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
