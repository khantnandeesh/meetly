"use client";

import {
  CircleAlert,
  EyeOff,
  Hand,
  MicOff,
  LoaderCircle,
  UserMinus,
  UserPlus,
  Users,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText, useCopied, useIsPhone, usePresence } from "@/lib/hooks";
import { DUR, EASE, prefersReducedMotion } from "@/lib/motion";
import { useAudioBlocked, useCall, useConnectionStatus, useParticipants, useTiles } from "@/lib/rtc/react";
import { displayName, type JoinGrant, type RtcParticipant, type RtcTile } from "@/lib/rtc/types";
import { useCallSettings } from "@/lib/useCallSettings";
import { noteOwnMicToggle, notePresence, useCallSounds } from "@/lib/useSounds";
import { useSpeakers, type VisibleRange } from "@/lib/useSpeakers";
import { ChatPanel } from "./ChatPanel";
import { ChatStore, ChatToasts } from "./ChatStore";
import { HostProvider } from "./HostTools";
import { ControlBar, type Panel } from "./ControlBar";
import { PeoplePanel } from "./PeoplePanel";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Tile } from "./Tile";
import { CopyIcon } from "./ui/CopyIcon";
import { Tip } from "./ui/Tip";
import { Stage, refKey } from "./Stage";
import { LogoMark } from "./ui/Logo";
import { useToast } from "./ui/Toaster";

/** Auto switches from the grid to the speaker-led view above this many people. */
const AUTO_GRID_LIMIT = 12;
/** Above this many people, joins and leaves are not announced at all: the people count is enough. */
const ROSTER_TOAST_LIMIT = 24;
const PHONE_PAGE_SIZE = 6;
type OpenPanel = Exclude<Panel, null>;

export function Conference(props: { code: string; grant: JoinGrant }) {
  return (
    <ChatStore>
      <Call {...props} />
    </ChatStore>
  );
}

