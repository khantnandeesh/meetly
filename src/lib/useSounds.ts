"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { RtcCall } from "./rtc/types";
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
 * provider's events. Whatever connects to the call reports to these (see below); they hold
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

/** Somebody new is asking to join. Call where the host's notification is raised. */
export function playKnockSound(): void {
  sounds.play("knock");
}

/** The call is over for you (you left, were removed, or it dropped for good). */
export function playCallEndedSound(): void {
  sounds.play("ended");
  sounds.suspend();
}

/* ------------------------------------------------------------ call adapter */

/**
 * Feeds the call sounds from the call. Mount once inside it. This is the only part that knows
 * the call's events: it translates them into the neutral calls above and nothing else.
 */
export function useCallSounds(call: RtcCall, { onHostMuted }: { onHostMuted?: () => void } = {}): void {
  useEffect(() => {
    const sound = createCallSounds(() => call.remoteIds().length + 1);
    activeCall = sound;

    let wasConnected = call.status === "connected";
    if (wasConnected) sound.onConnected();
    const current = call.activeDevice("audiooutput");
    if (current) sound.onOutputDevice(current);

    const stops = [
      call.on("status", () => {
        if (call.status === "connected") {
          if (wasConnected) sound.onConnectionRestored();
          else sound.onConnected();
          wasConnected = true;
        } else if (call.status === "reconnecting") {
          sound.onConnectionLost();
        }
      }),
      call.on("handRaised", (participant) => {
        if (!participant.isLocal) sound.onHandRaised();
      }),
      call.on("screenShare", (started) => {
        if (started) sound.onScreenShareStarted();
        else sound.onScreenShareStopped();
      }),
      call.on("localMic", (on) => {
        if (sound.onOwnMicChanged(on)) onHostMuted?.();
      }),
      call.on("device", (kind) => {
        const deviceId = kind === "audiooutput" ? call.activeDevice(kind) : undefined;
        if (deviceId) sound.onOutputDevice(deviceId);
      }),
    ];
    return () => {
      stops.forEach((stop) => stop());
      if (activeCall === sound) activeCall = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onHostMuted is read when it fires
  }, [call]);
}
