"use client";

import {
  CircleAlert,
  CircleGauge,
  EyeOff,
  Hand,
  MicOff,
  LoaderCircle,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveEffectSettings } from "@/lib/effects/settings";
import { badgeCount, fullCount, shortCount } from "@/lib/counts";
import { copyText, useCopied, useIsPhone, usePresence } from "@/lib/hooks";
import { miniTile } from "@/lib/miniTile";
import { handQueue } from "@/lib/handQueue";
import { crowdSentence } from "@/lib/notices";
import { DUR, EASE, prefersReducedMotion } from "@/lib/motion";
import { useCall, useCallQuality, useConnectionStatus, useTiles, useWaiting } from "@/lib/rtc/react";
import { noteOwnCameraToggle } from "@/lib/ownToggles";
import { displayName, type RtcParticipant, type RtcTile } from "@/lib/rtc/types";
import { deviceClass, sendUsageEvent, sizeBucket } from "@/lib/usage";
import { useCallSettings } from "@/lib/useCallSettings";
import { useMiniWindow } from "@/lib/usePip";
import { noteOwnMicToggle, notePresence, useCallSounds } from "@/lib/useSounds";
import { useSpeakers, type VisibleRange } from "@/lib/useSpeakers";
import { useCallNoun, useHandsShown, useStageParticipants, useWatching } from "@/lib/useWebinar";
import { CallQualityDialog, DataSaverBadge } from "./CallQuality";
import { ChatPanel, SaveChatButton } from "./ChatPanel";
import { ChatStore, ChatToasts } from "./ChatStore";
import { HostProvider, useHost } from "./HostTools";
import { ControlBar, type Panel } from "./ControlBar";
import { LimitNotice } from "./LimitNotice";
import { MiniPlaceholder, MiniProvider, MiniWindow, type MiniControl } from "./MiniWindow";
import { ModerationNotices } from "./ModerationNotices";
import { PeoplePanel } from "./PeoplePanel";
import { PollToasts } from "./Polls";
import { ReactionFeed, ReactionLane } from "./Reactions";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { OnStageChip, Switching } from "./StageInvite";
import { ViewerCall } from "./ViewerCall";
import { StatusLane } from "./StatusLane";
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

export function Conference(props: { code: string }) {
  return (
    <ChatStore>
      <CallOrAudience {...props} />
    </ChatStore>
  );
}

