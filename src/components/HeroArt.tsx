"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { MeetingScene, POSTER } from "./hero/scene";
import "./hero/hero.css";

/** The still: what the page paints first, and all it shows under reduced motion. */
function Poster({ quiet }: { quiet: boolean }) {
  return (
    <div className="hero-poster">
      <div className="hero-poster__scale" data-layout="wide">
        <MeetingScene s={POSTER} layout="wide" quiet={quiet} />
      </div>
      <div className="hero-poster__scale" data-layout="compact">
        <MeetingScene s={POSTER} layout="compact" quiet={quiet} />
      </div>
    </div>
  );
}

// The animation and the little engine that plays it are their own chunk, fetched only when they
// are going to be seen, so they cost the page's first paint and first interaction nothing.
const HeroStage = dynamic(() => import("./hero/HeroStage"), { ssr: false, loading: () => null });

/**
 * Decorative illustration for the home page: somebody opens the meeting's link and asks to join,
 * the host lets them in, and they are in the call. See hero/scene.tsx.
 *
 * `quiet`: on a phone the New meeting menu opens over the illustration, so its notification steps
 * aside while the menu is open.
 */
export function HeroArt({ quiet = false }: { quiet?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Animate only for someone who has not asked for less motion, once the page has settled and the
  // illustration is on screen. Until then, and otherwise, the poster tells the story on its own.
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  useEffect(() => {
    const el = ref.current;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!el || reduce.matches) return;
    let idle = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      const go = () => setLive(true);
      if ("requestIdleCallback" in window) idle = window.requestIdleCallback(go, { timeout: 2500 });
      else timer = setTimeout(go, 600);
    });
    observer.observe(el);
    // Asking for less motion once it is playing is handled by the stage, which goes back to the still.
    return () => {
      observer.disconnect();
      if (idle) window.cancelIdleCallback(idle);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div ref={ref} data-hero-art className="hero-art relative mx-auto w-full max-w-[34rem] select-none" aria-hidden="true">
      {/* The poster stays underneath until the stage has painted its first frame, which is the same
          picture, so the hand-over cannot be seen. */}
      {!ready && <Poster quiet={quiet} />}
      {live && (
        <div className={ready ? undefined : "absolute inset-0"}>
          <HeroStage quiet={quiet} onReady={onReady} />
        </div>
      )}
    </div>
  );
}
