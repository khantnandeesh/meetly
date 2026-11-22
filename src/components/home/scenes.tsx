import { AudioLines, Check, Coffee, Dog, Hand, Keyboard, LoaderCircle, Mic, MonitorUp, X } from "lucide-react";
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
 * copy. The product surface starts on the copy's gutter, directly under the copy, and runs off the
 * tile's foot; the reaction tile is a call's video tile, whole tile, with the copy on it.
 *
 * Each story only ever moves forward: new data arrives, nothing is played back. Every state carries
 * `beat`, true while the tile is in the middle of a change, which the page's tests read to check
 * that only one tile moves at a time.
 */

export type TileId = "share" | "noise" | "polls" | "reactions" | "hands";

/** How a number is drawn: the animated stage rolls it, the poster writes it. */
export type Num = (value: number, format?: (n: number) => string) => ReactNode;
const plain: Num = (value, format) => (format ? format(value) : String(value));

const vars = (values: Record<string, string | number>) => values as CSSProperties;

/* ------------------------------------------------------------------ share */

export type ShareState = { week: number; grown: boolean; beat: boolean };
export const SHARE_POSTER: ShareState = { week: 12, grown: true, beat: false };

// The shared slide's chart: weekly sign-ups, rising with a little noise. Each beat a new week comes in.
const signups = (week: number) => 60 + week * 9 + 14 * Math.sin(week * 1.7);
const BARS = 10;

/**
 * The presenter's own screen-share tile (Stage.tsx): the shared slide filling it edge to edge, and
 * the "You're sharing your screen" banner with Stop sharing at its top. The presenter's chart takes
 * in a new week now and then: the bars move along and the new one grows. On a phone the computer's
 * screen is drawn a little smaller (0.85), so the banner fits whole at a phone's gutter, and runs
 * off the tile's right edge; its chart is six weeks wide there, ending inside the tile.
 */
