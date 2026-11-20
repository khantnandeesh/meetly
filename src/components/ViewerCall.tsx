"use client";

import { LoaderCircle, Mic, Volume2, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { copyText, useCopied, useIsPhone, usePresence } from "@/lib/hooks";
import { useAudioBlocked, useCall, useConnectionStatus, useParticipants, useTiles } from "@/lib/rtc/react";
import type { RtcTile } from "@/lib/rtc/types";
import { useWatchingCount } from "@/lib/useWebinar";
import { ChatPanel } from "./ChatPanel";
import { PollToasts } from "./Polls";
import { ReactionFeed, ReactionLane } from "./Reactions";
import { Stage, refKey } from "./Stage";
import { StageInvite } from "./StageInvite";
import { ViewerControlBar } from "./ViewerControlBar";
import { CopyIcon } from "./ui/CopyIcon";
import { LogoMark } from "./ui/Logo";

const PAGE_SIZE = 9;
const PHONE_PAGE_SIZE = 6;

/**
 * A webinar, as its audience sees it: the people on stage and what they share, never a tile of
 * your own; "Live · N watching" at the top; Raise hand, React and Leave below. The chat is there
 * to read and polls to vote in. Nothing here names anyone else who is watching, and nothing
 * announces them coming or going.
 *
 * When the host invites you to speak and you say yes, you are on stage, and the meeting's own
 * screen takes over (see the branch at the end of Conference.tsx).
 */
export function ViewerCall({ code }: { code: string }) {
  const call = useCall();
  const phone = useIsPhone();
  const connection = useConnectionStatus();
  // A hand going up or down is a roster change, so this is current on every render.
  useParticipants();
  const handRaised = call.local.handRaised;
  const watching = useWatchingCount();

  // The same opt-in handle the meeting screen offers, for tests and debugging.
  useEffect(() => {
    try {
      if (localStorage.getItem("meetly:debug") !== "1") return;
    } catch {
      return;
    }
    const target = window as unknown as { __meetly?: { room: unknown; call: typeof call } };
    target.__meetly = {
      call,
      get room() {
        return call.native;
      },
    };
    return () => {
      delete target.__meetly;
    };
  }, [call]);

  /* ----------------------------------------------------------------- stage */
  const tiles = useTiles();
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [everyone, setEveryone] = useState(false);
  const [page, setPage] = useState(0);
  const screens = tiles.filter((tile) => tile.source === "screen_share");
  const cameras = tiles.filter((tile) => tile.source === "camera");
  const pinned = pinnedKey ? tiles.find((tile) => refKey(tile) === pinnedKey) : undefined;
  // What is shared leads, as in a meeting, unless you asked to see everyone or pinned someone.
  const main = pinned ?? (everyone ? undefined : screens[0]);
  const gallery = main ? [] : [...screens, ...cameras];
  const others = main ? [...screens, ...cameras].filter((tile) => tile !== main) : [];
  const pageSize = phone ? PHONE_PAGE_SIZE : PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(gallery.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const togglePin = useCallback((tile: RtcTile) => {
    const key = refKey(tile);
    setPinnedKey((current) => (current === key ? null : key));
  }, []);

  /* --------------------------------------------------------------- controls */
  const [chatOpen, setChatOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const toggleHand = useCallback(() => void call.setHandRaised(!call.local.handRaised).catch(() => {}), [call]);
  const openChat = useCallback(() => setChatOpen(true), []);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
      if (event.key === "Escape") {
        setChatOpen(false);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "h") toggleHand();
      else if (key === "r" && call.status === "connected") setReactOpen(true);
      else if (key === "c") setChatOpen((open) => !open);
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [call, toggleHand]);

  const copyLink = useCallback(() => copyText(`${window.location.origin}/${code}`), [code]);
  const copied = useCopied(copyLink);
  const live = connection === "connected" || connection === "reconnecting";

  return (
    <>
      <ReactionFeed />
      <header className="flex items-center justify-between gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] md:px-4 md:pt-3">
        <button
          onClick={copied.copy}
          aria-label={`Copy webinar link, code ${code}`}
          className="inline-flex h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 pl-1 font-mono text-[0.8125rem] text-muted transition-colors hover:bg-surface-2 active:bg-surface-2"
        >
          <LogoMark className="size-7 shrink-0" />
          <span className="truncate">{copied.copied ? "Copied" : code}</span>
          <CopyIcon copied={copied.copied} />
          <span className="sr-only" role="status">
            {copied.copied ? "Webinar link copied" : ""}
          </span>
        </button>
        {live && (
          <p data-live className="chip h-9 shrink-0 gap-2 px-3 text-sm font-medium">
            <span className="size-2 rounded-full bg-danger" aria-hidden="true" />
            <span className="font-semibold">Live</span>
            <span className="text-muted" aria-hidden="true">
              ·
            </span>
            <span className="tabular-nums" data-watching>
              {watching.toLocaleString("en-US")} watching
            </span>
          </p>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1 gap-3 p-3 max-md:py-2">
        <main className="relative min-w-0 flex-1" aria-label="Webinar stage">
          {tiles.length === 0 ? (
            <EmptyStage connecting={connection === "connecting"} />
          ) : (
            <Stage
              view={main ? "sidebar" : "tiled"}
              tiles={gallery.slice(currentPage * pageSize, (currentPage + 1) * pageSize)}
              total={gallery.length}
              rangeStart={currentPage * pageSize}
              page={currentPage}
              pageCount={pageCount}
              onPage={(next) => setPage(Math.max(0, next))}
              main={main}
              others={others}
              phone={phone}
              pinned={!!pinned}
              onTogglePin={togglePin}
              // The strip's "+N more": everyone on stage, in a grid.
              onShowEveryone={() => {
                setPinnedKey(null);
                setEveryone(true);
              }}
            />
          )}
          <ReactionLane />
          <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex flex-col items-center gap-2 px-3">
            <Reconnecting show={connection === "reconnecting"} />
            <AudioUnlock />
            <StageInvite />
          </div>
        </main>

        {chatOpen && (
          <>
            {phone && <div className="panel-scrim fixed inset-0 z-40 bg-black/55" onClick={() => setChatOpen(false)} aria-hidden="true" />}
            <aside
              aria-label="Chat"
              className="panel flex w-[22.5rem] shrink-0 flex-col overflow-hidden rounded-[1.25rem] bg-surface shadow-[inset_0_0_0_1px_var(--border)] max-md:fixed max-md:inset-x-0 max-md:top-[max(3.5rem,env(safe-area-inset-top))] max-md:bottom-0 max-md:z-50 max-md:w-auto max-md:rounded-b-none"
            >
              <div className="flex items-center justify-between py-2.5 pr-2.5 pl-5 max-md:pt-4">
                <h2 className="font-display text-lg font-semibold">Chat</h2>
                <button
                  className="icon-btn"
                  onClick={() => {
                    setChatOpen(false);
                    document.getElementById("toggle-chat")?.focus();
                  }}
                  aria-label="Close chat"
                >
                  <X className="size-5" aria-hidden="true" />
                </button>
              </div>
              <ChatPanel autoFocus={false} readOnly />
            </aside>
          </>
        )}
      </div>

      <ViewerControlBar
        phone={phone}
        handRaised={handRaised}
        onToggleHand={toggleHand}
        reactOpen={reactOpen}
        onReactOpenChange={setReactOpen}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((open) => !open)}
      />
      <PollToasts open={chatOpen} onShow={openChat} />
    </>
  );
}

/** Before anyone is on stage: said plainly, so an empty stage does not look broken. */
function EmptyStage({ connecting }: { connecting: boolean }) {
  return (
    <div className="grid size-full place-items-center rounded-[1.25rem] bg-surface/60 p-6 text-center shadow-[inset_0_0_0_1px_var(--border)]" role="status">
      {connecting ? (
        <div className="flex flex-col items-center gap-3 text-muted">
          <LoaderCircle className="anim-spin size-8" aria-hidden="true" />
          <p>Joining the webinar…</p>
        </div>
      ) : (
        <div className="flex max-w-xs flex-col items-center gap-3">
          <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted">
            <Mic className="size-6" aria-hidden="true" />
          </span>
          <p className="font-semibold">Nobody is on stage yet</p>
          <p className="text-sm leading-relaxed text-muted">You&apos;ll see and hear the speakers here as soon as they start.</p>
        </div>
      )}
    </div>
  );
}

function Reconnecting({ show }: { show: boolean }) {
  const presence = usePresence(show);
  if (!presence.mounted) return null;
  return (
    <p
      role={show ? "status" : undefined}
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      className="anim-pop chip h-9 gap-2 px-3.5 text-warn shadow-lg"
    >
      <WifiOff className="size-4" aria-hidden="true" />
      Connection lost. Reconnecting…
    </p>
  );
}

/** Browsers may block sound until the page is interacted with; for an audience that is the whole point. */
function AudioUnlock() {
  const call = useCall();
  const blocked = useAudioBlocked();
  if (!blocked) return null;
  return (
    <button onClick={() => call.startAudio().catch(() => {})} className="btn btn-primary anim-pop pointer-events-auto h-11 rounded-xl shadow-lg">
      <Volume2 className="size-[1.125rem]" aria-hidden="true" />
      Turn on sound
    </button>
  );
}
