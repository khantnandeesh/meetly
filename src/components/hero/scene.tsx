import { ChevronUp, Crown, DoorOpen, Ellipsis, Hand, Link2, MessageSquare, Mic, MicOff, MonitorUp, PhoneOff, Smile, Users, Video, X } from "lucide-react";
import type { ReactNode } from "react";
import { avatarColor, initials } from "../ui/Avatar";
import { LogoMark } from "../ui/Logo";

/*
 * The home page's illustration: Meetly's own call screen, drawn with the app's own classes (tile,
 * avatar-disc, chip, bars, ctrl) and icons, so it looks like the product because it is built like it.
 *
 * The story is one thing Meetly really does. In a meeting that asks people to knock, somebody opens
 * the link and asks to join; the host gets "Pat wants to join" with Deny and Admit (the wording of
 * ModerationNotices.tsx and notices.ts), and the People button counts them as waiting. Admit lets
 * them in: the tiles glide to make room and Pat's grows in (Stage.tsx), the count goes up, and Pat
 * starts talking, so the speaking ring moves to them.
 *
 * Everything here is a pure function of the scene state, so the same render is the static poster
 * the page paints first (and keeps, under reduced motion) and every frame of the animation.
 *
 * Two designs, not one squeezed: "wide" is the desktop call screen (tiles over the control bar, the
 * notification above the controls at the right, as on a computer) and "compact" is the phone one
 * (the code and People in a top bar, notifications dropping in under it, the phone's six controls).
 * The wide bar keeps only the controls that fit at their real size: the call has more (reactions,
 * More, layout), and the illustration simplifies by leaving them out, never by redrawing them.
 */

export type HeroLayout = "wide" | "compact";
export type HeroState = {
  /** Pat is asking to join: the notification is up and People shows 1 waiting. */
  asking: boolean;
  /** Pat is in the meeting. */
  admitted: boolean;
  /** Whose speaking ring is lit. */
  speaker: "maya" | "pat" | null;
};

/** The opening frame, the end of every loop, and the poster: somebody asking to join. */
export const POSTER: HeroState = { asking: true, admitted: false, speaker: "maya" };

export const SIZE = {
  wide: { width: 558, height: 440 },
  compact: { width: 358, height: 464 },
} as const;
/** Below this container width the phone design shows (the kit's `compact.below`, and hero.css's container query). */
export const COMPACT_BELOW = 400;

type Person = { id: string; name: string; you?: boolean; host?: boolean; muted?: boolean };

// You first, then everyone else in the order they joined, as the call orders them (useSpeakers.ts).
// Colours come from Meetly's own avatar palette, keyed so the five are five different colours.
const PEOPLE: Person[] = [
  { id: "alex", name: "Alex Chen", you: true, host: true },
  { id: "maya", name: "Maya Okafor" },
  { id: "jonas", name: "Jonas Weber", muted: true },
  { id: "priya", name: "Priya Nair" },
];
const PAT: Person = { id: "pat", name: "Pat Moreno" };
const COLORS: Record<string, string> = {
  alex: "#f5d67a",
  maya: "#9fe0c2",
  jonas: "#f4b9a3",
  priya: "#a9d6f5",
  pat: "#f4a9c8",
};
const colorOf = (p: Person) => COLORS[p.id] ?? avatarColor(p.id);

/** The meeting's code, as the phone's top bar shows it (lib/code.ts's form). */
const CODE = "rvx-mhqa-tez";

/* ------------------------------------------------------------------ geometry */

type Box = { x: number; y: number; w: number; h: number };

const MAX_RATIO = 16 / 9;
/**
 * Stage.tsx's own grid: centred, evenly sized cells, the column count that gives `count` tiles the
 * largest area. Copied so the illustration's tiles sit exactly where the call would put them.
 */
