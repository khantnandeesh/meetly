import { AudioLines, Check, Dog, Hand, Keyboard, LoaderCircle, Mic, MonitorUp, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { initials } from "../ui/Avatar";

/*
 * The feature grid's five pictures, each a real moment of a Meetly call drawn with the app's own
 * classes, sizes and words, at 1:1. Every scene is a pure function of its state, so the same render
 * is the poster the page paints first (and keeps, under reduced motion) and every frame of the
 * tile's animation (GridStages.tsx, loaded later).
 *
 * Every scene fills its tile's picture slot, which reaches the tile's edges (feature-grid.css), and
 * is laid out fluidly against that slot, so each tile width is its own design rather than a scaled
 * copy. Each is framed the same way: the product surface starts on the copy's gutter, directly under
 * the copy, and runs off the tile's bottom edge; the reaction tile is a call's video tile, whole
 * tile, with the copy on it.
 *
 * The poster of each is its payoff, which is also where each loop starts and ends.
 */

export type TileId = "share" | "noise" | "polls" | "reactions" | "hands";

/** How a number is drawn: the animated stage rolls it, the poster writes it. */
export type Num = (value: number, format?: (n: number) => string) => ReactNode;
const plain: Num = (value, format) => (format ? format(value) : String(value));

const vars = (values: Record<string, string | number>) => values as CSSProperties;

/* ------------------------------------------------------------------ share */

export type ShareState = { live: boolean; banner: boolean };
export const SHARE_POSTER: ShareState = { live: true, banner: true };

/**
 * The presenter's own screen-share tile (Stage.tsx, Tile.tsx): the shared screen filling it, and the
 * "You're sharing your screen" banner with Stop sharing, centred at its top. Before the first frame
 * arrives the tile says "Starting your screen share…", as the call does. On a phone the computer's
 * screen is drawn at 0.8, banner and all, so the banner fits whole.
 */
export function ShareScene({ s, layout }: { s: ShareState; layout: "wide" | "compact" }) {
  return (
    <div className="gm-scene gm-share" data-layout={layout}>
      <div className="gm-share-frame">
        <div className="gm-share-screen">
          <div className="gm-share-wait" data-show={!s.live}>
            <MonitorUp className="size-8 text-accent" />
            <span>Starting your screen share…</span>
          </div>
          <div className="gm-share-page" data-show={s.live}>
            <span className="gm-slide-kicker">Weekly review</span>
            <span className="gm-slide-title">Sign-ups since the beta</span>
            <div className="gm-slide-chart">
              {[34, 41, 38, 52, 49, 63, 71, 68, 84, 96].map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} data-last={index === 9 || undefined} />
              ))}
            </div>
          </div>
          <div className="gm-share-banner" data-show={s.banner}>
            <div className="flex items-center gap-3 rounded-2xl bg-[rgb(11_11_15/0.8)] py-1.5 pr-1.5 pl-3.5 text-sm font-medium whitespace-nowrap backdrop-blur-md">
              <MonitorUp className="size-4 text-accent" />
              You&apos;re sharing your screen
              <span className="gm-stop grid h-9 place-items-center rounded-xl bg-danger px-3 font-semibold text-white" data-target="stop" data-cursor="hand">
                Stop sharing
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ noise */

export type NoiseState = { on: boolean };
export const NOISE_POSTER: NoiseState = { on: true };

// The microphone's level, bar by bar (a bar every 8px from the tile's left edge): a voice in
// syllables throughout, with keyboard clacks and a dog's bark on top when nothing takes them out.
const VOICE = Array.from({ length: 64 }, (_, i) => {
  const syllable = Math.max(0, Math.sin(i * 0.42)) ** 0.6;
  return 0.18 + 0.5 * syllable * (0.62 + 0.38 * Math.abs(Math.sin(i * 1.3)));
});
const NOISE: Record<number, number> = {
  8: 0.92,
  10: 1,
  12: 0.86,
  25: 0.78,
  26: 1,
  27: 0.92,
  28: 1,
  29: 0.86,
};

/**
 * The microphone's signal, across the tile, over the real Audio settings menu (ControlBar.tsx):
 * the microphone, noise suppression's switch under it, and the speaker group running off the tile.
 */
