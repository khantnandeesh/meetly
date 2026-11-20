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
 * did not let you in ("denied"), or the host ended the call for everyone ("ended"). A webinar is
 * also ended for everyone when it reaches its free time limit ("limit") or when webinars are
 * switched off ("paused"); see src/lib/costGuard.server.ts.
 */
export type DisconnectReason = "left" | "removed" | "dropped" | "denied" | "ended" | "limit" | "paused";

/** Who may join: anyone with the link, people the host lets in one by one, or nobody new. */
export type JoinAccess = "open" | "ask" | "locked";

/**
 * What kind of call this is, fixed when the link is made. In a webinar most people only watch:
 * they have no microphone, camera or tile until the host brings them on stage.
 */
export type CallMode = "meeting" | "webinar";

/**
 * What someone may do in the call. Everyone in a meeting is a "speaker" except the host. In a
 * webinar the audience are "viewer"s, and a viewer the host brings on stage becomes a "speaker".
 * Co-hosts keep the role they have; `coHosts()` says who they are.
 */
export type ParticipantRole = "host" | "speaker" | "viewer";

/** What the pre-join screen may know about a meeting before asking to join it. */
export type MeetingPeek = {
  access: JoinAccess;
  /** This browser made the meeting. */
  host: boolean;
  /** How many people are in it right now, or null where the provider cannot say cheaply. */
  count: number | null;
  /** A meeting or a webinar, as its record says. Absent means "meeting". */
  mode?: CallMode;
};

/**
 * Something the host (or, for all but `end` and `coHost`, a co-host) asks for. It is a request:
 * our server decides, from the caller's signed token, whether it happens.
 */
export type HostAction =
  | { action: "mute" | "remove" | "stopCamera" | "lowerHand" | "admit" | "deny"; identity: string }
  /**
   * Answers everyone in `identities` (ids from `waiting()`) with one request to our server. If some
   * fail, it rejects once, saying how many, with a `BulkError` whose `failed` lists who.
   */
  | { action: "admitAll" | "denyAll"; identities: string[] }
  | { action: "muteAll" | "lowerAllHands" }
  | { action: "access"; access: JoinAccess }
  | { action: "end" }
  | { action: "coHost"; identity: string; on: boolean }
  /** Shows one chat message above the conversation for everyone; null takes it down again. */
  | { action: "pin"; messageId: string | null }
  /** Stops a poll taking votes. Its result stays where it is. */
  | { action: "closePoll"; pollId: string }
  /** Lets everyone send reactions, or stops them. See `reactionsAllowed`. */
  | { action: "reactions"; allowed: boolean }
  /** Webinars: invites a viewer to speak (`on`), or sends a speaker back to the audience. */
  | { action: "stage"; identity: string; on: boolean };

/** Someone asking to join. `id` is what `admit` and `deny` take as `identity`. */
export type RtcWaiter = {
  id: string;
  name: string;
  /**
   * When they started waiting, in milliseconds since the epoch. Where the provider does not say,
   * it is when this browser first saw them asking, so it can be later than the truth.
   */
  since: number;
};

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
  /**
   * What they may do in the call. Read live; a change is announced by the `host` or `stage`
   * event, not by `subscribe`.
   */
  readonly role: ParticipantRole;
  /**
   * Webinars: the host has invited them on stage and they have not answered yet (they are still a
   * "viewer"). Always false in a meeting. Read live; a change is announced by the `stage` event.
   */
  readonly stageInvite: boolean;
}

/** You, as `RtcCall.local` has you. Your own `stageInvite` is also announced by `subscribe`. */
export interface RtcLocalParticipant extends RtcParticipant {
  readonly stageInvite: boolean;
}

/** A camera or screen picture that can be shown in a `<video>`. */
export interface RtcVideoTrack {
  /** Shows the picture in `element` (now, or as soon as it is available). Returns the undo. */
  attach(element: HTMLVideoElement): () => void;
  /** Picture size, when the provider knows it. Used to shape a screen share's box. */
  readonly dimensions?: { width: number; height: number };
}

/**
 * Something the stage can show: every participant but a viewer has a camera tile (with a track
 * once their camera is published), and one more for each screen being shared.
 */
export type RtcTile = {
  participant: RtcParticipant;
  source: TileSource;
  /** Absent while there is nothing to show (camera never turned on, or not being received). */
  track?: RtcVideoTrack;
  /**
   * Set by the interface, never by an adapter: this picture is deliberately not being shown
   * ("use less data"), so it should not be asked for either.
   */
  withheld?: boolean;
};

export type RtcChatMessage = {
  id: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  /** Empty once the message has been deleted. */
  message: string;
  /** `isLocal`: you wrote it, in this browser, now or before a reload. */
  from?: { identity: string; name: string; isLocal: boolean };
  /** Sent before you joined: history, not news. Never counted as unread or announced. */
  earlier?: boolean;
  /** Its author took it back. The entry stays, so the conversation keeps its shape. */
  deleted?: boolean;
};