function gridRects(count: number, w: number, h: number, gap: number, minRatio: number): Box[] {
  let best = { width: 0, height: 0, cols: 1 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (w - gap * (cols - 1)) / cols;
    const cellH = (h - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const ratio = Math.min(MAX_RATIO, Math.max(minRatio, cellW / cellH));
    const width = Math.min(cellW, cellH * ratio);
    const height = width / ratio;
    if (width * height > best.width * best.height) best = { width, height, cols };
  }
  const tw = Math.floor(best.width);
  const th = Math.floor(best.height);
  const rows = Math.ceil(count / best.cols);
  const top = (h - (rows * th + (rows - 1) * gap)) / 2;
  const rects: Box[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / best.cols);
    const inRow = row === rows - 1 ? count - row * best.cols : best.cols;
    const left = (w - (inRow * tw + (inRow - 1) * gap)) / 2;
    rects.push({ x: Math.round(left + (i % best.cols) * (tw + gap)), y: Math.round(top + row * (th + gap)), w: tw, h: th });
  }
  return rects;
}

/**
 * The inset every edge keeps. On a computer the call runs to the stage's edges: the page around it
 * is the gutter, and five tiles across three columns stay wider than 11rem, the width under which
 * Meetly shrinks a tile's name chip (globals.css), so the chips never jump as Pat comes and goes.
 * On a phone one full 16px gutter (the phone call's is 12px; 16 keeps the notification, which
 * spans the screen, a clear gutter from the frame), which also leaves room for the "1 waiting"
 * badge that hangs off People's corner.
 */
const PAD: Record<HeroLayout, number> = { wide: 0, compact: 16 };
const GAP = 12; // Stage.tsx's gap for up to nine tiles
const BAR = 48; // a .ctrl's height

/** Where the tiles go: the area between the top (or the phone's top bar) and the controls. */
function tileArea(layout: HeroLayout): Box {
  const { width, height } = SIZE[layout];
  // Wide: the stage's 12px under the tiles plus the footer's 4px over the controls.
  // Compact: the phone's top bar (h-11) and the 8px under it; the same 12px over the controls.
  const pad = PAD[layout];
  const top = layout === "wide" ? pad : pad + 44 + 8;
  const bottom = height - pad - BAR - (layout === "wide" ? 16 : 12);
  return { x: pad, y: top, w: width - pad * 2, h: bottom - top };
}

const LAYOUTS = (["wide", "compact"] as const).reduce(
  (out, layout) => {
    const area = tileArea(layout);
    // Stage.tsx: tiles may be as tall as 0.7:1 in a stage under 640 wide.
    const place = (n: number) => gridRects(n, area.w, area.h, GAP, 0.7).map((r) => ({ ...r, x: r.x + area.x, y: r.y + area.y }));
    out[layout] = { four: place(4), five: place(5) };
    return out;
  },
  {} as Record<HeroLayout, { four: Box[]; five: Box[] }>,
);

/* --------------------------------------------------------------------- scene */

export function MeetingScene({
  s,
  layout,
  quiet = false,
  count,
}: {
  s: HeroState;
  layout: HeroLayout;
  /** The New meeting menu is open over the illustration on a phone: the notification steps aside. */
  quiet?: boolean;
  /** How the People count is drawn; the animated stage rolls it, the poster writes it. */
  count?: (n: number) => ReactNode;
}) {
  const headcount = PEOPLE.length + (s.admitted ? 1 : 0);
  const shown = count ? count(headcount) : headcount;
  const rects = LAYOUTS[layout][s.admitted ? "five" : "four"];
  const patRect = LAYOUTS[layout].five[4];
  return (
    // The call screen is the product's own surface and fills the stage. Its ground is Meetly's
    // --bg, which is the page's, so it is not painted: a painted rectangle would read as a plate
    // on the home page's glow. `ss-window` (which has no styles here) tells the stageshow film
    // checks that the tiles are this screen's layout, not cards set loose on the page.
    <div className="hero-scene ss-window" data-layout={layout} data-admitted={s.admitted}>
      {layout === "compact" && <PhoneTopBar count={shown} waiting={s.asking} />}

      {PEOPLE.map((person, i) => (
        <HeroTile key={person.id} person={person} rect={rects[i]} speaking={s.speaker === person.id} />
      ))}
      {/* Pat's tile is always there, so it can grow in and fade away rather than pop. */}
      <HeroTile person={PAT} rect={patRect} speaking={s.speaker === "pat"} present={s.admitted} />

      {layout === "wide" ? <DesktopBar count={shown} waiting={s.asking} /> : <PhoneBar />}

      <KnockNotice show={s.asking} quiet={quiet} layout={layout} />
      {/* Where the cursor waits between beats: the empty end of the control bar, clear of every tile. */}
      <span className="hero-rest" data-target="rest" />
    </div>
  );
}

