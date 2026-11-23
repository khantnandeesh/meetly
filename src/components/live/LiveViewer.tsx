"use client";

import { LoaderCircle, Maximize, Minimize, Play, Radio, RotateCw, Volume2, VolumeX, WifiOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { OverlayState, OverlayViewer } from "@meetly/overlay";
import { Tip } from "@/components/ui/Tip";
import { LIVE_VIEWER_CAP, audience, type LiveTree } from "@/lib/live/tree";
import { SERVERLESS_LINE } from "@/lib/live/webinar";
import { Card, FocusedHeading, LiveChip, LiveHeader, LiveRequestError, ServerlessNote, WebinarHeading, coordinatorUrl, fetchTree, postJson, useLiveTree, useOwnKey } from "./shared";
import { WhoIsConnected } from "./WhoIsConnected";

type Over = { title: string; body: string; action: "home" | "retry" };

type Phase =
  | { t: "checking" }
  | { t: "notice"; started: boolean }
  | { t: "joining" }
  | { t: "watching" }
  /** The browser could not get the picture on this network, and gave up its place: see STUCK_AFTER_MS. */
  | { t: "stuck" }
  /** The webinar cannot be watched: ended, full, removed, or not set up. Said plainly. */
  | ({ t: "over" } & Over);

const ENDED: Over = { title: "This webinar has ended", body: "The host has ended it. Thanks for watching.", action: "home" };
const FULL: Over = {
  title: "This webinar is full",
  body: `It already has ${LIVE_VIEWER_CAP} viewers, the most a serverless webinar can take in this beta. Someone may leave; try again in a little while.`,
  action: "retry",
};

/**
 * With the host live and this browser connected, no picture after this long most likely means
 * no viewer's browser (nor the host's) could be reached from this network: there is no TURN
 * relay yet, so a strict NAT or firewall cannot join the tree. The browser then leaves, so it
 * does not hold one of the places or count as watching.
 */
const STUCK_AFTER_MS = 20_000;

/** A round button laid on the picture, in the status chip's dark glass. */
const onPicture =
  "grid size-10 cursor-pointer place-items-center rounded-xl bg-[rgb(11_11_15/0.72)] text-text backdrop-blur-[10px] transition-[background-color,transform] duration-150 hover:bg-[rgb(11_11_15/0.9)] active:scale-[0.96]";

function over(tree: LiveTree): Phase | null {
  if (tree.ended) return { t: "over", ...ENDED };
  if (tree.full) return { t: "over", ...FULL };
  return null;
}

/**
 * A serverless webinar (Live, beta), a viewer: a short, honest notice, then "Watch". The picture
 * and sound come from the overlay (packages/overlay): from the host's browser or from another
 * viewer's, and this browser may pass them on to others. Its states: waiting for the host,
 * connecting, live, reconnecting, can't connect on this network, and the ends (ended, full,
 * refused, unavailable). The video takes the page's width; "Who's connected" is folded below it.
 */
export function LiveViewer({ id, title }: { id: string; title: string }) {
  const [phase, setPhase] = useState<Phase>({ t: "checking" });
  const [connection, setConnection] = useState<OverlayState>("idle");
  const [hasPicture, setHasPicture] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Read once in the browser; the buttons that use it only appear with a picture, after hydration.
  const [canFullscreen] = useState(
    () => typeof document !== "undefined" && (document.fullscreenEnabled || "webkitEnterFullscreen" in HTMLVideoElement.prototype),
  );
  const [peer, setPeer] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const viewer = useRef<OverlayViewer | null>(null);
  const identity = useRef<string | null>(null);

  const tree = useLiveTree(phase.t === "over" ? null : id);
  const ownKey = useOwnKey(peer);
  const started = !!tree?.started;

  useEffect(() => {
    let stale = false;
    fetchTree(id).then(
      (first) => {
        if (!stale) setPhase(over(first) ?? { t: "notice", started: first.started });
      },
      (error) => {
        if (stale) return;
        if (error instanceof LiveRequestError && error.status === 503) setPhase({ t: "over", title: "Serverless webinars aren’t available", body: error.message, action: "home" });
        else setPhase({ t: "notice", started: false });
      },
    );
    return () => {
      stale = true;
    };
  }, [id]);

  // While on the notice, a webinar that starts, ends or fills up says so before "Watch" is pressed.
  useEffect(() => {
    if (!tree) return;
    setPhase((current) => (current.t === "notice" ? (over(tree) ?? { t: "notice", started: tree.started }) : current));
  }, [tree]);

  useEffect(
    () => () => {
      void viewer.current?.close();
    },
    [],
  );

  // The picture goes on the <video> once the player has one; the element stays muted, because
  // the sound is played by the overlay's own audio output.
  useEffect(() => {
    const track = hasPicture ? viewer.current?.videoTrack() : null;
    if (video.current && track) {
      video.current.srcObject = new MediaStream([track]);
      void video.current.play().catch(() => undefined);
    }
  }, [hasPicture, phase.t]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === stage.current && !!stage.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  // The host is live and this browser is connected, but no picture comes: see STUCK_AFTER_MS.
  const waitingForPicture = phase.t === "watching" && connection === "connected" && started && !hasPicture;
  useEffect(() => {
    if (!waitingForPicture) return;
    const timer = setTimeout(() => {
      const current = viewer.current;
      viewer.current = null;
      setPeer(null);
      setPhase({ t: "stuck" });
      void current?.close().catch(() => undefined);
    }, STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waitingForPicture]);

  async function watch() {
    setPhase({ t: "joining" });
    setHasPicture(false);
    try {
      const { createOverlayViewer } = await import("@meetly/overlay");
      const overlay = createOverlayViewer({
        coordinatorUrl: coordinatorUrl(id),
        ticket: async () => {
          const answer = await postJson<{ ticket: string; identity: string }>(`/api/live/${id}/ticket`, { role: "viewer", identity: identity.current });
          identity.current = answer.identity;
          return answer.ticket;
        },
      });
      viewer.current = overlay;
      overlay.on("state", setConnection);
      overlay.on("firstFrame", () => setHasPicture(true));
      overlay.on("audioBlocked", setSoundBlocked);
      overlay.on("closed", (reason) => {
        if (viewer.current !== overlay) return;
        setHasPicture(false);
        if (reason === "ended") setPhase({ t: "over", ...ENDED });
        else if (reason === "full") setPhase({ t: "over", ...FULL });
        else if (reason === "kicked" || reason === "denied") setPhase({ t: "over", title: "You can’t watch this webinar", body: "The webinar didn’t let this browser in.", action: "home" });
      });
      await overlay.connect();
      overlay.setVolume(muted ? 0 : 1);
      setPeer(overlay.status()?.path[0] ?? null);
      setPhase({ t: "watching" });
      // Pressing Watch was the gesture the browser wants before it plays sound.
      void overlay.resumeAudio().catch(() => undefined);
    } catch (error) {
      await viewer.current?.close().catch(() => undefined);
      viewer.current = null;
      setPhase((current) =>
        current.t === "over"
          ? current
          : {
              t: "over",
              title: "Couldn’t connect",
              body: error instanceof Error && /unreachable/i.test(error.message) ? "The webinar couldn’t be reached." : "Something went wrong while connecting.",
              action: "retry",
            },
      );
    }
  }

  async function toggleSound() {
    if (soundBlocked) {
      await viewer.current?.resumeAudio().catch(() => undefined);
      setMuted(false);
      viewer.current?.setVolume(1);
      return;
    }
    viewer.current?.setVolume(muted ? 1 : 0);
    setMuted(!muted);
  }

  // Full screen takes the stage (picture and buttons) where the browser allows it; iPhone Safari
  // allows only the <video> itself, in its own player.
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else if (document.fullscreenEnabled && stage.current?.requestFullscreen) void stage.current.requestFullscreen().catch(() => undefined);
    else (video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
  }

  // The picture came, then the host's browser left the stream without ending it (its network, or
  // a crash): the last frame stays on the <video>, so it is said, not left looking live.
  const hostAway = phase.t === "watching" && hasPicture && !!tree && !tree.started && !tree.ended;

  const name = title || "Webinar";
  const soundLabel = muted ? "Turn on sound" : "Mute";
  const viewersNow = audience(tree).watching;

  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <LiveHeader narrow />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 pb-16 sm:px-8">
        <WebinarHeading title={name} />

        {phase.t === "over" ? (
          <Card className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <FocusedHeading data-testid="live-over">{phase.title}</FocusedHeading>
              <p className="max-w-[40rem] text-pretty text-muted">{phase.body}</p>
            </div>
            {phase.action === "retry" ? (
              <button className="btn btn-secondary self-start" onClick={() => location.reload()}>
                <RotateCw className="size-4" aria-hidden="true" />
                Try again
              </button>
            ) : (
              <Link href="/" className="btn btn-secondary self-start">
                Back to home
              </Link>
            )}
          </Card>
        ) : phase.t === "stuck" ? (
          <Card className="flex flex-col gap-4" data-testid="live-stuck">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-warn/12 text-warn" aria-hidden="true">
                <WifiOff className="size-5" />
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <FocusedHeading>Can’t get the video on this network</FocusedHeading>
                <p className="max-w-[40rem] text-pretty text-muted">
                  A serverless webinar needs your browser to connect directly to the host’s or other viewers’ browsers, and this network seems to block that. Some office,
                  school and mobile networks do. Try another network, such as home Wi-Fi or a phone hotspot.
                </p>
              </div>
            </div>
            <button className="btn btn-secondary self-start sm:ml-14" onClick={() => void watch()} data-testid="live-retry">
              <RotateCw className="size-4" aria-hidden="true" />
              Try again
            </button>
          </Card>
        ) : phase.t === "watching" || phase.t === "joining" ? (
          <div className="flex flex-col gap-3">
            <div ref={stage} className="relative aspect-video overflow-hidden rounded-3xl bg-surface-2 ring-1 ring-border data-[fullscreen=true]:rounded-none" data-fullscreen={fullscreen}>
              <video ref={video} className={`size-full object-contain ${hasPicture ? "" : "opacity-0"}`} autoPlay muted playsInline data-testid="live-video" />
              {!hasPicture ? (
                <div className="absolute inset-0 grid place-items-center p-6 text-center" data-testid="live-status" role="status">
                  {phase.t === "watching" && tree && !started ? (
                    <span className="flex flex-col items-center gap-2">
                      <Radio className="size-6 animate-pulse text-faint" aria-hidden="true" />
                      <span className="font-medium">Waiting for the host to go live</span>
                      <span className="text-sm text-muted">The video starts here on its own.</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2 text-sm text-muted">
                      <LoaderCircle className="anim-spin size-4" aria-hidden="true" />
                      {phase.t === "joining" ? "Connecting…" : connection === "reconnecting" ? "Reconnecting…" : "Connecting to the video…"}
                    </span>
                  )}
                </div>
              ) : hostAway ? (
                <div className="absolute inset-0 grid place-items-center bg-bg/75 p-6 text-center" role="status" data-testid="live-host-away">
                  <span className="flex flex-col items-center gap-2">
                    <WifiOff className="size-6 text-faint" aria-hidden="true" />
                    <span className="font-medium">The host’s connection dropped</span>
                    <span className="text-sm text-muted">The video carries on here if they come back.</span>
                  </span>
                </div>
              ) : connection === "reconnecting" ? (
                <div className="absolute inset-0 grid place-items-center bg-bg/60 text-sm" role="status">
                  <span className="chip h-9 px-3">
                    <LoaderCircle className="anim-spin size-4" aria-hidden="true" />
                    Reconnecting…
                  </span>
                </div>
              ) : null}
              {hasPicture && !hostAway && <LiveChip watching={Math.max(1, viewersNow)} testId="viewer-live" />}
              {/* The player's own buttons, on the picture, so they stay there in full screen. */}
              {hasPicture && (
                <div className="absolute right-3 bottom-3 flex items-center gap-2" role="group" aria-label="Player">
                  {soundBlocked ? (
                    <button className="btn btn-primary h-10 rounded-xl px-4 text-sm" onClick={() => void toggleSound()}>
                      <Volume2 className="size-4" aria-hidden="true" />
                      Turn on sound
                    </button>
                  ) : (
                    <Tip label={soundLabel}>
                      <button className={onPicture} aria-label={soundLabel} onClick={() => void toggleSound()} data-testid="viewer-sound">
                        {muted ? <VolumeX className="size-5 text-danger-text" aria-hidden="true" /> : <Volume2 className="size-5" aria-hidden="true" />}
                      </button>
                    </Tip>
                  )}
                  {canFullscreen && (
                    <Tip label={fullscreen ? "Exit full screen" : "Full screen"}>
                      <button className={onPicture} aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
                        {fullscreen ? <Minimize className="size-5" aria-hidden="true" /> : <Maximize className="size-5" aria-hidden="true" />}
                      </button>
                    </Tip>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <Card className="flex flex-col gap-5">
            <p className="flex items-start gap-2 text-sm font-medium" data-testid="live-start-state">
              {phase.t === "checking" ? (
                <>
                  <LoaderCircle className="anim-spin mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="text-muted" role="status">
                    Checking the webinar…
                  </span>
                </>
              ) : phase.started ? (
                <>
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-danger" aria-hidden="true" />
                  <span>
                    {/* Only the state is announced, not the count, which changes every few seconds. */}
                    <span role="status">Live now</span>
                    {tree && (
                      <span className="font-normal text-muted">
                        {" · "}
                        <span className="tabular-nums">{viewersNow}</span> watching
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-faint" aria-hidden="true" />
                  <span className="text-muted" role="status">
                    Not started yet. You can start watching and wait here.
                  </span>
                </>
              )}
            </p>
            <div className="flex max-w-[40rem] flex-col gap-3" data-testid="live-notice">
              <h2 className="font-display text-xl font-semibold tracking-tight">Before you watch</h2>
              <p className="text-pretty">{SERVERLESS_LINE}</p>
              <ul className="flex flex-col gap-1.5 text-sm text-muted">
                {[
                  "While you watch, your browser may pass the video on to a few other viewers.",
                  "Browsers connected to yours can see your IP address.",
                  "Each connection is encrypted, but not end to end. This is a beta.",
                ].map((line) => (
                  <li key={line} className="flex gap-2.5 text-pretty">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <button className="btn btn-primary self-start" onClick={() => void watch()} disabled={phase.t === "checking"} data-testid="watch">
              {phase.t === "checking" ? <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" /> : <Play className="size-[1.125rem] fill-current" aria-hidden="true" />}
              Watch
            </button>
          </Card>
        )}

        {(phase.t === "watching" || phase.t === "joining") && <ServerlessNote />}

        {/* Not once over, nor once this browser has given up its place: the tree would be stale. */}
        {phase.t !== "over" && phase.t !== "stuck" && <WhoIsConnected tree={tree} ownKey={ownKey} collapsible />}
      </main>
    </div>
  );
}