export function NoiseScene({ s }: { s: NoiseState }) {
  return (
    <div className="gm-scene gm-noise" data-on={s.on}>
      <div className="gm-wave">
        <span className="gm-wave-tag" data-at="keys">
          <Keyboard className="size-3.5" />
          Keyboard
        </span>
        <span className="gm-wave-tag" data-at="dog">
          <Dog className="size-3.5" />
          Dog
        </span>
        <div className="gm-wave-bars">
          {VOICE.map((voice, index) => {
            const noise = NOISE[index];
            const level = !s.on && noise ? noise : voice;
            return (
              <span
                key={index}
                style={{
                  transform: `scaleY(${level.toFixed(3)})`,
                  transitionDelay: `${index * 10}ms`,
                }}
              />
            );
          })}
        </div>
      </div>
      <div className="gm-menu">
        <div className="gm-menu-label">
          <Mic className="size-3.5" />
          <span>Microphone</span>
        </div>
        <div className="gm-menu-item pr-10">
          <span className="min-w-0 truncate">MacBook Pro Microphone</span>
          <Check className="absolute right-3 size-4 text-accent" />
        </div>
        <div className="gm-menu-item">
          <AudioLines className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Noise suppression</span>
            <span className="block text-xs text-muted">Turn off when you play music</span>
          </span>
          <span className="switch" data-on={s.on} data-target="switch" data-cursor="hand" />
        </div>
        <div className="gm-menu-sep" />
        <div className="gm-menu-label">
          <span>Speaker</span>
        </div>
        <div className="gm-menu-item pr-10">
          <span className="min-w-0 truncate">MacBook Pro Speakers</span>
          <Check className="absolute right-3 size-4 text-accent" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ polls */

export type PollState = {
  /** A new poll is arriving: the finished one leaves upwards as the new one comes in under it. */
  swap: boolean;
  vote: "none" | "pending" | "yes";
  /** Which count is showing: just after your vote, or once everyone has voted. */
  tally: 0 | 1;
};
export const POLL_POSTER: PollState = { swap: false, vote: "yes", tally: 1 };

// The last option is only the top of a row, running off the tile's foot: no words are cut there.
const OPTIONS = ["Monday", "Tuesday", "Wednesday", "Thursday", ""];
// Your vote is Wednesday's: 0, 1, 4, 2 just after it (7 votes), then 1, 2, 7, 2 (12 votes).
const TALLIES = [
  [0, 1, 4, 2, 0],
  [1, 2, 7, 2, 0],
];

/** A poll as an ordinary voter sees it (Polls.tsx): results hidden until you vote, then the counts. */
export function PollScene({ s, num = plain }: { s: PollState; num?: Num }) {
  return (
    <div className="gm-scene gm-poll">
      {/* The finished poll, leaving as the new one arrives: the picture is never empty. */}
      {s.swap && (
        <div className="gm-poll-card gm-poll-old">
          <PollCard vote="yes" tally={1} num={plain} />
        </div>
      )}
      <div className="gm-poll-card" data-in={s.swap || undefined}>
        <PollCard vote={s.vote} tally={s.tally} num={num} />
      </div>
    </div>
  );
}

function PollCard({ vote, tally, num }: { vote: PollState["vote"]; tally: PollState["tally"]; num: Num }) {
  const votes = TALLIES[tally];
  const total = votes.reduce((sum, n) => sum + n, 0);
  const shown = vote === "yes";
  return (
    <>
      <div className="flex flex-col gap-0.5 px-1">
        <span className="block text-[0.9375rem] leading-snug font-semibold">Which day for the offsite?</span>
        <span className="block text-xs text-muted">Sam asked · votes are anonymous</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {OPTIONS.map((option, index) => {
          const mine = index === 2;
          const share = votes[index] / total;
          return (
            <div
              key={option}
              className="gm-option relative w-full overflow-hidden rounded-xl bg-surface-2"
              data-mine={mine && vote !== "none" ? "" : undefined}
              data-target={mine ? "wed" : undefined}
              data-cursor={mine && vote === "none" ? "hand" : undefined}
            >
              <span className="gm-bar absolute inset-0 origin-left bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]" style={{ transform: `scaleX(${shown ? share : 0})` }} />
              <span className="relative flex min-h-11 items-center gap-2 px-3 py-2 text-left text-[0.9375rem] leading-snug">
                {mine && (
                  <span className="gm-mark" data-show={vote !== "none"}>
                    {/* Turning only while a vote is on its way, so nothing spins unseen. */}
                    <LoaderCircle className={`gm-mark-pending size-4 text-accent ${vote === "pending" ? "anim-spin" : ""}`} data-show={vote === "pending"} />
                    <Check className="gm-mark-done size-4 text-accent" data-show={vote === "yes"} />
                  </span>
                )}
                <span className="min-w-0 flex-1">{option}</span>
                {option && (
                  <span className="gm-count shrink-0 text-sm text-muted tabular-nums" data-show={shown}>
                    {num(votes[index])} · {num(Math.round(share * 100), (n) => `${n}%`)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="gm-foot grid min-h-8 items-center px-1 text-xs text-muted">
        <span data-show={!shown}>Results show once you vote</span>
        <span data-show={shown}>{num(total)} votes · you voted</span>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- reactions */

export type ReactState = {
  /** How many rows are in the lane, in the order they arrived (the first at the bottom). */
  rows: number;
  /** Claps so far: one is a name, more are a count. */
  claps: number;
  /** Bumped to send a burst of claps up into the row. */
  burst: number;
};
export const REACT_POSTER: ReactState = { rows: 4, claps: 12, burst: 0 };

const LATER = [
  { emoji: "🎉", label: "×5" },
  { emoji: "❤️", label: "Lena" },
  { emoji: "😂", label: "×3" },
];
// A pastel from the call's own set (Avatar.tsx) that the page shows nowhere else: the hero's tiles
// are yellow and mint.
const SPEAKER = { name: "Tomás Rivera", color: "#f4a9c8" };

/**
 * A speaker's video tile, camera off (Tile.tsx), with the reaction lane over its lower left
 * (Reactions.tsx): rows from people whose tiles are out of view, above the speaker's name label,
 * newest on top. One person's emoji shows with their name; once several send the same one, it is
 * a count.
 */
export function ReactionsScene({ s, num = plain }: { s: ReactState; num?: Num }) {
  return (
    <div className="gm-scene gm-react">
      <div className="gm-video" style={vars({ "--c": SPEAKER.color })}>
        <span className="gm-disc">{initials(SPEAKER.name)}</span>
      </div>
      <div className="gm-burst" key={s.burst} data-go={s.burst > 0 || undefined} data-emoji>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => (
          <span key={index} style={vars({ "--i": index })}>
            👏
          </span>
        ))}
      </div>
      <div className="gm-lane" data-emoji>
        <span className="chip gm-lane-row" data-show={s.rows > 0} style={vars({ "--i": 0 })}>
          {/* Pops once as the burst lands in it. */}
          <span className="gm-pop text-xl leading-none" key={s.burst} data-go={s.burst > 0 || undefined}>
            👏
          </span>
          <span className="gm-swap font-medium tabular-nums">
            <span data-show={s.claps < 2}>Sam</span>
            <span data-show={s.claps >= 2}>×{num(Math.max(2, s.claps))}</span>
          </span>
        </span>
        {LATER.map((row, index) => (
          <span key={row.emoji} className="chip gm-lane-row" data-show={s.rows > index + 1} style={vars({ "--i": index + 1 })}>
            <span className="text-xl leading-none">{row.emoji}</span>
            <span className="font-medium tabular-nums">{row.label}</span>
          </span>
        ))}
      </div>
      <span className="chip gm-name">
        <span className="bars shrink-0 text-accent">
          <i />
          <i />
          <i />
        </span>
        {SPEAKER.name}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ hands */

export type HandsState = { count: number };
export const HANDS_POSTER: HandsState = { count: 3 };

const HANDS = [
  { id: "priya", name: "Priya Nair", place: "1st", color: "#a9d6f5" },
  { id: "jonas", name: "Jonas Weber", place: "2nd", color: "#f4b9a3" },
  { id: "kofi", name: "Kofi Mensah", place: "3rd", color: "#c9b8f7" },
];
// Everyone, A to Z after you (PeoplePanel.tsx): the six the panel counts.
const EVERYONE = [
  { name: "Dana Brooks", note: "You · Host", color: "#9fe0c2" },
  { name: "Amara Osei", note: "", color: "#f5d67a" },
  { name: "Ines Duarte", note: "", color: "#f4a9c8" },
  { name: "Jonas Weber", note: "", color: "#f4b9a3" },
  { name: "Kofi Mensah", note: "", color: "#c9b8f7" },
  { name: "Priya Nair", note: "", color: "#a9d6f5" },
];
// The raised-hands section's height (PeoplePanel.tsx: a 40px heading, 56px rows, 4px under them),
// and so how far the list under it moves when the section changes. With no hand up the section is
// gone and the list takes its place.
const handsHeight = (count: number) => (count === 0 ? 0 : 40 + count * 56 + 4);
// Where the tile's foot crops the panel (feature-grid.css: every tile's picture is 280px tall), less
// the panel's 60px header. A row of the list shows only while it fits whole above it, so the list
// always ends on a whole row and fades out row by row as the hands push it down.
const LIST_ROOM = 280 - 60;
const fits = (count: number, bottom: number) => handsHeight(count) + bottom <= LIST_ROOM;

/**
 * The People panel (Conference.tsx, PeoplePanel.tsx) as the host sees it: raised hands first, in
 * order, then everyone. The list under the hands moves (by transform) as the section grows and
 * shrinks, as the panel's own rows glide.
 */
export function HandsScene({ s, num = plain }: { s: HandsState; num?: Num }) {
  return (
    <div className="gm-scene gm-hands" data-any={s.count > 0}>
      <div className="gm-panel">
        <div className="flex items-center justify-between py-2.5 pr-2.5 pl-5">
          <span className="flex items-baseline gap-2 font-display text-lg font-semibold">
            People
            <span className="font-sans text-sm font-medium text-muted tabular-nums">6</span>
          </span>
          <span className="grid size-10 place-items-center text-muted">
            <X className="size-5" />
          </span>
        </div>
        <div className="gm-hands-section">
          <div className="gm-hands-head flex h-10 items-end justify-between gap-2 pr-3 pb-0.5 pl-5">
            <span className="eyebrow flex gap-2 pb-1">
              Raised hands
              <span className="tracking-normal tabular-nums">{num(Math.max(1, s.count))}</span>
            </span>
            <span className="gm-lower text-sm font-semibold text-accent" data-target="lower" data-cursor="hand">
              Lower all
            </span>
          </div>
          <div className="px-2">
            {HANDS.map((person, index) => (
              <div key={person.id} className="gm-hand flex h-14 items-center gap-3 px-3" data-show={s.count > index} style={vars({ "--i": index })}>
                <Face name={person.name} color={person.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] font-medium">{person.name}</span>
                  <span className="gm-place block text-xs text-muted">{person.place}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="gm-handbadge grid size-8 place-items-center rounded-lg bg-accent text-accent-ink">
                    <Hand className="size-4" />
                  </span>
                  <span className="grid size-8 place-items-center text-muted">
                    <Mic className="size-[1.125rem]" />
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div
          className="gm-everyone"
          style={vars({
            "--gm-shift": `${handsHeight(s.count) - handsHeight(3)}px`,
          })}
        >
          <div className="eyebrow flex h-10 items-end gap-2 px-5 pb-1.5" data-show={fits(s.count, 40)}>
            In this meeting
            <span className="tracking-normal tabular-nums">6</span>
          </div>
          <div className="px-2">
            {EVERYONE.map((person, index) => (
              <div key={person.name} className="flex h-14 items-center gap-3 px-3" data-show={fits(s.count, 40 + 56 * (index + 1))}>
                <Face name={person.name} color={person.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] font-medium">{person.name}</span>
                  {person.note && <span className="block text-xs text-muted">{person.note}</span>}
                </span>
                <span className="grid size-8 place-items-center text-muted">
                  <Mic className="size-[1.125rem]" />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Face({ name, color }: { name: string; color: string }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full font-display text-sm font-semibold text-[#16161d]" style={{ background: color }}>
      {initials(name)}
    </span>
  );
}