function Call({ code, grant }: { code: string; grant: JoinGrant }) {
  const call = useCall();
  const toast = useToast();
  const phone = useIsPhone();
  const connection = useConnectionStatus();
  const [settings, updateSettings] = useCallSettings();
  useCallSounds(call, {
    onHostMuted: () => toast.push({ icon: <MicOff className="size-5" />, title: "The host muted your microphone" }),
  });

  // Opt-in handle for load tests and debugging: set localStorage["meetly:debug"] = "1".
  // `room` is the provider's own object (a LiveKit Room, or a RealtimeKit meeting).
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

  /* ------------------------------------------------------------------ panels */
  const [panel, setPanel] = useState<Panel>(null);
  // `shown` lags behind `panel` on close so the exit animation can play.
  const [shown, setShown] = useState<Panel>(null);
  if (panel && shown !== panel) setShown(panel);
  const panelRef = useRef<HTMLElement>(null);

  const togglePanel = useCallback((next: OpenPanel) => {
    setPanel((current) => (current === next ? null : next));
  }, []);

  function closePanel(restoreFocus: boolean) {
    if (restoreFocus && panel) document.getElementById(`toggle-${panel}`)?.focus();
    setPanel(null);
  }

  const sheetDrag = useMemo(() => createSheetDrag(() => setPanel(null)), []);

  useEffect(() => {
    if (!panel) return;
    // A sheet that was dragged away and reopened before it finished leaving starts from rest.
    panelRef.current?.style.removeProperty("transform");
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [panel]);

  /* ------------------------------------------------------------ participants */
  // Speaking and mute changes are handled by the tiles and rows themselves, so the whole call
  // does not re-render every time somebody talks.
  const participants = useParticipants();
  const localParticipant = call.local;
  // A hand going up or down is a roster change, so this is current on every render.
  const handRaised = localParticipant.handRaised;
  const raisedHands = participants.filter((p) => p.handRaised);

  /* ------------------------------------------------------------------ layout */
  const tracks = useTiles();
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const togglePin = useCallback((ref: RtcTile) => {
    const key = refKey(ref);
    setPinnedKey((current) => (current === key ? null : key));
  }, []);

  const pageSize = phone ? PHONE_PAGE_SIZE : settings.maxTiles;
  const screenShares = tracks.filter((t) => t.source === "screen_share");
  const pinned = pinnedKey ? tracks.find((t) => refKey(t) === pinnedKey) : undefined;
  // A pin wins; otherwise a screen share takes the main view (unless the user insists on tiles).
  const focus = pinned ?? (settings.layout !== "tiled" ? screenShares[0] : undefined);
  const small = participants.length <= Math.min(pageSize, AUTO_GRID_LIMIT);
  const view: "tiled" | "sidebar" | "spotlight" = focus
    ? settings.layout === "spotlight"
      ? "spotlight"
      : "sidebar"
    : settings.layout === "auto"
      ? small
        ? "tiled"
        : "sidebar"
      : settings.layout;

  const visibleRange = useMemo<VisibleRange>(
    () =>
      view === "tiled"
        ? { start: page * pageSize, size: pageSize, pinned: pinned?.participant.identity }
        : { start: 0, size: 6, pinned: pinned?.participant.identity },
    [view, page, pageSize, pinned],
  );
  const { stageSpeaker, ordered } = useSpeakers(call, participants.length, visibleRange);

  const cameras = new Map<string, RtcTile>();
  for (const t of tracks) if (t.source === "camera") cameras.set(t.participant.identity, t);
  const selfTile = cameras.get(localParticipant.identity);
  const everyone = ordered.flatMap((id) => cameras.get(id) ?? []);
  // Speaker-led: a pin or share, else whoever is talking, else the last speaker, else anyone.
  const firstRemote = everyone.find((t) => !t.participant.isLocal);
  const main = focus ?? (stageSpeaker ? cameras.get(stageSpeaker) : undefined) ?? firstRemote ?? selfTile;
  // On a phone a screen share sits above a grid of people (see Stage). A floating self view would
  // have nowhere to go but on top of somebody, so there it takes a cell like everyone else.
  const stackedShare = phone && view === "sidebar" && main?.source === "screen_share";
  const selfInGrid =
    settings.selfView === "grid" || participants.length === 1 || (stackedShare && settings.selfView === "float");
  const people = selfInGrid ? everyone : everyone.filter((t) => !t.participant.isLocal);

  // Tiled: screen shares lead, then people, a page at a time.
  const gallery = view === "tiled" ? [...screenShares, ...people] : [];
  const pageCount = Math.max(1, Math.ceil(gallery.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const goToPage = useCallback((next: number) => setPage(Math.max(0, next)), []);

  const others = main ? [...screenShares, ...people].filter((t) => t !== main) : [];
  const floatSelf =
    !!selfTile &&
    participants.length > 1 &&
    main !== selfTile &&
    !stackedShare &&
    (settings.selfView === "float" || (view === "spotlight" && settings.selfView === "grid"));

  const toggleHand = useCallback(() => {
    call.setHandRaised(!call.local.handRaised).catch(() => {});
  }, [call]);

  const openChat = useCallback(() => setPanel("chat"), []);

  /* ------------------------------------------------------------ room events */
  useEffect(() => {
    // One signal per arrival or departure. If their tile is in front of you, the tile (and in a
    // small call its sound) is the signal. If it is not (another gallery page, the "+N more"
    // cell, Spotlight), a toast is, and bursts share one toast that updates in place. In a very
    // large call the people count is enough and nothing else is shown.
    const onStage = (p: RtcParticipant) =>
      document.querySelector(`[data-tile][data-key="${CSS.escape(`${p.identity}:camera`)}"]`) !== null;
    const roster = (verb: "joined" | "left", icon: React.ReactNode) => {
      let names: string[] = [];
      let lastAt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        const [first, second, ...rest] = names;
        const who = !second
          ? first
          : rest.length === 0
            ? `${first} and ${second}`
            : `${first}, ${second} and ${rest.length} ${rest.length === 1 ? "other" : "others"}`;
        toast.push({ tag: verb, icon, title: `${who} ${verb}` });
      };
      return {
        announce(p: RtcParticipant) {
          if (call.remoteIds().length + 1 > ROSTER_TOAST_LIMIT) return;
          // A lull starts a new list; until then the visible toast keeps counting.
          if (Date.now() - lastAt > 5000) names = [];
          lastAt = Date.now();
          names.push(displayName(p));
          timer ??= setTimeout(flush, 350);
        },
        cancel: () => clearTimeout(timer),
      };
    };
    const arrivals = roster("joined", <UserPlus className="size-5" />);
    const departures = roster("left", <UserMinus className="size-5 text-muted" />);
    const pendingArrivals = new Set<ReturnType<typeof setTimeout>>();
    const joined = (p: RtcParticipant) => {
      // Whether the newcomer got a tile is only known once the stage has drawn them.
      const timer = setTimeout(() => {
        pendingArrivals.delete(timer);
        if (onStage(p)) notePresence("joined");
        else arrivals.announce(p);
      }, 60);
      pendingArrivals.add(timer);
    };
    const left = (p: RtcParticipant) => {
      // Their tile, if they had one, is still on the stage at this moment.
      if (onStage(p)) notePresence("left");
      else departures.announce(p);
    };
    // A raised hand is signalled by the hands button beside People, the badge on the tile and
    // one sound. No toast: that would be a fourth signal for one event.
    const stopJoined = call.on("participantJoined", joined);
    const stopLeft = call.on("participantLeft", left);
    return () => {
      stopJoined();
      stopLeft();
      arrivals.cancel();
      departures.cancel();
      pendingArrivals.forEach(clearTimeout);
    };
  }, [call, toast]);

  const showPeople = useCallback(() => setPanel("people"), []);
  const hideSelf = useCallback(() => {
    updateSettings({ selfView: "hidden" });
    toast.push({
      icon: <EyeOff className="size-5" />,
      title: "Your video is hidden from you",
      body: "Others can still see you.",
      action: { label: "Undo", onClick: () => updateSettings({ selfView: "float" }) },
    });
  }, [toast, updateSettings]);

  // Copying confirms on the button that was pressed (see useCopied); only a failure needs a toast.
  const copyLink = useCallback(async () => {
    const ok = await copyText(`${window.location.origin}/${code}`);
    if (!ok) toast.push({ icon: <CircleAlert className="size-5" />, tone: "danger", title: "Couldn't copy the link" });
    return ok;
  }, [code, toast]);
  const headerCopy = useCopied(copyLink);

  /* ---------------------------------------------------------- notifications */
  // On large screens notifications rise from the stage's bottom-right corner (see globals.css).
  // They stay clear of an open side panel and of whatever already sits in that corner.
  // In the sidebar view that corner is the main tile's, left of the filmstrip.
  const beside = view === "sidebar" && others.length > 0;
  const cornerLift =
    participants.length === 1
      ? 9.25 // the invite card
      : view === "tiled" && pageCount > 1
        ? floatSelf
          ? 10
          : 3.25 // the page bar, and the self view above it
        : floatSelf
          ? 7.25
          : 0;
  const panelInset = (shown ? 23.25 : 0) + (beside ? 14.75 : 0);
  useEffect(() => {
    // Set on the notification region itself, not on the page root: a custom property changed on
    // the root makes the browser re-resolve the style of every element in the document, and
    // this one changes on every panel toggle and layout switch.
    const region = document.querySelector<HTMLElement>(".toast-region");
    if (!region) return;
    region.style.setProperty("--toast-inset", `${panelInset}rem`);
    region.style.setProperty("--toast-lift", `${cornerLift}rem`);
    return () => {
      region.style.removeProperty("--toast-inset");
      region.style.removeProperty("--toast-lift");
    };
  }, [panelInset, cornerLift]);

  /* -------------------------------------------------------------- shortcuts */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsOn = settings.shortcuts;
  const paged = view === "tiled" && pageCount > 1;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      const typing = target.closest("input, textarea, select, [contenteditable='true']");
      const inOverlay = target.closest("[role='menu'], [role='dialog']");
      if (event.key === "Escape") {
        if (inOverlay) return;
        // Escape from the composer closes chat too; nothing is lost, the draft stays in state.
        setPanel((current) => {
          if (current) document.getElementById(`toggle-${current}`)?.focus();
          return null;
        });
        return;
      }
      if (typing || inOverlay) return;
      if (paged && (event.key === "ArrowRight" || event.key === "PageDown")) {
        setPage(Math.min(currentPage + 1, pageCount - 1));
        event.preventDefault();
        return;
      }
      if (paged && (event.key === "ArrowLeft" || event.key === "PageUp")) {
        setPage(Math.max(currentPage - 1, 0));
        event.preventDefault();
        return;
      }
      if (event.repeat) return;
      if (event.key === "?") {
        setShortcutsOpen(true);
        return;
      }
      if (!shortcutsOn) return;
      const media = call.localMedia();
      switch (event.key.toLowerCase()) {
        case "m":
          noteOwnMicToggle();
          call.setEnabled("microphone", !media.microphone).catch(() => {});
          break;
        case "v":
          call.setEnabled("camera", !media.camera).catch(() => {});
          break;
        case "h":
          toggleHand();
          break;
        case "c":
          togglePanel("chat");
          break;
        case "p":
          togglePanel("people");
          break;
        default:
          return;
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [call, shortcutsOn, toggleHand, togglePanel, paged, currentPage, pageCount]);

  /* ------------------------------------------------------------------ render */
  const connecting = connection === "connecting";
  const reconnecting = connection === "reconnecting";
  const alone = participants.length === 1 && !connecting;
  const leaving = panel === null && shown !== null;
  const panelTitle = shown === "chat" ? "Chat" : "People";

  return (
    <HostProvider grant={grant} localIdentity={localParticipant.identity}>
      {phone && (
        <header className="flex items-center justify-between gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <button
            onClick={headerCopy.copy}
            aria-label={`Copy meeting link, code ${code}`}
            className="inline-flex h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 pl-1 font-mono text-[0.8125rem] text-muted active:bg-surface-2"
          >
            <LogoMark className="size-7 shrink-0" />
            <span className="truncate">{headerCopy.copied ? "Copied" : code}</span>
            <CopyIcon copied={headerCopy.copied} />
            <span className="sr-only" role="status">
              {headerCopy.copied ? "Meeting link copied" : ""}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-2">
            <RaisedHands hands={raisedHands} onShow={showPeople} compact />
            <button
              id="toggle-people"
              onClick={() => togglePanel("people")}
              aria-expanded={panel === "people"}
              aria-label="Show everyone"
              className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-xl bg-surface-2 px-3.5 text-sm font-semibold tabular-nums active:bg-surface-3"
            >
              <Users className="size-[1.125rem]" aria-hidden="true" />
              {participants.length}
            </button>
          </div>
        </header>
      )}

      <div className="relative flex min-h-0 flex-1 gap-3 p-3 max-md:py-2">
        <main className="relative min-w-0 flex-1" aria-label="Meeting stage">
          <Stage
            view={view}
            tiles={gallery.slice(currentPage * pageSize, (currentPage + 1) * pageSize)}
            total={gallery.length}
            rangeStart={currentPage * pageSize}
            page={currentPage}
            pageCount={pageCount}
            onPage={goToPage}
            main={main}
            others={others}
            phone={phone}
            pinned={!!pinned}
            onTogglePin={togglePin}
            onShowEveryone={showPeople}
          />

          <FloatingSelf
            tile={floatSelf ? selfTile : undefined}
            offset={
              view === "sidebar"
                ? phone
                  ? { x: 0, y: -6.5 }
                  : { x: -14.75, y: paged ? -2.75 : 0 }
                : { x: 0, y: paged ? -2.75 : 0 }
            }
            onHide={hideSelf}
          />

          <InviteCard show={alone} code={code} onCopy={copyLink} />

          <Connecting show={connecting} />

          <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex flex-col items-center gap-2">
            <Reconnecting show={reconnecting} />
            <AudioUnlock />
          </div>
        </main>

        {shown && (
          <>
            {phone && (
              <div
                className="panel-scrim fixed inset-0 z-40 bg-black/55"
                data-leaving={leaving}
                onClick={() => closePanel(false)}
                aria-hidden="true"
              />
            )}
            <aside
              ref={panelRef}
              aria-label={panelTitle}
              data-leaving={leaving}
              onAnimationEnd={(event) => {
                if (leaving && event.target === event.currentTarget) setShown(null);
              }}
              className={`panel flex w-[22.5rem] shrink-0 flex-col ${leaving ? "md:absolute md:inset-y-3 md:right-3" : ""} overflow-hidden rounded-[1.25rem] bg-surface shadow-[inset_0_0_0_1px_var(--border)] max-md:fixed max-md:inset-x-0 max-md:top-[max(3.5rem,env(safe-area-inset-top))] max-md:bottom-0 max-md:z-50 max-md:w-auto max-md:rounded-b-none`}
            >
              <div
                className="relative flex items-center justify-between py-2.5 pr-2.5 pl-5 max-md:touch-none max-md:pt-4"
                {...(phone ? sheetDrag : {})}
              >
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-surface-3 md:hidden"
                />
                <h2 className="flex items-baseline gap-2 font-display text-lg font-semibold">
                  {panelTitle}
                  {shown === "people" && (
                    <span className="font-sans text-sm font-medium text-muted tabular-nums">
                      {participants.length}
                      <span className="sr-only"> in the call</span>
                    </span>
                  )}
                </h2>
                <button className="icon-btn" onClick={() => closePanel(true)} aria-label={`Close ${panelTitle.toLowerCase()}`}>
                  <X className="size-5" aria-hidden="true" />
                </button>
              </div>
              {shown === "chat" ? (
                <ChatPanel autoFocus={!phone} />
              ) : (
                <PeoplePanel participants={participants} code={code} onCopyLink={copyLink} />
              )}
            </aside>
          </>
        )}
      </div>

      <ControlBar
        code={code}
        phone={phone}
        panel={panel}
        headcount={participants.length}
        handRaised={handRaised}
        hands={<RaisedHands hands={raisedHands} onShow={showPeople} />}
        onToggleHand={toggleHand}
        onTogglePanel={togglePanel}
        onCopyLink={copyLink}
        onShowShortcuts={() => setShortcutsOpen(true)}
        settings={settings}
        onSettings={updateSettings}
      />

      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        enabled={shortcutsOn}
        onEnabledChange={(shortcuts) => updateSettings({ shortcuts })}
      />
      <ChatToasts open={panel === "chat"} onReply={openChat} />
    </HostProvider>
  );
}

/* ------------------------------------------------------------- sheet drag */

/**
 * Lets the phone bottom sheet be pulled down by its header. The sheet follows the finger; let go
 * past a third of the way, or with a flick, and it carries on out, otherwise it springs back.
 */
function createSheetDrag(onDismiss: () => void) {
  let drag: { y: number; at: number; dy: number; speed: number } | null = null;
  const sheetOf = (event: React.PointerEvent) => (event.currentTarget as HTMLElement).closest<HTMLElement>("aside");
  const release = (el: HTMLElement | null) => {
    drag = null;
    if (!el) return;
    delete el.dataset.dragging;
    el.style.transform = "";
  };
  return {
    onPointerDown(event: React.PointerEvent) {
      if (event.pointerType === "mouse" || (event.target as HTMLElement).closest("button")) return;
      drag = { y: event.clientY, at: event.timeStamp, dy: 0, speed: 0 };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: React.PointerEvent) {
      const el = sheetOf(event);
      if (!drag || !el) return;
      const dy = Math.max(0, event.clientY - drag.y);
      drag.speed = (dy - drag.dy) / Math.max(1, event.timeStamp - drag.at);
      drag.dy = dy;
      drag.at = event.timeStamp;
      el.dataset.dragging = "true";
      el.style.transform = `translateY(${dy}px)`;
    },
    onPointerUp(event: React.PointerEvent) {
      const el = sheetOf(event);
      const state = drag;
      drag = null;
      if (!state || !el || el.dataset.dragging !== "true") return;
      delete el.dataset.dragging;
      if (state.dy > el.offsetHeight / 3 || state.speed > 0.5) {
        // The exit animation starts from wherever the finger left the sheet.
        onDismiss();
        return;
      }
      el.style.transform = "";
      if (!prefersReducedMotion()) {
        el.animate([{ transform: `translateY(${state.dy}px)` }, { transform: "translateY(0)" }], {
          duration: DUR.base,
          easing: EASE.move,
        });
      }
    },
    onPointerCancel: (event: React.PointerEvent) => release(sheetOf(event)),
  };
}

/* ------------------------------------------------------------ small overlays */

/** Your own camera as a small picture over the stage. It slides, rather than jumps, out of the way of the page bar and filmstrip. */
function FloatingSelf({
  tile,
  offset,
  onHide,
}: {
  tile?: RtcTile;
  /** Shift from the bottom-right corner, in rem. */
  offset: { x: number; y: number };
  onHide: () => void;
}) {
  const presence = usePresence(!!tile);
  // The tile to show while leaving is the last one we had.
  const [kept, setKept] = useState(tile);
  if (tile && tile !== kept) setKept(tile);
  const shown = tile ?? kept;
  if (!presence.mounted || !shown) return null;
  return (
    <div
      className="self-float absolute right-3 bottom-3 z-30 w-44 transition-[translate] duration-(--dur-move) ease-(--ease-move) max-md:w-24"
      style={{ translate: `${offset.x}rem ${offset.y}rem` }}
    >
      <div
        data-leaving={presence.leaving}
        onAnimationEnd={presence.onAnimationEnd}
        className="anim-pop overflow-hidden rounded-[1.25rem] shadow-[0_16px_40px_-10px_rgb(0_0_0/0.8)]"
      >
        <Tile trackRef={shown} className="aspect-video w-full max-md:aspect-[3/4]">
          <div className="tile-actions absolute top-1.5 right-1.5 z-30">
            <Tip label="Hide your video from yourself" side="left">
              <button
                aria-label="Hide self view"
                onClick={onHide}
                className="grid size-9 cursor-pointer place-items-center rounded-lg bg-[rgb(11_11_15/0.72)] text-text backdrop-blur-md hover:bg-[rgb(40_40_52/0.9)] pointer-coarse:size-11"
              >
                <EyeOff className="size-4" />
              </button>
            </Tip>
          </div>
        </Tile>
      </div>
    </div>
  );
}

/**
 * Who has a hand up, as a button that opens the people list (where the queue is). It lives with
 * the people control, in the bar on large screens and the top bar on phones, never over video.
 */
function RaisedHands({ hands, onShow, compact = false }: { hands: RtcParticipant[]; onShow: () => void; compact?: boolean }) {
  const presence = usePresence(hands.length > 0);
  const [kept, setKept] = useState(hands);
  if (hands.length > 0 && hands !== kept) setKept(hands);
  const list = hands.length > 0 ? hands : kept;
  // The button pops in for the first hand; each later hand gives the count one short pulse.
  const [pulse, setPulse] = useState(0);
  const [seen, setSeen] = useState(hands.length);
  if (hands.length !== seen) {
    setSeen(hands.length);
    if (hands.length > seen && seen > 0) setPulse((n) => n + 1);
  }
  if (!presence.mounted) return null;
  // Room for one name beside the controls; the rest are a count, and the list has them all.
  const namesClass = compact ? "sr-only" : "flex min-w-0 gap-1 max-lg:sr-only";
  const button = (
    <button
      onClick={onShow}
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      className={`anim-pop inline-flex min-w-0 shrink cursor-pointer items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface-2))] pr-3 pl-1.5 text-sm font-medium text-text transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_26%,var(--surface-2))] ${compact ? "h-11" : "h-12 rounded-2xl pl-2"}`}
    >
      <span
        key={pulse}
        className={`grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-ink ${pulse > 0 ? "anim-nudge" : ""}`}
      >
        <Hand className="size-[1.125rem]" aria-hidden="true" />
      </span>
      <ul className={namesClass} aria-label="Raised hands">
        {list.slice(0, 1).map((p) => (
          <li key={p.identity} className="max-w-28 truncate">
            {p.isLocal ? "You" : displayName(p)}
          </li>
        ))}
        {list.slice(1).map((p) => (
          <li key={p.identity} className="sr-only">
            {p.isLocal ? "You" : displayName(p)}
          </li>
        ))}
      </ul>
      <span className={`shrink-0 font-semibold tabular-nums ${compact ? "" : list.length > 1 ? "lg:text-muted" : "lg:hidden"}`} aria-hidden="true">
        <span className={compact ? "hidden" : "max-lg:hidden"}>+{list.length - 1}</span>
        <span className={compact ? "" : "lg:hidden"}>{list.length}</span>
      </span>
      <span className="sr-only">{list.length === 1 ? "has a hand raised" : "have hands raised"}. Show people</span>
    </button>
  );
  if (compact) return button;
  return (
    <Tip label={list.length === 1 ? "1 raised hand" : `${list.length} raised hands`}>{button}</Tip>
  );
}

/** Covers the stage until the room is connected, then fades away to reveal it. */
function Connecting({ show }: { show: boolean }) {
  const presence = usePresence(show);
  if (!presence.mounted) return null;
  return (
    <div
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      className="anim-fade absolute inset-0 z-40 grid place-items-center rounded-[1.25rem] bg-bg"
      role={show ? "status" : undefined}
    >
      <div className="flex flex-col items-center gap-3 text-muted">
        <LoaderCircle className="anim-spin size-8" aria-hidden="true" />
        <p>Joining the meeting…</p>
      </div>
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

function InviteCard({ show, code, onCopy }: { show: boolean; code: string; onCopy: () => Promise<boolean> }) {
  const [dismissed, setDismissed] = useState(false);
  // It leaves, quickly, the moment somebody else arrives: it goes first, then the tiles move.
  const presence = usePresence(show && !dismissed);
  const { copied, copy } = useCopied(onCopy);
  if (!presence.mounted) return null;
  return (
    <div
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      className={`anim-rise absolute z-30 w-80 max-w-[calc(100%-1.5rem)] rounded-2xl bg-[rgb(20_20_26/0.92)] p-4 shadow-[inset_0_0_0_1px_var(--border-strong),0_20px_50px_-15px_rgb(0_0_0/0.8)] backdrop-blur-md max-md:top-3 max-md:left-1/2 max-md:-translate-x-1/2 md:right-4 md:bottom-4 ${presence.leaving ? "" : "[animation-delay:400ms]"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">You&apos;re the only one here</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">Share the link so others can join.</p>
        </div>
        <button className="icon-btn -mt-1.5 -mr-1.5 size-9" onClick={() => setDismissed(true)} aria-label="Dismiss invite reminder">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <button className="btn btn-secondary mt-3 h-11 w-full justify-between rounded-xl bg-surface-3 px-3.5 text-sm" onClick={copy}>
        <span className="truncate font-mono font-medium">{code}</span>
        <span className="inline-flex items-center gap-1.5 text-accent" role="status">
          <CopyIcon copied={copied} />
          {copied ? "Copied" : "Copy link"}
        </span>
      </button>
    </div>
  );
}

/** Browsers may block audio until the page is interacted with; offer a one-tap fix. */
function AudioUnlock() {
  const call = useCall();
  const blocked = useAudioBlocked();
  if (!blocked) return null;
  return (
    <button onClick={() => call.startAudio().catch(() => {})} className="btn btn-primary anim-pop pointer-events-auto h-11 rounded-xl shadow-lg">
      <Volume2 className="size-[1.125rem]" aria-hidden="true" />
      Tap to hear others
    </button>
  );
}
