"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  CallQuality,
  ConnectionStatus,
  DeviceKind,
  DisconnectReason,
  JoinAccess,
  LocalEffects,
  LocalMedia,
  LocalSource,
  RtcCall,
  RtcChatMessage,
  RtcEventName,
  RtcParticipant,
  RtcPoll,
  RtcTile,
  RtcVideoTrack,
  RtcWaiter,
} from "./types";

const CallContext = createContext<RtcCall | null>(null);

/** When this browser was first let into each call (epoch ms). Asking to join is not being in. */
const arrivals = new WeakMap<RtcCall, number>();

/**
 * When you were first let into `call`, noting it now if this is that moment; null until then.
 * Reconnecting, or changing role in a webinar, is not arriving again.
 */
function noteArrival(call: RtcCall): number | null {
  const known = arrivals.get(call);
  if (known !== undefined) return known;
  if (call.status !== "connected") return null;
  const now = Date.now();
  arrivals.set(call, now);
  return now;
}

export function useCall(): RtcCall {
  const call = useContext(CallContext);
  if (!call) throw new Error("useCall must be used inside <CallRoom>");
  return call;
}

/**
 * Connects `call` for as long as it is mounted and makes it available to everything inside.
 * Leaving the call (or losing it) is reported once through `onDisconnected`; unmounting this
 * component hangs up quietly.
 */
export function CallRoom({
  call,
  onConnected,
  onDisconnected,
  onError,
  children,
}: {
  call: RtcCall;
  onConnected: () => void;
  onDisconnected: (reason: DisconnectReason) => void;
  onError: (error: Error) => void;
  children: React.ReactNode;
}) {
  // Read when they fire, so a new callback identity never reconnects the call.
  const handlers = useRef({ onConnected, onDisconnected, onError });
  useEffect(() => {
    handlers.current = { onConnected, onDisconnected, onError };
  });

  useEffect(() => {
    // Once per connection: coming back from a reconnect is not a second arrival.
    let arrived = noteArrival(call) !== null;
    const stops = [
      call.on("status", () => {
        if (arrived || noteArrival(call) === null) return;
        arrived = true;
        handlers.current.onConnected();
      }),
      call.on("disconnected", (reason) => handlers.current.onDisconnected(reason)),
      call.on("error", (error) => handlers.current.onError(error)),
    ];
    // Connecting waits one tick. React's development mode mounts every effect twice in a row;
    // this way the throwaway first mount never dials, instead of dialling and hanging up.
    let dialled = false;
    const dial = setTimeout(() => {
      dialled = true;
      call.connect();
    }, 0);
    return () => {
      clearTimeout(dial);
      // Listeners go first, so hanging up on unmount is not mistaken for the call ending.
      stops.forEach((stop) => stop());
      if (dialled) call.disconnect().catch(() => {});
    };
  }, [call]);

  return <CallContext.Provider value={call}>{children}</CallContext.Provider>;
}

/** Subscribes to one or more call events and re-reads `read` when any of them fires. */
function useCallValue<T>(call: RtcCall, events: readonly RtcEventName[], read: () => T): T {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = events.map((event) => call.on(event, onChange));
      return () => stops.forEach((stop) => stop());
    },
    // `events` is always a module-level constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [call],
  );
  return useSyncExternalStore(subscribe, read, read);
}

const STATUS = ["status"] as const;
const ROSTER = ["roster"] as const;
const TILES = ["tiles"] as const;
const HOST = ["host", "status"] as const;
const LOCAL_MEDIA = ["localMedia"] as const;
const CHAT = ["chat"] as const;
const AUDIO = ["audio"] as const;
const EFFECTS = ["effects"] as const;
const DEVICE = ["device"] as const;
const POLLS = ["polls", "status"] as const;
const QUALITY = ["quality"] as const;

export function useConnectionStatus(): ConnectionStatus {
  const call = useCall();
  return useCallValue(call, STATUS, () => call.status);
}

/** When you were first let into the call (epoch ms), or null while connecting or asking to join. */
export function useJoinedAt(): number | null {
  const call = useCall();
  // Read through `noteArrival`: whichever listener hears "connected" first notes the moment.
  return useCallValue(call, STATUS, () => noteArrival(call));
}

/** Everyone in the call, you first. Changes when people come and go, are renamed or move a hand. */
export function useParticipants(): RtcParticipant[] {
  const call = useCall();
  return useCallValue(call, ROSTER, () => call.participants());
}

export function useTiles(): RtcTile[] {
  const call = useCall();
  return useCallValue(call, TILES, () => call.tiles());
}

export function useHostIdentity(): string | null {
  const call = useCall();
  return useCallValue(call, HOST, () => call.hostIdentity);
}

const ACCESS = ["access", "status"] as const;
const WAITING = ["waiting"] as const;

/** Identities of the co-hosts, as the server recorded them. */
export function useCoHosts(): string[] {
  const call = useCall();
  return useCallValue(call, HOST, () => call.coHosts());
}