/** Limits on a poll, enforced wherever a poll is made. */
export const POLL_LIMITS = { question: 140, option: 80, minOptions: 2, maxOptions: 6, open: 5 } as const;

/** A question put to everyone in the call, with a few answers to choose from. */
export type RtcPoll = {
  id: string;
  question: string;
  /** Name of whoever started it, for display. */
  createdBy: string;
  /** Votes are counted without saying whose they are. */
  anonymous: boolean;
  /** Still taking votes. */
  open: boolean;
  options: {
    text: string;
    votes: number;
    /** Names of people who chose this, as far as they are known. Always empty when `anonymous`. */
    voters: string[];
  }[];
  /** Votes cast so far, over all options. */
  total: number;
  /** You have voted in this poll (from this browser, now or before a reload). */
  voted: boolean;
  /** The option you chose, when that is known. */
  myVote?: number;
};

export type NewPoll = { question: string; options: string[]; anonymous: boolean };

/** How your own connection to the call is doing, as the provider judges it. */
export type ConnectionHealth = "unknown" | "good" | "fair" | "poor";

export type CallQuality = {
  connection: ConnectionHealth;
  /** "Use less data" is on: your camera is sent smaller, and the interface asks for fewer pictures. */
  dataSaver: boolean;
};

/** Numbers behind `CallQuality`, for the person who wants them. Null where the provider does not say. */
export type CallStats = {
  sentKbps: number | null;
  receivedKbps: number | null;
  roundTripMs: number | null;
  /** Share of what you send that is being lost on the way, in percent. */
  lossPercent: number | null;
  /** Your camera as it is being sent (its largest version). */
  sentVideo: { width: number; height: number; fps: number | null } | null;
};

/** What is done to your camera picture before anyone else sees it. */
export type BackgroundMode = "none" | "light" | "blur";

/**
 * What is being done to your microphone and camera before they are sent. All of it happens in
 * this browser; nothing is sent anywhere to be processed.
 */
export type LocalEffects = {
  /** What you asked for. */
  noiseSuppression: boolean;
  /**
   * What is running: "enhanced" is our own filter on top of the browser's, "basic" the browser's
   * alone (the filter could not start here), "off" neither.
   */
  noiseState: "off" | "basic" | "enhanced";
  /** What you asked for. */
  background: BackgroundMode;
  /** "starting" while the model loads; "on" once what leaves this browser is blurred. */
  backgroundState: "off" | "starting" | "on";
  /** Why this browser cannot blur the background, when it cannot. */
  backgroundUnavailable?: string;
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
  /** `chatMessages()`, `pinnedMessage()` or `chatSending` changed. */
  chat: [];
  /** `localEffects()` changed. */
  effects: [];
  /** Blurring kept the camera under a usable frame rate, so it was switched off. `mode` is what was on. */
  backgroundTooSlow: [mode: BackgroundMode];
  /** `hostIdentity` or `coHosts()` changed. */
  host: [];
  /** `access` changed. */
  access: [];
  /** The list from `waiting()` changed. */
  waiting: [];
  /** Somebody (possibly you) sent a reaction. `emoji` is always one of `REACTIONS`. */
  reaction: [participant: RtcParticipant, emoji: string];
  /** `reactionsAllowed` changed. */
  reactionsAllowed: [];
  /** Somebody's `role`, or your `stageInvite`, changed. */
  stage: [];
  /** `limitWarning` changed. */
  limitWarning: [];
  /** `audioBlocked` changed. */
  audio: [];
  /** The list from `polls()` changed. */
  polls: [];
  /** `quality()` changed. */
  quality: [];
};

export type RtcEventName = keyof RtcEvents;

export type LocalMedia = { microphone: boolean; camera: boolean; screenShare: boolean };

export interface RtcCall {
  readonly provider: RtcProviderName;
  /** The provider's own room or meeting object. For debugging and tests only, never for UI. */
  readonly native: unknown;
  /** A meeting or a webinar. It never changes during the call. */
  readonly mode: CallMode;
  /**
   * Webinars: you were just made co-host ("cohost"), or are no longer one ("audience"), and the
   * call is reconnecting you with what that role needs. Null otherwise. A change is announced by
   * the `status` event; the call stays the same object throughout.
   */
  readonly switching: "cohost" | "audience" | null;

  /* connection */
  readonly status: ConnectionStatus;
  /** Starts connecting. Safe to call again after `disconnect()`. */
  connect(): void;
  /** Leaves the call. */
  disconnect(): Promise<void>;

