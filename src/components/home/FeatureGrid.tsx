"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  HANDS_POSTER,
  HandsScene,
  NOISE_POSTER,
  NoiseScene,
  POLL_POSTER,
  PollScene,
  REACT_POSTER,
  ReactionsScene,
  SHARE_POSTER,
  ShareScene,
  type TileId,
} from "./scenes";
import "./feature-grid.css";

/*
 * The home page's feature grid, under the hero: five tiles, each a short title over one real moment
 * of a Meetly call. Built to the stageshow skill's bento rules: one picture per tile at 1:1, copy as
 * page text beside it, one wide tile, every picture cropped by its tile's own edge.
 *
 * Each picture is painted first as its still poster (scenes.tsx), laid out with CSS alone. Once the
 * grid is near the screen and the page is idle, the animations load as one deferred chunk
 * (GridStages.tsx, on the hero's engine) and take over, each tile playing only while it is on
 * screen. Under reduced motion they never load, and every tile keeps its poster.
 */

export function FeatureGrid() {
  const ref = useRef<HTMLElement>(null);
  const live = useLiveWhenNear(ref);
  return (
    <section ref={ref} aria-labelledby="inside-a-meeting" className="fg anim-rise border-t border-border pt-10 [animation-delay:200ms]">
      <h2 id="inside-a-meeting" className="fg-heading font-display font-semibold">
        Inside a meeting
      </h2>
      <LiveContext.Provider value={live}>
        <ul className="fg-grid">
          <Tile id="share" wide title="Share your screen" line="From a computer" />
          <Tile id="noise" title="Noise suppression" line="On by default" />
          <Tile id="polls" title="Quick polls" />
          <Tile id="reactions" title="Group reactions" />
          <Tile id="hands" title="Hands, in order" />
        </ul>
      </LiveContext.Provider>
    </section>
  );
}

function Tile({ id, title, line, wide = false }: { id: TileId; title: string; line?: string; wide?: boolean }) {
  return (
    <li className={`fg-tile ${wide ? "fg-wide" : ""}`} data-feature={id}>
      <h3 className="fg-title">{title}</h3>
      {line && <p className="fg-line">{line}</p>}
      <TilePicture id={id} />
    </li>
  );
}

/* ------------------------------------------------------------- the pictures */

const POSTERS: Record<TileId, (layout: "wide" | "compact") => ReactNode> = {
  share: (layout) => <ShareScene s={SHARE_POSTER} layout={layout} />,
  noise: () => <NoiseScene s={NOISE_POSTER} />,
  polls: () => <PollScene s={POLL_POSTER} />,
  reactions: () => <ReactionsScene s={REACT_POSTER} />,
  hands: () => <HandsScene s={HANDS_POSTER} />,
};

const GridStage = dynamic(() => import("./GridStages"), { ssr: false, loading: () => null });
const LiveContext = createContext(false);

/**
 * One tile's picture: its poster until the animation has drawn its first frame (the same picture,
 * so the hand-over cannot be seen), then the animation, drawn at the slot's own size. Decorative:
 * its words are in the tile's title and line.
 */
function TilePicture({ id }: { id: TileId }) {
  const live = useContext(LiveContext);
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref, live);
  return (
    <div ref={ref} className="gm-slot" data-scene={id} aria-hidden="true">
      {!ready && (
        <div className="gm-poster">
          <div className="gm-poster-layout" data-layout="wide">
            {POSTERS[id]("wide")}
          </div>
          {id === "share" && (
            <div className="gm-poster-layout" data-layout="compact">
              {POSTERS[id]("compact")}
            </div>
          )}
        </div>
      )}
      {live && size && (
        <div className={ready ? "gm-live" : "gm-live gm-handover"}>
          <GridStage tile={id} width={size.width} height={size.height} onReady={onReady} />
        </div>
      )}
    </div>
  );
}

/** The slot's size in whole pixels, followed as the tile reflows; measured only once it is needed. */
function useSize(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const measure = () => {
      const width = Math.round(el.clientWidth);
      const height = Math.round(el.clientHeight);
      setSize((was) => (was && was.width === width && was.height === height ? was : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, active]);
  return size;
}

/** True once the grid is within a screen of view and the page is idle; never under reduced motion. */
function useLiveWhenNear(ref: React.RefObject<HTMLElement | null>) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let idle = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const go = () => setLive(true);
        if ("requestIdleCallback" in window) idle = window.requestIdleCallback(go, { timeout: 2500 });
        else timer = setTimeout(go, 600);
      },
      { rootMargin: "0px 0px 50% 0px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (idle) window.cancelIdleCallback(idle);
      clearTimeout(timer);
    };
  }, [ref]);
  return live;
}