export function useAccess(): JoinAccess {
  const call = useCall();
  return useCallValue(call, ACCESS, () => call.access);
}

/** People asking to join. Empty unless you are the host or a co-host. */
export function useWaiting(): RtcWaiter[] {
  const call = useCall();
  return useCallValue(call, WAITING, () => call.waiting());
}

const REACTIONS_ALLOWED = ["reactionsAllowed"] as const;
const MAY_REACT = ["reactionsAllowed", "host", "status"] as const;

/** The host lets everyone send reactions (the meeting's setting, whoever you are). */
export function useReactionsAllowed(): boolean {
  const call = useCall();
  return useCallValue(call, REACTIONS_ALLOWED, () => call.reactionsAllowed);
}

/** You may send a reaction now: reactions are allowed, or you are the host or a co-host. */
export function useCanReact(): boolean {
  const call = useCall();
  return useCallValue(call, MAY_REACT, () => {
    if (call.reactionsAllowed) return true;
    const me = call.local.identity;
    return !!me && (call.hostIdentity === me || call.coHosts().includes(me));
  });
}

export function useLocalMedia(): LocalMedia {
  const call = useCall();
  return useCallValue(call, LOCAL_MEDIA, () => call.localMedia());
}

export function useAudioBlocked(): boolean {
  const call = useCall();
  return useCallValue(call, AUDIO, () => call.audioBlocked);
}

export function useActiveDevice(kind: DeviceKind): string {
  const call = useCall();
  return useCallValue(call, DEVICE, () => call.activeDevice(kind) ?? "default");
}

/** What is being done to your own microphone and camera before they are sent. */
export function useLocalEffects(): LocalEffects {
  const call = useCall();
  return useCallValue(call, EFFECTS, () => call.localEffects());
}

/** The call's polls, oldest first. */
export function usePolls(): RtcPoll[] {
  const call = useCall();
  return useCallValue(call, POLLS, () => call.polls());
}

/** How your own connection is doing, and whether "use less data" is on. */
export function useCallQuality(): CallQuality {
  const call = useCall();
  return useCallValue(call, QUALITY, () => call.quality());
}

export function useChat(): {
  chatMessages: RtcChatMessage[];
  /** The message a host put above the conversation, if any. */
  pinned: RtcChatMessage | null;
  isSending: boolean;
  send: (text: string) => Promise<void>;
  /** Takes back one of your own messages, for everyone. */
  remove: (id: string) => Promise<void>;
} {
  const call = useCall();
  const chatMessages = useCallValue(call, CHAT, () => call.chatMessages());
  const pinned = useCallValue(call, CHAT, () => call.pinnedMessage());
  const isSending = useCallValue(call, CHAT, () => call.chatSending);
  const send = useCallback((text: string) => call.sendChat(text), [call]);
  const remove = useCallback((id: string) => call.deleteChatMessage(id), [call]);
  return { chatMessages, pinned, isSending, send, remove };
}

/**
 * One of your own devices as a toggle. `pending` is true while the device is starting or
 * stopping; a failure to start is passed to `onError` instead of being thrown.
 */
export function useLocalToggle(source: LocalSource, onError?: (error: Error) => void) {
  const call = useCall();
  const media = useLocalMedia();
  const [pending, setPending] = useState(false);
  const enabled = source === "microphone" ? media.microphone : source === "camera" ? media.camera : media.screenShare;
  const failed = useRef(onError);
  useEffect(() => {
    failed.current = onError;
  });
  const toggle = useCallback(async () => {
    const current = call.localMedia();
    const on = source === "microphone" ? current.microphone : source === "camera" ? current.camera : current.screenShare;
    setPending(true);
    try {
      await call.setEnabled(source, !on);
    } catch (error) {
      failed.current?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setPending(false);
    }
  }, [call, source]);
  return { enabled, pending, toggle };
}

/** One participant's live state. Re-renders only the component that asked, and only on a change. */
export function useParticipantState(participant: RtcParticipant) {
  const { subscribe } = participant;
  const name = useSyncExternalStore(subscribe, () => participant.name);
  const micOn = useSyncExternalStore(subscribe, () => participant.micOn);
  const camOn = useSyncExternalStore(subscribe, () => participant.camOn);
  const handRaised = useSyncExternalStore(subscribe, () => participant.handRaised);
  const speaking = useSyncExternalStore(subscribe, () => participant.speaking);
  const weakConnection = useSyncExternalStore(subscribe, () => participant.weakConnection);
  return { name, micOn, camOn, handRaised, speaking, weakConnection };
}

/** Shows `track` in the `<video>` behind `element` for as long as both stay the same. */
export function useVideoTrack(track: RtcVideoTrack, element: React.RefObject<HTMLVideoElement | null>): void {
  useEffect(() => {
    const video = element.current;
    if (!video) return;
    return track.attach(video);
  }, [track, element]);
}
