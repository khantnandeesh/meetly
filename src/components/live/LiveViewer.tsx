"use client";

import { CircleAlert, LoaderCircle, Play, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OverlayState, OverlayViewer } from "@meetly/overlay";
import type { LiveTree } from "@/lib/live/tree";
import { Card, LiveHeader, LiveRequestError, coordinatorUrl, fetchTree, postJson, useLiveTree, useOwnKey } from "./shared";
import { WhoIsConnected } from "./WhoIsConnected";

type Phase =
  | { t: "checking" }
  | { t: "notice"; started: boolean }
  | { t: "joining" }
  | { t: "watching" }
  /** The stream cannot be watched: ended, full, removed, or not set up. Said plainly. */
  | { t: "over"; title: string; body: string };

const ENDED = { title: "This stream has ended", body: "The host has ended the stream." };
const FULL = { title: "This stream is full", body: "It already has 50 viewers, the most one stream can take in this beta. Try again later." };

function over(tree: LiveTree): Phase | null {
  if (tree.ended) return { t: "over", ...ENDED };
  if (tree.full) return { t: "over", ...FULL };
  return null;
}

/**
 * Live (beta), a viewer: a short notice, then "Watch". The picture and sound come from the
 * overlay (packages/overlay): from the host's browser or from another viewer's, and this
 * browser may pass them on to others.
 */
export function LiveViewer({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>({ t: "checking" });
  const [connection, setConnection] = useState<OverlayState>("idle");
  const [hasPicture, setHasPicture] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [peer, setPeer] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const viewer = useRef<OverlayViewer | null>(null);
  const identity = useRef<string | null>(null);

  const tree = useLiveTree(phase.t === "over" ? null : id);
  const ownKey = useOwnKey(peer);

  useEffect(() => {
    let stale = false;
    fetchTree(id).then(
      (first) => {
        if (!stale) setPhase(over(first) ?? { t: "notice", started: first.started });
      },
      (error) => {
        if (stale) return;
        if (error instanceof LiveRequestError && error.status === 503) setPhase({ t: "over", title: "Live isn't available", body: error.message });
        else setPhase({ t: "notice", started: false });
      },
    );
    return () => {
      stale = true;
    };
  }, [id]);

  // While on the notice, a stream that ends or fills up says so before "Watch" is pressed.
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

  async function watch() {
    setPhase({ t: "joining" });
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
        setHasPicture(false);
        if (reason === "ended") setPhase({ t: "over", ...ENDED });
        else if (reason === "full") setPhase({ t: "over", ...FULL });
        else if (reason === "kicked" || reason === "denied") setPhase({ t: "over", title: "You can't watch this stream", body: "The stream didn't let this browser in." });
      });
      await overlay.connect();
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
          : { t: "over", title: "Couldn't connect", body: error instanceof Error && /unreachable/i.test(error.message) ? "The stream couldn't be reached. Reload to try again." : "Reload to try again." },
      );
    }
  }

  async function unmute() {
    await viewer.current?.resumeAudio().catch(() => undefined);
  }

  const status =
    connection === "reconnecting"
      ? "Reconnecting…"
      : !hasPicture
        ? tree && !tree.started
          ? "Waiting for the host to go live…"
          : "Finding someone to get the stream from…"
        : null;

  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <LiveHeader />
      <main className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-5 px-4 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-6">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2 pt-2">
            <h1 className="font-display text-[clamp(2rem,5vw,2.75rem)] leading-[1.05] font-semibold tracking-[-0.03em]">Live stream</h1>
            <p className="font-mono text-sm text-muted">{id}</p>
          </div>

          {phase.t === "watching" || phase.t === "joining" ? (
            <div className="relative aspect-video overflow-hidden rounded-3xl bg-surface-2 ring-1 ring-border">
              <video ref={video} className={`size-full object-contain ${hasPicture ? "" : "opacity-0"}`} autoPlay muted playsInline data-testid="live-video" />
              {status && (
                <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted">
                  <span className="inline-flex items-center gap-2">
                    <LoaderCircle className="anim-spin size-4" aria-hidden="true" />
                    {phase.t === "joining" ? "Connecting…" : status}
                  </span>
                </div>
              )}
              {hasPicture && (
                <span className="chip absolute top-3 left-3">
                  <span className="size-2 rounded-full bg-danger" aria-hidden="true" />
                  Live · {tree?.viewers ?? 1} {tree?.viewers === 1 ? "viewer" : "viewers"}
                </span>
              )}
              {soundBlocked && (
                <button className="btn btn-primary absolute right-3 bottom-3 h-10 rounded-xl px-4 text-sm" onClick={() => void unmute()}>
                  <Volume2 className="size-4" aria-hidden="true" />
                  Turn on sound
                </button>
              )}
            </div>
          ) : phase.t === "over" ? (
            <Card className="flex flex-col gap-2" >
              <h2 className="font-display text-xl font-semibold tracking-tight" data-testid="live-over">
                {phase.title}
              </h2>
              <p className="text-muted">{phase.body}</p>
            </Card>
          ) : (
            <Card className="flex flex-col gap-5">
              <div className="flex items-start gap-3">
                <CircleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
                <p className="text-pretty" data-testid="live-notice">
                  Beta. This stream reaches you through other viewers&apos; browsers, and you may pass it on to others. People connected to you can see your IP address. It is not
                  encrypted.
                </p>
              </div>
              {phase.t === "notice" && !phase.started && <p className="text-sm text-muted">The host hasn&apos;t gone live yet. You can start watching and wait here.</p>}
              <button className="btn btn-primary self-start" onClick={() => void watch()} disabled={phase.t === "checking"} data-testid="watch">
                {phase.t === "checking" ? <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" /> : <Play className="size-[1.125rem] fill-current" aria-hidden="true" />}
                Watch
              </button>
            </Card>
          )}
        </div>

        <div className="min-w-0 lg:pt-[5.5rem]">
          <WhoIsConnected tree={tree} ownKey={ownKey} />
        </div>
      </main>
    </div>
  );
}
