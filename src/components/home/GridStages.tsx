"use client";

import { useEffect, useState } from "react";
import { Stopped, type Act } from "../hero/kit/act";
// The hero's animation loads the same kit modules (Stage and Count); asking for the same set lets
// the bundler share one engine chunk between the two instead of shipping it twice.
import "../hero/kit/Count";
import { Stage } from "../hero/kit/stage";
import {
  HANDS_POSTER,
  HandsScene,
  NOISE_POSTER,
  NoiseScene,
  POLL_POSTER,
  POLL_STEPS,
  PollScene,
  REACT_POSTER,
  ReactionsScene,
  SHARE_POSTER,
  ShareScene,
  type HandsState,
  type LaneRow,
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
 * shared), drawn at its slot's own size, which runs only while that tile is on screen.
 *
 * One tile moves at a time. A conductor hands out turns round the grid in reading order (share,
 * noise, poll, reactions, hands), skipping tiles that are off screen; each tile plays one short
 * beat of its story, settles, and hands on after a pause. Each story only goes forward: the chart
 * takes in a new week, a noise comes and is kept out, votes arrive (and a poll ends and the next
 * begins), reactions arrive and expire, the queue of hands moves on a place. Nothing is
 * played back, so no tile ever undoes itself in view. Off screen, a stage is reset to its poster
 * out of sight and its story starts again from there.
 */

const ORDER: TileId[] = ["share", "noise", "polls", "reactions", "hands"];
/** The still moment between one tile's beat and the next. */
const PAUSE = 900;
/** After a beat's last change, the time its transitions take to settle before the turn passes. */
const SETTLE = 450;

function makeConductor() {
  const waiting = new Map<TileId, () => void>();
  let playing: TileId | null = null;
  let last = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pick = () => {
    if (playing || timer) return;
    for (let step = 1; step <= ORDER.length; step++) {
      const tile = ORDER[(last + step) % ORDER.length];
      const go = waiting.get(tile);
      if (!go) continue;
      waiting.delete(tile);
      playing = tile;
      last = ORDER.indexOf(tile);
      go();
      return;
    }
  };
  // The first turn comes a pause after the first tile is ready, so the stills are seen first.
  const rest = () => {
    timer = setTimeout(() => {
      timer = null;
      pick();
    }, PAUSE);
  };
  return {
    /** Resolves when it is this tile's turn; rejects (Stopped) if its stage stops first. */
    turn(tile: TileId, signal: AbortSignal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Stopped());
        const abort = () => {
          waiting.delete(tile);
          reject(new Stopped());
        };
        signal.addEventListener("abort", abort, { once: true });
        waiting.set(tile, () => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
        if (last === -1 && !timer && !playing) rest();
        else pick();
      });
    },
    done(tile: TileId) {
      if (playing !== tile) return;
      playing = null;
      rest();
    },
  };
}
const conductor = makeConductor();

/** What a beat changes: `go` paints a change (and waits for it), `jump` makes one without motion. */
type Beat<S> = { a: Act<S>; s: () => S; go: (patch: Partial<S>) => Promise<void>; jump: (patch: Partial<S>) => Promise<void>; n: number };

/**
 * A tile's story: wait for its turn, play the next beat, settle, hand on; for as long as it runs.
 * The story keeps its own copy of the scene's state, from the poster on, since each beat follows
 * from the last.
 */
function story<S extends { beat: boolean }>(tile: TileId, poster: S, beat: (b: Beat<S>) => Promise<void>) {
  return async (a: Act<S>) => {
    let state = poster;
    const s = () => state;
    const go = (patch: Partial<S>) => {
      state = { ...state, ...patch };
      return a.set(patch);
    };
    const jump = (patch: Partial<S>) => {
      state = { ...state, ...patch };
      return a.snap(patch);
    };
    for (let n = 1; ; n++) {
      await conductor.turn(tile, a.signal);
      try {
        a.mark(`${tile} ${n}`);
        await go({ beat: true } as Partial<S>);
        await beat({ a, s, go, jump, n });
        await a.wait(SETTLE);
        await go({ beat: false } as Partial<S>);
      } finally {
        conductor.done(tile);
      }
    }
  };
}

/**
 * A number that ticks to its next value, the new figure rising into place, as a counter in the call
 * changes (the kit's rolling Count re-centres its digit strips after each roll, which reads as a hop
 * on a tile that otherwise holds still). One box holds the whole text, sign and unit included, so
 * nothing sits against it. The first value it shows does not move.
 */
function Tick({ value, format = String }: { value: number; format?: (n: number) => string }) {
  const text = format(value);
  // Every change after the first value ticks, even back to a figure it has shown before; the
  // figure it leaves rises out as the new one rises in.
  const [shown, setShown] = useState(text);
  const [left, setLeft] = useState<string | null>(null);
  if (shown !== text) {
    setLeft(shown);
    setShown(text);
  }
  return (
    <span className="gm-tick" aria-label={text}>
      {left !== null && left !== text && (
        <span key={`out-${left}`} data-out aria-hidden="true">
          {left}
        </span>
      )}
      <span key={text} data-go={left !== null || undefined}>
        {text}
      </span>
    </span>
  );
}
const roll: Num = (value, format) => <Tick value={value} format={format} />;

