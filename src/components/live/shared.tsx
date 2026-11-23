"use client";

import { ChevronDown, Globe, LockKeyhole, ServerOff, Share2, Users, Waypoints, WifiOff } from "lucide-react";
import { Fact } from "@/components/ui/Fact";
import { useEffect, useId, useRef, useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { elapsedSeconds, formatElapsed } from "@/lib/meetingTime";
import { LIVE_VIEWER_CAP, type LiveTree } from "@/lib/live/tree";

/** The "Beta" tag, beside what it qualifies: "Serverless webinar" above each Live page's title. */
export function BetaTag() {
  return (
    <span className="inline-flex h-5 items-center rounded-md px-1.5 text-[0.6875rem] font-semibold tracking-wide text-accent uppercase ring-1 ring-accent/40 ring-inset">
      Beta
    </span>
  );
}

/**
 * `narrow`: as wide as the viewer's page (`max-w-5xl`), so the logo lines up with the video.
 * `onLeave`: given the logo's in-app navigation, which it may cancel (the host's page, while live).
 */
export function LiveHeader({ narrow = false, onLeave }: { narrow?: boolean; onLeave?: (event: { preventDefault: () => void }) => void }) {
  return (
    <header className={`mx-auto flex w-full items-center justify-between gap-3 px-4 py-5 sm:px-8 ${narrow ? "max-w-5xl" : "max-w-6xl"}`}>
      <Logo onNavigate={onLeave} />
    </header>
  );
}

/**
 * The app's `.ctrl` switch, drawn as unavailable while it cannot be used (`.ctrl` itself has no
 * disabled look; kept local so the call screen's controls are unchanged).
 */
export const CTRL =
  "ctrl disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-surface-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-surface-2";

/** The page's title block: what kind of webinar this is above, its name below. */
export function WebinarHeading({ title, detail }: { title: string; detail?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 pt-2">
      <p className="inline-flex items-center gap-2">
        <span className="eyebrow inline-flex items-center gap-1.5 text-accent">
          <ServerOff className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
          Serverless webinar
        </span>
        <BetaTag />
      </p>
      <h1
        className="font-display text-[clamp(1.875rem,5vw,2.75rem)] leading-[1.05] font-semibold tracking-[-0.03em] text-balance break-words"
        data-testid="webinar-title"
      >
        {title}
      </h1>
      {detail}
    </div>
  );
}

/**
 * "Never touches our servers": the indicator under the picture on both Live pages. One line, and
 * "How it works" opens the facts in place (a tap works on a phone, where a tooltip would not).
 */
export function ServerlessNote({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className={`rounded-2xl bg-surface ring-1 ring-border ${className}`} data-testid="serverless-note">
      <div className="flex items-center gap-3 py-2 pr-2 pl-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent" aria-hidden="true">
          <ServerOff className="size-4" strokeWidth={2.25} />
        </span>
        <p className="min-w-0 flex-1 text-sm font-semibold text-pretty">Never touches our servers</p>
        <button
          type="button"
          className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-sm font-medium text-accent hover:bg-surface-2"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((was) => !was)}
        >
          How it works
          <ChevronDown className={`size-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div id={panel} className="anim-fade border-t border-border px-4 py-4">
          <HowItWorks />
        </div>
      )}
    </div>
  );
}

/**
 * How a serverless webinar works, and its beta limits: an icon and a few words each, with the
 * full sentence in a tooltip and for screen readers (docs/UI-WRITING.md).
 */
export function HowItWorks() {
  const works = [
    {
      icon: <LockKeyhole />,
      label: "End-to-end encrypted",
      detail: "Only people with the full link can see the video, not us or anyone in between. The key is in the link and never reaches our server.",
    },
    {
      icon: <Share2 />,
      label: "Viewers pass it on",
      detail: "The host’s browser sends the encrypted video to a few viewers, whose browsers pass it on to others.",
    },
    {
      icon: <ServerOff />,
      label: "Our server never sees it",
      detail: "Our server only introduces browsers to each other. It never receives the video or the sound.",
    },
  ];
  // Strict networks: with TURN on this deployment ([D80]) they connect through a relay and only
  // watch; without it, or until the server has said, they can't connect.
  const turn = useLiveTurn();
  const strict = turn
    ? { icon: <Waypoints />, label: "Strict networks: watch only", detail: "On strict networks (some offices, schools and mobile carriers), viewers connect through a relay and only watch. They never pass the video on." }
    : { icon: <WifiOff />, label: "Some networks block it", detail: "Some strict networks (some offices, schools and mobile carriers) can’t connect yet." };
  const limits = [
    { icon: <Users />, label: `Up to ${LIVE_VIEWER_CAP} viewers, 1 camera`, detail: `Up to ${LIVE_VIEWER_CAP} viewers, with one person on camera.` },
    strict,
    { icon: <Globe />, label: "Peers see your IP address", detail: "Browsers connected to each other can see each other’s IP address." },
  ];
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2.5" aria-label="How it works" data-testid="e2ee-note">
        {works.map((fact) => (
          <Fact key={fact.label} {...fact} />
        ))}
      </ul>
      <div className="flex flex-col gap-2.5">
        <p className="eyebrow">Beta limits</p>
        <ul className="flex flex-col gap-2.5 text-muted" aria-label="Beta limits">
          {limits.map((fact) => (
            <Fact key={fact.label} {...fact} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** "12:03", then "1:02:03": how long the webinar has been live, counted in this browser. */
export function Elapsed({ from }: { from: number }) {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(from, Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setSeconds(elapsedSeconds(from, Date.now())), 1000);
    return () => clearInterval(timer);
  }, [from]);
  return <span className="tabular-nums">{formatElapsed(seconds)}</span>;
}

/**
 * A card's heading that takes the focus when it appears, for a state that replaces what the
 * person was looking at (ended, can't connect): a screen reader reads it, and the keyboard
 * continues from there.
 */
export function FocusedHeading({ children, ...rest }: React.ComponentProps<"h2">) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h2 ref={ref} tabIndex={-1} className="font-display text-xl font-semibold tracking-tight outline-none" {...rest}>
      {children}
    </h2>
  );
}

/** The status chip over the picture: "● Live · 12:03 · 7 watching" (the time only where it is known). */
export function LiveChip({ since, watching, testId }: { since?: number | null; watching: number; testId?: string }) {
  return (
    <span className="chip absolute top-3 left-3" data-testid={testId}>
      <span className="size-2 rounded-full bg-danger" aria-hidden="true" />
      <span className="font-semibold">Live</span>
      {since != null && (
        <>
          <span className="text-muted" aria-hidden="true">
            ·
          </span>
          <Elapsed from={since} />
        </>
      )}
      <span className="text-muted" aria-hidden="true">
        ·
      </span>
      <span>
        <span className="tabular-nums">{watching}</span> watching
      </span>
    </span>
  );
}

/** The coordinator's WebSocket, through the app's own Worker (custom-worker.ts). */
export const coordinatorUrl = (id: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live/${encodeURIComponent(id)}`;

export class LiveRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new LiveRequestError(data.error ?? `Request failed (${response.status}).`, response.status);
  return data;
}

export async function fetchTree(id: string): Promise<LiveTree> {
  const response = await fetch(`/api/live/${encodeURIComponent(id)}/tree`, { cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as LiveTree & { error?: string };
  if (!response.ok) throw new LiveRequestError(data.error ?? `Request failed (${response.status}).`, response.status);
  return data;
}

/** How often "Who's connected" asks again. */
const TREE_EVERY_MS = 2000;

/** The stream's tree, asked for every two seconds while `id` is set and the page is visible. */
/** Whether this deployment offers TURN (GET /api/live), asked once per page load and shared. */
let turnAnswer: Promise<boolean> | null = null;

/** True once the server says viewers on strict networks can watch through a relay ([D80]); null until it answers, false if not or on failure. */
export function useLiveTurn(): boolean | null {
  const [turn, setTurn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    turnAnswer ??= fetch("/api/live", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ turn?: unknown }>) : {}))
      .then((body) => (body as { turn?: unknown }).turn === true)
      .catch(() => false);
    void turnAnswer.then((value) => live && setTurn(value));
    return () => {
      live = false;
    };
  }, []);
  return turn;
}

export function useLiveTree(id: string | null): LiveTree | null {
  const [tree, setTree] = useState<LiveTree | null>(null);
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const next = await fetchTree(id);
          if (!stopped) setTree(next);
        } catch {
          // Kept as it was; the next poll tries again.
        }
      }
      if (!stopped) timer = setTimeout(poll, TREE_EVERY_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);
  // Once asking stops (the webinar ended, or this page left it), the last answer is out of date.
  return id ? tree : null;
}

/** This browser's own node in the tree: its PeerId, hashed as the server hashes it. */
export function useOwnKey(peer: string | null): string | null {
  const [key, setKey] = useState<{ peer: string; key: string } | null>(null);
  useEffect(() => {
    if (!peer) return;
    let stale = false;
    void import("@/lib/live/tree").then(({ viewKey }) =>
      viewKey(peer).then((k) => {
        if (!stale) setKey({ peer, key: k });
      }),
    );
    return () => {
      stale = true;
    };
  }, [peer]);
  return peer && key?.peer === peer ? key.key : null;
}

/** A card in the Live pages' language: the app's surface, a hairline border, generous corners. */
export function Card({ children, className = "", ...rest }: React.ComponentProps<"section">) {
  return (
    <section className={`rounded-3xl bg-surface p-5 ring-1 ring-border sm:p-6 ${className}`} {...rest}>
      {children}
    </section>
  );
}
