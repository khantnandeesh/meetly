"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JoinChoices } from "./rtc/types";

// The preview is plain browser media: no provider SDK is on the page until Join is pressed.
// Whichever provider the call then uses acquires its own tracks from the chosen devices.

export type MediaProblem = "denied" | "missing" | "busy" | "unknown";
type Kind = "audio" | "video";

export type MediaSlot = {
  /** What the user asked for. A slot can be enabled and still have no track (see `problem`). */
  enabled: boolean;
  pending: boolean;
  deviceId: string;
  track?: MediaStreamTrack;
  problem?: MediaProblem;
};

function classify(error: unknown): MediaProblem {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "unknown";
}

/**
 * Camera and microphone for the pre-join preview. Both are requested together the first time
 * (one permission prompt), then managed independently so toggling one never restarts the other.
 */
export function usePreviewMedia(initial: {
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId: string;
  videoDeviceId: string;
}) {
  const [audio, setAudio] = useState<MediaSlot>({
    enabled: initial.audioEnabled,
    pending: initial.audioEnabled,
    deviceId: initial.audioDeviceId,
  });
  const [video, setVideo] = useState<MediaSlot>({
    enabled: initial.videoEnabled,
    pending: initial.videoEnabled,
    deviceId: initial.videoDeviceId,
  });

  const live = useRef<{ audio?: MediaStreamTrack; video?: MediaStreamTrack }>({});
  const ids = useRef({ audio: initial.audioDeviceId, video: initial.videoDeviceId });
  const alive = useRef(true);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const initialRef = useRef(initial);

  /** Jobs run strictly one after another so rapid toggles can't interleave. */
  const enqueue = useCallback((job: () => Promise<void>) => {
    chain.current = chain.current.then(job, job);
  }, []);

  const open = useCallback(async (wantAudio: boolean, wantVideo: boolean): Promise<void> => {
    if (!alive.current || (!wantAudio && !wantVideo)) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: wantAudio ? { deviceId: ids.current.audio || undefined } : false,
        video: wantVideo
          ? { deviceId: ids.current.video || undefined, width: { ideal: 1280 }, height: { ideal: 720 } }
          : false,
      });
      const tracks = stream.getTracks();
      if (!alive.current) {
        tracks.forEach((track) => track.stop());
        return;
      }
      for (const track of tracks) {
        const deviceId = track.getSettings().deviceId ?? "";
        if (track.kind === "audio") {
          live.current.audio?.stop();
          live.current.audio = track;
          if (deviceId) ids.current.audio = deviceId;
          setAudio((slot) => ({
            ...slot,
            pending: false,
            problem: undefined,
            track,
            deviceId: deviceId || slot.deviceId,
          }));
        } else {
          live.current.video?.stop();
          live.current.video = track;
          if (deviceId) ids.current.video = deviceId;
          setVideo((slot) => ({
            ...slot,
            pending: false,
            problem: undefined,
            track,
            deviceId: deviceId || slot.deviceId,
          }));
        }
      }
    } catch (error) {
      if (!alive.current) return;
      if (wantAudio && wantVideo) {
        // One of the two failed; ask separately to learn which.
        await open(true, false);
        await open(false, true);
        return;
      }
      const problem = classify(error);
      if (wantAudio) setAudio((slot) => ({ ...slot, pending: false, track: undefined, problem }));
      else setVideo((slot) => ({ ...slot, pending: false, track: undefined, problem }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const tracks = live.current;
    const { audioEnabled, videoEnabled } = initialRef.current;
    enqueue(() => open(audioEnabled, videoEnabled));
    return () => {
      alive.current = false;
      tracks.audio?.stop();
      tracks.video?.stop();
      tracks.audio = undefined;
      tracks.video = undefined;
    };
  }, [enqueue, open]);

  const setEnabled = useCallback(
    (kind: Kind, enabled: boolean) => {
      const set = kind === "audio" ? setAudio : setVideo;
      if (enabled) {
        (set as typeof setAudio)((slot) => ({ ...slot, enabled: true, pending: true, problem: undefined }));
        enqueue(() => open(kind === "audio", kind === "video"));
      } else {
        (set as typeof setAudio)((slot) => ({ ...slot, enabled: false, pending: false, track: undefined }));
        enqueue(async () => {
          live.current[kind]?.stop();
          live.current[kind] = undefined;
        });
      }
    },
    [enqueue, open],
  );

  const setDevice = useCallback(
    (kind: Kind, deviceId: string) => {
      ids.current[kind] = deviceId;
      const set = (kind === "audio" ? setAudio : setVideo) as typeof setAudio;
      set((slot) => ({ ...slot, deviceId }));
      enqueue(async () => {
        // Only a device that is running is restarted; one that is off just remembers the choice.
        if (!live.current[kind]) return;
        try {
          const stream = await navigator.mediaDevices.getUserMedia(
            kind === "audio"
              ? { audio: { deviceId } }
              : { video: { deviceId, width: { ideal: 1280 }, height: { ideal: 720 } } },
          );
          const [track] = stream.getTracks();
          if (!alive.current || !live.current[kind]) {
            track.stop();
            return;
          }
          live.current[kind]?.stop();
          live.current[kind] = track;
          set((slot) => ({ ...slot, track, problem: undefined }));
        } catch (error) {
          if (alive.current) set((slot) => ({ ...slot, problem: classify(error) }));
        }
      });
    },
    [enqueue],
  );

  const retry = useCallback(() => {
    const wantAudio = audio.enabled && !audio.track;
    const wantVideo = video.enabled && !video.track;
    if (wantAudio) setAudio((slot) => ({ ...slot, pending: true, problem: undefined }));
    if (wantVideo) setVideo((slot) => ({ ...slot, pending: true, problem: undefined }));
    enqueue(() => open(wantAudio, wantVideo));
  }, [audio.enabled, audio.track, video.enabled, video.track, enqueue, open]);

  return { audio, video, setEnabled, setDevice, retry };
}

