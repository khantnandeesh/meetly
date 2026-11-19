"use client";

import { ParticipantEvent, type Participant } from "livekit-client";
import { useCallback, useSyncExternalStore } from "react";

export const HAND = "hand";

const MEDIA_EVENTS = [
  ParticipantEvent.TrackMuted,
  ParticipantEvent.TrackUnmuted,
  ParticipantEvent.TrackPublished,
  ParticipantEvent.TrackUnpublished,
  ParticipantEvent.LocalTrackPublished,
  ParticipantEvent.LocalTrackUnpublished,
] as const;

/**
 * Whether a participant's mic and camera are live. Unlike LiveKit's `useIsMuted`, this treats
 * "never published" as off, which is what the UI needs to show.
 */
export function useMediaState(participant: Participant): { micOn: boolean; camOn: boolean } {
  const subscribe = useCallback(
    (onChange: () => void) => {
      MEDIA_EVENTS.forEach((event) => participant.on(event, onChange));
      return () => MEDIA_EVENTS.forEach((event) => participant.off(event, onChange));
    },
    [participant],
  );
  const micOn = useSyncExternalStore(subscribe, () => participant.isMicrophoneEnabled);
  const camOn = useSyncExternalStore(subscribe, () => participant.isCameraEnabled);
  return { micOn, camOn };
}

export function displayName(participant: Participant): string {
  return participant.name || "Guest";
}