function Call({ code }: { code: string }) {
  const call = useCall();
  const toast = useToast();
  const phone = useIsPhone();
  const connection = useConnectionStatus();
  const [settings, updateSettings] = useCallSettings();
  useCallSounds(call, {
    onHostMuted: () => toast.push({ tag: "muted-by-host", priority: "you", icon: <MicOff className="size-5" />, title: "The host muted your microphone" }),
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
  // Webinars: the stage, People and the layout are about who is on stage; the audience has its
  // own section in People (see AudienceSection.tsx). In a meeting this is everyone.
  const participants = useStageParticipants();
  const noun = useCallNoun();
  const localParticipant = call.local;
  // A hand going up or down is a roster change, so this is current on every render.
  const handRaised = localParticipant.handRaised;
  // In the order they went up (the audience's too, for the host): the hands button names whoever asked first.
  const raisedHands = handQueue(useHandsShown());

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
  const [reactOpen, setReactOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);

  /* ---------------------------------------------------------- using less data */
  // The sending half is the call's business (see `setDataSaver`). The receiving half is here:
  // only the main picture and shared screens are shown, everyone else is their avatar, and a
  // picture that is not shown is not asked for (see src/lib/videoDemand.ts).
  const { dataSaver } = useCallQuality();
  const lean = (list: RtcTile[]): RtcTile[] =>
    dataSaver
      ? list.map((tile) =>
          tile !== main && tile.source === "camera" && !tile.participant.isLocal
            ? { participant: tile.participant, source: tile.source, withheld: true }
            : tile,
        )
      : list;
  const showQuality = useCallback(() => {
    setQualityOpen(true);
    sendUsageEvent({ kind: "feature", feature: "call-quality-opened", size: sizeBucket(call.participants().length), device: deviceClass() });
  }, [call, setQualityOpen]);

  /* ------------------------------------------------------------- mini window */
  const miniWindow = useMiniWindow();
  const { supported: miniSupported, window: miniTarget, open: openMiniWindow, close: closeMini } = miniWindow;
  const miniOpen = miniTarget !== null;
  const openMini = useCallback(async () => {
    const opened = await openMiniWindow();
    if (opened) sendUsageEvent({ kind: "feature", feature: "mini-window", size: sizeBucket(call.participants().length), device: deviceClass() });
    return opened;
  }, [openMiniWindow, call]);
  const toggleMini = useCallback(() => {
    if (miniOpen) closeMini();
    else void openMini();
  }, [miniOpen, closeMini, openMini]);
  const backFromMini = useCallback(() => {
    closeMini();
    // Brings this tab forward where the browser allows it from a click in the mini window.
    window.focus();
  }, [closeMini]);
  const mini = useMemo<MiniControl>(() => ({ supported: miniSupported, open: miniOpen, toggle: toggleMini }), [miniSupported, miniOpen, toggleMini]);

  // Chromium asks the page for its picture-in-picture when you switch to another tab while in a
  // call, if the site is allowed to open one automatically. Where it does not ask, nothing happens.
  useEffect(() => {
    if (!miniSupported || !("mediaSession" in navigator)) return;
    const action = "enterpictureinpicture" as MediaSessionAction;
    try {
      navigator.mediaSession.setActionHandler(action, () => void openMini());
    } catch {
      return;
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {}
    };
  }, [miniSupported, openMini]);

  // Opted in (on the placeholder the stage shows while the mini window is open): presenting
  // opens it. A browser may refuse, since choosing what to share can use up the click that
  // would have allowed it; the window is then simply not opened, and More still offers it.
  const miniOnShare = settings.miniOnShare;
  useEffect(() => {
    if (!miniSupported || !miniOnShare) return;
    let sharing = call.localMedia().screenShare;
    return call.on("localMedia", () => {
      const now = call.localMedia().screenShare;
      if (now && !sharing) void openMini();
      sharing = now;
    });
  }, [call, miniSupported, miniOnShare, openMini]);

  /* ------------------------------------------------------------ room events */
  // Read inside event handlers, so a panel opening does not resubscribe to the call.
  const peopleOpen = useRef(false);
  useEffect(() => {
    peopleOpen.current = panel === "people";
    // The list in front of you is the news; a notification about it would only repeat it.
    if (panel === "people") {
      toast.dismissTag("joined");
      toast.dismissTag("left");
    }
  }, [panel, toast]);
  useEffect(() => {
    // One signal per arrival or departure. If their tile is in front of you, the tile (and in a
    // small call its sound) is the signal. If it is not (another gallery page, the "+N more"
    // cell, Spotlight), a notification is, and a burst is one notification that keeps count. In
    // a large call, or with the people list open, the people count is enough and nothing else
    // is shown. See src/lib/notices.ts for how these give way to anything that matters more.
    const onStage = (p: RtcParticipant) =>
      document.querySelector(`[data-tile][data-key="${CSS.escape(`${p.identity}:camera`)}"]`) !== null;
    const roster = (verb: "joined" | "left", icon: React.ReactNode) => {
      let names: string[] = [];
      let lastAt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        if (names.length === 0) return;
        toast.push({ tag: verb, priority: "presence", icon, title: crowdSentence(names, verb) });
      };
      return {
        announce(p: RtcParticipant) {
          if (call.remoteIds().length + 1 > ROSTER_TOAST_LIMIT || peopleOpen.current) return;
          // A webinar's audience comes and goes unannounced: the Audience count is enough.
          if (p.role === "viewer") return;
          // A lull starts a new count; until then the notification on screen keeps counting.
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
    // one sound. No notification: that would be a fourth signal for one event.
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

  // Blur that the device cannot keep up with is switched off by the call itself (see
  // src/lib/effects/blur.ts). Said once, with the way back.
  useEffect(
    () =>
      call.on("backgroundTooSlow", (mode) => {
        saveEffectSettings({ background: "none" });
        toast.push({
          tag: "blur-slow",
          priority: "you",
          icon: <CircleGauge className="size-5" />,
          title: "Background blur was turned off",
          body: "It was slowing down your camera.",
          duration: 10_000,
          action: {
            label: "Turn back on",
            onClick: () => {
              call.setBackground(mode).then(
                () => saveEffectSettings({ background: mode }),
                () => {},
              );
            },
          },
        });
      }),
    [call, toast],
  );

  const showPeople = useCallback(() => setPanel("people"), []);
  const hideSelf = useCallback(() => {
    updateSettings({ selfView: "hidden" });
    toast.push({
      tag: "self-hidden",
      priority: "you",
      icon: <EyeOff className="size-5" />,
      title: "Your own video is hidden",
      body: "Others can still see you.",
      action: { label: "Show", onClick: () => updateSettings({ selfView: "float" }) },
    });
  }, [toast, updateSettings]);

  // Copying confirms on the button that was pressed (see useCopied); only a failure needs a toast.
  const copyLink = useCallback(async () => {
    const ok = await copyText(`${window.location.origin}/${code}`);
    if (!ok) toast.push({ tag: "copy-error", icon: <CircleAlert className="size-5" />, tone: "danger", title: "Couldn't copy the link", body: "Copy it from the address bar instead." });
    return ok;
  }, [code, toast]);
  const headerCopy = useCopied(copyLink);

  /* ---------------------------------------------------------- notifications */
  // On large screens notifications rise from the stage's bottom-right corner (see globals.css).
  // They stay clear of an open side panel and of whatever already sits in that corner.
  // In the sidebar view that corner is the main tile's, left of the filmstrip.
  const beside = view === "sidebar" && others.length > 0;
  // The invite card steps aside while somebody is asking to join (only hosts are told of them).
  const knocking = useWaiting().length;
  const cornerLift =
    call.participants().length === 1 && knocking === 0
      ? 9.25 // the invite card
      : view === "tiled" && pageCount > 1
        ? floatSelf
          ? 10
          : 3.25 // the page bar, and the self view above it
        : floatSelf
          ? 7.25
          : 0;
  const panelInset = (shown ? 23.25 : 0) + (beside ? 14.75 : 0);
  // How many notifications fit is the status lane's to say (see StatusLane.tsx).
  const sheetOpen = phone && panel !== null;
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
      if (event.shiftKey && event.key.toLowerCase() === "p") {
        // Where there is no mini window, Shift+P is not a shortcut at all.
        if (!miniSupported) return;
        toggleMini();
        event.preventDefault();
        return;
      }
      const media = call.localMedia();
      switch (event.key.toLowerCase()) {
        case "m":
          noteOwnMicToggle();
          call.setEnabled("microphone", !media.microphone).catch(() => {});
          break;
        case "v":
          noteOwnCameraToggle();
          call.setEnabled("camera", !media.camera).catch(() => {});
          break;
        case "r":
          // Opens the strip; inside it 1 to 6 send, and Escape closes it.
          if (call.status === "connected") setReactOpen(true);
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
  }, [call, shortcutsOn, toggleHand, togglePanel, paged, currentPage, pageCount, miniSupported, toggleMini]);

  /* ------------------------------------------------------------------ render */
  const connecting = connection === "connecting";
  // Webinars: the audience counts here. A host with people watching is not alone.
  const alone = call.participants().length === 1 && !connecting;
  const leaving = panel === null && shown !== null;
  const panelTitle = shown === "chat" ? "Chat" : "People";

  return (
    <HostProvider localIdentity={localParticipant.identity}>
      <MiniProvider value={mini}>
      <ModerationNotices localIdentity={localParticipant.identity} peopleOpen={panel === "people"} onShowPeople={showPeople} />
      <LimitNotice />
      <ReactionFeed />
      {phone && (
        <header className="flex items-center justify-between gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <button
            onClick={headerCopy.copy}
            aria-label={`Copy ${noun} link, code ${code}`}
            className="inline-flex h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 pl-1 font-mono text-[0.8125rem] text-muted active:bg-surface-2"
          >
            <LogoMark className="size-7 shrink-0" />
            <span className="truncate">{headerCopy.copied ? "Copied" : code}</span>
            <CopyIcon copied={headerCopy.copied} />
            <span className="sr-only" role="status">
              {headerCopy.copied ? `Link copied` : ""}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-2">
            <DataSaverBadge onOpen={showQuality} compact />
            <RaisedHands hands={raisedHands} onShow={showPeople} compact />
            {/* On a webinar's stage: "Live · On stage", with the way back to the audience. */}
            <OnStageChip compact />
            <button
              id="toggle-people"
              onClick={() => togglePanel("people")}
              aria-expanded={panel === "people"}
              className="relative inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-xl bg-surface-2 px-3.5 text-sm font-semibold tabular-nums active:bg-surface-3"
            >
              <Users className="size-[1.125rem]" aria-hidden="true" />
              <span className="sr-only">People, </span>
              {/* "1.2k" fits the top bar; a screen reader hears the whole number. */}
              <span aria-hidden="true" data-headcount>
                {shortCount(participants.length)}
              </span>
              <span className="sr-only">
                {fullCount(participants.length)} {noun === "webinar" ? "on stage" : "in the meeting"}
              </span>
              <WaitingCount />
            </button>
          </div>
        </header>
      )}

      <div className="relative flex min-h-0 flex-1 gap-3 p-3 max-md:py-2">
        <main className="relative min-w-0 flex-1" aria-label="Meeting stage">
          {miniOpen ? (
            // The pictures are in the mini window; drawing them here as well would stream them twice over.
            <MiniPlaceholder onBack={backFromMini} onShare={settings.miniOnShare} onShareChange={(miniOnShare) => updateSettings({ miniOnShare })} />
          ) : (
            <Stage
              view={view}
              tiles={lean(gallery.slice(currentPage * pageSize, (currentPage + 1) * pageSize))}
              total={gallery.length}
              rangeStart={currentPage * pageSize}
              page={currentPage}
              pageCount={pageCount}
              onPage={goToPage}
              main={main}
              others={lean(others)}
              phone={phone}
              pinned={!!pinned}
              onTogglePin={togglePin}
              onShowEveryone={showPeople}
            />
          )}
          {miniTarget && (
            <MiniWindow
              target={miniTarget}
              tile={miniTile(main, [stageSpeaker ? cameras.get(stageSpeaker) : undefined, firstRemote, selfTile])}
              onBack={backFromMini}
            />
          )}

          <FloatingSelf
            tile={floatSelf && !miniOpen ? selfTile : undefined}
            offset={
              view === "sidebar"
                ? phone
                  ? { x: 0, y: -6.5 }
                  : { x: -14.75, y: paged ? -2.75 : 0 }
                : { x: 0, y: paged ? -2.75 : 0 }
            }
            onHide={hideSelf}
          />

          <ReactionLane />

          <InviteCard show={alone} code={code} onCopy={copyLink} />

          <Connecting show={connecting} noun={noun} />

          <StatusLane phone={phone} sheetOpen={sheetOpen} />
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
              className={`panel flex w-[22.5rem] shrink-0 flex-col ${leaving ? "md:absolute md:inset-y-3 md:right-3" : ""} overflow-hidden rounded-[1.25rem] bg-surface shadow-[inset_0_0_0_1px_var(--border)] max-md:fixed max-md:inset-x-0 max-md:top-(--sheet-top) max-md:bottom-0 max-md:z-50 max-md:w-auto max-md:rounded-b-none`}
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
                      <span className="sr-only">{noun === "webinar" ? " on stage" : " in the meeting"}</span>
                    </span>
                  )}
                </h2>
                <div className="flex items-center gap-0.5">
                  {shown === "chat" && <SaveChatButton code={code} />}
                  <button className="icon-btn" onClick={() => closePanel(true)} aria-label={`Close ${panelTitle.toLowerCase()}`}>
                    <X className="size-5" aria-hidden="true" />
                  </button>
                </div>
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
        reactOpen={reactOpen}
        onReactOpenChange={setReactOpen}
        onTogglePanel={togglePanel}
        onCopyLink={copyLink}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onShowQuality={showQuality}
        settings={settings}
        onSettings={updateSettings}
      />

      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        enabled={shortcutsOn}
        onEnabledChange={(shortcuts) => updateSettings({ shortcuts })}
        miniWindow={miniSupported}
      />
      <CallQualityDialog open={qualityOpen} onOpenChange={setQualityOpen} />
      <ChatToasts open={panel === "chat"} onReply={openChat} />
      <PollToasts open={panel === "chat"} onShow={openChat} />
      <Switching />
      </MiniProvider>
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
            <Tip label="Hide your own video" side="left">
              <button
                aria-label="Hide your own video"
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

/** Phones: how many people are asking to join, on the people button. Host and co-hosts only. */
function WaitingCount() {
  const { waiting, canModerate } = useHost();
  if (!canModerate || waiting.length === 0) return null;
  return (
    <span
      className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-accent-ink tabular-nums ring-3 ring-bg"
      data-waiting-count
    >
      <span aria-hidden="true">{badgeCount(waiting.length)}</span>
      <span className="sr-only">, {fullCount(waiting.length)} waiting to join</span>
    </span>
  );
}

/** Covers the stage until the room is connected, then fades away to reveal it. */
function Connecting({ show, noun }: { show: boolean; noun: "meeting" | "webinar" }) {
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
        <p>Joining the {noun}…</p>
      </div>
    </div>
  );
}

function InviteCard({ show, code, onCopy }: { show: boolean; code: string; onCopy: () => Promise<boolean> }) {
  const [dismissed, setDismissed] = useState(false);
  // Somebody asking to join is the answer to this card: it steps aside for their notification
  // instead of stacking with it (on a phone the two would cover half the screen).
  const { waiting, canModerate } = useHost();
  const knocking = canModerate && waiting.length > 0;
  // (Conference keeps notifications above this card only while it is up; see `knocking` there.)
  // It leaves, quickly, the moment somebody else arrives: it goes first, then the tiles move.
  const presence = usePresence(show && !dismissed && !knocking);
  const { copied, copy } = useCopied(onCopy);
  if (!presence.mounted) return null;
  return (
    <div
      // On a phone notifications arrive at the top, where this card is: they are placed below it (see globals.css).
      data-invite-card
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

/* ---------------------------------------------------------------- webinars */

/**
 * A webinar's audience has a screen of its own (ViewerCall.tsx): no microphone, camera or tile.
 * Everyone else, and anyone the host brings on stage, has the meeting's.
 */
function CallOrAudience(props: { code: string }) {
  return useWatching() ? <ViewerCall {...props} /> : <Call {...props} />;
}
