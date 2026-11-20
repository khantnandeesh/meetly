"use client";

import { useSyncExternalStore } from "react";

export type LayoutMode = "auto" | "tiled" | "spotlight" | "sidebar";
export type SelfView = "grid" | "float" | "hidden";
export const TILE_LIMITS = [9, 16, 25, 49] as const;

export type CallSettings = {
  layout: LayoutMode;
  /** Most tiles the gallery shows per page on a large screen. */
  maxTiles: (typeof TILE_LIMITS)[number];
  selfView: SelfView;
  shortcuts: boolean;
  /** Open the mini window whenever you start presenting. Offered after the mini window was first used. */
  miniOnShare: boolean;
  /** Show a new chat message as a notification while chat is closed (src/lib/notices.ts decides which). On unless switched off. */
  chatPreviews: boolean;
  /** This viewer does not see other people's reactions, on their tiles or in the lane. Off unless switched on. */
  reactionsHidden: boolean;
};

const KEY = "meetly:call-settings";
const DEFAULTS: CallSettings = {
  layout: "auto",
  maxTiles: 16,
  selfView: "grid",
  shortcuts: true,
  miniOnShare: false,
  chatPreviews: true,
  reactionsHidden: false,
};

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
      miniOnShare: saved.miniOnShare === true,
      chatPreviews: saved.chatPreviews !== false,
      reactionsHidden: saved.reactionsHidden === true,
    };
  } catch {
    return DEFAULTS;
  }
}

/*
 * One copy for the whole page, so a switch in a menu and the part of the call it affects (the
 * chat previews, the reactions) always agree, wherever each of them reads it from.
 */
let current: CallSettings | null = null;
const listeners = new Set<() => void>();

/** The settings right now, outside React (in an event handler). */
export function callSettings(): CallSettings {
  if (current) return current;
  if (typeof window === "undefined") return DEFAULTS;
  return (current = load());
}

function updateCallSettings(patch: Partial<CallSettings>): void {
  current = { ...callSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {}
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Per-user call preferences, remembered in this browser. Client-only (used after join). */
export function useCallSettings() {
  const settings = useSyncExternalStore(subscribe, callSettings, () => DEFAULTS);
  return [settings, updateCallSettings] as const;
}

/**
 * Whether this viewer has switched other people's reactions off (More › Reactions). For the
 * reaction feed: a reaction from someone else is then neither shown nor announced.
 */
export function useReactionsHidden(): boolean {
  return useSyncExternalStore(subscribe, () => callSettings().reactionsHidden, () => false);
}