/** Devices of one kind, refreshed on hot-plug and whenever `refreshKey` changes. */
export function useDeviceList(kind: MediaDeviceKind, refreshKey: unknown): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!navigator.mediaDevices) return;
    let cancelled = false;
    const load = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => {
          // Before permission is granted browsers return unlabeled stubs; hide those.
          if (!cancelled) setDevices(list.filter((device) => device.kind === kind && device.deviceId && device.label));
        })
        .catch(() => {});
    load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", load);
    };
  }, [kind, refreshKey]);
  return devices;
}

/** How loud a live microphone track is right now, 0 to 1. For the pre-join level meter. */
export function useTrackVolume(track: MediaStreamTrack | undefined): number {
  const [volume, setVolume] = useState(0);
  useEffect(() => {
    if (!track) return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 32;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -80;
    context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (const value of data) sum += value * value;
      setVolume(Math.sqrt(sum / data.length) / 255);
    }, 1000 / 30);
    return () => {
      clearInterval(interval);
      context.close().catch(() => {});
    };
  }, [track]);
  return track ? volume : 0;
}

const CHOICES_KEY = "lk-user-choices"; // kept from the LiveKit-only days so nobody loses their name
const DEFAULT_CHOICES: JoinChoices = {
  username: "",
  audioEnabled: true,
  videoEnabled: true,
  audioDeviceId: "default",
  videoDeviceId: "default",
};

function loadChoices(): JoinChoices {
  try {
    const saved = JSON.parse(localStorage.getItem(CHOICES_KEY) ?? "null");
    return { ...DEFAULT_CHOICES, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch {
    return DEFAULT_CHOICES;
  }
}

/** Name, devices and on/off choices from the last visit, saved in this browser as they change. */
export function useSavedChoices(): [JoinChoices, (patch: Partial<JoinChoices>) => void] {
  const [choices, setChoices] = useState(loadChoices);
  useEffect(() => {
    try {
      // Empty values are left out, so a cleared field falls back to its default next time.
      const kept = Object.fromEntries(Object.entries(choices).filter(([, value]) => value !== ""));
      localStorage.setItem(CHOICES_KEY, JSON.stringify(kept));
    } catch {
      // Private mode or a full disk: choices simply are not remembered.
    }
  }, [choices]);
  const update = useCallback((patch: Partial<JoinChoices>) => setChoices((previous) => ({ ...previous, ...patch })), []);
  return [choices, update];
}
