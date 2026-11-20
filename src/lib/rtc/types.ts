/**
 * The call, as the interface sees it. Nothing here names a media provider: the LiveKit and
 * RealtimeKit adapters (./livekit.ts, ./realtimekit.ts) both implement `RtcCall`, and components
 * and hooks import only from this file and ./react.
 *
 * It covers what the UI uses and no more. If a component needs something new, add it here first
 * and implement it in both adapters.
 */

export type RtcProviderName = "livekit" | "realtimekit";

/**
 * "waiting": you asked to join and nobody has answered yet. You are not in the call: you see and
 * hear nothing of it, and only the host and co-hosts are shown that you are there.
 */
export type ConnectionStatus = "connecting" | "waiting" | "connected" | "reconnecting" | "disconnected";

/**
 * Why the call ended for you: you left, the host removed you, the connection was lost, the host
 * did not let you in ("denied"), or the host ended the call for everyone ("ended").
 */
export type DisconnectReason = "left" | "removed" | "dropped" | "denied" | "ended";

/** Who may join: anyone with the link, people the host lets in one by one, or nobody new. */
export type JoinAccess = "open" | "ask" | "locked";

/**
 * Something the host (or, except for the last two kinds, a co-host) asks for. It is a request:
 * our server decides, from the caller's signed token, whether it happens.
 */
export type HostAction =
  | { action: "mute" | "remove" | "stopCamera" | "lowerHand" | "admit" | "deny"; identity: string }
  | { action: "muteAll" | "lowerAllHands" }
  | { action: "access"; access: JoinAccess }
  | { action: "end" }
  | { action: "coHost"; identity: string; on: boolean };

/** Someone asking to join. `id` is what `admit` and `deny` take as `identity`. */
export type RtcWaiter = { id: string; name: string };

/** The reactions that can be sent. Anything else is dropped on arrival. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "👏", "🎉"] as const;

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
  /** `hostIdentity` or `coHosts()` changed. */
  host: [];
  /** `access` changed. */
  access: [];
  /** The list from `waiting()` changed. */
  waiting: [];
  /** Somebody (possibly you) sent a reaction. `emoji` is always one of `REACTIONS`. */
  reaction: [participant: RtcParticipant, emoji: string];
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
  /** Identities the host made co-host, as the server recorded it. A new array whenever `host` fires. */
  coHosts(): string[];
  /** Who may join right now, as far as this client has been told. */
  readonly access: JoinAccess;
  /** People asking to join. Empty unless you are the host or a co-host. A new array whenever `waiting` fires. */
  waiting(): RtcWaiter[];
  /**
   * Asks our server for a moderation action and does whatever the provider needs around it.
   * Rejects with a message fit to show if it was refused or failed.
   */
  moderate(action: HostAction): Promise<void>;
  /** Moderation that depends on how the provider is set up. Everything else is always available. */
  readonly supports: { askToJoin: boolean; stopCamera: boolean };

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
  /** Shows `emoji` (one of `REACTIONS`) to everyone for a moment. Nothing is stored. */
  sendReaction(emoji: string): Promise<void>;

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
  | {
      provider: "livekit";
      token: string;
      serverUrl: string;
      /** The token opens the lobby, not the meeting: this person has to be let in first. */
      lobby?: boolean;
    }
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
      /** Co-hosts and join access at the moment of joining; the adapter asks again when told they changed. */
      coHosts: string[];
      access: JoinAccess;
      /** The app has a preset whose holders wait to be let in, so "ask to join" can be offered. */
      canAsk: boolean;
    };

export type RtcProviderModule = {
  createCall(grant: JoinGrant, choices: JoinChoices): RtcCall;
};

export function displayName(participant: Pick<RtcParticipant, "name">): string {
  return participant.name || "Guest";
}