  /* people */
  readonly local: RtcLocalParticipant;
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
   * A webinar near its free time limit: when it is expected to end (epoch ms), as our server's
   * watchdog worked it out. Only the host and co-hosts are told; null otherwise, and always on
   * LiveKit, where nothing is billed by the minute.
   */
  readonly limitWarning: { endsAt: number } | null;
  /**
   * Asks our server for a moderation action and does whatever the provider needs around it.
   * Rejects with a message fit to show if it was refused or failed.
   */
  moderate(action: HostAction): Promise<void>;
  /**
   * What depends on how the provider is set up. Everything else is always available. `polls`:
   * this call has polls at all; `createPolls`: the provider would let you start one (our server
   * still decides whether you may). `stage`: this is a webinar and the provider would let you
   * invite people on stage or send them back (our server still decides whether you may).
   */
  readonly supports: { askToJoin: boolean; stopCamera: boolean; polls: boolean; createPolls: boolean; stage: boolean };

  /* pictures */
  /** Never includes a viewer. A new array whenever `tiles` fires. */
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
  /** A new object whenever `effects` fires. */
  localEffects(): LocalEffects;
  /** Background noise is filtered out of your microphone, or (off) it is sent as it is. Never rejects. */
  setNoiseSuppression(on: boolean): Promise<void>;
  /**
   * Blurs what is behind you, camera only. Rejects with a message fit to show if it could not be
   * started; the camera then carries on as it was.
   */
  setBackground(mode: BackgroundMode): Promise<void>;

  /* chat and hands */
  /** Oldest first, including what was said before you joined. A new array whenever `chat` fires. */
  chatMessages(): RtcChatMessage[];
  readonly chatSending: boolean;
  sendChat(text: string): Promise<void>;
  /** The message a host put above the conversation, if any. Pinning is `moderate({ action: "pin" })`. */
  pinnedMessage(): RtcChatMessage | null;
  /** Takes back a message of your own, for everyone. Rejects for anybody else's. */
  deleteChatMessage(id: string): Promise<void>;
  setHandRaised(raised: boolean): Promise<void>;
  /** Shows `emoji` (one of `REACTIONS`) to everyone for a moment. Nothing is stored. */
  sendReaction(emoji: string): Promise<void>;
  /**
   * The host lets people send reactions, as the meeting's record says; `reactionsAllowed` fires
   * when it changes. While it is false, only the host and co-hosts can send one, and a reaction
   * from anyone else is dropped on arrival. Each browser keeps to it for itself; nothing on a
   * server stops a modified client sending one anyway.
   */
  readonly reactionsAllowed: boolean;

  /* polls */
  /** Oldest first, including what was started before you joined. A new array whenever `polls` fires. */
  polls(): RtcPoll[];
  /** Starts a poll. Rejects with a message fit to show if you may not, or it is not a valid poll. */
  createPoll(poll: NewPoll): Promise<void>;
  /** Casts your one vote. Rejects with a message fit to show if it was not counted. */
  votePoll(pollId: string, option: number): Promise<void>;

  /* how the call is doing */
  /** A new object whenever `quality` fires. */
  quality(): CallQuality;
  /** Sends your camera smaller (and, with the interface's help, receives fewer pictures). Never rejects. */
  setDataSaver(on: boolean): Promise<void>;
  /** A fresh measurement. Never rejects; what cannot be measured is null. */
  stats(): Promise<CallStats>;

  on<E extends RtcEventName>(event: E, listener: (...args: RtcEvents[E]) => void): () => void;
}

/** What the pre-join screen hands over when the user presses Join. */
export type JoinChoices = {
  username: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId: string;
  videoDeviceId: string;
  /** Start with these already applied (see `LocalEffects`). Absent means noise suppression on, no blur. */
  noiseSuppression?: boolean;
  background?: BackgroundMode;
};

/** What POST /api/token returns, per provider. Opaque to components. */
export type JoinGrant =
  | {
      provider: "livekit";
      token: string;
      serverUrl: string;
      /** The token opens the lobby, not the meeting: this person has to be let in first. */
      lobby?: boolean;
      /** Absent means "meeting". */
      mode?: CallMode;
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
      /** Id of the pinned chat message at the moment of joining, if any. */
      pin?: string | null;
      /** Ids of polls that had been ended at the moment of joining. */
      closedPolls?: string[];
      /** Reactions allowed at the moment of joining. Absent means allowed. */
      reactions?: boolean;
      /** Absent means "meeting". */
      mode?: CallMode;
      /** Webinars: the audience's preset and a co-host's, so the client knows which one it holds. */
      webinarPresets?: { viewer: string; cohost: string };
    };

export type RtcProviderModule = {
  createCall(grant: JoinGrant, choices: JoinChoices): RtcCall;
};

export function displayName(participant: Pick<RtcParticipant, "name">): string {
  return participant.name || "Guest";
}
