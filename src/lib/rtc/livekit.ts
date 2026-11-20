import { setupChat } from "@livekit/components-core";
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason as LiveKitDisconnectReason,
  ParticipantEvent,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  getBrowser,
  type Participant,
  type RemoteTrack,
  type TrackPublication,
} from "livekit-client";
import { RtcEmitter } from "./emitter";
import { ADMIT_TOPIC, REACTION_MESSAGE, createReactionLimits, isReaction, postHost } from "./shared";
import type {
  ConnectionStatus,
  DeviceKind,
  DisconnectReason,
  HostAction,
  JoinAccess,
  JoinChoices,
  JoinGrant,
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

/** The part of the meeting's record (room metadata, written by our server only) that clients show. */
type Meta = { host: string | null; coHosts: string[]; access: JoinAccess };
const NO_META: Meta = { host: null, coHosts: [], access: "open" };

function readMeta(metadata: string | undefined): Meta {
  try {
    const value = JSON.parse(metadata || "{}");
    if (typeof value !== "object" || value === null) return NO_META;
    return {
      host: typeof value.host === "string" ? value.host : null,
      coHosts: Array.isArray(value.cohosts) ? value.cohosts.filter((id: unknown): id is string => typeof id === "string") : [],
      access: value.access === "ask" || value.access === "locked" ? value.access : "open",
    };
  } catch {
    return NO_META;
  }
}

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
  private messages: RtcChatMessage[] = [];
  private sending = false;
  private sendMessage: ((text: string) => Promise<unknown>) | null = null;
  private chatSubscriptions: { unsubscribe(): void }[] = [];
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

  constructor(
    private readonly grant: Extract<JoinGrant, { provider: "livekit" }>,
    private readonly choices: JoinChoices,
  ) {
    super();
    this.native = new Room({
      adaptiveStream: true, // only pull the resolution each tile actually needs
      dynacast: true, // stop publishing layers nobody is watching
      publishDefaults: { simulcast: true },
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
    this.startChat();
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
    await postHost({ token: this.token, ...action });
  }

  /** Follows the room's metadata, and says what changed. */
  private readMeta(): void {
    const next = readMeta(this.native.metadata);
    const last = this.meta;
    this.meta = next;
    const roles = next.host !== last.host || next.coHosts.join() !== last.coHosts.join();
    if (roles) this.emit("host");
    if (next.access !== last.access) this.emit("access");
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
    else if (source === "camera") await local.setCameraEnabled(enabled);
    else await local.setScreenShareEnabled(enabled, { audio: true, selfBrowserSurface: "include" });
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

  /* ---------------------------------------------------------- chat and hands */

  /**
   * LiveKit's own chat protocol (text streams, plus the older data-channel topic), so Meetly
   * keeps talking to any other LiveKit client in the room.
   */
  private startChat(): void {
    if (this.sendMessage) return;
    const chat = setupChat(this.native);
    this.sendMessage = chat.send;
    this.chatSubscriptions = [
      chat.messageObservable.subscribe((list) => {
        this.messages = list.map((message) => ({
          id: message.id,
          timestamp: message.timestamp,
          message: message.message,
          from: message.from && {
            identity: message.from.identity,
            name: message.from.name ?? "",
            isLocal: message.from.isLocal,
          },
        }));
        this.emit("chat");
      }),
      chat.isSendingObservable.subscribe((sending) => {
        if (sending === this.sending) return;
        this.sending = sending;
        this.emit("chat");
      }),
    ];
  }

  chatMessages(): RtcChatMessage[] {
    return this.messages;
  }

  get chatSending(): boolean {
    return this.sending;
  }

  async sendChat(text: string): Promise<void> {
    if (!this.sendMessage) throw new Error("Not connected.");
    await this.sendMessage(text);
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
        Promise.all([
          local.setMicrophoneEnabled(audioEnabled, audioEnabled ? { deviceId: audioDeviceId || undefined } : undefined),
          local.setCameraEnabled(videoEnabled, videoEnabled ? { deviceId: videoDeviceId || undefined } : undefined),
        ]).catch((error) => this.emit("error", error instanceof Error ? error : new Error(String(error))));
      })
      .on(RoomEvent.ConnectionStateChanged, () => {
        this.emit("status");
        rosterChanged();
        tilesChanged();
        this.emit("host");
        this.readMeta();
      })
      .on(RoomEvent.Connected, this.sweepUnattached)
      .on(RoomEvent.Disconnected, (reason) => {
        // The chat helper tears itself down with the room; a later connect() starts it afresh.
        this.chatSubscriptions.forEach((subscription) => subscription.unsubscribe());
        this.chatSubscriptions = [];
        this.sendMessage = null;
        this.audioSink?.remove();
        this.audioSink = null;
        this.stopLobbyWatch();
        this.emit("disconnected", whyDisconnected(reason, false));
      })
      .on(RoomEvent.RoomMetadataChanged, () => this.readMeta())
      .on(RoomEvent.DataReceived, (payload, sender, _kind, topic) => {
        // The sender is named by LiveKit, not by the message, so it cannot be somebody else's.
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
        if (publication.source === Track.Source.Microphone) this.emit("localMic", true);
      })
      .on(RoomEvent.ActiveSpeakersChanged, () => this.emit("speakers"))
      .on(RoomEvent.ActiveDeviceChanged, (kind) => this.emit("device", kind))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.emit("audio"));
  }
}

export function createCall(grant: JoinGrant, choices: JoinChoices): RtcCall {
  if (grant.provider !== "livekit") throw new Error("This build is set up for LiveKit.");
  return new LiveKitCall(grant, choices);
}