export function ShareScene({ s, layout }: { s: ShareState; layout: "wide" | "compact" }) {
  // On a phone the chart is six weeks wide, so its newest end shows inside the tile.
  const bars = layout === "compact" ? 6 : BARS;
  const weeks = Array.from({ length: bars + 1 }, (_, i) => s.week - bars + i);
  const top = Math.max(...weeks.slice(1).map(signups));
  return (
    <div className="gm-scene gm-share" data-layout={layout} data-beat={s.beat}>
      <div className="gm-share-frame">
        <div className="gm-share-screen">
          <div className="gm-share-page">
            <span className="gm-slide-kicker">Weekly review</span>
            <span className="gm-slide-title">Sign-ups since the beta</span>
            <div className="gm-slide-chart" data-crop style={vars({ "--n": bars })}>
              {weeks.map((week, index) => {
                const newest = week === s.week;
                const level = newest && !s.grown ? 0.02 : signups(week) / top;
                return <span key={week} data-out={index === 0 || undefined} data-last={newest || undefined} style={vars({ "--k": index - 1, "--h": level.toFixed(3) })} />;
              })}
            </div>
          </div>
          <div className="gm-share-banner">
            <div className="flex items-center gap-3 rounded-2xl bg-[rgb(11_11_15/0.8)] py-1.5 pr-1.5 pl-3.5 text-sm font-medium whitespace-nowrap backdrop-blur-md">
              <MonitorUp className="size-4 text-accent" />
              You&apos;re sharing your screen
              <span className="gm-stop grid h-9 place-items-center rounded-xl bg-danger px-3 font-semibold text-white">Stop sharing</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ noise */

export type NoiseState = { event: number; noisy: boolean; beat: boolean };
export const NOISE_POSTER: NoiseState = { event: 0, noisy: false, beat: false };

const BAR_COUNT = 64;
// The voice, bar by bar (a bar every 8px from the tile's left edge), in syllables with gaps
// between them; each beat is the next few words, so the syllables' loudness changes.
const voice = (i: number, event: number) => {
  const syllable = Math.max(0, Math.sin(i * 0.42)) ** 0.6;
  const word = 0.62 + 0.38 * Math.abs(Math.sin(i * 1.3 + event * 2.1));
  return 0.16 + 0.46 * syllable * word;
};
// What the microphone also picks up, in a gap between syllables, and what it is.
const NOISES = [
  { name: "Keyboard", Icon: Keyboard, bars: { 8: 0.92, 10: 1, 12: 0.86 }, at: "gap1" },
  { name: "Dog", Icon: Dog, bars: { 25: 0.78, 26: 1, 27: 0.92, 28: 1, 29: 0.86 }, at: "gap2" },
  { name: "Coffee machine", Icon: Coffee, bars: { 8: 0.7, 9: 0.84, 10: 0.78, 11: 0.9, 12: 0.74, 13: 0.66 }, at: "gap1" },
] as const;

/**
 * Noise suppression at work, on as it is by default: what others hear (the voice, light) over what
 * the microphone also picked up (a noise, in grey, named), above the real Audio settings menu
 * (ControlBar.tsx) with its switch on. The menu runs on past the tile's foot.
 */
export function NoiseScene({ s }: { s: NoiseState }) {
  const noise = NOISES[s.event % NOISES.length];
  return (
    <div className="gm-scene gm-noise" data-noisy={s.noisy} data-beat={s.beat}>
      <div className="gm-wave">
        {NOISES.map((each, index) => (
          <span key={each.name} className="gm-wave-tag" data-at={each.at} data-name={each.name} data-show={s.noisy && index === s.event % NOISES.length}>
            <each.Icon className="size-3.5" />
            {each.name}
          </span>
        ))}
        <div className="gm-wave-bars" data-layer="noise">
          {Array.from({ length: BAR_COUNT }, (_, index) => {
            const level = (noise.bars as Record<number, number>)[index];
            return <span key={index} style={{ transform: `scaleY(${s.noisy && level ? level : 0})` }} />;
          })}
        </div>
        <div className="gm-wave-bars" data-layer="voice">
          {Array.from({ length: BAR_COUNT }, (_, index) => (
            <span key={index} style={{ transform: `scaleY(${voice(index, s.event).toFixed(3)})`, transitionDelay: `${index * 8}ms` }} />
          ))}
        </div>
      </div>
      <div className="gm-menu" data-crop>
        <div className="gm-menu-label">
          <Mic className="size-3.5" />
          <span>Microphone</span>
        </div>
        <div className="gm-menu-item pr-10">
          <span className="min-w-0 truncate">MacBook Pro Microphone</span>
          <Check className="absolute right-3 size-4 text-muted" />
        </div>
        <div className="gm-menu-item">
          <AudioLines className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Noise suppression</span>
            <span className="block text-xs text-muted">Turn off when you play music</span>
          </span>
          <span className="switch" data-on="true" />
        </div>
        <div className="gm-menu-sep" />
        <div className="gm-menu-label">
          <span>Speaker</span>
        </div>
        <div className="gm-menu-item pr-10">
          <span className="min-w-0 truncate">MacBook Pro Speakers</span>
        </div>
        <div className="gm-menu-item pr-10">
          <span className="min-w-0 truncate">AirPods Pro</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ polls */

export type PollState = {
  poll: number;
  /** How far the votes have come: each step, new votes have arrived. */
  step: number;
  vote: "none" | "pending" | "yes";
  /** The poll on screen has ended (its host ended it); a new one comes next. */
  ended: boolean;
  /** The ended poll is leaving as the new one comes in under it. */
  swap: boolean;
  beat: boolean;
};
export const POLL_POSTER: PollState = { poll: 0, step: 0, vote: "yes", ended: false, swap: false, beat: false };

// Polls in turn, as a host asks them through a meeting. Each runs for three steps of votes (the
// first with yours in it), then ends. The last option of each runs off the tile's foot: only the
// top of its row shows, so it has no words.
const POLLS = [
  {
    question: "Which day for the offsite?",
    by: "Sam",
    options: ["Monday", "Tuesday", "Wednesday", "Thursday"],
    mine: 2,
    steps: [
      [1, 2, 7, 2],
      [1, 3, 8, 2],
      [2, 3, 10, 3],
    ],
  },
  {
    question: "Lunch on the day?",
    by: "Noor",
    options: ["Tacos", "Sushi", "Pizza", "Salads"],
    mine: 1,
    steps: [
      [2, 3, 1, 1],
      [3, 5, 1, 2],
      [3, 6, 2, 2],
    ],
  },
  {
    question: "Where should we meet?",
    by: "Theo",
    options: ["Lisbon", "Berlin", "Online", "London"],
    mine: 0,
    steps: [
      [4, 2, 1, 1],
      [5, 3, 2, 1],
      [7, 3, 2, 2],
    ],
  },
] as const;
export const POLL_STEPS = 3;
export const pollAt = (index: number) => POLLS[index % POLLS.length];
const total = (votes: readonly number[]) => votes.reduce((sum, n) => sum + n, 0);

/** A poll as an ordinary voter sees it (Polls.tsx): results hidden until you vote, then the counts. */
export function PollScene({ s, num = plain }: { s: PollState; num?: Num }) {
  return (
    <div className="gm-scene gm-poll" data-beat={s.beat}>
      {/* The ended poll, leaving as the new one arrives: the picture is never empty. */}
      {s.swap && (
        <div className="gm-poll-card gm-poll-old" data-crop>
          <PollCard poll={s.poll - 1} step={POLL_STEPS - 1} vote="yes" ended num={plain} />
        </div>
      )}
      <div className="gm-poll-card" data-in={s.swap || undefined} data-crop>
        <PollCard poll={s.poll} step={s.step} vote={s.vote} ended={s.ended} num={num} />
      </div>
    </div>
  );
}

function PollCard({ poll, step, vote, ended, num }: { poll: number; step: number; vote: PollState["vote"]; ended: boolean; num: Num }) {
  const { question, by, options, mine, steps } = pollAt(poll);
  const votes = steps[step];
  const sum = total(votes);
  const shown = vote === "yes";
  return (
    <>
      <div className="gm-poll-head flex flex-col gap-0.5">
        <span className="block text-[0.9375rem] leading-snug font-semibold">{question}</span>
        <span className="gm-swap text-xs text-muted">
          <span data-show={!ended}>{by} asked · votes are anonymous</span>
          <span data-show={ended}>Ended · {sum} votes</span>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {[...options, ""].map((option, index) => {
          const own = index === mine;
          const share = option ? votes[index] / sum : 0;
          return (
            <div key={index} className="gm-option relative w-full overflow-hidden rounded-xl bg-surface-2" data-mine={own && vote !== "none" ? "" : undefined}>
              <span className="gm-bar absolute inset-0 origin-left" data-mine={own || undefined} style={{ transform: `scaleX(${shown ? share : 0})` }} />
              <span className="relative flex min-h-11 items-center gap-2 px-3 py-2 text-left text-[0.9375rem] leading-snug">
                {own && (
                  <span className="gm-mark" data-show={vote !== "none"}>
                    {/* Turning only while a vote is on its way, so nothing spins unseen. */}
                    <LoaderCircle className={`gm-mark-pending size-4 text-accent ${vote === "pending" ? "anim-spin" : ""}`} data-show={vote === "pending"} />
                    <Check className="gm-mark-done size-4 text-accent" data-show={vote === "yes"} />
                  </span>
                )}
                <span className="min-w-0 flex-1">{option}</span>
                {option && (
                  <span className="gm-count flex shrink-0 items-baseline gap-1 text-sm text-muted tabular-nums" data-show={shown}>
                    <span>{num(votes[index])}</span>
                    <span>·</span>
                    <span>{num(Math.round(share * 100), (n) => `${n}%`)}</span>
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* -------------------------------------------------------------- reactions */

export type LaneRow = { id: number; emoji: string; name?: string; count: number; leaving?: boolean; bumped?: boolean };
export type ReactState = { rows: LaneRow[]; next: number; beat: boolean };
export const REACT_POSTER: ReactState = {
  rows: [
    { id: 1, emoji: "👏", count: 12 },
    { id: 2, emoji: "🎉", count: 5 },
    { id: 3, emoji: "❤️", name: "Lena", count: 1 },
    { id: 4, emoji: "😂", count: 3 },
  ],
  next: 5,
  beat: false,
};
const SPEAKER = { name: "Tomás Rivera", color: "#f4a9c8" };

/**
 * A speaker's video tile, camera off (Tile.tsx), with the reaction lane over its lower left
 * (Reactions.tsx): rows from people whose tiles are out of view, above the speaker's name label,
 * oldest at the bottom, newest on top. One person's emoji shows with their name; several people's
 * share a row whose count climbs. Rows leave as they expire, oldest first.
 */
export function ReactionsScene({ s, num = plain }: { s: ReactState; num?: Num }) {
  let slot = 0;
  return (
    <div className="gm-scene gm-react" data-beat={s.beat}>
      <div className="gm-video" style={vars({ "--c": SPEAKER.color })}>
        <span className="gm-disc">{initials(SPEAKER.name)}</span>
      </div>
      <div className="gm-lane" data-emoji>
        {s.rows.map((row) => {
          const at = row.leaving ? 0 : slot++;
          return (
            <span key={row.id} className="chip gm-lane-row" data-show={!row.leaving} data-new={row.id > 4 || undefined} style={vars({ "--i": at })}>
              <span className="gm-nudge text-xl leading-none" key={row.count} data-go={row.bumped || undefined}>
                {row.emoji}
              </span>
              <span className="font-medium tabular-nums">{row.name ?? num(row.count, (n) => `×${n}`)}</span>
            </span>
          );
        })}
      </div>
      <span className="chip gm-name">
        <span className="bars shrink-0">
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

/**
 * The queue of raised hands moves on, one turn at a time: the 1st is given the floor and speaks,
 * lowers their hand, the 2nd and 3rd move up a place, and someone new puts a hand up as 3rd.
 * `next` counts the hands that have gone up; the queue is hands next-3, next-2 and next-1.
 */
export type HandsState = { next: number; speaking: boolean; leaving: boolean; beat: boolean };
export const HANDS_POSTER: HandsState = { next: 3, speaking: false, leaving: false, beat: false };

const PEOPLE = {
  dana: { name: "Dana Brooks", color: "#9fe0c2" },
  amara: { name: "Amara Osei", color: "#f5d67a" },
  ines: { name: "Ines Duarte", color: "#f4a9c8" },
  jonas: { name: "Jonas Weber", color: "#f4b9a3" },
  kofi: { name: "Kofi Mensah", color: "#c9b8f7" },
  priya: { name: "Priya Nair", color: "#a9d6f5" },
} as const;
type Person = keyof typeof PEOPLE;
// Who puts a hand up next, in turn (the host, Dana, runs the queue). Any four in a row are four
// different people, so nobody is in the queue twice.
const RAISERS: Person[] = ["priya", "jonas", "kofi", "ines", "amara"];
const PLACES = ["1st", "2nd", "3rd"];
// Everyone, you first, then A to Z (PeoplePanel.tsx): the six the panel counts. It starts under
// the three hands, past the tile's foot.
const EVERYONE: { id: Person; note?: string }[] = [{ id: "dana", note: "You · Host" }, { id: "amara" }, { id: "ines" }];

/**
 * The People panel (Conference.tsx, PeoplePanel.tsx) as the host sees it: raised hands first, in
 * the order they went up, then everyone. As the queue moves, its rows glide up a place (by
 * transform) and take their new places' names.
 */
export function HandsScene({ s, num = plain }: { s: HandsState; num?: Num }) {
  // The queue, oldest first, with the 1st's row kept while it leaves.
  const hands = Array.from({ length: 4 }, (_, i) => s.next - 4 + i).filter((hand) => hand >= 0);
  return (
    <div className="gm-scene gm-hands" data-beat={s.beat}>
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
        <div className="gm-hands-head flex h-10 items-end justify-between gap-2 pr-3 pb-0.5 pl-5">
          <span className="eyebrow flex gap-2 pb-1">
            Raised hands
            <span className="tracking-normal tabular-nums">{num(3)}</span>
          </span>
          <span className="gm-lower text-sm font-semibold">Lower all</span>
        </div>
        <div className="gm-queue mx-2">
          {hands.map((hand) => {
            const place = hand - (s.next - 3);
            const person = PEOPLE[RAISERS[hand % RAISERS.length]];
            const gone = place < 0 || (place === 0 && s.leaving);
            return (
              <div
                key={hand}
                className="gm-hand flex h-14 items-center gap-3 px-3"
                data-show={!gone}
                data-new={hand >= 3 || undefined}
                style={vars({ "--slot": Math.max(place, 0) })}
              >
                <Face name={person.name} color={person.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] font-medium">{person.name}</span>
                  <span className="gm-swap gm-places text-xs">
                    {PLACES.map((label, index) => (
                      <span key={label} className="gm-place" data-show={index === Math.max(place, 0)} data-first={index === 0 || undefined}>
                        {label}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="gm-handbadge grid size-8 place-items-center rounded-lg">
                    <Hand className="size-4" />
                  </span>
                  <span className="gm-swap size-8 place-items-center text-muted">
                    {/* The 1st has the floor: the panel shows them speaking. */}
                    <Mic className="size-[1.125rem]" data-show={!(place === 0 && s.speaking)} />
                    <span className="bars" data-show={place === 0 && s.speaking}>
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="gm-everyone">
          <div className="eyebrow mt-1 flex h-10 items-end gap-2 px-5 pb-1.5">
            In this meeting
            <span className="tracking-normal tabular-nums">6</span>
          </div>
          <div className="px-2">
            {EVERYONE.map(({ id, note }) => (
              <div key={id} className="flex h-14 items-center gap-3 px-3">
                <Face name={PEOPLE[id].name} color={PEOPLE[id].color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] font-medium">{PEOPLE[id].name}</span>
                  {note && <span className="block text-xs text-muted">{note}</span>}
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