function HeroTile({ person, rect, speaking, present = true }: { person: Person; rect: Box; speaking: boolean; present?: boolean }) {
  const color = colorOf(person);
  const muted = !!person.muted;
  return (
    <div
      className="tile hero-tile"
      data-placed=""
      data-speaking={speaking && !muted}
      data-present={present}
      style={{ width: rect.w, height: rect.h, transform: `translate(${rect.x}px, ${rect.y}px)` }}
    >
      <div className="tile-media absolute inset-0">
        <div
          className="absolute inset-0 grid place-items-center"
          style={{ background: `radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, ${color} 18%, var(--surface-2)), var(--surface) 75%)` }}
        >
          <span
            className="avatar-disc"
            style={{ "--c": color, width: "clamp(2.5rem, 32cqmin, 8.5rem)", fontSize: "clamp(1rem, 13cqmin, 3.5rem)" } as React.CSSProperties}
          >
            {initials(person.name)}
          </span>
        </div>
      </div>
      <div className="tile-meta absolute bottom-2 left-2 z-30 flex max-w-[calc(100%-1rem)] items-center gap-1.5">
        <span className="chip min-w-0">
          {muted ? (
            <MicOff className="size-3.5 shrink-0 text-danger-text" />
          ) : (
            // The speaking bars open their own room, so the name moves over instead of jumping.
            <span className="hero-bars" data-on={speaking}>
              <span className="bars text-accent">
                <i />
                <i />
                <i />
              </span>
            </span>
          )}
          <span className="truncate">{person.you ? `${person.name} (You)` : person.name}</span>
          {person.host && <Crown className="size-3.5 shrink-0 text-accent" />}
        </span>
      </div>
    </div>
  );
}

/** "1 waiting" on People, as ControlBar.tsx and Conference.tsx's WaitingCount draw it. */
function WaitingBadge({ show }: { show: boolean }) {
  return (
    <span
      className="hero-badge absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-accent-ink tabular-nums ring-3 ring-bg"
      data-show={show}
    >
      1
    </span>
  );
}

/** The desktop control bar (ControlBar.tsx), the controls that fit at their real size. */
function DesktopBar({ count, waiting }: { count: ReactNode; waiting: boolean }) {
  const { width, height } = SIZE.wide;
  return (
    <div
      className="hero-bar absolute grid grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-4"
      style={{ left: 0, top: height - BAR, width }}
    >
      <span />
      <span className="flex items-center justify-center gap-2">
        <span className="ctrl-split">
          <span className="ctrl">
            <Mic className="size-5" />
          </span>
          <span className="ctrl">
            <ChevronUp className="size-4" />
          </span>
        </span>
        <span className="ctrl-split">
          <span className="ctrl">
            <Video className="size-5" />
          </span>
          <span className="ctrl">
            <ChevronUp className="size-4" />
          </span>
        </span>
        <span className="ctrl">
          <MonitorUp className="size-5" />
        </span>
        <span className="ctrl">
          <Hand className="size-5" />
        </span>
        <span className="mx-1 h-6 w-px bg-border-strong" />
        {/* The host's leave button, with "End meeting for everyone" behind its arrow. */}
        <span className="ctrl-split">
          <span className="ctrl ctrl-danger w-16">
            <PhoneOff className="size-5" />
          </span>
          <span className="ctrl ctrl-danger">
            <ChevronUp className="size-4" />
          </span>
        </span>
      </span>
      <span className="flex min-w-0 items-center justify-end gap-2">
        <span className="ctrl px-3.5">
          <Users className="size-5" />
          <span className="hero-count text-sm font-semibold tabular-nums">{count}</span>
          <WaitingBadge show={waiting} />
        </span>
        <span className="ctrl">
          <MessageSquare className="size-5" />
        </span>
      </span>
    </div>
  );
}

