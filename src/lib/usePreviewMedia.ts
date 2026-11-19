"use client";

import {
  Room,
  Track,
  VideoPresets,
  createLocalTracks,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

export type MediaProblem = "denied" | "missing" | "busy" | "unknown";
type Kind = "audio" | "video";

export type MediaSlot<T> = {
  /** What the user asked for. A slot can be enabled and still have no track (see `problem`). */
  enabled: boolean;
  pending: boolean;
  deviceId: string;
  track?: T;
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
  const [audio, setAudio] = useState<MediaSlot<LocalAudioTrack>>({
    enabled: initial.audioEnabled,
    pending: initial.audioEnabled,
    deviceId: initial.audioDeviceId,
  });
  const [video, setVideo] = useState<MediaSlot<LocalVideoTrack>>({
    enabled: initial.videoEnabled,
    pending: initial.videoEnabled,
    deviceId: initial.videoDeviceId,
  });

  const live = useRef<{ audio?: LocalAudioTrack; video?: LocalVideoTrack }>({});
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
      const tracks = await createLocalTracks({
        audio: wantAudio ? { deviceId: ids.current.audio || undefined } : false,
        video: wantVideo
          ? { deviceId: ids.current.video || undefined, resolution: VideoPresets.h720.resolution }
          : false,
      });
      if (!alive.current) {
        tracks.forEach((track) => track.stop());
        return;
      }
      for (const track of tracks) {
        const deviceId = (await track.getDeviceId(false)) ?? "";
        if (track.kind === Track.Kind.Audio) {
          live.current.audio?.stop();
          live.current.audio = track as LocalAudioTrack;
          if (deviceId) ids.current.audio = deviceId;
          setAudio((slot) => ({
            ...slot,
            pending: false,
            problem: undefined,
            track: track as LocalAudioTrack,
            deviceId: deviceId || slot.deviceId,
          }));
        } else {
          live.current.video?.stop();
          live.current.video = track as LocalVideoTrack;
          if (deviceId) ids.current.video = deviceId;
          setVideo((slot) => ({
            ...slot,
            pending: false,
            problem: undefined,
            track: track as LocalVideoTrack,
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
        try {
          await live.current[kind]?.setDeviceId(deviceId);
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
      Room.getLocalDevices(kind, false)
        .then((list) => {
          // Before permission is granted browsers return unlabeled stubs; hide those.
          if (!cancelled) setDevices(list.filter((device) => device.deviceId && device.label));
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
