"use client";

import { Volume2, WifiOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { usePresence } from "@/lib/hooks";
import { DUR, EASE, prefersReducedMotion } from "@/lib/motion";
import { laneSurface, statusBanner } from "@/lib/notices";
import { useAudioBlocked, useCall, useConnectionStatus } from "@/lib/rtc/react";
import { useCallHealth } from "@/lib/useCallHealth";
import { WeakConnectionNotice } from "./CallQuality";
import { useToast } from "./ui/Toaster";

/**
 * The status lane: one banner about the meeting itself, the most urgent of Reconnecting › Turn
 * on sound › Weak connection (statusBanner in src/lib/notices.ts), at the top centre of the stage.
 *
 * On a phone the banner heads the notification column: notifications start below it, and it
 * counts toward the two that fit. With a phone sheet open, Reconnecting or Turn on sound takes
 * the one line over the top bar that notifications otherwise use; a weak connection waits.
 *
 * Mount once, inside the stage.
 */
export function StatusLane({ phone, sheetOpen }: { phone: boolean; sheetOpen: boolean }) {
  const toast = useToast();
  const reconnecting = useConnectionStatus() === "reconnecting";
  const soundBlocked = useAudioBlocked();
  const health = useCallHealth();
  const banner = statusBanner({ reconnecting, soundBlocked, weak: health.weak });
  const strip = phone && sheetOpen;
  // Under a sheet the stage is covered: only what stops you hearing or being heard is shown.
  const shown = strip && banner === "weak" ? null : banner;

  // How many notifications the screen can take (src/lib/notices.ts).
  const surface = laneSurface(phone, sheetOpen, shown);
  const { max, info, compact } = surface;
  useEffect(() => {
    toast.setSurface({ max, info, compact });
  }, [max, info, compact, toast]);
  useEffect(() => () => toast.setSurface({ max: 2, info: true }), [toast]);

  // On a phone, notifications start 8px below the banner. Set in the same frame the banner
  // appears, so the two never overlap; when it goes, the cards glide up into its place.
  const lane = useRef<HTMLDivElement>(null);
  const below = phone && !strip;
  useLayoutEffect(() => {
    const region = document.querySelector<HTMLElement>(".toast-region");
    const node = lane.current;
    if (!region || !node) return;
    if (!below) {
      region.style.removeProperty("--status-bottom");
      return;
    }
    let last = 0;
    const measure = () => {
      const box = node.getBoundingClientRect();
      const bottom = box.height > 0 ? Math.round(box.bottom + 8) : 0;
      if (bottom === last) return;
      const before = region.getBoundingClientRect().top;
      if (bottom) region.style.setProperty("--status-bottom", `${bottom}px`);
      else region.style.removeProperty("--status-bottom");
      const shift = before - region.getBoundingClientRect().top;
      if (bottom < last && shift > 0 && !prefersReducedMotion()) {
        for (const card of region.querySelectorAll<HTMLElement>("[data-toast]")) {
          card.animate([{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }], { duration: DUR.base, easing: EASE.move });
        }
      }
      last = bottom;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      region.style.removeProperty("--status-bottom");
    };
  }, [below]);

  return (
    <div
      ref={lane}
      data-status-lane={strip ? "strip" : "stage"}
      // One cell: a banner giving way to a more urgent one fades out where the new one pops in.
      className={`pointer-events-none grid justify-items-center *:col-start-1 *:row-start-1 ${
        // Over a phone sheet's scrim, where the one-line notification strip goes.
        strip ? "fixed inset-x-0 top-[max(0.25rem,env(safe-area-inset-top))] z-45 px-3" : "absolute inset-x-0 top-3 z-40"
      }`}
    >
      <Reconnecting show={shown === "reconnecting"} />
      <AudioUnlock show={shown === "sound"} />
      <WeakConnectionNotice show={shown === "weak"} onDismiss={health.dismiss} />
    </div>
  );
}

function Reconnecting({ show }: { show: boolean }) {
  const presence = usePresence(show);
  if (!presence.mounted) return null;
  return (
    <p
      role={show ? "status" : undefined}
      data-status-banner="reconnecting"
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      // In the strip over a phone's top bar it is opaque, like the notification it stands in for:
      // the meeting code underneath must not show through.
      className="anim-pop chip h-9 gap-2 px-3.5 text-warn shadow-lg in-data-[status-lane=strip]:h-11 in-data-[status-lane=strip]:rounded-2xl in-data-[status-lane=strip]:bg-surface-2 in-data-[status-lane=strip]:shadow-[inset_0_0_0_1px_var(--border-strong),0_16px_40px_-12px_rgb(0_0_0/0.7)]"
    >
      <WifiOff className="size-4" aria-hidden="true" />
      Connection lost. Reconnecting…
    </p>
  );
}

/** Browsers may block audio until the page is interacted with; offer a one-tap fix. */
function AudioUnlock({ show }: { show: boolean }) {
  const call = useCall();
  const presence = usePresence(show);
  if (!presence.mounted) return null;
  return (
    <button
      data-status-banner="sound"
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      onClick={() => call.startAudio().catch(() => {})}
      className="btn btn-primary anim-pop pointer-events-auto h-11 rounded-xl shadow-lg"
    >
      <Volume2 className="size-[1.125rem]" aria-hidden="true" />
      Turn on sound
    </button>
  );
}
