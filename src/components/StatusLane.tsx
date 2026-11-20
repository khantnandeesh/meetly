"use client";

import { Volume2, WifiOff } from "lucide-react";
import { useEffect } from "react";
import { usePresence } from "@/lib/hooks";
import { useAudioBlocked, useCall, useConnectionStatus } from "@/lib/rtc/react";
import { WeakConnectionNotice } from "./CallQuality";
import { useToast } from "./ui/Toaster";

/**
 * The status lane: banners about the meeting itself (the connection, sound), at the top centre of
 * the stage. It also tells the notifications how much room the screen has, because on a phone the
 * two share one column.
 *
 * Mount once, inside the stage.
 */
export function StatusLane({ sheetOpen }: { sheetOpen: boolean }) {
  const toast = useToast();
  const reconnecting = useConnectionStatus() === "reconnecting";

  // How many notifications the screen can take (src/lib/notices.ts): two, or on a phone with a
  // sheet open one line over the top bar, and then only what concerns you.
  useEffect(() => {
    toast.setSurface(sheetOpen ? { max: 1, info: false, compact: true } : { max: 2, info: true });
  }, [sheetOpen, toast]);
  useEffect(() => () => toast.setSurface({ max: 2, info: true }), [toast]);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex flex-col items-center gap-2">
      <Reconnecting show={reconnecting} />
      <WeakConnectionNotice />
      <AudioUnlock />
    </div>
  );
}

function Reconnecting({ show }: { show: boolean }) {
  const presence = usePresence(show);
  if (!presence.mounted) return null;
  return (
    <p
      role={show ? "status" : undefined}
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      className="anim-pop chip h-9 gap-2 px-3.5 text-warn shadow-lg"
    >
      <WifiOff className="size-4" aria-hidden="true" />
      Connection lost. Reconnecting…
    </p>
  );
}

/** Browsers may block audio until the page is interacted with; offer a one-tap fix. */
function AudioUnlock() {
  const call = useCall();
  const blocked = useAudioBlocked();
  if (!blocked) return null;
  return (
    <button onClick={() => call.startAudio().catch(() => {})} className="btn btn-primary anim-pop pointer-events-auto h-11 rounded-xl shadow-lg">
      <Volume2 className="size-[1.125rem]" aria-hidden="true" />
      Turn on sound
    </button>
  );
}
