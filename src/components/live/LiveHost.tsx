"use client";

import { Check, CircleAlert, Copy, LoaderCircle, Radio, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OverlaySource } from "@meetly/overlay";
import { Card, LiveHeader, coordinatorUrl, postJson, useLiveTree, useOwnKey } from "./shared";
import { WhoIsConnected } from "./WhoIsConnected";

type Phase =
  | { t: "asking" }
  | { t: "no-media"; message: string }
  | { t: "ready" }
  | { t: "starting" }
  | { t: "live"; id: string }
  | { t: "ending"; id: string }
  | { t: "ended"; id: string; message: string };

function mediaMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera and microphone are blocked. Allow them in your browser's site settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera or microphone was found.";
  if (name === "NotReadableError" || name === "AbortError") return "Your camera or microphone is in use by another app.";
  return "Couldn't open your camera and microphone.";
}

/**
 * Live (beta), the host: one person broadcasting from this browser, which is the overlay's
 * source. The stream reaches viewers through other viewers' browsers (packages/overlay), not
 * through RealtimeKit or any media server.
 */
export function LiveHost() {
  const [phase, setPhase] = useState<Phase>({ t: "asking" });
  const [media, setMedia] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [peer, setPeer] = useState<string | null>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const source = useRef<OverlaySource | null>(null);
  const hostKey = useRef<string | null>(null);

  const id = phase.t === "live" || phase.t === "ending" || phase.t === "ended" ? phase.id : null;
  const tree = useLiveTree(phase.t === "live" || phase.t === "ending" ? id : null);
  const ownKey = useOwnKey(peer);

  const askForMedia = useCallback(async () => {
    setPhase({ t: "asking" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      setMedia(stream);
      setPhase({ t: "ready" });
    } catch (e) {
      setPhase({ t: "no-media", message: mediaMessage(e) });
    }
  }, []);

  useEffect(() => {
    // The camera is asked for once, on arrival: the host came here to broadcast.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the permission prompt is an external system; its answer sets the phase.
    void askForMedia();
  }, [askForMedia]);

  useEffect(() => {
    if (preview.current && media) preview.current.srcObject = media;
  }, [media, phase.t]);

  // Leaving the page ends the broadcast; the browser asks first while it is on.
  useEffect(() => {
    if (phase.t !== "live") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase.t]);

  useEffect(
    () => () => {
      void source.current?.close();
    },
    [],
  );
  useEffect(() => () => media?.getTracks().forEach((track) => track.stop()), [media]);

  async function goLive() {
    if (!media) return;
    setError(null);
    setPhase({ t: "starting" });
    try {
      const created = await postJson<{ id: string; hostKey: string }>("/api/live", {});
      // The key lives as long as this page: a reload is a new stream (beta).
      hostKey.current = created.hostKey;
      const { createOverlaySource } = await import("@meetly/overlay");
      const overlay = createOverlaySource({
        coordinatorUrl: coordinatorUrl(created.id),
        ticket: async () => (await postJson<{ ticket: string }>(`/api/live/${created.id}/ticket`, { role: "source", hostKey: hostKey.current })).ticket,
      });
      source.current = overlay;
      overlay.on("closed", (reason) => {
        if (reason === "left") return;
        setPhase({ t: "ended", id: created.id, message: reason === "ended" ? "The stream has ended." : "The stream was stopped." });
      });
      await overlay.connect();
      setPeer(overlay.status()?.path[0] ?? null);
      const video = media.getVideoTracks()[0];
      const audio = media.getAudioTracks()[0];
      await overlay.publish(audio ? { video, audio } : { video });
      setPhase({ t: "live", id: created.id });
    } catch (e) {
      await source.current?.close().catch(() => undefined);
      source.current = null;
      setError(e instanceof Error ? e.message : "Couldn't go live.");
      setPhase({ t: "ready" });
    }
  }

  async function end() {
    if (phase.t !== "live") return;
    const liveId = phase.id;
    setPhase({ t: "ending", id: liveId });
    try {
      await postJson(`/api/live/${liveId}/end`, { hostKey: hostKey.current });
    } catch {
      // Closing the source below still stops the picture; viewers see it stop.
    }
    await source.current?.close().catch(() => undefined);
    source.current = null;
    media?.getTracks().forEach((track) => track.stop());
    setMedia(null);
    setPhase({ t: "ended", id: liveId, message: "Your stream has ended." });
  }

  const shareUrl = id ? `${location.origin}/live/${id}` : "";
  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The link is on screen to copy by hand.
    }
  }

  const showTree = phase.t === "live" || phase.t === "ending";

  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <LiveHeader />
      <main className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-5 px-4 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-6">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2 pt-2">
            <h1 className="font-display text-[clamp(2rem,5vw,2.75rem)] leading-[1.05] font-semibold tracking-[-0.03em]">Go live</h1>
            <p className="max-w-[36rem] text-pretty text-muted">
              Broadcast your camera to up to 50 people with one link. They watch in their browser; you&apos;re the only one on camera.
            </p>
          </div>

          <div className="relative aspect-video overflow-hidden rounded-3xl bg-surface-2 ring-1 ring-border">
            {media && phase.t !== "ended" ? (
              <video ref={preview} className="size-full -scale-x-100 object-cover" autoPlay muted playsInline data-testid="host-preview" />
            ) : (
              <div className="grid size-full place-items-center p-6 text-center text-sm text-muted">
                {phase.t === "asking" ? (
                  <span className="inline-flex items-center gap-2">
                    <LoaderCircle className="anim-spin size-4" aria-hidden="true" /> Asking for your camera and microphone…
                  </span>
                ) : phase.t === "no-media" ? (
                  <span className="flex max-w-sm flex-col items-center gap-3">
                    <CircleAlert className="size-6 text-danger-text" aria-hidden="true" />
                    {phase.message}
                  </span>
                ) : phase.t === "ended" ? (
                  phase.message
                ) : null}
              </div>
            )}
            {(phase.t === "live" || phase.t === "ending") && (
              <span className="chip absolute top-3 left-3" data-testid="host-viewers">
                <span className="size-2 rounded-full bg-danger" aria-hidden="true" />
                Live · {tree?.viewers ?? 0} {tree?.viewers === 1 ? "viewer" : "viewers"}
              </span>
            )}
          </div>

          {error && (
            <p className="flex items-start gap-2 text-sm text-danger-text" role="alert">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          {phase.t === "no-media" && (
            <button className="btn btn-secondary self-start" onClick={() => void askForMedia()}>
              Try again
            </button>
          )}

          {(phase.t === "ready" || phase.t === "starting" || phase.t === "asking") && (
            <button className="btn btn-primary self-start" onClick={() => void goLive()} disabled={phase.t !== "ready"} data-testid="go-live">
              {phase.t === "starting" ? <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" /> : <Radio className="size-[1.125rem]" strokeWidth={2.5} aria-hidden="true" />}
              Go live
            </button>
          )}

          {(phase.t === "live" || phase.t === "ending") && (
            <Card className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label htmlFor="share-link" className="text-sm font-medium">
                  Share link
                </label>
                <div className="flex gap-2">
                  <input
                    id="share-link"
                    readOnly
                    value={shareUrl}
                    onFocus={(event) => event.currentTarget.select()}
                    className="h-12 min-w-0 flex-1 rounded-2xl bg-surface-2 px-4 font-mono text-sm ring-1 ring-border outline-none ring-inset focus:ring-accent"
                    data-testid="share-link"
                  />
                  <button className="btn btn-secondary w-12 px-0 sm:w-auto sm:px-5" onClick={() => void copy()} aria-label="Copy link">
                    {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                    <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted" data-testid="host-viewer-count">
                  <span className="font-semibold text-text tabular-nums">{tree?.viewers ?? 0}</span> watching
                </p>
                <button className="btn ctrl-danger" onClick={() => void end()} disabled={phase.t === "ending"} data-testid="end-live">
                  {phase.t === "ending" ? <LoaderCircle className="anim-spin size-4" aria-hidden="true" /> : <Square className="size-4 fill-current" aria-hidden="true" />}
                  End
                </button>
              </div>
            </Card>
          )}

          {phase.t === "ended" && (
            <button className="btn btn-primary self-start" onClick={() => void askForMedia()}>
              <Radio className="size-[1.125rem]" strokeWidth={2.5} aria-hidden="true" />
              Go live again
            </button>
          )}

          <p className="max-w-[40rem] text-xs leading-relaxed text-faint">
            Beta. Your stream reaches viewers through other viewers&apos; browsers, and they may pass it on. People connected to you can see your IP address. It is not
            encrypted.
          </p>
        </div>

        <div className="min-w-0 lg:pt-[5.5rem]">
          {showTree ? (
            <WhoIsConnected tree={tree} ownKey={ownKey} />
          ) : (
            <Card>
              <h2 className="font-display text-lg font-semibold tracking-tight">Who&apos;s connected</h2>
              <p className="mt-2 text-sm text-muted">Once you&apos;re live, everyone watching shows up here, under the browser they get the stream from.</p>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
