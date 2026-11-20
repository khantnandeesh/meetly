"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { DUR, EASE, prefersReducedMotion } from "./motion";

/**
 * A list someone is reading holds still. While the People list is scrolled, or a finger, a
 * resting mouse pointer or an open menu is on it, rows are not added or moved under it: what was on screen when the hold
 * began stays, and what arrived since is counted for an "N new" pill instead. People who leave
 * still leave (a row for someone who is gone would be wrong), so a hold only ever removes.
 */

/** How long a hold outlasts the last touch, so a list does not jump the moment a finger lifts. */
export const HOLD_AFTER_TOUCH_MS = 1500;

/**
 * `held` (the list as it was when the hold began) without whoever is no longer in `current`,
 * in its own order, and how many of `current` it leaves out. Anyone in `yours` (changed by you,
 * see `noteOwnChange`) is shown at once even if they arrived since, after the held rows: the hold
 * protects you from other people's changes, not from the result of your own.
 */
export function holdList<T>(
  held: readonly T[],
  current: readonly T[],
  key: (item: T) => string,
  yours: ReadonlySet<string> = NONE,
): { shown: T[]; added: number } {
  const now = new Map(current.map((item) => [key(item), item]));
  const shown: T[] = [];
  const placed = new Set<string>();
  for (const item of held) {
    // The current object, so a renamed person shows their new name in their old place.
    const still = now.get(key(item));
    if (still !== undefined) {
      shown.push(still);
      placed.add(key(item));
    }
  }
  for (const item of current) if (yours.has(key(item)) && !placed.has(key(item))) shown.push(item);
  return { shown, added: current.length - shown.length };
}

const NONE: ReadonlySet<string> = new Set();

/**
 * People this browser just did something to (let in, invited on stage, sent back, made co-host),
 * by identity. A held list shows them as they are now (see `holdList`).
 */
let own: ReadonlySet<string> = NONE;
const ownListeners = new Set<() => void>();

export function noteOwnChange(...identities: string[]): void {
  own = new Set([...own, ...identities]);
  ownListeners.forEach((listener) => listener());
}

export function useOwnChanges(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      ownListeners.add(listener);
      return () => ownListeners.delete(listener);
    },
    () => own,
    () => NONE,
  );
}

/**
 * Whether the scrolling list in `box` is being read: scrolled away from the top, touched, a mouse
 * pointer resting over it (a phone has no hover, so a glance at it stays live), or with a menu
 * open from one of its rows. `release` ends the hold at once (the pill does this,
 * then scrolls to the top).
 */
export function useListHold(box: RefObject<HTMLElement | null>): { held: boolean; release: () => void } {
  const [held, setHeld] = useState(false);
  const touching = useRef(false);
  const hovering = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const settle = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(function check() {
      const element = box.current;
      if (!element) return;
      // A row's menu is open: the row must stay where the menu points.
      const menuOpen = element.querySelector('[aria-expanded="true"]') !== null;
      if (touching.current || hovering.current || element.scrollTop > 0 || menuOpen) {
        if (menuOpen && !touching.current && !hovering.current && element.scrollTop <= 0) timer.current = setTimeout(check, HOLD_AFTER_TOUCH_MS);
        return;
      }
      setHeld(false);
    }, HOLD_AFTER_TOUCH_MS);
  }, [box]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const hold = () => {
      clearTimeout(timer.current);
      setHeld(true);
    };
    const down = () => {
      touching.current = true;
      hold();
    };
    const up = () => {
      touching.current = false;
      settle();
    };
    // Only a mouse (or pen) hovers; a finger's pointerenter is a touch, handled by pointerdown.
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      hovering.current = true;
      hold();
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      hovering.current = false;
      settle();
    };
    // A wheel turned at the top scrolls nothing: hold, then let go as after a touch.
    const wheel = () => {
      hold();
      if (!touching.current && !hovering.current) settle();
    };
    const scroll = () => {
      if (element.scrollTop > 0) hold();
      else if (!touching.current && !hovering.current) settle();
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("touchstart", down, { passive: true });
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("scroll", scroll, { passive: true });
    // Released anywhere: a finger that starts on the list may lift off it.
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);
    return () => {
      clearTimeout(timer.current);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("touchstart", down);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("scroll", scroll);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [box, settle]);

  // The pill ends the hold at once, even with the pointer still over the list: that is where
  // the pill is. The pointer starts a new hold only by leaving and coming back.
  const release = useCallback(() => {
    clearTimeout(timer.current);
    touching.current = false;
    hovering.current = false;
    setHeld(false);
  }, []);

  return { held, release };
}

/**
 * Rows that move glide to their new place instead of jumping (the same glide as the notices),
 * and snap under reduced motion. Every element in `box` with a `data-flip` key is measured after
 * each render by its layout offset (`offsetTop`, which a running animation's transform does not
 * change) and, if it moved, animated from where it was by transform alone. An element inside
 * another one that moved is measured against its own parent, so the two never add up twice.
 */
export function useFlip(box: RefObject<HTMLElement | null>): void {
  const places = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const before = places.current;
    const after = new Map<string, number>();
    const nodes = Array.from(element.querySelectorAll<HTMLElement>("[data-flip]"));
    for (const node of nodes) after.set(node.dataset.flip!, node.offsetTop);
    places.current = after;
    if (prefersReducedMotion()) return;
    for (const node of nodes) {
      const was = before.get(node.dataset.flip!);
      const now = after.get(node.dataset.flip!)!;
      if (was === undefined || Math.abs(was - now) < 1) continue;
      node.animate([{ transform: `translateY(${was - now}px)` }, { transform: "translateY(0)" }], {
        duration: DUR.base,
        easing: EASE.move,
      });
    }
  });
}
