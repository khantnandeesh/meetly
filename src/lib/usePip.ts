"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsPhone, useMounted } from "./hooks";

/**
 * The mini window: a small always-on-top window of our own, which keeps the call in view while
 * you look at another tab or present.
 *
 * It is the browser's Document Picture-in-Picture: a real window we can put buttons in. Today
 * that exists in desktop Chromium browsers (Chrome, Edge, Opera, Brave) and nowhere else: not
 * Firefox, not Safari, not any phone. Where it does not exist nothing offers it. There is no
 * video-only fallback: a floating picture without a mute button would look like this feature and
 * not be it.
 */
type PipHost = { requestWindow(options?: { width?: number; height?: number }): Promise<Window>; window: Window | null };

function pipHost(): PipHost | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { documentPictureInPicture?: PipHost }).documentPictureInPicture ?? null;
}

/** Makes the new window look like the page it came from: same stylesheets, so same tokens, fonts and classes. */
function copyStyles(from: Document, to: Document): void {
  for (const node of Array.from(from.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style'))) {
    const copy = to.importNode(node, true);
    // An absolute address: relative ones would be resolved against the new window.
    if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
    to.head.append(copy);
  }
  to.documentElement.lang = from.documentElement.lang;
  to.documentElement.className = from.documentElement.className;
  to.title = "Meetly";
}

export type MiniWindow = {
  /** This browser can open one, and the screen is large enough to want one. */
  supported: boolean;
  /** The open window, to render into. */
  window: Window | null;
  /** Must be called from a click or a key press. False if the browser would not open it. */
  open: () => Promise<boolean>;
  close: () => void;
};

export function useMiniWindow(): MiniWindow {
  const mounted = useMounted();
  const phone = useIsPhone();
  const [win, setWin] = useState<Window | null>(null);
  const current = useRef<Window | null>(null);
  const opening = useRef(false);
  const supported = mounted && !phone && pipHost() !== null;

  const close = useCallback(() => {
    current.current?.close();
  }, []);

  const open = useCallback(async () => {
    const host = pipHost();
    if (!host || opening.current) return false;
    if (current.current) return true;
    opening.current = true;
    try {
      const opened = await host.requestWindow({ width: 360, height: 300 });
      copyStyles(document, opened.document);
      opened.document.body.className = "flex h-dvh flex-col overflow-hidden bg-bg text-text";
      // However it goes (its own close button, "back to tab", our button, the tab closing).
      opened.addEventListener(
        "pagehide",
        () => {
          if (current.current !== opened) return;
          current.current = null;
          setWin(null);
        },
        { once: true },
      );
      current.current = opened;
      setWin(opened);
      return true;
    } catch {
      return false;
    } finally {
      opening.current = false;
    }
  }, []);

  // Leaving the call, or the page, takes the mini window with it.
  useEffect(() => () => current.current?.close(), []);
  // It cannot exist at phone width; if the window is made that narrow, it goes.
  useEffect(() => {
    if (phone) current.current?.close();
  }, [phone]);

  return { supported, window: win, open, close };
}
