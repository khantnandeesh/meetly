"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const noop = () => () => {};

/** False during SSR and hydration, true afterwards. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Matches Tailwind's `max-md:` breakpoint. */
export function useIsPhone(): boolean {
  return useMediaQuery("(width < 48rem)");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps something mounted while its exit animation plays.
 * Render while `mounted`; put `data-leaving={leaving}` and `onAnimationEnd` on the animated element.
 */
export function usePresence(present: boolean) {
  const [mounted, setMounted] = useState(present);
  if (present && !mounted) setMounted(true);
  const leaving = mounted && !present;
  useEffect(() => {
    if (!leaving) return;
    // Safety net for an animation that never reports back (hidden tab, display: none).
    const timer = setTimeout(() => setMounted(false), 500);
    return () => clearTimeout(timer);
  }, [leaving]);
  const onAnimationEnd = (event: React.AnimationEvent) => {
    if (leaving && event.target === event.currentTarget) setMounted(false);
  };
  return { mounted, leaving, onAnimationEnd };
}
