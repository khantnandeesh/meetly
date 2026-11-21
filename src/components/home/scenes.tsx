import { AudioLines, Check, Dog, Hand, Keyboard, LoaderCircle, Mic, MonitorUp } from "lucide-react";
import type { ReactNode } from "react";
import { initials } from "../ui/Avatar";

/*
 * The feature grid's five pictures, each a real moment of a Meetly call drawn with the app's own
 * classes and words. Every scene is a pure function of its state, so the same render is the poster
 * the page paints first (and keeps, under reduced motion) and every frame of the tile's animation
 * (GridStages.tsx, loaded later).
 *
 * The poster of each is its payoff, which is also where each loop starts and ends: the screen
 * shared, the noise gone, the poll voted, the reactions counted, three hands in order.
 */

export type TileId = "share" | "noise" | "polls" | "reactions" | "hands";

/** How a number is drawn: the animated stage rolls it, the poster writes it. */
export type Num = (value: number, format?: (n: number) => string) => ReactNode;
const plain: Num = (value, format) => (format ? format(value) : String(value));

/** Design sizes, drawn at 1:1 wherever the tile has the room (bento.md rule 12). */
export const SIZES = {
  share: { width: 692, height: 232, compact: { below: 520, width: 420, height: 248 } },
  noise: { width: 296, height: 232 },
  polls: { width: 296, height: 272 },
  reactions: { width: 296, height: 272 },
  hands: { width: 296, height: 272 },
} as const;

/* ------------------------------------------------------------------ share */

export type ShareState = { live: boolean; banner: boolean };
export const SHARE_POSTER: ShareState = { live: true, banner: true };

/**
 * The presenter's own view while sharing (Stage.tsx, Tile.tsx): the shared tab in the screen-share
 * tile, the "You're sharing your screen" banner with Stop sharing, and "Your screen". Before the
 * first frame arrives the tile says "Starting your screen share…", as the call does.
 */
