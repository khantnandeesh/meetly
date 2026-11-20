"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { RtcCall } from "./rtc/types";
import { SOUND_DEFAULTS, sounds, type SoundSettings } from "./sounds";

/** Past this many people, comings and goings are shown (toasts) but no longer heard. */
export const PRESENCE_SOUND_LIMIT = 8;
/**
 * Past this many people, only the host and co-hosts, who are the ones to answer, hear a hand go
 * up, and they at most once every HAND_SOUND_GAP_MS.
 */
export const HAND_SOUND_LIMIT = 24;
/**
 * Everyone else hears only the first hand after this long without one (Meet plays the first
 * hand only); it is also the moderators' gap in a large call. The hands button keeps the count.
 */
export const HAND_SOUND_GAP_MS = 30_000;
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

/** What the rules below play sounds through: the page's engine, or a stand-in in a test. */
export type SoundOutput = Pick<typeof sounds, "play" | "skipped" | "setOutputDevice">;

/**
 * What the call sounds like, in terms of things that happen in a call rather than any media
 * provider's events. Whatever connects to the call reports to these (see below); they hold
 * the rules: who hears what, the settle time after joining, bursts, and the large-call limit.
 * `output` and `now` are the engine and the clock, replaceable so a test can run the rules alone.
 */
export function createCallSounds(
  headcount: () => number,
  { output = sounds, now = () => performance.now() }: { output?: SoundOutput; now?: () => number } = {},
) {
  const startedAt = now();
  const settled = () => now() - startedAt > SETTLE_MS;
  let lost = false;
  // The last hand that went up, heard or not, and the last one a moderator heard in a large call.
  let lastHandAt = -Infinity;
  let lastLargeHandSoundAt = -Infinity;

  // Presence sounds accompany a tile arriving or leaving in front of you, so the stage reports
  // them (see notePresence). The engine's own minimum gap makes a burst one sound, played at
  // the start of the movement rather than after it.
  const presence = (name: "joined" | "left") => {
    if (!settled()) return output.skipped(name, "settling");
    if (headcount() > PRESENCE_SOUND_LIMIT) return output.skipped(name, "large-call");
    output.play(name);
  };
  const whenSettled = (name: "hand" | "shareStart" | "shareStop") =>
    settled() ? output.play(name) : output.skipped(name, "settling");

  return {
    /** You are in the call. Also right after a dropped connection comes back. */
    onConnected() {
      lost = false;
      output.play("connected");
    },
    onConnectionLost() {
      if (!lost) output.play("connectionLost");
      lost = true;
    },
    onConnectionRestored() {
      if (lost) output.play("connected");
      lost = false;
    },
    /** Somebody's tile appeared on, or left, the part of the stage you can see. */
    onVisibleArrival: () => presence("joined"),
    onVisibleDeparture: () => presence("left"),
    /**
     * Somebody else raised a hand. Moderators, who answer hands, hear each one up to
     * HAND_SOUND_LIMIT people and then at most one every HAND_SOUND_GAP_MS. Everyone else hears
     * only the first hand after a quiet spell, and nothing in a large call.
     */
    onHandRaised(moderator: boolean) {
      const at = now();
      const lull = at - lastHandAt >= HAND_SOUND_GAP_MS;
      lastHandAt = at;
      const large = headcount() > HAND_SOUND_LIMIT;
      if (!moderator) {
        if (large) return output.skipped("hand", "large-call");
        if (!lull) return output.skipped("hand", "not-first-hand");
        return whenSettled("hand");
      }
      if (!large) return whenSettled("hand");
      if (at - lastLargeHandSoundAt < HAND_SOUND_GAP_MS) return output.skipped("hand", "large-call-gap");
      if (!settled()) return output.skipped("hand", "settling");
      if (output.play("hand")) lastLargeHandSoundAt = at;
    },
    onScreenShareStarted: () => whenSettled("shareStart"),
    onScreenShareStopped: () => whenSettled("shareStop"),
    /**
     * Your microphone changed. Off without a recent toggle of your own means the host did it:
     * that gets its own sound instead of the usual tick, never both. Returns true in that case.
     */
    onOwnMicChanged(on: boolean): boolean {
      if (on) {
        output.play("micOn");
        return false;
      }
      if (now() - ownMicToggleAt > OWN_TOGGLE_MS && settled()) {
        output.play("mutedByHost");
        return true;
      }
      output.play("micOff");
      return false;
    },
    onOutputDevice: (deviceId: string) => output.setOutputDevice(deviceId),
  };
}

let activeCall: ReturnType<typeof createCallSounds> | null = null;
/** Report a join or leave whose tile is in view. Anything not in view gets a toast instead, never both. */
export function notePresence(kind: "joined" | "left"): void {
  if (kind === "joined") activeCall?.onVisibleArrival();
  else activeCall?.onVisibleDeparture();
}

/**
 * A chat message is being previewed while chat is closed. It is heard exactly when it is shown:
 * which messages those are (the first after a quiet spell, fewer in a large call, none when
 * previews are off) is decided in src/lib/notices.ts, so a sound never announces a message
 * that is not there to read.
 */
export function playChatMessageSound(): void {
  sounds.play("message");
}

/**
 * Somebody new is asking to join. Call where the host's notification is raised. The knock's
 * own minimum gap (see SOUNDS in ./sounds) keeps a steady stream of arrivals to one knock every
 * 30 seconds; the notification keeps the count.
 */
export function playKnockSound(): void {
  sounds.play("knock");
}

/* ----------------------------------------------- devices the host switched off */

type HostOffKind = "microphone" | "camera";
const offByHost: Record<HostOffKind, boolean> = { microphone: false, camera: false };
const offByHostListeners = new Set<() => void>();

/**
 * Notes that the host switched your microphone or camera off (true), or that it is back on
 * (false). The control says so until then, long after the notification has gone.
 */
export function setOffByHost(kind: HostOffKind, off: boolean): void {
  if (offByHost[kind] === off) return;
  offByHost[kind] = off;
  offByHostListeners.forEach((listener) => listener());
}

/** Whether your microphone or camera is off because the host turned it off, and you have not turned it back on. */
export function useOffByHost(kind: HostOffKind): boolean {
  return useSyncExternalStore(
    (listener) => {
      offByHostListeners.add(listener);
      return () => offByHostListeners.delete(listener);
    },
    () => offByHost[kind],
    () => false,
  );
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
        const me = call.local.identity;
        if (!participant.isLocal) sound.onHandRaised(call.hostIdentity === me || call.coHosts().includes(me));
      }),
      call.on("screenShare", (started) => {
        if (started) sound.onScreenShareStarted();
        else sound.onScreenShareStopped();
      }),
      call.on("localMic", (on) => {
        if (on) setOffByHost("microphone", false);
        if (sound.onOwnMicChanged(on)) {
          setOffByHost("microphone", true);
          onHostMuted?.();
        }
      }),
      call.on("device", (kind) => {
        const deviceId = kind === "audiooutput" ? call.activeDevice(kind) : undefined;
        if (deviceId) sound.onOutputDevice(deviceId);
      }),
    ];
    return () => {
      stops.forEach((stop) => stop());
      if (activeCall === sound) activeCall = null;
      // A new meeting starts with nothing switched off by anybody.
      setOffByHost("microphone", false);
      setOffByHost("camera", false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onHostMuted is read when it fires
  }, [call]);
}