/** The phone's top bar (Conference.tsx): the code, which copies the link, and People. */
function PhoneTopBar({ count, waiting }: { count: ReactNode; waiting: boolean }) {
  return (
    <div className="absolute flex h-11 items-center justify-between gap-2" style={{ left: PAD.compact, right: PAD.compact, top: PAD.compact }}>
      <span className="inline-flex h-11 min-w-0 items-center gap-2.5 rounded-xl pr-3 pl-1 font-mono text-[0.8125rem] text-muted">
        <LogoMark className="size-7 shrink-0" />
        <span className="truncate">{CODE}</span>
        <Link2 className="size-4 shrink-0" />
      </span>
      <span className="relative inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-surface-2 px-3.5 text-sm font-semibold tabular-nums">
        <Users className="size-[1.125rem]" />
        <span className="hero-count">{count}</span>
        <WaitingBadge show={waiting} />
      </span>
    </div>
  );
}

/** The phone's control bar (ControlBar.tsx): microphone, camera, reactions, chat, More, leave. */
function PhoneBar() {
  const { height } = SIZE.compact;
  const pad = PAD.compact;
  return (
    <div className="absolute flex items-center justify-between" style={{ left: pad, right: pad, top: height - pad - BAR }}>
      {[Mic, Video, Smile, MessageSquare, Ellipsis].map((Icon, i) => (
        <span key={i} className="ctrl">
          <Icon className="size-5" />
        </span>
      ))}
      <span className="ctrl ctrl-danger ml-2">
        <PhoneOff className="size-5" />
      </span>
    </div>
  );
}

/**
 * "Pat wants to join", as Toaster.tsx draws a notification with two answers: the door, the title
 * and the close button on one line, Deny and Admit on a line of their own under it. On a computer
 * it rises in over the bottom-right corner, above the controls; on a phone it drops in under the
 * top bar. Two small liberties, so the card keeps one inset when Admit shows its pressed fill: the
 * answers sit 4px further in from the right, and the card has 12px under them where the app has 8.
 */
function KnockNotice({ show, quiet, layout }: { show: boolean; quiet: boolean; layout: HeroLayout }) {
  return (
    <div className="hero-toast-slot" data-layout={layout} data-hero-toast="" data-quiet={quiet || undefined}>
      <div
        className="hero-toast ss-toast flex flex-wrap items-center gap-x-3 rounded-2xl bg-surface-2 pt-2 pr-2 pb-3 pl-3.5 text-sm shadow-[inset_0_0_0_1px_var(--border-strong),0_16px_40px_-12px_rgb(0_0_0/0.7)]"
        data-show={show}
      >
        <span className="shrink-0 text-accent">
          <DoorOpen className="size-5" />
        </span>
        <span className="min-w-0 flex-1 py-1.5">
          <span className="block font-medium">Pat wants to join</span>
        </span>
        <span className="order-last -mt-1.5 mr-1 flex basis-full justify-end gap-1">
          <span className="hero-answer grid h-9 shrink-0 place-items-center rounded-lg px-3 font-semibold text-muted" data-cursor="hand">
            Deny
          </span>
          <span className="hero-answer grid h-9 shrink-0 place-items-center rounded-lg px-3 font-semibold text-accent" data-target="admit" data-cursor="hand">
            Admit
          </span>
        </span>
        <span className="grid size-9 shrink-0 place-items-center rounded-xl text-muted">
          <X className="size-4" />
        </span>
      </div>
    </div>
  );
}