/* -------------------------------------------------------------- the beats */

/** The presenter's chart takes in a new week: the bars move along, the new one grows. */
const share = story<ShareState>("share", SHARE_POSTER, async ({ a, s, go }) => {
  await go({ week: s().week + 1, grown: false });
  await a.wait(620);
  await go({ grown: true });
  await a.wait(600);
});

/** A noise reaches the microphone and is kept out: it shows in grey, named, and goes; the voice carries on. */
const noise = story<NoiseState>("noise", NOISE_POSTER, async ({ a, s, go }) => {
  await go({ event: s().event + 1, noisy: true });
  await a.wait(1400);
  await go({ noisy: false });
  await a.wait(400);
});

/** New votes arrive; after a few, the host ends the poll and the next one comes, and you vote in it. */
const polls = story<PollState>("polls", POLL_POSTER, async ({ a, s, go }) => {
  if (s().step < POLL_STEPS - 1) {
    await go({ step: s().step + 1 });
    await a.wait(700);
    return;
  }
  await go({ ended: true });
  await a.wait(1100);
  await go({ poll: s().poll + 1, step: 0, vote: "none", ended: false, swap: true });
  await a.wait(700);
  await go({ swap: false, vote: "pending" });
  await a.wait(420);
  await go({ vote: "yes" });
  await a.wait(500);
});

// The six reactions a call offers (Reactions.tsx), and who sends the ones that arrive alone.
const EMOJI = ["👍", "❤️", "😂", "😮", "👏", "🎉"];
const SENDERS = ["Yuki", "Omar", "Bea", "Lena"];
/** Every other beat a row's count climbs; in between, a reaction arrives on top and the oldest expires. */
const reactions = story<ReactState>("reactions", REACT_POSTER, async ({ a, s, go, n }) => {
  const rows = s().rows.filter((row) => !row.leaving).map((row) => ({ ...row, bumped: false }));
  if (n % 2 === 1) {
    // Several more people send one already in the lane: its count climbs.
    const counted = rows.filter((row) => !row.name);
    const target = counted[n % counted.length] ?? rows[0];
    await go({ rows: rows.map((row) => (row.id === target.id ? { ...row, count: row.count + 1 + (n % 3), bumped: true } : row)) });
    await a.wait(900);
    return;
  }
  // A new one arrives on top; the oldest, at the bottom, has run its time and goes.
  const used = new Set(rows.map((row) => row.emoji));
  const free = EMOJI.filter((emoji) => !used.has(emoji));
  const fresh = free[(n / 2) % free.length];
  const alone = n % 4 === 0;
  const arriving: LaneRow = { id: s().next, emoji: fresh, count: alone ? 1 : 2 + (n % 5), name: alone ? SENDERS[(n / 4) % SENDERS.length] : undefined };
  const [oldest, ...rest] = rows;
  await go({ rows: [{ ...oldest, leaving: true }, ...rest] });
  await a.wait(220);
  await go({ rows: [{ ...oldest, leaving: true }, ...rest, arriving], next: s().next + 1 });
  await a.wait(800);
  await go({ rows: [...rest, arriving] });
});

/** The queue moves on: the 1st has the floor and speaks, lowers their hand, the others move up a place, and a new hand goes up as 3rd. */
const hands = story<HandsState>("hands", HANDS_POSTER, async ({ a, s, go }) => {
  await go({ speaking: true });
  await a.wait(1100);
  await go({ speaking: false, leaving: true });
  // The others move up as the 1st's row fades, so the top place is never empty.
  await a.wait(120);
  await go({ next: s().next + 1, leaving: false });
  await a.wait(800);
});

/* --------------------------------------------------------------- the stages */

type Size = { width: number; height: number };

export default function GridStage({ tile, width, height, onReady }: { tile: TileId; onReady?: () => void } & Size) {
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

  const common = { width, height, theme: "dark" as const, fidelity: "realistic" as const, className: "gm-stage" };
  switch (tile) {
    case "share":
      return (
        // The same size either way: below 520px the computer's screen is drawn smaller (scenes.tsx).
        <Stage<ShareState> {...common} compact={{ below: 520, width, height }} initial={SHARE_POSTER} poster={SHARE_POSTER} script={share}>
          {(s, _rect, layout) => <ShareScene s={s} layout={layout} />}
        </Stage>
      );
    case "noise":
      return (
        <Stage<NoiseState> {...common} initial={NOISE_POSTER} poster={NOISE_POSTER} script={noise}>
          {(s) => <NoiseScene s={s} />}
        </Stage>
      );
    case "polls":
      return (
        <Stage<PollState> {...common} initial={POLL_POSTER} poster={POLL_POSTER} script={polls}>
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
        <Stage<HandsState> {...common} initial={HANDS_POSTER} poster={HANDS_POSTER} script={hands}>
          {(s) => <HandsScene s={s} num={roll} />}
        </Stage>
      );
  }
}
