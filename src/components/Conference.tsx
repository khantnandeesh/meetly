"use client";

import {
  RoomAudioRenderer,
  isTrackReference,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useStartAudio,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { ConnectionState, RoomEvent, Track, type Participant } from "livekit-client";
import {
  Check,
  CircleAlert,
  EyeOff,
  Hand,
  Link2,
  LoaderCircle,
  UserMinus,
  UserPlus,
  Users,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText, useIsPhone, usePresence } from "@/lib/hooks";
import { DUR, EASE, prefersReducedMotion } from "@/lib/motion";
import { HAND, displayName } from "@/lib/participant";
import { useCallSettings } from "@/lib/useCallSettings";
import { useOffscreenVideoPause } from "@/lib/videoDemand";
import { useSpeakers, type VisibleRange } from "@/lib/useSpeakers";
import { ChatPanel } from "./ChatPanel";
import { ChatStore, ChatToasts } from "./ChatStore";
import { HostProvider } from "./HostTools";
import { ControlBar, type Panel } from "./ControlBar";
import { PeoplePanel } from "./PeoplePanel";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Tile } from "./Tile";
import { Tip } from "./ui/Tip";
import { Stage, refKey } from "./Stage";
import { LogoMark } from "./ui/Logo";
import { useToast } from "./ui/Toaster";

/** Auto switches from the grid to the speaker-led view above this many people. */
const AUTO_GRID_LIMIT = 12;
const PHONE_PAGE_SIZE = 6;
// Speaking and mute changes are handled by the tiles and rows themselves, so the whole call
// does not re-render every time somebody talks.
const ROSTER_EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ParticipantAttributesChanged,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.ConnectionStateChanged,
];
type OpenPanel = Exclude<Panel, null>;

export function Conference(props: { code: string; token: string }) {
  return (
    <ChatStore>
      <Call {...props} />
    </ChatStore>
  );
}

