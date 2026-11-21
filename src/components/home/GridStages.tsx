"use client";

import { useEffect, useMemo, useState } from "react";
import type { Act } from "../hero/kit/act";
import { clock } from "../hero/kit/clock";
import { Count } from "../hero/kit/Count";
import { Stage } from "../hero/kit/stage";
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
  type HandsState,
  type Num,
  type NoiseState,
  type PollState,
  type ReactState,
  type ShareState,
  type TileId,
} from "./scenes";

/*
 * The grid's animations, loaded only once the grid is near the screen and the page is idle, and
 * never under reduced motion (FeatureGrid.tsx). Each tile is its own Stage (the hero's engine,
 * shared), drawn at its slot's own size, which plays only while that tile is on screen and stops
 * when it is not.
 *
 * The five loops share one ten-second cycle, each with its own two-second slot, so their busy
 * moments take turns around the grid instead of all firing at once: share, then noise, poll,
 * reactions and hands. Each holds its payoff (its poster) for the rest of the cycle. Each loop
 * starts and ends on that payoff, and gets back to it by doing what the product does next, never
 * by rewinding: sharing stops and starts again, the switch goes off and on, a new poll arrives,
 * reactions run out and new ones come in, the host lowers all hands and new ones go up.
 */

const CYCLE = 10_000;
const SLOTS: Record<TileId, number> = { share: 0, noise: 2000, polls: 4000, reactions: 6000, hands: 8000 };
// The first slot comes 600ms after this module arrives, not a cycle later.
const EPOCH = clock.now() - CYCLE + 600;

/** Waits for this tile's turn in the cycle. */
function turn<S>(a: Act<S>, tile: TileId) {
  const now = (clock.now() - EPOCH) % CYCLE;
  return a.wait((SLOTS[tile] - now + CYCLE) % CYCLE);
}

const roll: Num = (value, format) => <Count value={value} format={format} duration={480} />;

type Size = { width: number; height: number };
// Where each tile's pointer waits: off its picture's lower right, so it walks in to act and out after.
const restOf = ({ width, height }: Size) => ({ x: width + 28, y: height - 24 });

/* -------------------------------------------------------------- the scripts */

const share = (size: Size) => async (a: Act<ShareState>) => {
  await turn(a, "share");
  await a.move({ at: "stop", x: 0.72, y: 0.62 });
  await a.wait(150);
  await a.click();
  a.mark("stopped");
  await a.set({ banner: false });
  await a.wait(160);
  await a.set({ live: false });
  void a.move(restOf(size));
  await a.wait(1200);
  a.mark("live");
  await a.set({ live: true });
  await a.wait(500);
  await a.set({ banner: true });
};

const noise = (size: Size) => async (a: Act<NoiseState>) => {
  await turn(a, "noise");
  await a.move({ at: "switch", x: 0.62, y: 0.55 });
  await a.wait(150);
  await a.click();
  a.mark("off");
  await a.set({ on: false });
  // Aside while the noise comes through, just off the switch, then back to turn it on.
  await a.move({ at: "switch", x: -0.6, y: -1.1 });
  await a.wait(1300);
  await a.move({ at: "switch", x: 0.62, y: 0.55 });
  await a.wait(120);
  await a.click();
  a.mark("on");
  await a.set({ on: true });
  await a.move(restOf(size));
};

const polls = (size: Size) => async (a: Act<PollState>) => {
  await turn(a, "polls");
  // The poll on screen gives way to a new one, and you vote in it.
  await a.set({ swap: true, vote: "none", tally: 0 });
  await a.wait(700);
  await a.set({ swap: false });
  await a.move({ at: "wed", x: 0.58, y: 0.62 });
  await a.wait(150);
  await a.click();
  a.mark("voted");
  await a.set({ vote: "pending" });
  await a.wait(380);
  await a.set({ vote: "yes" });
  void a.move(restOf(size));
  await a.wait(1100);
  a.mark("counted");
  await a.set({ tally: 1 });
};

async function reactions(a: Act<ReactState>) {
  await turn(a, "reactions");
  // The reactions on screen run out, and new ones come in.
  await a.set({ rows: 0 });
  await a.wait(250);
  await a.snap({ claps: 1 });
  await a.set({ rows: 1 });
  await a.wait(500);
  a.mark("burst");
  await a.set((s) => ({ burst: s.burst + 1, claps: 2 }));
  await a.wait(320);
  await a.set({ claps: 12 });
  await a.wait(760);
  await a.set({ rows: 2 });
  await a.wait(420);
  await a.set({ rows: 3 });
  await a.wait(380);
  await a.set({ rows: 4 });
  // The burst key returns to rest out of sight: the particles have long faded.
  await a.wait(900);
  await a.snap({ burst: 0 });
}

const hands = (size: Size) => async (a: Act<HandsState>) => {
  await turn(a, "hands");
  await a.move({ at: "lower", x: 0.6, y: 0.6 });
  await a.wait(150);
  await a.click();
  a.mark("lowered");
  await a.set({ count: 0 });
  void a.move(restOf(size));
  await a.wait(650);
  a.mark("raised");
  for (const count of [1, 2, 3]) {
    await a.set({ count });
    await a.wait(480);
  }
};

/* --------------------------------------------------------------- the stages */

export default function GridStage({ tile, width, height, onReady }: { tile: TileId; onReady?: () => void } & Size) {
  // A fingertip on a phone, a mouse pointer on a computer.
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(width < 48rem)");
    const update = () => setTouch(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => onReady?.());
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [onReady]);
  // A new size is a new design: its scripts are rebuilt for it (and the scene starts afresh).
  const scripts = useMemo(() => {
    const size = { width, height };
    return { share: share(size), noise: noise(size), polls: polls(size), hands: hands(size), rest: restOf(size) };
  }, [width, height]);

  const style = touch ? "touch" : "real";
  const common = { width, height, theme: "dark" as const, fidelity: "realistic" as const, className: "gm-stage" };
  const cursor = { at: scripts.rest, style } as const;
  switch (tile) {
    case "share":
      return (
        <Stage<ShareState>
          {...common}
          // The same size either way: below 520px the computer's screen is drawn smaller (scenes.tsx).
          compact={{ below: 520, width, height }}
          initial={SHARE_POSTER}
          poster={SHARE_POSTER}
          script={scripts.share}
          cursor={{ at: { wide: scripts.rest, compact: scripts.rest }, style }}
        >
          {(s, _rect, layout) => <ShareScene s={s} layout={layout} />}
        </Stage>
      );
    case "noise":
      return (
        <Stage<NoiseState> {...common} initial={NOISE_POSTER} poster={NOISE_POSTER} script={scripts.noise} cursor={cursor}>
          {(s) => <NoiseScene s={s} />}
        </Stage>
      );
    case "polls":
      return (
        <Stage<PollState> {...common} initial={POLL_POSTER} poster={POLL_POSTER} script={scripts.polls} cursor={cursor}>
          {(s) => <PollScene s={s} num={roll} />}
        </Stage>
      );
    case "reactions":
      return (
        <Stage<ReactState> {...common} initial={REACT_POSTER} poster={REACT_POSTER} script={reactions}>
          {(s) => <ReactionsScene s={s} num={roll} />}
        </Stage>
      );
    case "hands":
      return (
        <Stage<HandsState> {...common} initial={HANDS_POSTER} poster={HANDS_POSTER} script={scripts.hands} cursor={cursor}>
          {(s) => <HandsScene s={s} num={roll} />}
        </Stage>
      );
  }
}
