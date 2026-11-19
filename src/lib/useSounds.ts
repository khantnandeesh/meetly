"use client";

import { ConnectionState, RoomEvent, Track, type Participant, type Room, type TrackPublication } from "livekit-client";
import { useEffect, useSyncExternalStore } from "react";
import { SOUND_DEFAULTS, sounds, type SoundSettings } from "./sounds";

/** Past this many people, comings and goings are shown (toasts) but no longer heard. */
export const PRESENCE_SOUND_LIMIT = 8;
/** Nothing about other people sounds until the room has settled after you join. */
const SETTLE_MS = 2500;
/** A microphone that goes off this long after your last own toggle was not switched off by you. */
const OWN_TOGGLE_MS = 1500;

/** The user's sound level and volume, shared with the engine and remembered in this browser. */
export function useSoundSettings(): [SoundSettings, (patch: Partial<SoundSettings>) => void] {
  const settings = useSyncExternalStore(
    sounds.subscribe,
    () => sounds.getSettings(),
    () => SOUND_DEFAULTS,
  );
  return [settings, sounds.setSettings];
}

/* ------------------------------------------------- provider-neutral policy */

let ownMicToggleAt = -Infinity;
/** Call from every control that toggles your own microphone, so a host mute can be told apart. */
export function noteOwnMicToggle(): void {
  ownMicToggleAt = performance.now();
}

/**
 * What the call sounds like, in terms of things that happen in a call rather than any media
 * provider's events. Whatever connects to the call (LiveKit today) reports to these; they hold
 * the rules: who hears what, the settle time after joining, bursts, and the large-call limit.
 */
export function createCallSounds(headcount: () => number) {
  const startedAt = performance.now();
  const settled = () => performance.now() - startedAt > SETTLE_MS;
  let lost = false;

  // Presence sounds accompany a tile arriving or leaving in front of you, so the stage reports
  // them (see notePresence). The engine's own minimum gap makes a burst one sound, played at
  // the start of the movement rather than after it.
  const presence = (name: "joined" | "left") => {
    if (!settled()) return sounds.skipped(name, "settling");
    if (headcount() > PRESENCE_SOUND_LIMIT) return sounds.skipped(name, "large-call");
    sounds.play(name);
  };
  const whenSettled = (name: "hand" | "shareStart" | "shareStop") =>
    settled() ? sounds.play(name) : sounds.skipped(name, "settling");

  return {
    /** You are in the call. Also right after a dropped connection comes back. */
    onConnected() {
      lost = false;
      sounds.play("connected");
    },
    onConnectionLost() {
      if (!lost) sounds.play("connectionLost");
      lost = true;
    },
    onConnectionRestored() {
      if (lost) sounds.play("connected");
      lost = false;
    },
    /** Somebody's tile appeared on, or left, the part of the stage you can see. */
    onVisibleArrival: () => presence("joined"),
    onVisibleDeparture: () => presence("left"),
    onHandRaised: () => whenSettled("hand"),
    onScreenShareStarted: () => whenSettled("shareStart"),
    onScreenShareStopped: () => whenSettled("shareStop"),
    /**
     * Your microphone changed. Off without a recent toggle of your own means the host did it:
     * that gets its own sound instead of the usual tick, never both. Returns true in that case.
     */
    onOwnMicChanged(on: boolean): boolean {
      if (on) {
        sounds.play("micOn");
        return false;
      }
      if (performance.now() - ownMicToggleAt > OWN_TOGGLE_MS && settled()) {
        sounds.play("mutedByHost");
        return true;
      }
      sounds.play("micOff");
      return false;
    },
    onOutputDevice: (deviceId: string) => sounds.setOutputDevice(deviceId),

  };
}

let activeCall: ReturnType<typeof createCallSounds> | null = null;
/** Report a join or leave whose tile is in view. Anything not in view gets a toast instead, never both. */
export function notePresence(kind: "joined" | "left"): void {
  if (kind === "joined") activeCall?.onVisibleArrival();
  else activeCall?.onVisibleDeparture();
}

