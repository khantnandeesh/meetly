"use client";

import { ConnectionState, RoomEvent, Track, type Participant, type Room, type TrackPublication } from "livekit-client";
import { useEffect, useSyncExternalStore } from "react";
import { SOUND_DEFAULTS, sounds, type SoundSettings } from "./sounds";

/** Past this many people, comings and goings are shown (toasts) but no longer heard. */
export const PRESENCE_SOUND_LIMIT = 8;
/** Arrivals and departures within this window make one sound, matching the coalesced toast. */
const PRESENCE_WINDOW_MS = 350;
/** Nothing about other people sounds until the room has settled after you join. */
const SETTLE_MS = 2500;
const HAND = "hand";

/** The user's sound level and volume, shared with the engine and remembered in this browser. */
export function useSoundSettings(): [SoundSettings, (patch: Partial<SoundSettings>) => void] {
  const settings = useSyncExternalStore(
    sounds.subscribe,
    () => sounds.getSettings(),
    () => SOUND_DEFAULTS,
  );
  return [settings, sounds.setSettings];
}

/**
 * Plays the call's sounds from room events. Mount once inside the call.
 *
 * What is deliberately not here: chat messages (played where the chat toast is raised, so sound
 * and toast can never disagree), "the host muted you" (played where that is detected) and
 * `sounds.unlock()` (must run inside the click that joins the call).
 */
export function useCallSounds(room: Room): void {
  useEffect(() => {
    const startedAt = performance.now();
    const settled = () => performance.now() - startedAt > SETTLE_MS;
    const smallCall = () => room.remoteParticipants.size + 1 <= PRESENCE_SOUND_LIMIT;

    // One sound per burst of arrivals or departures, however many people it contains.
    const burst = (name: "joined" | "left") => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        add() {
          if (!settled() || !smallCall()) return;
          timer ??= setTimeout(() => {
            timer = undefined;
            sounds.play(name);
          }, PRESENCE_WINDOW_MS);
        },
        cancel: () => clearTimeout(timer),
      };
    };
    const arrivals = burst("joined");
    const departures = burst("left");

    let wasConnected = room.state === ConnectionState.Connected;
    let lost = false;
    const onConnection = (state: ConnectionState) => {
      if (state === ConnectionState.Connected) {
        // First connection and a recovered one sound the same: "you are in".
        if (!wasConnected || lost) sounds.play("connected");
        wasConnected = true;
        lost = false;
      } else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
        if (!lost) sounds.play("connectionLost");
        lost = true;
      } else if (state === ConnectionState.Disconnected && wasConnected) {
        sounds.play("ended");
        sounds.suspend();
      }
    };

    const onAttributes = (changed: Record<string, string>, participant: Participant) => {
      if (changed[HAND] === "1" && !participant.isLocal && settled()) sounds.play("hand");
    };

    const isScreen = (publication: TrackPublication) => publication.source === Track.Source.ScreenShare;
    const shareStarted = (publication: TrackPublication) => {
      if (isScreen(publication) && settled()) sounds.play("shareStart");
    };
    const shareStopped = (publication: TrackPublication) => {
      if (isScreen(publication) && settled()) sounds.play("shareStop");
    };

    // Your own microphone, however it was toggled (button, shortcut or the host).
    const isOwnMic = (publication: TrackPublication, participant: Participant) =>
      participant.isLocal && publication.source === Track.Source.Microphone;
    const onMuted = (publication: TrackPublication, participant: Participant) => {
      if (isOwnMic(publication, participant)) sounds.play("micOff");
    };
    const onUnmuted = (publication: TrackPublication, participant: Participant) => {
      if (isOwnMic(publication, participant)) sounds.play("micOn");
    };

    const onDevice = (kind: MediaDeviceKind, deviceId: string) => {
      if (kind === "audiooutput") sounds.setOutputDevice(deviceId);
    };
    const current = room.getActiveDevice("audiooutput");
    if (current) sounds.setOutputDevice(current);
    if (wasConnected) sounds.play("connected");

    room.on(RoomEvent.ParticipantConnected, arrivals.add);
    room.on(RoomEvent.ParticipantDisconnected, departures.add);
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
      room.off(RoomEvent.ParticipantConnected, arrivals.add);
      room.off(RoomEvent.ParticipantDisconnected, departures.add);
      room.off(RoomEvent.ConnectionStateChanged, onConnection);
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributes);
      room.off(RoomEvent.TrackPublished, shareStarted);
      room.off(RoomEvent.LocalTrackPublished, shareStarted);
      room.off(RoomEvent.TrackUnpublished, shareStopped);
      room.off(RoomEvent.LocalTrackUnpublished, shareStopped);
      room.off(RoomEvent.TrackMuted, onMuted);
      room.off(RoomEvent.TrackUnmuted, onUnmuted);
      room.off(RoomEvent.ActiveDeviceChanged, onDevice);
      arrivals.cancel();
      departures.cancel();
    };
  }, [room]);
}
