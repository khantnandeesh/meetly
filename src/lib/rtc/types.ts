/**
 * The call, as the interface sees it. Nothing here names a media provider: the LiveKit and
 * RealtimeKit adapters (./livekit.ts, ./realtimekit.ts) both implement `RtcCall`, and components
 * and hooks import only from this file and ./react.
 *
 * It covers what the UI uses and no more. If a component needs something new, add it here first
 * and implement it in both adapters.
 */

export type RtcProviderName = "livekit" | "realtimekit";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

/** Why the call ended for you: you left, the host removed you, or the connection was lost. */
export type DisconnectReason = "left" | "removed" | "dropped";

/** Also the value of `data-source` on a tile, which the stylesheet and the stage key on. */
export type TileSource = "camera" | "screen_share";

export type DeviceKind = "audioinput" | "videoinput" | "audiooutput";

export type LocalSource = "microphone" | "camera" | "screen_share";

/**
 * One person in the call. The object is the same for as long as they are in it, and its
 * properties are read live, so it can be used as a key and subscribed to on its own: one person
 * talking re-renders one tile, not the call.
 */
export interface RtcParticipant {
  /** Stable for the length of the call, minted by our server. Empty for you until connected. */
  readonly identity: string;
  readonly isLocal: boolean;
  /** Display name as entered; may be empty (see `displayName`). */
  readonly name: string;
  readonly micOn: boolean;
  readonly camOn: boolean;
  readonly handRaised: boolean;
  readonly speaking: boolean;
  /** Their connection is poor or lost. */
  readonly weakConnection: boolean;
  /** Called when any of the properties above changes. */
  subscribe(listener: () => void): () => void;
}

/** A camera or screen picture that can be shown in a `<video>`. */
export interface RtcVideoTrack {
  /** Shows the picture in `element` (now, or as soon as it is available). Returns the undo. */
  attach(element: HTMLVideoElement): () => void;
  /** Picture size, when the provider knows it. Used to shape a screen share's box. */
  readonly dimensions?: { width: number; height: number };
}

/**
 * Something the stage can show: every participant has a camera tile (with a track once their
 * camera is published), and one more for each screen being shared.
 */
export type RtcTile = {
  participant: RtcParticipant;
  source: TileSource;
  /** Absent while there is nothing to show (camera never turned on, or not being received). */
  track?: RtcVideoTrack;
};

export type RtcChatMessage = {
  id: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  message: string;
  from?: { identity: string; name: string; isLocal: boolean };
};

export type RtcEvents = {
  /** `status` changed. */
  status: [];
  /** The call is over for you. Fires once per connection; not when you unmount the call. */
  disconnected: [reason: DisconnectReason];
  /** Something failed that the user should be told about (could not connect, device error). */
  error: [error: Error];
  /** The list from `participants()` changed: someone came, went, was renamed or moved a hand. */
  roster: [];
  participantJoined: [participant: RtcParticipant];
  participantLeft: [participant: RtcParticipant];
  /** The list from `tiles()` changed. */
  tiles: [];
  /** The list from `activeSpeakers()` changed. */
  speakers: [];
  /** Somebody (possibly you) raised a hand. */
  handRaised: [participant: RtcParticipant];
  /** Somebody (possibly you) started or stopped sharing a screen. */
  screenShare: [started: boolean];
  /** `localMedia()` changed. */
  localMedia: [];
  /** Your microphone was switched on or off after joining, by you or by the host. */
  localMic: [on: boolean];
  /** The device in use for `kind` changed. */
  device: [kind: DeviceKind];
  /** `chatMessages()` or `chatSending` changed. */
  chat: [];
  /** `hostIdentity` changed. */
  host: [];
  /** `audioBlocked` changed. */
  audio: [];
};

export type RtcEventName = keyof RtcEvents;

export type LocalMedia = { microphone: boolean; camera: boolean; screenShare: boolean };

export interface RtcCall {
  readonly provider: RtcProviderName;
  /** The provider's own room or meeting object. For debugging and tests only, never for UI. */
  readonly native: unknown;

  /* connection */
  readonly status: ConnectionStatus;
  /** Starts connecting. Safe to call again after `disconnect()`. */
  connect(): void;
  /** Leaves the call. */
  disconnect(): Promise<void>;

  /* people */
  readonly local: RtcParticipant;
  /** You first, then everyone else in a stable order. A new array whenever `roster` fires. */
  participants(): RtcParticipant[];
  /** Identities of everyone but you, in the same order. Read live. */
  remoteIds(): string[];
  participant(identity: string): RtcParticipant | undefined;
  /** Who the server made host, or null while unknown. Decided server-side; this only displays it. */
  readonly hostIdentity: string | null;

  /* pictures */
  /** A new array whenever `tiles` fires. */
  tiles(): RtcTile[];
  /** Tells the provider whose pictures are on screen, so the rest need not be streamed. */
  setVideoDemand(visibleRemoteIdentities: string[]): void;

  /* sound */
  /** Identities currently talking, most prominent first. May include you. Read live. */
  activeSpeakers(): string[];
  /** The browser is refusing to play other people's audio until the page is interacted with. */
  readonly audioBlocked: boolean;
  /** Call from a click to lift `audioBlocked`. */
  startAudio(): Promise<void>;

  /* your devices */
  /** A new object whenever `localMedia` fires. */
  localMedia(): LocalMedia;
  /** Rejects if the device could not be started (permission, in use, picker dismissed). */
  setEnabled(source: LocalSource, enabled: boolean): Promise<void>;
  /** The device id in use for `kind`, if the provider has picked or been given one. */
  activeDevice(kind: DeviceKind): string | undefined;
  setDevice(kind: DeviceKind, deviceId: string): Promise<void>;

  /* chat and hands */
  /** A new array whenever a message arrives. */
  chatMessages(): RtcChatMessage[];
  readonly chatSending: boolean;
  sendChat(text: string): Promise<void>;
  setHandRaised(raised: boolean): Promise<void>;

  on<E extends RtcEventName>(event: E, listener: (...args: RtcEvents[E]) => void): () => void;
}

/** What the pre-join screen hands over when the user presses Join. */
export type JoinChoices = {
  username: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId: string;
  videoDeviceId: string;
};

/** What POST /api/token returns, per provider. Opaque to components. */
export type JoinGrant =
  | { provider: "livekit"; token: string; serverUrl: string }
  | {
      provider: "realtimekit";
      authToken: string;
      /** Our own signed session, presented to /api/host. */
      session: string;
      participantId: string;
      meetingId: string;
      role: "host" | "guest";
      /** Preset name that marks a participant as host, so guests can show who it is. */
      hostPreset: string;
    };

export type RtcProviderModule = {
  createCall(grant: JoinGrant, choices: JoinChoices): RtcCall;
};

export function displayName(participant: Pick<RtcParticipant, "name">): string {
  return participant.name || "Guest";
}
