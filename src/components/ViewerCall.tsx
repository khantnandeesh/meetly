"use client";

import { LoaderCircle, Mic, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { copyText, useCopied, useIsPhone } from "@/lib/hooks";
import { useCall, useConnectionStatus, useParticipants, useTiles } from "@/lib/rtc/react";
import type { RtcTile } from "@/lib/rtc/types";
import { useStageParticipants, useWatchingCount } from "@/lib/useWebinar";
import { ChatPanel, SaveChatButton } from "./ChatPanel";
import { HostProvider, useHost } from "./HostTools";
import { ModerationNotices } from "./ModerationNotices";
import { PeoplePanel } from "./PeoplePanel";
import { PollToasts } from "./Polls";
import { ReactionFeed, ReactionLane } from "./Reactions";
import { Stage, refKey } from "./Stage";
import { StageInvite, Switching } from "./StageInvite";
import { StatusLane } from "./StatusLane";
import { LiveCount, PeopleToggle, ViewerControlBar, type ViewerPanel } from "./ViewerControlBar";
import { CopyIcon } from "./ui/CopyIcon";
import { LogoMark } from "./ui/Logo";

const PAGE_SIZE = 9;
const PHONE_PAGE_SIZE = 6;

/**
 * A webinar, as its audience sees it: the people on stage and what they share, never a tile of
 * your own, with Raise hand, React and Leave below and "● Live · N watching" beside them (on a
 * phone, in the top bar). The chat is there to read and polls to vote in. Nothing here names
 * anyone else who is watching, and nothing announces them coming or going.
 *
 * A co-host moderates from here, off stage: People (with the Audience, the waiting list and the
 * host's controls) is theirs, and so is the chat's composer.
 *
 * When the host invites you to speak and you say yes, you are on stage, and the meeting's own
 * screen takes over (see the branch at the end of Conference.tsx).
 */
export function ViewerCall({ code }: { code: string }) {
  const call = useCall();
  return (
    <HostProvider localIdentity={call.local.identity}>
      <Audience code={code} />
    </HostProvider>
  );
}

function Audience({ code }: { code: string }) {
  const call = useCall();
  const phone = useIsPhone();
  const connection = useConnectionStatus();
  const { canModerate } = useHost();
  // A hand going up or down is a roster change, so this is current on every render.
  useParticipants();
  const onStage = useStageParticipants();
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
  const [panel, setPanel] = useState<ViewerPanel>(null);
  // People is a co-host's only; losing the role closes it.
  const shown: ViewerPanel = panel === "people" && !canModerate ? null : panel;
  const togglePanel = useCallback((next: Exclude<ViewerPanel, null>) => setPanel((current) => (current === next ? null : next)), []);
  const [reactOpen, setReactOpen] = useState(false);
  const toggleHand = useCallback(() => void call.setHandRaised(!call.local.handRaised).catch(() => {}), [call]);
  const openChat = useCallback(() => setPanel("chat"), []);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
      if (event.key === "Escape") {
        setPanel(null);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "h") toggleHand();
      else if (key === "r" && call.status === "connected") setReactOpen(true);
      else if (key === "c") togglePanel("chat");
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [call, toggleHand, togglePanel]);

  const copyLink = useCallback(() => copyText(`${window.location.origin}/${code}`), [code]);
  const copied = useCopied(copyLink);
  const sheetOpen = phone && shown !== null;
  const panelTitle = shown === "people" ? "People" : "Chat";
  const closePanel = () => {
    if (shown) document.getElementById(`toggle-${shown}`)?.focus();
    setPanel(null);
  };

  return (
    <>
      {canModerate && <ModerationNotices localIdentity={call.local.identity} peopleOpen={shown === "people"} onShowPeople={() => setPanel("people")} />}
      <ReactionFeed />
      {phone && (
        <header className="flex items-center justify-between gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <button
            onClick={copied.copy}
            aria-label={`Copy webinar link, code ${code}`}
            className="inline-flex h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 pl-1 font-mono text-[0.8125rem] text-muted active:bg-surface-2"
          >
            <LogoMark className="size-7 shrink-0" />
            <span className="truncate">{copied.copied ? "Copied" : code}</span>
            <CopyIcon copied={copied.copied} />
            <span className="sr-only" role="status">
              {copied.copied ? "Link copied" : ""}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-2">
            <LiveCount watching={watching} compact />
            {canModerate && <PeopleToggle open={shown === "people"} onToggle={() => togglePanel("people")} />}
          </div>
        </header>
      )}

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
          <StatusLane phone={phone} sheetOpen={sheetOpen} />
        </main>

        {shown && (
          <>
            {phone && <div className="panel-scrim fixed inset-0 z-40 bg-black/55" onClick={() => setPanel(null)} aria-hidden="true" />}
            <aside
              aria-label={panelTitle}
              className="panel flex w-[22.5rem] shrink-0 flex-col overflow-hidden rounded-[1.25rem] bg-surface shadow-[inset_0_0_0_1px_var(--border)] max-md:fixed max-md:inset-x-0 max-md:top-[max(3.5rem,env(safe-area-inset-top))] max-md:bottom-0 max-md:z-50 max-md:w-auto max-md:rounded-b-none"
            >
              <div className="flex items-center justify-between py-2.5 pr-2.5 pl-5 max-md:pt-4">
                <h2 className="font-display text-lg font-semibold">{panelTitle}</h2>
                <div className="flex items-center gap-0.5">
                  {shown === "chat" && canModerate && <SaveChatButton code={code} />}
                  <button className="icon-btn" onClick={closePanel} aria-label={`Close ${panelTitle.toLowerCase()}`}>
                    <X className="size-5" aria-hidden="true" />
                  </button>
                </div>
              </div>
              {shown === "chat" ? (
                // The audience reads; a co-host, who moderates from here, writes too.
                <ChatPanel autoFocus={false} readOnly={!canModerate} />
              ) : (
                <PeoplePanel participants={onStage} code={code} onCopyLink={copyLink} />
              )}
            </aside>
          </>
        )}
      </div>

      <ViewerControlBar
        phone={phone}
        code={code}
        watching={watching}
        handRaised={handRaised}
        onToggleHand={toggleHand}
        reactOpen={reactOpen}
        onReactOpenChange={setReactOpen}
        panel={shown}
        onTogglePanel={togglePanel}
        moderating={canModerate}
        onCopyLink={copyLink}
      />
      <PollToasts open={shown === "chat"} onShow={openChat} />
      <StageInvite />
      <Switching />
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
