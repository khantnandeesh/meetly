import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason as LiveKitDisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  ParticipantEvent,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  getBrowser,
  type AudioProcessorOptions,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type TrackProcessor,
  type TrackPublication,
  type VideoProcessorOptions,
} from "livekit-client";
import { BlurPipeline, blurUnavailable, type BlurStrength } from "../effects/blur";
import { NoiseFilter, noiseFilterSupported } from "../effects/noise";
import { RtcEmitter } from "./emitter";
import {
  ADMIT_TOPIC,
  CHAT_HISTORY_LIMIT,
  CHAT_SYNC_TOPIC,
  CHAT_TOPIC,
  REACTION_MESSAGE,
  createReactionLimits,
  createThrottle,
  isReaction,
  isSignedChat,
  postChat,
  postHost,
  type SignedChat,
} from "./shared";
import type {
  BackgroundMode,
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
  RtcCall,
  RtcChatMessage,
  RtcParticipant,
  RtcTile,
  RtcVideoTrack,
  RtcWaiter,
} from "./types";

/** Participant attribute that carries a raised hand ("1" when up). */
const HAND = "hand";

/** Everything that can change one of the properties `RtcParticipant` exposes. */
const PARTICIPANT_EVENTS = [
  ParticipantEvent.TrackMuted,
  ParticipantEvent.TrackUnmuted,
  ParticipantEvent.TrackPublished,
  ParticipantEvent.TrackUnpublished,
  ParticipantEvent.LocalTrackPublished,
  ParticipantEvent.LocalTrackUnpublished,
  ParticipantEvent.IsSpeakingChanged,
  ParticipantEvent.AttributesChanged,
  ParticipantEvent.ParticipantNameChanged,
  ParticipantEvent.ConnectionQualityChanged,
] as const;

/** Everything that can change which track a publication is showing. */
const TRACK_EVENTS = [
  ParticipantEvent.TrackSubscribed,
  ParticipantEvent.TrackUnsubscribed,
  ParticipantEvent.TrackSubscriptionStatusChanged,
  ParticipantEvent.TrackPublished,
  ParticipantEvent.TrackUnpublished,
  ParticipantEvent.LocalTrackPublished,
  ParticipantEvent.LocalTrackUnpublished,
  ParticipantEvent.TrackMuted,
  ParticipantEvent.TrackUnmuted,
] as const;

class LiveKitParticipant implements RtcParticipant {
  constructor(private readonly source: Participant) {}
  get identity() {
    return this.source.identity;
  }
  get isLocal() {
    return this.source.isLocal;
  }
  get name() {
    return this.source.name ?? "";
  }
  /** "Never published" counts as off, which is what the UI needs to show. */
  get micOn() {
    return this.source.isMicrophoneEnabled;
  }
  get camOn() {
    return this.source.isCameraEnabled;
  }
  get handRaised() {
    return this.source.attributes[HAND] === "1";
  }
  get speaking() {
    return this.source.isSpeaking;
  }
  get weakConnection() {
    const quality = this.source.connectionQuality;
    return quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost;
  }
  subscribe = (listener: () => void) => {
    PARTICIPANT_EVENTS.forEach((event) => this.source.on(event, listener));
    return () => PARTICIPANT_EVENTS.forEach((event) => this.source.off(event, listener));
  };
}

class LiveKitVideo implements RtcVideoTrack {
  constructor(
    private readonly publication: TrackPublication,
    private readonly owner: Participant,
  ) {}
  get dimensions() {
    return this.publication.dimensions;
  }
  attach(element: HTMLVideoElement) {
    let attached: Track | undefined;
    // A remote track only exists once it is subscribed, so follow the publication.
    const sync = () => {
      const track = this.publication.track;
      if (track === attached) return;
      attached?.detach(element);
      attached = track;
      track?.attach(element);
    };
    sync();
    TRACK_EVENTS.forEach((event) => this.owner.on(event, sync));
    return () => {
      TRACK_EVENTS.forEach((event) => this.owner.off(event, sync));
      attached?.detach(element);
      attached = undefined;
    };
  }
}

/** The pinned chat message as the meeting's record holds it: our server checked it before writing it. */
type Pin = { id: string; identity: string; name: string; ts: number; text: string };

/** The part of the meeting's record (room metadata, written by our server only) that clients show. */
type Meta = { host: string | null; coHosts: string[]; access: JoinAccess; pin: Pin | null };
const NO_META: Meta = { host: null, coHosts: [], access: "open", pin: null };

function readPin(value: unknown): Pin | null {
  if (typeof value !== "object" || value === null) return null;
  const pin = value as Record<string, unknown>;
  return typeof pin.id === "string" && typeof pin.text === "string"
    ? {
        id: pin.id,
        identity: typeof pin.identity === "string" ? pin.identity : "",
        name: typeof pin.name === "string" ? pin.name : "",
        ts: typeof pin.ts === "number" ? pin.ts : 0,
        text: pin.text,
      }
    : null;
}

/* ---------------------------------------------------------------- effects */

/**
 * Noise suppression (src/lib/effects/noise.ts) as a LiveKit track processor. LiveKit swaps
 * `processedTrack` in for the microphone on the wire, and calls `restart` whenever the
 * microphone itself is restarted or changed.
 */
class NoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "meetly-noise";
  processedTrack?: MediaStreamTrack;
  /** The microphone as captured, before the filter. */
  input?: MediaStreamTrack;
  private filter: NoiseFilter | null = null;
  constructor(private readonly onStall: () => void) {}
  async init({ track }: AudioProcessorOptions) {
    const filter = await NoiseFilter.create(this.onStall);
    filter.setInput(track);
    this.filter = filter;
    this.input = track;
    this.processedTrack = filter.output;
  }
  async restart({ track }: AudioProcessorOptions) {
    this.input = track;
    this.filter?.setInput(track);
  }
  async destroy() {
    this.filter?.close();
    this.filter = null;
    this.input = undefined;
    this.processedTrack = undefined;
  }
}

/** Background blur (src/lib/effects/blur.ts) as a LiveKit track processor, in the same way. */
class BlurProcessor implements TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  readonly name = "meetly-blur";
  processedTrack?: MediaStreamTrack;
  pipeline: BlurPipeline | null = null;
  constructor(
    private strength: BlurStrength,
    private readonly onSlow: () => void,
  ) {}
  async init({ track }: VideoProcessorOptions) {
    this.pipeline = await BlurPipeline.create(track, this.strength, this.onSlow);
    this.processedTrack = this.pipeline.output;
  }
  async restart({ track }: VideoProcessorOptions) {
    this.pipeline?.setInput(track);
  }
  async destroy() {
    this.pipeline?.close();
    this.pipeline = null;
    this.processedTrack = undefined;
  }
  setStrength(strength: BlurStrength) {
    this.strength = strength;
    this.pipeline?.setStrength(strength);
  }
}

/** The camera or microphone itself failed to start, as opposed to something we put on top of it. */
const isDeviceError = (error: unknown) =>
  error instanceof Error && /^(NotAllowed|NotFound|NotReadable|Overconstrained|Abort|Security)Error$/.test(error.name);

/* -------------------------------------------------------------------- chat */

/** One entry of the conversation as this client holds it. `signed` is what can be passed on to a newcomer. */
type ChatEntry = { message: RtcChatMessage; signed?: SignedChat };

/** How long one participant is given to answer a request for the conversation so far. */
const HISTORY_WAIT_MS = 2500;
/** How many participants are asked, one after another, before giving up on history. */
const HISTORY_ASKS = 3;
/** Most bytes of JSON put in one data packet when answering. LiveKit carries about 15 kB reliably. */
const HISTORY_CHUNK_BYTES = 12_000;

function readMeta(metadata: string | undefined): Meta {
  try {
    const value = JSON.parse(metadata || "{}");
    if (typeof value !== "object" || value === null) return NO_META;
    return {
      host: typeof value.host === "string" ? value.host : null,
      coHosts: Array.isArray(value.cohosts) ? value.cohosts.filter((id: unknown): id is string => typeof id === "string") : [],
      access: value.access === "ask" || value.access === "locked" ? value.access : "open",
      pin: readPin(value.pin),
    };
  } catch {
    return NO_META;
  }
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function decode(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload));
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function whyDisconnected(reason: LiveKitDisconnectReason | undefined, asking: boolean): DisconnectReason {
  if (reason === LiveKitDisconnectReason.PARTICIPANT_REMOVED) return asking ? "denied" : "removed";
  if (reason === LiveKitDisconnectReason.ROOM_DELETED) return "ended";
  return reason === undefined || reason === LiveKitDisconnectReason.CLIENT_INITIATED ? "left" : "dropped";
}

class LiveKitCall extends RtcEmitter implements RtcCall {
  readonly provider = "livekit" as const;
  readonly native: Room;

