"use client";

import { useCallback, useState } from "react";

export type LayoutMode = "auto" | "tiled" | "spotlight" | "sidebar";
export type SelfView = "grid" | "float" | "hidden";
export const TILE_LIMITS = [9, 16, 25, 49] as const;

export type CallSettings = {
  layout: LayoutMode;
  /** Most tiles the gallery shows per page on a large screen. */
  maxTiles: (typeof TILE_LIMITS)[number];
  selfView: SelfView;
  shortcuts: boolean;
};

const KEY = "meetly:call-settings";
const DEFAULTS: CallSettings = { layout: "auto", maxTiles: 16, selfView: "grid", shortcuts: true };

function load(): CallSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<CallSettings>;
    return {
      layout: (["auto", "tiled", "spotlight", "sidebar"] as const).includes(saved.layout as LayoutMode)
        ? (saved.layout as LayoutMode)
        : DEFAULTS.layout,
      maxTiles: TILE_LIMITS.includes(saved.maxTiles as 9) ? (saved.maxTiles as 9) : DEFAULTS.maxTiles,
      selfView: (["grid", "float", "hidden"] as const).includes(saved.selfView as SelfView)
        ? (saved.selfView as SelfView)
        : DEFAULTS.selfView,
      shortcuts: saved.shortcuts !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Per-user call preferences, remembered in this browser. Client-only (used after join). */
export function useCallSettings() {
  const [settings, setSettings] = useState<CallSettings>(load);
  const update = useCallback((patch: Partial<CallSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  return [settings, update] as const;
}