let lastMessageAt = -Infinity;
/** How long chat must have been quiet for the next message to be heard. */
const CHAT_QUIET_MS = 4000;
/**
 * A chat message arrived while chat was closed. Call where the chat toast is raised.
 * Only the first message after a quiet spell sounds: a busy chat is not a row of chimes.
 */
export function playChatMessageSound(): void {
  const now = performance.now();
  const quiet = now - lastMessageAt > CHAT_QUIET_MS;
  lastMessageAt = now;
  if (quiet) sounds.play("message");
  else sounds.skipped("message", "busy-chat");
}

/** The call is over for you (you left, were removed, or it dropped for good). */
export function playCallEndedSound(): void {
  sounds.play("ended");
  sounds.suspend();
}

/* ---------------------------------------------------------- LiveKit adapter */

const HAND = "hand";

/**
 * Feeds the call sounds from a LiveKit room. Mount once inside the call. This is the only part
 * that knows LiveKit: it translates room events into the neutral calls above and nothing else.
 */
export function useCallSounds(room: Room, { onHostMuted }: { onHostMuted?: () => void } = {}): void {
  useEffect(() => {
    const call = createCallSounds(() => room.remoteParticipants.size + 1);
    activeCall = call;

    let wasConnected = room.state === ConnectionState.Connected;
    if (wasConnected) call.onConnected();
    const onConnection = (state: ConnectionState) => {
      if (state === ConnectionState.Connected) {
        if (wasConnected) call.onConnectionRestored();
        else call.onConnected();
        wasConnected = true;
      } else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
        call.onConnectionLost();
      }
    };
    const onAttributes = (changed: Record<string, string>, participant: Participant) => {
      if (changed[HAND] === "1" && !participant.isLocal) call.onHandRaised();
    };
    const isScreen = (publication: TrackPublication) => publication.source === Track.Source.ScreenShare;
    const shareStarted = (publication: TrackPublication) => {
      if (isScreen(publication)) call.onScreenShareStarted();
    };
    const shareStopped = (publication: TrackPublication) => {
      if (isScreen(publication)) call.onScreenShareStopped();
    };
    const isOwnMic = (publication: TrackPublication, participant: Participant) =>
      participant.isLocal && publication.source === Track.Source.Microphone;
    const onMuted = (publication: TrackPublication, participant: Participant) => {
      if (isOwnMic(publication, participant) && call.onOwnMicChanged(false)) onHostMuted?.();
    };
    const onUnmuted = (publication: TrackPublication, participant: Participant) => {
      if (isOwnMic(publication, participant)) call.onOwnMicChanged(true);
    };
    const onDevice = (kind: MediaDeviceKind, deviceId: string) => {
      if (kind === "audiooutput") call.onOutputDevice(deviceId);
    };
    const current = room.getActiveDevice("audiooutput");
    if (current) call.onOutputDevice(current);

    room.on(RoomEvent.ConnectionStateChanged, onConnection);
    room.on(RoomEvent.ParticipantAttributesChanged, onAttributes);
    room.on(RoomEvent.TrackPublished, shareStarted);
    room.on(RoomEvent.LocalTrackPublished, shareStarted);
    room.on(RoomEvent.TrackUnpublished, shareStopped);
    room.on(RoomEvent.LocalTrackUnpublished, shareStopped);
    room.on(RoomEvent.TrackMuted, onMuted);
    room.on(RoomEvent.TrackUnmuted, onUnmuted);
    room.on(RoomEvent.ActiveDeviceChanged, onDevice);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnection);
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributes);
      room.off(RoomEvent.TrackPublished, shareStarted);
      room.off(RoomEvent.LocalTrackPublished, shareStarted);
      room.off(RoomEvent.TrackUnpublished, shareStopped);
      room.off(RoomEvent.LocalTrackUnpublished, shareStopped);
      room.off(RoomEvent.TrackMuted, onMuted);
      room.off(RoomEvent.TrackUnmuted, onUnmuted);
      room.off(RoomEvent.ActiveDeviceChanged, onDevice);
      if (activeCall === call) activeCall = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onHostMuted is read when it fires
  }, [room]);
}