  private readonly people = new WeakMap<Participant, LiveKitParticipant>();
  private readonly videos = new WeakMap<TrackPublication, LiveKitVideo>();
  private roster: RtcParticipant[] | null = null;
  private tileList: RtcTile[] | null = null;
  private media: LocalMedia | null = null;
  /** The conversation, oldest first, by message id. */
  private readonly chat = new Map<string, ChatEntry>();
  private messages: RtcChatMessage[] = [];
  private pinned: RtcChatMessage | null = null;
  private sending = 0;
  /** Messages this browser wrote under an earlier identity (before a reload), as our server said. */
  private readonly mine = new Set<string>();
  /** Ids taken back before (or without) the message itself reaching this client. */
  private readonly deleted = new Set<string>();
  private historyAttempt = 0;
  private historyWaiter: { from: string; nonce: string; got: SignedChat[]; done: (complete: boolean) => void; more: () => void } | null = null;
  private readonly mayAnswerHistory = createThrottle(5000);
  private audioSink: HTMLElement | null = null;
  private attempt = 0;
  private meta: Meta = NO_META;
  private readonly limits = createReactionLimits();
  /** While you are asking to join: the lobby you wait in (see src/lib/host.server.ts). */
  private lobby: Room | null = null;
  /** Your way into the meeting itself, once a host has let you in from the lobby. */
  private memberToken: string | null = null;
  /** As host or co-host: a hidden connection to the lobby, to see who is asking. */
  private watch: Room | null = null;
  private watchAttempt = 0;
  private waiters: RtcWaiter[] = [];
  readonly supports = { askToJoin: true, stopCamera: true } as const;
  private fx: LocalEffects;
  private noise: NoiseProcessor | null = null;
  private blur: BlurProcessor | null = null;
  /** Microphone tracks whose own noise suppression we already tried to change, so a browser that ignores it is asked once. */
  private constraintTried = new WeakSet<MediaStreamTrack>();
  private noiseFailures = 0;
  /** Changes to the effects run one after another, never interleaved. */
  private effectsQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly grant: Extract<JoinGrant, { provider: "livekit" }>,
    private readonly choices: JoinChoices,
  ) {
    super();
    const noiseSuppression = choices.noiseSuppression !== false;
    const unavailable = typeof document === "undefined" ? null : blurUnavailable();
    this.fx = {
      noiseSuppression,
      noiseState: "off",
      background: unavailable ? "none" : (choices.background ?? "none"),
      backgroundState: "off",
      ...(unavailable ? { backgroundUnavailable: unavailable } : {}),
    };
    this.native = new Room({
      adaptiveStream: true, // only pull the resolution each tile actually needs
      dynacast: true, // stop publishing layers nobody is watching
      publishDefaults: { simulcast: true },
      audioCaptureDefaults: this.microphoneConstraints(noiseSuppression),
    });
    this.listen();
  }

  /* -------------------------------------------------------------- connection */

  get status(): ConnectionStatus {
    if (this.lobby) return this.lobby.state === ConnectionState.Connecting ? "connecting" : "waiting";
    switch (this.native.state) {
      case ConnectionState.Connecting:
        return "connecting";
      case ConnectionState.Connected:
        return "connected";
      case ConnectionState.Reconnecting:
      case ConnectionState.SignalReconnecting:
        return "reconnecting";
      default:
        return "disconnected";
    }
  }

  /** What proves who you are to the meeting and to our server. */
  private get token(): string {
    return this.memberToken ?? this.grant.token;
  }

  connect(): void {
    const attempt = ++this.attempt;
    if (this.grant.lobby && !this.memberToken) this.ask(attempt);
    else this.enter(attempt);
  }

  private enter(attempt: number): void {
    // A fresh connection starts a fresh conversation; what was said before comes from the others.
    this.chat.clear();
    this.deleted.clear();
    this.messages = [];
    this.pinned = null;
    this.native.connect(this.grant.serverUrl, this.token).catch((error) => {
      // A connect that was abandoned (the call was unmounted) is not worth reporting.
      if (attempt === this.attempt) this.emit("error", error instanceof Error ? error : new Error(String(error)));
    });
  }

  /**
   * Waits in the lobby until a host answers. Being let in arrives as a message from our server
   * (nobody in the lobby can send one) carrying a token for the meeting; being turned away is
   * being removed from the lobby.
   */
  private ask(attempt: number): void {
    const lobby = new Room();
    this.lobby = lobby;
    this.emit("status");
    lobby
      .on(RoomEvent.ConnectionStateChanged, () => {
        if (this.lobby === lobby) this.emit("status");
      })
      .on(RoomEvent.DataReceived, (payload, sender, _kind, topic) => {
        if (this.lobby !== lobby || sender || topic !== ADMIT_TOPIC) return;
        let token: unknown;
        try {
          token = JSON.parse(new TextDecoder().decode(payload)).token;
        } catch {
          return;
        }
        if (typeof token !== "string" || attempt !== this.attempt) return;
        this.memberToken = token;
        this.lobby = null;
        lobby.disconnect().catch(() => {});
        this.enter(attempt);
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.lobby !== lobby) return;
        this.lobby = null;
        this.emit("status");
        this.emit("disconnected", whyDisconnected(reason, true));
      });
    lobby.connect(this.grant.serverUrl, this.grant.token).catch((error) => {
      if (this.lobby !== lobby) return;
      this.lobby = null;
      this.emit("status");
      if (attempt === this.attempt) this.emit("error", error instanceof Error ? error : new Error(String(error)));
    });
  }

  async disconnect(): Promise<void> {
    this.attempt++;
    const lobby = this.lobby;
    if (lobby) {
      // Giving up on asking: quietly, like any other hang-up of your own.
      this.lobby = null;
      await lobby.disconnect();
      this.emit("status");
      return;
    }
    await this.native.disconnect();
  }

  /* ------------------------------------------------------------------ people */

  private wrap(participant: Participant): LiveKitParticipant {
    let wrapped = this.people.get(participant);
    if (!wrapped) this.people.set(participant, (wrapped = new LiveKitParticipant(participant)));
    return wrapped;
  }

  get local(): RtcParticipant {
    return this.wrap(this.native.localParticipant);
  }

  participants(): RtcParticipant[] {
    this.roster ??= [this.native.localParticipant, ...this.native.remoteParticipants.values()].map((p) => this.wrap(p));
    return this.roster;
  }

  remoteIds(): string[] {
    return Array.from(this.native.remoteParticipants.keys());
  }

  participant(identity: string): RtcParticipant | undefined {
    const local = this.native.localParticipant;
    if (identity === local.identity) return this.wrap(local);
    const remote = this.native.remoteParticipants.get(identity);
    return remote && this.wrap(remote);
  }

  /** Room metadata is written by our server only (see src/lib/host.server.ts). */
  get hostIdentity(): string | null {
    return this.meta.host;
  }

  coHosts(): string[] {
    return this.meta.coHosts;
  }

  get access(): JoinAccess {
    return this.meta.access;
  }

  waiting(): RtcWaiter[] {
    return this.waiters;
  }

  async moderate(action: HostAction): Promise<void> {
    // To pin, our server wants the message as it signed it: that is how it knows the text is
    // what was really said, and by whom.
    const message = action.action === "pin" && action.messageId ? this.chat.get(action.messageId)?.signed : undefined;
    if (action.action === "pin" && action.messageId && !message) throw new Error("That message can't be pinned.");
    await postHost({ token: this.token, ...action, ...(message ? { message } : {}) });
  }

  /** Follows the room's metadata, and says what changed. */
  private readMeta(): void {
    const next = readMeta(this.native.metadata);
    const last = this.meta;
    this.meta = next;
    const roles = next.host !== last.host || next.coHosts.join() !== last.coHosts.join();
    if (roles) this.emit("host");
    if (next.access !== last.access) this.emit("access");
    if (next.pin?.id !== last.pin?.id) this.chatChanged();
    this.syncLobbyWatch();
  }

  private get canModerate(): boolean {
    const me = this.native.localParticipant.identity;
    return !!me && (this.meta.host === me || this.meta.coHosts.includes(me));
  }

  /**
   * The host and co-hosts see who is asking to join by being in the lobby themselves, hidden,
   * for as long as people have to ask or somebody is still waiting. Who is in the lobby is the
   * list; our server hands out the way in and checks who is asking for it.
   */
  private syncLobbyWatch(): void {
    const wanted =
      this.native.state === ConnectionState.Connected &&
      this.canModerate &&
      (this.meta.access === "ask" || this.waiters.length > 0);
    if (wanted === !!this.watch) return;
    if (!wanted) return this.stopLobbyWatch();
    const attempt = ++this.watchAttempt;
    const room = new Room();
    this.watch = room;
    const current = () => this.watch === room && attempt === this.watchAttempt;
    const refresh = () => {
      if (!current()) return;
      this.waiters = Array.from(room.remoteParticipants.values(), (p) => ({ id: p.identity, name: p.name ?? "" }));
      this.emit("waiting");
      this.syncLobbyWatch();
    };
    const retry = (afterMs: number) => {
      if (!current()) return;
      this.watch = null;
      if (this.waiters.length > 0) {
        this.waiters = [];
        this.emit("waiting");
      }
      setTimeout(() => this.syncLobbyWatch(), afterMs);
    };
    room
      .on(RoomEvent.Connected, refresh)
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ParticipantNameChanged, refresh)
      .on(RoomEvent.Disconnected, () => retry(3000));
    postHost({ token: this.token, action: "lobby" })
      .then((data) => {
        if (!current()) return;
        return room.connect(this.grant.serverUrl, String(data.token));
      })
      .catch(() => retry(5000));
  }

  private stopLobbyWatch(): void {
    const room = this.watch;
    this.watch = null;
    this.watchAttempt++;
    if (this.waiters.length > 0) {
      this.waiters = [];
      this.emit("waiting");
    }
    room?.disconnect().catch(() => {});
  }

  /* ---------------------------------------------------------------- pictures */

  private video(publication: TrackPublication, owner: Participant): LiveKitVideo {
    let video = this.videos.get(publication);
    if (!video) this.videos.set(publication, (video = new LiveKitVideo(publication, owner)));
    return video;
  }

  tiles(): RtcTile[] {
    if (this.tileList) return this.tileList;
    const cameras: RtcTile[] = [];
    const screens: RtcTile[] = [];
    for (const person of [this.native.localParticipant, ...this.native.remoteParticipants.values()]) {
      const participant = this.wrap(person);
      // A publication counts as soon as it is announced, subscribed or not: the tile then waits
      // for the picture rather than for the track.
      const camera = person.getTrackPublication(Track.Source.Camera);
      cameras.push({ participant, source: "camera", track: camera && this.video(camera, person) });
      const screen = person.getTrackPublication(Track.Source.ScreenShare);
      if (screen) screens.push({ participant, source: "screen_share", track: this.video(screen, person) });
    }
    return (this.tileList = [...cameras, ...screens]);
  }

  /**
   * Nothing to do: adaptive stream already pauses any video whose element is off screen, and
   * `pauseUnattached` below covers the ones that never had an element.
   */
  setVideoDemand(): void {}

  /**
   * Only cameras that are on screen cost bandwidth.
   *
   * LiveKit's adaptive stream pauses a video track once none of its elements is visible, and
   * resumes it within a frame or two when one is. That covers tiles leaving the screen (paging,
   * the filmstrip, a speaker change). What it does not cover is a camera that has *never* been
   * attached to an element: the server keeps sending its lowest layer indefinitely. In a
   * 50-person call that is dozens of streams nobody is looking at.
   *
   * So when a camera is subscribed we attach it once to a throwaway element and detach it again.
   * That makes adaptive stream evaluate it as "not visible" and pause it until a tile shows it.
   *
   * Why not unsubscribe off-screen cameras instead? It was tried and measured: every
   * subscribe/unsubscribe renegotiates the peer connection, the session description grows with
   * each one, and after a few minutes of speaker changes in a large room the renegotiations alone
   * were blocking the main thread for hundreds of milliseconds. Staying subscribed and paused has
   * a fixed cost paid once at join. Audio is never touched: everyone is always heard.
   */
  private pauseUnattached = (track: unknown, publication: unknown) => {
    if (!(publication instanceof RemoteTrackPublication) || publication.source !== Track.Source.Camera) return;
    if (!(track instanceof RemoteVideoTrack) || track.attachedElements.length > 0) return;
    // Give a tile that is about to show this track the chance to attach first.
    setTimeout(() => {
      if (track.attachedElements.length > 0) return;
      const probe = document.createElement("video");
      track.attach(probe);
      track.detach(probe);
    }, 250);
  };

  private sweepUnattached = () =>
    this.native.remoteParticipants.forEach((participant) =>
      participant.trackPublications.forEach((publication) => this.pauseUnattached(publication.track, publication)),
    );

  /* ------------------------------------------------------------------- sound */

  activeSpeakers(): string[] {
    return this.native.activeSpeakers.map((participant) => participant.identity);
  }

  get audioBlocked(): boolean {
    return !this.native.canPlaybackAudio;
  }

  startAudio(): Promise<void> {
    return this.native.startAudio();
  }

  /** Other people's microphones and shared-screen audio each play through an element of their own. */
  private playAudio = (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    if (!this.audioSink) {
      this.audioSink = document.createElement("div");
      this.audioSink.style.display = "none";
      this.audioSink.dataset.callAudio = "";
      document.body.append(this.audioSink);
    }
    if (track.attachedElements.length === 0) this.audioSink.append(track.attach());
  };

  private stopAudio = (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    track.detach().forEach((element) => element.remove());
  };

  /* ------------------------------------------------------------ your devices */

  private readMedia(): LocalMedia {
    const local = this.native.localParticipant;
    return {
      microphone: local.isMicrophoneEnabled,
      camera: local.isCameraEnabled,
      screenShare: local.isScreenShareEnabled,
    };
  }

  localMedia(): LocalMedia {
    return (this.media ??= this.readMedia());
  }

  async setEnabled(source: LocalSource, enabled: boolean): Promise<void> {
    const local = this.native.localParticipant;
    if (source === "microphone") await local.setMicrophoneEnabled(enabled);
    else if (source === "camera") await (enabled ? this.startCamera() : local.setCameraEnabled(false));
    else await local.setScreenShareEnabled(enabled, { audio: true, selfBrowserSurface: "include" });
  }

  /**
   * Turns the camera on. If blur is wanted and the camera has not been published yet, it is
   * published already blurred: the room never sees a frame of what was meant to be hidden. If
   * blur cannot start, the camera stays off and the error says so.
   */
  private async startCamera(deviceId?: string): Promise<void> {
    const local = this.native.localParticipant;
    const mode = this.fx.background;
    const device = deviceId ? { deviceId } : undefined;
    if (mode === "none" || local.getTrackPublication(Track.Source.Camera)?.track) {
      await local.setCameraEnabled(true, device);
      return;
    }
    const processor = this.makeBlur(mode);
    this.blur = processor;
    this.setFx({ backgroundState: "starting" });
    try {
      await local.setCameraEnabled(true, { ...device, processor });
      this.setFx({ backgroundState: "on" });
    } catch (error) {
      this.blur = null;
      if (isDeviceError(error)) {
        this.setFx({ backgroundState: "off" });
        throw error;
      }
      this.setFx({ background: "none", backgroundState: "off" });
      throw new Error("Background blur couldn't start, so your camera was left off. Turn it on to be seen without blur.");
    }
  }

  activeDevice(kind: DeviceKind): string | undefined {
    return this.native.getActiveDevice(kind);
  }

  async setDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    const browser = getBrowser();
    // Safari and iOS cannot route audio output; asking only produces an error.
    if (kind === "audiooutput" && (browser?.name === "Safari" || browser?.os === "iOS")) return;
    await this.native.switchActiveDevice(kind, deviceId);
  }

  /* ----------------------------------------------------------------- effects */

  /**
   * How the microphone is opened. Echo cancellation and gain control always stay on; noise
   * suppression is the browser's own, underneath ours (see src/lib/effects/noise.ts).
   */
  private microphoneConstraints(noiseSuppression: boolean) {
    return { noiseSuppression, echoCancellation: true, autoGainControl: true };
  }

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
    // For a microphone that is opened later (it is off now, or gets republished).
    this.native.options.audioCaptureDefaults = { ...this.native.options.audioCaptureDefaults, noiseSuppression: on };
    this.setFx({ noiseSuppression: on });
    await this.queued(() => this.syncNoise());
  }

  /**
   * Makes the live microphone match what was asked for, in two layers: the browser's own noise
   * suppression (a property of how the microphone was opened, so changing it means reopening
   * it), and our filter on top. Off means both off: what a musician wants. If our filter cannot
   * run here, the browser's carries on alone ("basic").
   */
  private async syncNoise(): Promise<void> {
    const want = this.fx.noiseSuppression;
    const track = this.native.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!(track instanceof LocalAudioTrack) || track.isMuted || this.native.state !== ConnectionState.Connected) {
      // Nothing is being sent. It is put right the moment the microphone comes on (see listen()).
      if (!want) this.setFx({ noiseState: "off" });
      return;
    }
    const ours = () => (this.noise && track.getProcessor() === this.noise ? this.noise : null);
    try {
      const raw = ours()?.input ?? track.mediaStreamTrack;
      const has = raw.getSettings().noiseSuppression;
      if (typeof has === "boolean" && has !== want && !this.constraintTried.has(raw)) {
        const deviceId = raw.getSettings().deviceId;
        await track.restartTrack({ ...this.microphoneConstraints(want), ...(deviceId ? { deviceId: { exact: deviceId } } : {}) });
        // A browser that ignores the request is not asked again for the same microphone.
        this.constraintTried.add(ours()?.input ?? track.mediaStreamTrack);
      }
      if (want && !track.getProcessor() && noiseFilterSupported() && this.noiseFailures < 2) {
        const processor: NoiseProcessor = new NoiseProcessor(() => this.noiseStalled(processor));
        try {
          await track.setProcessor(processor);
          this.noise = processor;
        } catch {
          this.noiseFailures++;
        }
      } else if (!want && track.getProcessor()) {
        this.noise = null;
        await track.stopProcessor();
      }
    } catch {
      // The microphone carries on with whatever was running.
    }
    this.setFx({ noiseState: !want ? "off" : ours() ? "enhanced" : "basic" });
  }

  /** The browser stopped our audio graph, so the filtered track has gone silent: back to the plain microphone. */
  private noiseStalled(processor: NoiseProcessor): void {
    void this.queued(async () => {
      if (this.noise !== processor) return;
      this.noise = null;
      this.noiseFailures = 2;
      const track = this.native.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (track instanceof LocalAudioTrack && track.getProcessor() === processor) await track.stopProcessor().catch(() => {});
      this.setFx({ noiseState: this.fx.noiseSuppression ? "basic" : "off" });
    });
  }

  async setBackground(mode: BackgroundMode): Promise<void> {
    if (mode !== "none" && this.fx.backgroundUnavailable) throw new Error(this.fx.backgroundUnavailable);
    this.setFx({ background: mode });
    await this.queued(() => this.syncBackground());
  }

  private makeBlur(strength: BlurStrength): BlurProcessor {
    const processor: BlurProcessor = new BlurProcessor(strength, () => this.blurTooSlow(processor));
    return processor;
  }

  /**
   * Makes the camera match the background that was asked for. A camera that is switched off can
   * be given the processor all the same: it then starts blurred when it comes back on.
   */
  private async syncBackground(): Promise<void> {
    const mode = this.fx.background;
    const track = this.native.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    // No camera yet: `startCamera` publishes it blurred.
    if (!(track instanceof LocalVideoTrack)) return void this.setFx({ backgroundState: "off" });
    const current = track.getProcessor();
    if (mode === "none") {
      this.blur = null;
      if (current) await track.stopProcessor();
      return void this.setFx({ backgroundState: "off" });
    }
    if (current && current === this.blur) {
      this.blur.setStrength(mode);
      return void this.setFx({ backgroundState: "on" });
    }
    this.setFx({ backgroundState: "starting" });
    const processor = this.makeBlur(mode);
    this.blur = processor;
    try {
      await track.setProcessor(processor);
      this.setFx({ backgroundState: "on" });
    } catch {
      this.blur = null;
      this.setFx({ background: "none", backgroundState: "off" });
      throw new Error("Couldn't start background blur. Your camera is unchanged.");
    }
  }

  /** The device cannot blur and keep a usable frame rate: blur goes, and the interface is told so it can say why. */
  private blurTooSlow(processor: BlurProcessor): void {
    void this.queued(async () => {
      const mode = this.fx.background;
      if (this.blur !== processor || mode === "none") return;
      this.setFx({ background: "none" });
      await this.syncBackground().catch(() => {});
      this.emit("backgroundTooSlow", mode);
    });
  }

  /** For changes nobody is waiting on (the camera came back, the microphone was republished). */
  private resync(what: "noise" | "background"): void {
    this.queued(() => (what === "noise" ? this.syncNoise() : this.syncBackground())).catch((error) =>
      this.emit("error", error instanceof Error ? error : new Error(String(error))),
    );
  }

  /* ---------------------------------------------------------- chat and hands */

  /**
   * Chat goes through our server (src/lib/chat.server.ts): it checks who is sending from their
   * token, signs the message and hands it to the room. That is what lets a message be pinned or
   * taken back with the server knowing whose it is, and lets someone who joins late be given
   * the conversation so far by another participant without having to take their word for it.
   * There is still no storage: once everybody has left, the conversation is gone.
   */
  private chatChanged(): void {
    this.messages = Array.from(this.chat.values(), (entry) => entry.message);
    const pin = this.meta.pin;
    const me = this.native.localParticipant.identity;
    this.pinned =
      !pin || this.deleted.has(pin.id)
        ? null
        : {
            id: pin.id,
            timestamp: pin.ts,
            message: pin.text,
            from: { identity: pin.identity, name: pin.name, isLocal: pin.identity === me || this.mine.has(pin.id) },
          };
    this.emit("chat");
  }

  /** Files a message our server signed. False if it is already here, or is not for this meeting. */
  private addChat(signed: SignedChat, earlier: boolean): boolean {
    if (this.chat.has(signed.id) || this.deleted.has(signed.id) || signed.room !== this.native.name) return false;
    const isLocal = signed.identity === this.native.localParticipant.identity || this.mine.has(signed.id);
    this.chat.set(signed.id, {
      signed,
      message: {
        id: signed.id,
        timestamp: signed.ts,
        message: signed.text,
        from: { identity: signed.identity, name: signed.name, isLocal },
        ...(earlier ? { earlier: true } : {}),
      },
    });
    return true;
  }

  /** A packet from our server: a new message, or one being taken back. */
  private onChatPacket(payload: Uint8Array): void {
    const data = decode(payload);
    if (!data) return;
    if (data.type === "message" && isSignedChat(data.message)) {
      if (this.addChat(data.message, false)) this.chatChanged();
    } else if (data.type === "delete" && typeof data.id === "string") {
      this.deleted.add(data.id);
      const entry = this.chat.get(data.id);
      // The entry stays where it was, without its text, and can no longer be passed on.
      if (entry) this.chat.set(data.id, { message: { ...entry.message, message: "", deleted: true } });
      this.chatChanged();
    }
  }

  chatMessages(): RtcChatMessage[] {
    return this.messages;
  }

  get chatSending(): boolean {
    return this.sending > 0;
  }

  pinnedMessage(): RtcChatMessage | null {
    return this.pinned;
  }

  async sendChat(text: string): Promise<void> {
    if (this.native.state !== ConnectionState.Connected) throw new Error("Not connected.");
    this.sending++;
    this.emit("chat");
    try {
      const data = await postChat({ token: this.token, action: "send", text });
      // Usually the room has delivered it already; if not, this is it.
      if (isSignedChat(data.message) && this.addChat(data.message, false)) this.chatChanged();
    } finally {
      this.sending--;
      this.emit("chat");
    }
  }

  async deleteChatMessage(id: string): Promise<void> {
    const entry = this.chat.get(id);
    // The server checks again; this only saves the round trip.
    if (!entry?.signed || !entry.message.from?.isLocal) throw new Error("You can only delete your own messages.");
    await postChat({ token: this.token, action: "delete", message: entry.signed });
  }

  /**
   * Asks for what was said before you joined. The messages come from another participant, so
   * none is shown until our server has confirmed it signed that exact message: a participant
   * can leave messages out, but cannot invent one, change one or put a name to one.
   */
  private askForHistory(): void {
    const attempt = ++this.historyAttempt;
    void (async () => {
      const got = await this.collectHistory(attempt);
      if (!got || got.length === 0 || attempt !== this.historyAttempt) return;
      const data = await postChat({ token: this.token, action: "verify", messages: got });
      if (attempt !== this.historyAttempt) return;
      const valid = new Set(strings(data.valid));
      for (const id of strings(data.mine)) this.mine.add(id);
      let added = false;
      for (const signed of got) if (valid.has(signed.id)) added = this.addChat(signed, true) || added;
      if (!added) return;
      const inOrder = Array.from(this.chat.entries()).sort((a, b) => a[1].message.timestamp - b[1].message.timestamp);
      this.chat.clear();
      for (const [id, entry] of inOrder) this.chat.set(id, entry);
      this.chatChanged();
    })().catch(() => {});
  }

  private async collectHistory(attempt: number): Promise<SignedChat[] | null> {
    // Whoever has been in the call longest has seen the most of it.
    const peers = Array.from(this.native.remoteParticipants.values())
      .sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))
      .slice(0, HISTORY_ASKS);
    for (const peer of peers) {
      if (attempt !== this.historyAttempt || this.native.state !== ConnectionState.Connected) return null;
      const answer = await this.askPeer(peer);
      if (answer) return answer;
    }
    return null;
  }

  private askPeer(peer: RemoteParticipant): Promise<SignedChat[] | null> {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const got: SignedChat[] = [];
      let timer = setTimeout(() => done(false), HISTORY_WAIT_MS);
      const done = (complete: boolean) => {
        clearTimeout(timer);
        if (this.historyWaiter?.nonce === nonce) this.historyWaiter = null;
        resolve(complete ? got : null);
      };
      const more = () => {
        clearTimeout(timer);
        timer = setTimeout(() => done(false), HISTORY_WAIT_MS);
      };
      this.historyWaiter = { from: peer.identity, nonce, got, done, more };
      this.native.localParticipant
        .publishData(encode({ type: "ask", nonce }), { reliable: true, topic: CHAT_SYNC_TOPIC, destinationIdentities: [peer.identity] })
        .catch(() => done(false));
    });
  }

  /** A packet from another participant: someone asking for the conversation so far, or answering us. */
  private onSyncPacket(payload: Uint8Array, sender: RemoteParticipant): void {
    const data = decode(payload);
    if (!data || typeof data.nonce !== "string") return;
    if (data.type === "ask") {
      if (!this.mayAnswerHistory(sender.identity)) return;
      const held: SignedChat[] = [];
      for (const entry of this.chat.values()) if (entry.signed) held.push(entry.signed);
      const send = (messages: SignedChat[], last: boolean) =>
        this.native.localParticipant
          .publishData(encode({ type: "history", nonce: data.nonce, messages, last }), {
            reliable: true,
            topic: CHAT_SYNC_TOPIC,
            destinationIdentities: [sender.identity],
          })
          .catch(() => {});
      let chunk: SignedChat[] = [];
      let bytes = 0;
      for (const signed of held.slice(-CHAT_HISTORY_LIMIT)) {
        const size = JSON.stringify(signed).length * 3;
        if (chunk.length > 0 && bytes + size > HISTORY_CHUNK_BYTES) {
          void send(chunk, false);
          chunk = [];
          bytes = 0;
        }
        chunk.push(signed);
        bytes += size;
      }
      void send(chunk, true);
      return;
    }
    const waiter = this.historyWaiter;
    if (data.type !== "history" || !waiter || waiter.from !== sender.identity || waiter.nonce !== data.nonce) return;
    if (Array.isArray(data.messages)) {
      for (const message of data.messages) if (isSignedChat(message) && waiter.got.length < CHAT_HISTORY_LIMIT) waiter.got.push(message);
    }
    if (data.last === true) waiter.done(true);
    else waiter.more();
  }

  async setHandRaised(raised: boolean): Promise<void> {
    await this.native.localParticipant.setAttributes({ [HAND]: raised ? "1" : "" });
  }

  async sendReaction(emoji: string): Promise<void> {
    if (!isReaction(emoji) || this.native.state !== ConnectionState.Connected || !this.limits.maySend()) return;
    this.emit("reaction", this.local, emoji);
    await this.native.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ emoji })), {
      reliable: true,
      topic: REACTION_MESSAGE,
    });
  }

  /* ------------------------------------------------------------------ events */

  private listen(): void {
    const room = this.native;
    const isScreen = (publication: TrackPublication) => publication.source === Track.Source.ScreenShare;

    const rosterChanged = () => {
      this.roster = null;
      this.emit("roster");
    };
    const tilesChanged = () => {
      this.tileList = null;
      this.emit("tiles");
    };
    const mediaChanged = () => {
      const next = this.readMedia();
      const last = this.media;
      if (last && last.microphone === next.microphone && last.camera === next.camera && last.screenShare === next.screenShare) return;
      this.media = next;
      this.emit("localMedia");
    };

    room
      .on(RoomEvent.SignalConnected, () => {
        const local = room.localParticipant;
        const { audioEnabled, videoEnabled, audioDeviceId, videoDeviceId } = this.choices;
        const report = (error: unknown) => this.emit("error", error instanceof Error ? error : new Error(String(error)));
        // Separately, so that blur failing to start (the camera then stays off) says so itself.
        local
          .setMicrophoneEnabled(audioEnabled, audioEnabled ? { deviceId: audioDeviceId || undefined } : undefined)
          .catch(report);
        (videoEnabled ? this.startCamera(videoDeviceId || undefined) : local.setCameraEnabled(false)).catch(report);
      })
      .on(RoomEvent.ConnectionStateChanged, () => {
        this.emit("status");
        rosterChanged();
        tilesChanged();
        this.emit("host");
        this.readMeta();
      })
      .on(RoomEvent.Connected, this.sweepUnattached)
      .on(RoomEvent.Connected, () => {
        if (room.remoteParticipants.size > 0) this.askForHistory();
        this.resync("noise");
        // Something else may have had the microphone open when the call opened it (the pre-join
        // preview, in the moment of handing over), and a browser then hands back what it has,
        // whatever was asked for. Look once more when that is over.
        setTimeout(() => {
          if (room.state !== ConnectionState.Connected) return;
          this.constraintTried = new WeakSet();
          this.resync("noise");
        }, 4000);
      })
      // After a full reconnect, anything said in between is fetched the same way.
      .on(RoomEvent.Reconnected, () => {
        if (room.remoteParticipants.size > 0) this.askForHistory();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        // The conversation is kept: the goodbye screen can still save it.
        this.historyAttempt++;
        this.historyWaiter?.done(false);
        // LiveKit destroys a track's processors when it stops the track.
        this.noise = null;
        this.blur = null;
        this.setFx({ noiseState: "off", backgroundState: "off" });
        this.audioSink?.remove();
        this.audioSink = null;
        this.stopLobbyWatch();
        this.emit("disconnected", whyDisconnected(reason, false));
      })
      .on(RoomEvent.RoomMetadataChanged, () => this.readMeta())
      .on(RoomEvent.DataReceived, (payload, sender, _kind, topic) => {
        // The sender is named by LiveKit, not by the message, so it cannot be somebody else's.
        // Chat only counts from our server, which is the one sender that has no name.
        if (topic === CHAT_TOPIC) return void (sender ? undefined : this.onChatPacket(payload));
        if (topic === CHAT_SYNC_TOPIC) return void (sender ? this.onSyncPacket(payload, sender) : undefined);
        if (topic !== REACTION_MESSAGE || !sender) return;
        let emoji: unknown;
        try {
          emoji = JSON.parse(new TextDecoder().decode(payload)).emoji;
        } catch {
          return;
        }
        if (isReaction(emoji) && this.limits.mayReceive(sender.identity)) this.emit("reaction", this.wrap(sender), emoji);
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        rosterChanged();
        tilesChanged();
        this.emit("participantJoined", this.wrap(participant));
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        rosterChanged();
        tilesChanged();
        this.emit("participantLeft", this.wrap(participant));
      })
      .on(RoomEvent.ParticipantNameChanged, rosterChanged)
      .on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
        rosterChanged();
        if (changed[HAND] === "1") this.emit("handRaised", this.wrap(participant));
      })
      .on(RoomEvent.TrackPublished, (publication) => {
        tilesChanged();
        if (isScreen(publication)) this.emit("screenShare", true);
      })
      .on(RoomEvent.LocalTrackPublished, (publication) => {
        tilesChanged();
        mediaChanged();
        if (isScreen(publication)) this.emit("screenShare", true);
        // A microphone or camera published now (first time, or again after reconnecting) gets
        // whatever was asked for.
        if (publication.source === Track.Source.Microphone) this.resync("noise");
        if (publication.source === Track.Source.Camera) this.resync("background");
      })
      .on(RoomEvent.TrackUnpublished, (publication) => {
        tilesChanged();
        if (isScreen(publication)) this.emit("screenShare", false);
      })
      .on(RoomEvent.LocalTrackUnpublished, (publication) => {
        tilesChanged();
        mediaChanged();
        if (isScreen(publication)) this.emit("screenShare", false);
      })
      .on(RoomEvent.TrackSubscribed, (track, publication) => {
        this.pauseUnattached(track, publication);
        this.playAudio(track);
      })
      .on(RoomEvent.TrackUnsubscribed, this.stopAudio)
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        if (!participant.isLocal) return;
        mediaChanged();
        if (publication.source === Track.Source.Microphone) this.emit("localMic", false);
      })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => {
        if (!participant.isLocal) return;
        mediaChanged();
        if (publication.source === Track.Source.Microphone) {
          this.emit("localMic", true);
          this.resync("noise");
        }
      })
      .on(RoomEvent.ActiveSpeakersChanged, () => this.emit("speakers"))
      .on(RoomEvent.ActiveDeviceChanged, (kind) => {
        this.emit("device", kind);
        if (kind === "audioinput") this.resync("noise");
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.emit("audio"));
  }
}

export function createCall(grant: JoinGrant, choices: JoinChoices): RtcCall {
  if (grant.provider !== "livekit") throw new Error("This build is set up for LiveKit.");
  return new LiveKitCall(grant, choices);
}
