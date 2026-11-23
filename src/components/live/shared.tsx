"use client";

import { ChevronDown, LockKeyhole, ServerOff } from "lucide-react";
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

/** `narrow`: as wide as the viewer's page (`max-w-5xl`), so the logo lines up with the video. */
export function LiveHeader({ narrow = false }: { narrow?: boolean }) {
  return (
    <header className={`mx-auto flex w-full items-center justify-between gap-3 px-4 py-5 sm:px-8 ${narrow ? "max-w-5xl" : "max-w-6xl"}`}>
      <Logo />
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
 * "How it works" opens the longer, honest account in place (a tap works on a phone, where a
 * tooltip would not).
 */
export function ServerlessNote({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className={`rounded-2xl bg-surface ring-1 ring-border ${className}`} data-testid="serverless-note">
      <div className="flex items-start gap-3 py-3 pr-2 pl-4">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent" aria-hidden="true">
          <ServerOff className="size-4" strokeWidth={2.25} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <p className="min-w-0 flex-1 text-sm leading-snug text-pretty">
            <span className="font-semibold">The video never touches our servers.</span>{" "}
            <span className="text-muted">It goes from the host’s browser to viewers’ browsers, which pass it on to each other.</span>
          </p>
          <button
            type="button"
            className="-ml-2 inline-flex h-9 shrink-0 cursor-pointer items-center gap-1 self-start rounded-lg px-2 text-sm font-medium text-accent hover:bg-surface-2 sm:ml-0 sm:self-center"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen((was) => !was)}
          >
            How it works
            <ChevronDown className={`size-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
        </div>
      </div>
      {open && (
        <div id={panel} className="anim-fade border-t border-border px-4 py-4">
          <HowItWorks />
        </div>
      )}
    </div>
  );
}

/** How a serverless webinar works, and what it cannot do yet, in plain words. */
export function HowItWorks() {
  const steps = [
    "The host’s browser encrypts the video and sends it to a few viewers’ browsers. The key is in the link the host shares, and never reaches our server.",
    "Those browsers pass the encrypted video on to others, so a viewer’s browser may relay the video it is already watching.",
    "Our server only introduces browsers to each other. It never receives the video or the sound.",
  ];
  const limits = [
    `Up to ${LIVE_VIEWER_CAP} viewers, with one person on camera.`,
    "Some strict networks (some offices, schools and mobile carriers) can’t connect yet.",
    "Browsers connected to each other can see each other’s IP address.",
  ];
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="flex items-start gap-2.5 text-pretty" data-testid="e2ee-note">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <span>
          <span className="font-semibold">End-to-end encrypted:</span> only people with the full link can see the video — not us, not anyone in between.
        </span>
      </p>
      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold tabular-nums" aria-hidden="true">
              {index + 1}
            </span>
            <span className="pt-0.5 text-pretty">{step}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-2">
        <p className="eyebrow">Beta limits</p>
        <ul className="flex flex-col gap-1.5 text-muted">
          {limits.map((limit) => (
            <li key={limit} className="flex gap-2.5 text-pretty">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" aria-hidden="true" />
              {limit}
            </li>
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
