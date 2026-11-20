"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * A list someone is reading holds still. While the People list is scrolled, or a finger, mouse or
 * open menu is on it, rows are not added or moved under it: what was on screen when the hold
 * began stays, and what arrived since is counted for an "N new" pill instead. People who leave
 * still leave (a row for someone who is gone would be wrong), so a hold only ever removes.
 */

/** How long a hold outlasts the last touch, so a list does not jump the moment a finger lifts. */
export const HOLD_AFTER_TOUCH_MS = 1500;

/**
 * `held` (the list as it was when the hold began) without whoever is no longer in `current`,
 * in its own order, and how many of `current` it leaves out.
 */
export function holdList<T>(held: readonly T[], current: readonly T[], key: (item: T) => string): { shown: T[]; added: number } {
  const now = new Map(current.map((item) => [key(item), item]));
  const shown: T[] = [];
  for (const item of held) {
    // The current object, so a renamed person shows their new name in their old place.
    const still = now.get(key(item));
    if (still !== undefined) shown.push(still);
  }
  return { shown, added: current.length - shown.length };
}

/**
 * Whether the scrolling list in `box` is being read: scrolled away from the top, touched, or
 * with a menu open from one of its rows. `release` ends the hold at once (the pill does this,
 * then scrolls to the top).
 */
export function useListHold(box: RefObject<HTMLElement | null>): { held: boolean; release: () => void } {
  const [held, setHeld] = useState(false);
  const touching = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const settle = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(function check() {
      const element = box.current;
      if (!element) return;
      // A row's menu is open: the row must stay where the menu points.
      const menuOpen = element.querySelector('[aria-expanded="true"]') !== null;
      if (touching.current || element.scrollTop > 0 || menuOpen) {
        if (menuOpen && !touching.current && element.scrollTop <= 0) timer.current = setTimeout(check, HOLD_AFTER_TOUCH_MS);
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
    // A wheel turned at the top scrolls nothing: hold, then let go as after a touch.
    const wheel = () => {
      hold();
      if (!touching.current) settle();
    };
    const scroll = () => {
      if (element.scrollTop > 0) hold();
      else if (!touching.current) settle();
    };
    element.addEventListener("pointerdown", down);
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
      element.removeEventListener("touchstart", down);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("scroll", scroll);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [box, settle]);

  const release = useCallback(() => {
    clearTimeout(timer.current);
    touching.current = false;
    setHeld(false);
  }, []);

  return { held, release };
}
