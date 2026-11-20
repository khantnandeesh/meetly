"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { BackgroundMode } from "../rtc/types";
import type { BlurPipeline } from "./blur";

/** What you chose for your microphone and camera, remembered in this browser. */
export type EffectSettings = { noiseSuppression: boolean; background: BackgroundMode };

const KEY = "meetly:effects";
/** Noise suppression is on unless you switch it off (musicians do); blur is off unless you ask. */
const DEFAULTS: EffectSettings = { noiseSuppression: true, background: "none" };
const MODES: readonly BackgroundMode[] = ["none", "light", "blur"];

let current: EffectSettings | null = null;
const listeners = new Set<() => void>();

function read(): EffectSettings {
  if (current) return current;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<EffectSettings>;
    current = {
      noiseSuppression: saved.noiseSuppression !== false,
      background: MODES.includes(saved.background as BackgroundMode) ? (saved.background as BackgroundMode) : DEFAULTS.background,
    };
  } catch {
    current = DEFAULTS;
  }
  return current;
}

export function loadEffectSettings(): EffectSettings {
  return typeof localStorage === "undefined" ? DEFAULTS : read();
}

export function saveEffectSettings(patch: Partial<EffectSettings>): void {
  current = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode or a full disk: the choice lasts for this page only.
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Client-only (the saved values are not known on the server). */
export function useEffectSettings(): [EffectSettings, (patch: Partial<EffectSettings>) => void] {
  const settings = useSyncExternalStore(subscribe, read, () => DEFAULTS);
  return [settings, saveEffectSettings];
}

/**
 * The pre-join preview with the chosen background applied: the same code that runs in the call,
 * so what you see is what others will get. `track` is the camera as it is until the blurred
 * picture is ready, and again if it could not be made.
 */
export function useBackgroundPreview(
  camera: MediaStreamTrack | undefined,
  mode: BackgroundMode,
): { track: MediaStreamTrack | undefined; state: "off" | "starting" | "on" | "failed" } {
  const [made, setMade] = useState<{ camera: MediaStreamTrack; pipeline: BlurPipeline } | null>(null);
  const [failedFor, setFailedFor] = useState<MediaStreamTrack | null>(null);
  const wanted = mode !== "none" && !!camera;

  useEffect(() => {
    if (!camera || mode === "none") return;
    let cancelled = false;
    let pipeline: BlurPipeline | null = null;
    void import("./blur")
      .then(({ BlurPipeline }) => BlurPipeline.create(camera, mode))
      .then(
        (ready) => {
          if (cancelled) return ready.close();
          pipeline = ready;
          setMade({ camera, pipeline: ready });
        },
        () => {
          if (!cancelled) setFailedFor(camera);
        },
      );
    return () => {
      cancelled = true;
      pipeline?.close();
      setMade(null);
    };
    // The strength is changed on the running pipeline (below), not by starting another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, mode === "none"]);

  const setStrength = useCallback(() => {
    if (made && mode !== "none") made.pipeline.setStrength(mode);
  }, [made, mode]);
  useEffect(setStrength, [setStrength]);

  if (!wanted) return { track: camera, state: "off" };
  if (made && made.camera === camera) return { track: made.pipeline.output, state: "on" };
  if (failedFor === camera) return { track: camera, state: "failed" };
  return { track: camera, state: "starting" };
}