function Call({ code, token }: { code: string; token: string }) {
  const room = useRoomContext();
  const toast = useToast();
  const phone = useIsPhone();
  const connection = useConnectionState();
  const [settings, updateSettings] = useCallSettings();
  useOffscreenVideoPause(room);

  // Opt-in handle for load tests and debugging: set localStorage["meetly:debug"] = "1".
  useEffect(() => {
    try {
      if (localStorage.getItem("meetly:debug") !== "1") return;
    } catch {
      return;
    }
    const target = window as unknown as { __meetly?: { room: typeof room } };
    target.__meetly = { room };
    return () => {
      delete target.__meetly;
    };
  }, [room]);

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
  const participants = useParticipants({ updateOnlyOn: ROSTER_EVENTS });
  const { localParticipant } = useLocalParticipant();
  const handRaised = localParticipant.attributes[HAND] === "1";
  const raisedHands = participants.filter((p) => p.attributes[HAND] === "1");

  /* ------------------------------------------------------------------ layout */
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const togglePin = useCallback((ref: TrackReferenceOrPlaceholder) => {
    const key = refKey(ref);
    setPinnedKey((current) => (current === key ? null : key));
  }, []);

  const pageSize = phone ? PHONE_PAGE_SIZE : settings.maxTiles;
  const screenShares = tracks.filter((t) => isTrackReference(t) && t.source === Track.Source.ScreenShare);
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
  const { stageSpeaker, ordered } = useSpeakers(room, participants.length, visibleRange);

  const cameras = new Map<string, TrackReferenceOrPlaceholder>();
  for (const t of tracks) if (t.source === Track.Source.Camera) cameras.set(t.participant.identity, t);
  const selfTile = cameras.get(localParticipant.identity);
  const everyone = ordered.flatMap((id) => cameras.get(id) ?? []);
  const selfInGrid = settings.selfView === "grid" || participants.length === 1;
  const people = selfInGrid ? everyone : everyone.filter((t) => !t.participant.isLocal);

  // Tiled: screen shares lead, then people, a page at a time.
  const gallery = view === "tiled" ? [...screenShares, ...people] : [];
  const pageCount = Math.max(1, Math.ceil(gallery.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const goToPage = useCallback((next: number) => setPage(Math.max(0, next)), []);

  // Speaker-led: a pin or share, else whoever is talking, else the last speaker, else anyone.
  const firstRemote = everyone.find((t) => !t.participant.isLocal);
  const main = focus ?? (stageSpeaker ? cameras.get(stageSpeaker) : undefined) ?? firstRemote ?? selfTile;
  const others = main ? [...screenShares, ...people].filter((t) => t !== main) : [];
  const floatSelf =
    !!selfTile &&
    participants.length > 1 &&
    main !== selfTile &&
    (settings.selfView === "float" || (view === "spotlight" && settings.selfView === "grid"));

  const toggleHand = useCallback(() => {
    const raised = localParticipant.attributes[HAND] === "1";
    localParticipant.setAttributes({ [HAND]: raised ? "" : "1" }).catch(() => {});
  }, [localParticipant]);

  const openChat = useCallback(() => setPanel("chat"), []);

  /* ------------------------------------------------------------ room events */
  useEffect(() => {
    // People often arrive (and leave) in bursts. Names collected within a short window share one
    // toast, and a later burst updates that toast in place instead of stacking another.
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
        add(p: Participant) {
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
    const joined = arrivals.add;
    const left = departures.add;
    const attributes = (changed: Record<string, string>, p: Participant) => {
      if (changed[HAND] === "1" && !p.isLocal) {
        toast.push({ icon: <Hand className="size-5" />, title: `${displayName(p)} raised a hand` });
      }
    };
    room.on(RoomEvent.ParticipantConnected, joined);
    room.on(RoomEvent.ParticipantDisconnected, left);
    room.on(RoomEvent.ParticipantAttributesChanged, attributes);
    return () => {
      room.off(RoomEvent.ParticipantConnected, joined);
      room.off(RoomEvent.ParticipantDisconnected, left);
      room.off(RoomEvent.ParticipantAttributesChanged, attributes);
      arrivals.cancel();
      departures.cancel();
    };
  }, [room, toast]);

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

  const copyLink = useCallback(async () => {
    const ok = await copyText(`${window.location.origin}/${code}`);
    toast.push(
      ok
        ? { icon: <Check className="size-5" />, title: "Meeting link copied", duration: 2500 }
        : { icon: <CircleAlert className="size-5" />, tone: "danger", title: "Couldn't copy the link" },
    );
  }, [code, toast]);

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
      const local = room.localParticipant;
      switch (event.key.toLowerCase()) {
        case "m":
          local.setMicrophoneEnabled(!local.isMicrophoneEnabled).catch(() => {});
          break;
        case "v":
          local.setCameraEnabled(!local.isCameraEnabled).catch(() => {});
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
  }, [room, shortcutsOn, toggleHand, togglePanel, paged, currentPage, pageCount]);

  /* ------------------------------------------------------------------ render */
  const connecting = connection === ConnectionState.Connecting;
  const reconnecting = connection === ConnectionState.Reconnecting || connection === ConnectionState.SignalReconnecting;
  const alone = participants.length === 1 && !connecting;
  const leaving = panel === null && shown !== null;
  const panelTitle = shown === "chat" ? "Chat" : "People";

  return (
    <HostProvider token={token} localIdentity={localParticipant.identity}>
      {phone && (
        <header className="flex items-center justify-between gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <button
            onClick={copyLink}
            aria-label={`Copy meeting link, code ${code}`}
            className="inline-flex h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 pl-1 font-mono text-[0.8125rem] text-muted active:bg-surface-2"
          >
            <LogoMark className="size-7 shrink-0" />
            <span className="truncate">{code}</span>
            <Link2 className="size-4 shrink-0" aria-hidden="true" />
          </button>
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

          <RaisedHands hands={raisedHands} />

          {alone && <InviteCard code={code} onCopy={copyLink} />}

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
      <RoomAudioRenderer />
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
  tile?: TrackReferenceOrPlaceholder;
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
      className="absolute right-3 bottom-3 z-30 w-44 transition-[translate] duration-(--dur-move) ease-(--ease-move) max-md:w-24"
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

function RaisedHands({ hands }: { hands: Participant[] }) {
  const presence = usePresence(hands.length > 0);
  const [kept, setKept] = useState(hands);
  if (hands.length > 0 && hands !== kept) setKept(hands);
  const list = hands.length > 0 ? hands : kept;
  if (!presence.mounted) return null;
  return (
    <div
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      className="anim-pop chip pointer-events-none absolute top-3 left-3 z-30 h-8 max-w-[min(22rem,calc(100%-1.5rem))] gap-2 pr-3 pl-1 shadow-lg"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-accent-ink">
        <Hand className="size-3.5" aria-hidden="true" />
      </span>
      <ul className="flex min-w-0 gap-1" aria-label="Raised hands">
        {list.slice(0, 2).map((p, index, shown) => (
          <li key={p.identity} className="truncate">
            {p.isLocal ? "You" : displayName(p)}
            {index < shown.length - 1 && ","}
          </li>
        ))}
        {list.length > 2 && <li className="shrink-0 text-muted">+{list.length - 2}</li>}
      </ul>
    </div>
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

function InviteCard({ code, onCopy }: { code: string; onCopy: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="anim-rise absolute z-30 w-80 max-w-[calc(100%-1.5rem)] rounded-2xl bg-[rgb(20_20_26/0.92)] p-4 shadow-[inset_0_0_0_1px_var(--border-strong),0_20px_50px_-15px_rgb(0_0_0/0.8)] backdrop-blur-md [animation-delay:400ms] max-md:top-3 max-md:left-1/2 max-md:-translate-x-1/2 md:right-4 md:bottom-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">You&apos;re the only one here</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">Share the link so others can join.</p>
        </div>
        <button className="icon-btn -mt-1.5 -mr-1.5 size-9" onClick={() => setDismissed(true)} aria-label="Dismiss invite reminder">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <button className="btn btn-secondary mt-3 h-11 w-full justify-between rounded-xl bg-surface-3 px-3.5 text-sm" onClick={onCopy}>
        <span className="truncate font-mono font-medium">{code}</span>
        <span className="inline-flex items-center gap-1.5 text-accent">
          <Link2 className="size-4" aria-hidden="true" />
          Copy link
        </span>
      </button>
    </div>
  );
}

/** Browsers may block audio until the page is interacted with; offer a one-tap fix. */
function AudioUnlock() {
  const room = useRoomContext();
  const { mergedProps, canPlayAudio } = useStartAudio({ room, props: {} });
  if (canPlayAudio) return null;
  return (
    <button onClick={mergedProps.onClick} className="btn btn-primary anim-pop pointer-events-auto h-11 rounded-xl shadow-lg">
      <Volume2 className="size-[1.125rem]" aria-hidden="true" />
      Tap to hear others
    </button>
  );
}
