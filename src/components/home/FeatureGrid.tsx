"use client";

import { AudioLines, Check, Hand, Mic, MonitorUp } from "lucide-react";
import { useEffect, useRef } from "react";
import { initials } from "../ui/Avatar";
import "./feature-grid.css";

/*
 * The home page's feature grid, under the hero: five tiles, each one real moment of a Meetly call,
 * drawn with the app's own classes and icons. Built to the stageshow skill's bento rules: one
 * picture per tile at its native size (never the grid scaled), copy as page text beside it, one
 * hero tile, neighbours of different kinds, and nothing said twice.
 *
 * Every picture is still. The one motion is the poll's bars filling once as the card comes into
 * view (PollBars below); the hero above is the page's only loop. So this is plain markup and CSS,
 * not the hero's animation engine: it costs the page almost nothing.
 *
 * The pictures carry `ss-stage` (styled here, not by the kit) so the skill's film checks can find
 * and judge each one as a picture. They are decorative: hidden from assistive technology, whose
 * users get the same facts from each tile's copy.
 */

export function FeatureGrid() {
  return (
    <section aria-labelledby="inside-a-meeting" className="fg anim-rise border-t border-border pt-10 [animation-delay:200ms]">
      <h2 id="inside-a-meeting" className="fg-heading font-display font-semibold">
        Inside a meeting
      </h2>
      <ul className="fg-grid">
        <li className="fg-tile fg-wide" data-feature="share">
          <p className="fg-copy">
            <strong>Share your screen.</strong> On a computer, share a tab, a window or your whole screen.
          </p>
          <SharePicture />
        </li>
        <li className="fg-tile" data-feature="noise">
          <NoiseStatement />
        </li>
        <li className="fg-tile" data-feature="polls">
          <p className="fg-copy">
            <strong>Quick polls.</strong> The host asks, everyone gets one vote, and votes can be anonymous.
          </p>
          <PollPicture />
        </li>
        <li className="fg-tile" data-feature="reactions">
          <p className="fg-copy">
            <strong>React without unmuting.</strong> When many people send the same emoji, it shows as one count.
          </p>
          <ReactionsPicture />
        </li>
        <li className="fg-tile" data-feature="hands">
          <p className="fg-copy">
            <strong>Hands, in order.</strong> Raised hands are listed in the order they went up, and the host can lower them all in one tap.
          </p>
          <HandsPicture />
        </li>
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------- 1. screen share */

/**
 * The presenter's own view while sharing (Stage.tsx and Tile.tsx): the shared tab in a screen-share
 * tile, the "You're sharing your screen" banner with Stop sharing, and the "Your screen" label. On a
 * wide tile it runs off the tile's right edge; where the tile is narrow it is drawn whole and
 * smaller, as a computer's screen would be, so the banner and its button are never cut.
 */
function SharePicture() {
  return (
    <div className="fg-pic ss-stage fg-share" aria-hidden="true">
      <div className="fg-share-frame">
        <div className="fg-share-page">
          <i className="fg-share-title" />
          <div className="fg-share-cols">
            <div className="fg-share-chart">
              {[40, 62, 48, 80, 70, 92].map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
            <div className="fg-share-lines">
              {[90, 70, 84, 60].map((width, index) => (
                <i key={index} style={{ width: `${width}%` }} />
              ))}
            </div>
          </div>
        </div>
        <div className="fg-share-banner flex items-center gap-3 rounded-2xl bg-[rgb(11_11_15/0.8)] py-1.5 pr-1.5 pl-3.5 text-sm font-medium whitespace-nowrap backdrop-blur-md">
          <MonitorUp className="size-4 text-accent" />
          You&apos;re sharing your screen
          <span className="grid h-9 place-items-center rounded-xl bg-danger px-3 font-semibold text-white">Stop sharing</span>
        </div>
        <span className="chip fg-share-label">
          <MonitorUp className="size-3.5 shrink-0 text-accent" />
          Your screen
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 2. noise suppression */

/** A statement tile: the setting's own name, one line in large type, and the menu's own hint. */
function NoiseStatement() {
  return (
    <div className="fg-statement">
      <h3 className="fg-statement-label">
        <span className="fg-glyph" aria-hidden="true">
          <AudioLines className="size-[1.375rem]" />
        </span>
        Noise suppression
      </h3>
      <p className="fg-statement-big font-display">Background noise, turned down.</p>
      <p className="fg-statement-line">On by default. Turn it off when you play music.</p>
    </div>
  );
}

/* ---------------------------------------------------------------------- 3. polls */

const POLL = {
  question: "Which day for the offsite?",
  asked: "Sam asked · votes are anonymous",
  options: [
    { text: "Tuesday", votes: 2 },
    { text: "Wednesday", votes: 7, mine: true },
    { text: "Thursday", votes: 3 },
  ],
} as const;
const POLL_TOTAL = POLL.options.reduce((sum, option) => sum + option.votes, 0);

/** A poll as an ordinary voter sees it once they have voted (Polls.tsx), with no host controls. */
function PollPicture() {
  const card = useRef<HTMLDivElement>(null);
  usePollBarsOnce(card);
  return (
    <div className="fg-pic ss-stage fg-poll" aria-hidden="true">
      <div ref={card} className="flex flex-col gap-2.5 rounded-2xl bg-surface p-3 shadow-[inset_0_0_0_1px_var(--border-strong)]">
        <div className="flex flex-col gap-0.5 px-1">
          <span className="block text-[0.9375rem] leading-snug font-semibold">{POLL.question}</span>
          <span className="block text-xs text-muted">{POLL.asked}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {POLL.options.map((option) => {
            const share = option.votes / POLL_TOTAL;
            const mine = "mine" in option && option.mine;
            return (
              <div
                key={option.text}
                className={`relative w-full overflow-hidden rounded-xl bg-surface-2 ${mine ? "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_45%,var(--border))]" : "shadow-[inset_0_0_0_1px_var(--border)]"}`}
              >
                {/* Full by default: this is what a still, a screenshot or a page with no script shows. */}
                <span
                  data-poll-bar
                  className="absolute inset-0 origin-left bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]"
                  style={{ transform: `scaleX(${share})` }}
                />
                <span className="relative flex min-h-11 items-center gap-2 px-3 py-2 text-left text-[0.9375rem] leading-snug">
                  {mine && <Check className="size-4 shrink-0 text-accent" />}
                  <span className="min-w-0 flex-1">{option.text}</span>
                  <span className="shrink-0 text-sm text-muted tabular-nums">
                    {option.votes} · {Math.round(share * 100)}%
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex min-h-8 items-center px-1 text-xs text-muted">
          <span>{POLL_TOTAL} votes · you voted</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The grid's one motion: the poll's bars fill once, from the left, when the card is first at least
 * half on screen. The bars always render full, so a page with no script, a screenshot or a slow
 * page shows the result; the start (empty) is set only as the fill begins, by an animation that
 * runs from scaleX(0) to each bar's own value with the call's timing (--dur-slow, --ease-move),
 * transform alone. Nothing moves under reduced motion. It never runs again.
 */
function usePollBarsOnce(card: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = card.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const bars = Array.from(root.querySelectorAll<HTMLElement>("[data-poll-bar]"));
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio < 0.5) return;
        observer.disconnect();
        const tokens = getComputedStyle(document.documentElement);
        const duration = parseFloat(tokens.getPropertyValue("--dur-slow")) || 360;
        const easing = tokens.getPropertyValue("--ease-move").trim() || "ease-out";
        bars.forEach((bar) => bar.animate([{ transform: "scaleX(0)" }, { transform: bar.style.transform }], { duration, easing }));
      },
      { threshold: [0.5] },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [card]);
}

/* ------------------------------------------------------------------- 4. reactions */

/**
 * The reaction lane (Reactions.tsx): a column at the bottom left, newest on top, each row an emoji
 * with a name, or with a count once several people send the same one. A phone shows one row fewer.
 */
const LANE = [
  { emoji: "😂", label: "×3", desktopOnly: true },
  { emoji: "❤️", label: "Lena" },
  { emoji: "🎉", label: "×5" },
  { emoji: "👏", label: "×12" },
];

function ReactionsPicture() {
  return (
    <div className="fg-pic ss-stage fg-reactions" aria-hidden="true">
      <div className="fg-lane flex flex-col items-start gap-1.5">
        {LANE.map((row) => (
          <span key={row.emoji} className={`chip h-9 shrink-0 gap-2 pr-3 pl-2 text-sm shadow-lg ${row.desktopOnly ? "fg-desktop-only" : ""}`}>
            <span className="text-xl leading-none">{row.emoji}</span>
            <span className="font-medium tabular-nums">{row.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- 5. hands */

// Three colours from Meetly's avatar palette (ui/Avatar.tsx), chosen so no two are alike.
const HANDS = [
  { id: "priya", name: "Priya Nair", place: "1st", color: "#a9d6f5" },
  { id: "jonas", name: "Jonas Weber", place: "2nd", color: "#f4b9a3" },
  { id: "kofi", name: "Kofi Mensah", place: "3rd", color: "#c9b8f7" },
];

/** The People list's "Raised hands" section (PeoplePanel.tsx), as the host sees it. */
function HandsPicture() {
  return (
    <div className="fg-pic ss-stage fg-hands" aria-hidden="true">
      <div className="flex h-10 items-end justify-between gap-2 pr-3 pb-0.5 pl-5">
        <span className="eyebrow flex gap-2 pb-1">
          Raised hands
          <span className="tracking-normal tabular-nums">{HANDS.length}</span>
        </span>
        <span className="grid h-8 place-items-center rounded-lg px-2.5 text-sm font-semibold text-accent">Lower all</span>
      </div>
      <div className="px-2">
        {HANDS.map((person) => (
          <div key={person.id} className="flex h-14 items-center gap-3 rounded-xl px-3">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full font-display text-sm font-semibold text-[#16161d]"
              style={{ background: person.color }}
            >
              {initials(person.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.9375rem] font-medium">{person.name}</span>
              <span className="block text-xs text-muted">{person.place}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-ink">
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