export function ShareScene({ s, layout }: { s: ShareState; layout: "wide" | "compact" }) {
  return (
    <div className="gm-scene gm-share" data-layout={layout}>
      <div className="gm-share-frame">
        <div className="gm-share-wait" data-show={!s.live}>
          <MonitorUp className="size-8 text-accent" />
          <span>Starting your screen share…</span>
        </div>
        <div className="gm-share-page" data-show={s.live}>
          <i className="gm-share-title" />
          <div className="gm-share-cols">
            <div className="gm-share-chart">
              {[40, 62, 48, 80, 70, 92].map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
            <div className="gm-share-lines">
              {[90, 70, 84, 60].map((width, index) => (
                <i key={index} style={{ width: `${width}%` }} />
              ))}
            </div>
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
        <span className="chip gm-share-label">
          <MonitorUp className="size-3.5 shrink-0 text-accent" />
          Your screen
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ noise */

export type NoiseState = { on: boolean };
export const NOISE_POSTER: NoiseState = { on: true };

// The microphone's level, bar by bar: a voice throughout, with keyboard clacks and a dog's bark
// on top when nothing takes them out.
const VOICE = [0.18, 0.26, 0.34, 0.42, 0.36, 0.3, 0.24, 0.32, 0.44, 0.5, 0.42, 0.34, 0.28, 0.22, 0.3, 0.38, 0.46, 0.52, 0.44, 0.36, 0.28, 0.24, 0.3, 0.36, 0.42, 0.34, 0.26, 0.2, 0.28, 0.36, 0.44, 0.38, 0.3, 0.24, 0.18];
const NOISE: Record<number, number> = { 4: 0.92, 6: 0.78, 8: 0.96, 10: 0.84, 22: 0.74, 23: 1, 24: 0.86, 25: 0.98, 26: 0.8, 27: 0.9 };

/** A picture of the microphone's signal over the real menu row that switches noise suppression. */
export function NoiseScene({ s }: { s: NoiseState }) {
  return (
    <div className="gm-scene gm-noise" data-on={s.on}>
      <div className="gm-noise-card">
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
            return <span key={index} data-noise={noise ? "" : undefined} style={{ transform: `scaleY(${level})`, transitionDelay: `${index * 12}ms` }} />;
          })}
        </div>
      </div>
        <div className="gm-menu-item">
          <AudioLines className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Noise suppression</span>
            <span className="block text-xs text-muted">Turn off when you play music</span>
          </span>
          <span className="switch" data-on={s.on} data-target="switch" data-cursor="hand" />
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
  /** Which count is showing: after your vote, or once everyone has voted. */
  tally: 0 | 1;
};
export const POLL_POSTER: PollState = { swap: false, vote: "yes", tally: 1 };

const OPTIONS = ["Tuesday", "Wednesday", "Thursday"];
// Your vote is Wednesday's: 1, 4, 2 just after it (7 votes), then 2, 7, 3 (12 votes).
const TALLIES = [
  [1, 4, 2],
  [2, 7, 3],
];

/** A poll as an ordinary voter sees it (Polls.tsx): results hidden until you vote, then the count. */
export function PollScene({ s, num = plain }: { s: PollState; num?: Num }) {
  return (
    <div className="gm-scene gm-poll">
      {/* The finished poll, leaving as the new one arrives: the picture is never empty. */}
      {s.swap && (
        <div className="gm-poll-old">
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
  const s = { vote };
  const votes = TALLIES[tally];
  const total = votes.reduce((sum, n) => sum + n, 0);
  const shown = vote === "yes";
  return (
      <div className="flex flex-col gap-2.5 rounded-2xl bg-surface p-3 shadow-[inset_0_0_0_1px_var(--border-strong)]">
        <div className="flex flex-col gap-0.5 px-1">
          <span className="block text-[0.9375rem] leading-snug font-semibold">Which day for the offsite?</span>
          <span className="block text-xs text-muted">Sam asked · votes are anonymous</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {OPTIONS.map((option, index) => {
            const mine = index === 1;
            const share = votes[index] / total;
            return (
              <div
                key={option}
                className="gm-option relative w-full overflow-hidden rounded-xl bg-surface-2"
                data-mine={mine && s.vote !== "none" ? "" : undefined}
                data-target={mine ? "wed" : undefined}
                data-cursor={mine && s.vote === "none" ? "hand" : undefined}
              >
                <span className="gm-bar absolute inset-0 origin-left bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]" style={{ transform: `scaleX(${shown ? share : 0})` }} />
                <span className="relative flex min-h-11 items-center gap-2 px-3 py-2 text-left text-[0.9375rem] leading-snug">
                  {mine && (
                    <span className="gm-mark" data-show={s.vote !== "none"}>
                      {/* Turning only while a vote is on its way, so nothing spins unseen. */}
                      <LoaderCircle className={`gm-mark-pending size-4 text-accent ${s.vote === "pending" ? "anim-spin" : ""}`} data-show={s.vote === "pending"} />
                      <Check className="gm-mark-done size-4 text-accent" data-show={s.vote === "yes"} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">{option}</span>
                  <span className="gm-count shrink-0 text-sm text-muted tabular-nums" data-show={shown}>
                    {num(votes[index])} · {num(Math.round(share * 100), (n) => `${n}%`)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="gm-foot grid min-h-8 items-center px-1 text-xs text-muted">
          <span data-show={!shown}>Results show once you vote</span>
          <span data-show={shown}>
            {num(total)} votes · you voted
          </span>
        </div>
      </div>
  );
}

/* -------------------------------------------------------------- reactions */

export type ReactState = {
  /** How many rows are in the lane, in the order they arrived (the first at the bottom). */
  rows: number;
  /** Claps so far: one is a name, more are a count. */
  claps: number;
  /** Bumped to send a burst of claps into the row. */
  burst: number;
};
export const REACT_POSTER: ReactState = { rows: 4, claps: 12, burst: 0 };

const LATER = [
  { emoji: "🎉", label: "×5" },
  { emoji: "❤️", label: "Lena" },
  { emoji: "😂", label: "×3", desktopOnly: true },
];

/**
 * The reaction lane (Reactions.tsx): a column at the bottom left, newest on top. One person's
 * emoji shows with their name; once several people send the same one, it is a count.
 */
export function ReactionsScene({ s, num = plain }: { s: ReactState; num?: Num }) {
  return (
    <div className="gm-scene gm-react">
      <div className="gm-burst" key={s.burst} data-go={s.burst > 0 || undefined}>
        {[0, 1, 2, 3, 4, 5, 6].map((index) => (
          <span key={index} style={{ ["--i" as string]: index }}>
            👏
          </span>
        ))}
      </div>
      <div className="gm-lane">
        <span className="chip gm-lane-row" data-show={s.rows > 0} style={{ ["--i" as string]: 0 }}>
          <span className="text-2xl leading-none">👏</span>
          <span className="gm-swap font-medium tabular-nums">
            <span data-show={s.claps < 2}>Sam</span>
            <span data-show={s.claps >= 2}>×{num(Math.max(2, s.claps))}</span>
          </span>
        </span>
        {LATER.map((row, index) => (
          <span
            key={row.emoji}
            className={`chip gm-lane-row ${row.desktopOnly ? "gm-desktop-only" : ""}`}
            data-show={s.rows > index + 1}
            style={{ ["--i" as string]: index + 1 }}
          >
            <span className="text-2xl leading-none">{row.emoji}</span>
            <span className="font-medium tabular-nums">{row.label}</span>
          </span>
        ))}
      </div>
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

/** The People list's "Raised hands" section (PeoplePanel.tsx), as the host sees it. */
export function HandsScene({ s, num = plain }: { s: HandsState; num?: Num }) {
  return (
    <div className="gm-scene gm-hands" data-any={s.count > 0}>
      {/* The People list's own insets are dropped, so the avatars and heading sit on the tile's copy edge. */}
      <div className="gm-hands-head flex h-10 items-end justify-between gap-2 pb-0.5">
        <span className="eyebrow flex gap-2 pb-1">
          Raised hands
          <span className="tracking-normal tabular-nums">{num(Math.max(1, s.count))}</span>
        </span>
        <span className="gm-lower text-sm font-semibold text-accent" data-target="lower" data-cursor="hand">
          Lower all
        </span>
      </div>
      <div>
        {HANDS.map((person, index) => (
          <div key={person.id} className="gm-hand flex h-14 items-center gap-3" data-show={s.count > index} style={{ ["--i" as string]: index }}>
            <span className="grid size-9 shrink-0 place-items-center rounded-full font-display text-sm font-semibold text-[#16161d]" style={{ background: person.color }}>
              {initials(person.name)}
            </span>
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
  );
}
