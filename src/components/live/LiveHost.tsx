"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { CircleAlert, LoaderCircle, Mic, MicOff, Radio, Square, Video, VideoOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { OverlaySource } from "@meetly/overlay";
import { CopyIcon } from "@/components/ui/CopyIcon";
import { Tip } from "@/components/ui/Tip";
import { copyText, useCopied } from "@/lib/hooks";
import { LIVE_VIEWER_CAP, audience } from "@/lib/live/tree";
import { debugHandles, exposeE2eeStats, newWebinarKey, withoutKey } from "@/lib/live/e2ee";
import { TITLE_MAX, cleanTitle, durationWords, viewerLink } from "@/lib/live/webinar";
import { CTRL, Card, FocusedHeading, HowItWorks, LiveChip, LiveHeader, ServerlessNote, WebinarHeading, coordinatorUrl, postJson, useLiveTree, useOwnKey } from "./shared";
import { WhoIsConnected } from "./WhoIsConnected";

type Phase =
  | { t: "asking" }
  | { t: "no-media"; message: string }
  | { t: "ready" }
  | { t: "starting" }
  | { t: "live"; id: string }
  | { t: "ending"; id: string }
  /** `seconds`: how long it was live, when it got that far. */
  | { t: "ended"; id: string; message: string; seconds: number | null };

type SignedTitle = { title: string; sig: string } | null;

/** The debug flag is read once per render; nothing announces a change to it. */
const noSubscription = () => () => {};

/** "the one viewer", "both viewers", "all 7 viewers". */
const everyone = (n: number) => (n === 1 ? "the one viewer" : n === 2 ? "both viewers" : `all ${n} viewers`);

function mediaMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera and microphone are blocked. Allow them in your browser’s site settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found. A serverless webinar needs a camera; a microphone is optional.";
  if (name === "NotReadableError" || name === "AbortError") return "Your camera or microphone is in use by another app.";
  return "Couldn’t open your camera and microphone.";
}

/**
 * A serverless webinar (Live, beta), the host: one person broadcasting from this browser, which is
 * the overlay's source. The video reaches viewers browser to browser, viewers passing it on to
 * each other (packages/overlay); no media server, RealtimeKit's or anyone's, carries it.
 *
 * Before going live: the camera preview, the microphone and camera switches, an optional title
 * (signed by the server and carried in the share link, since nothing is stored), and "Go live".
 * Live: "● Live · 12:03 · N watching" on the picture, the same switches, the link, and "End
 * webinar", which asks first in a dialog. Ended: how long it ran and its largest audience.
 */
export function LiveHost() {
  const [phase, setPhase] = useState<Phase>({ t: "asking" });
  const [media, setMedia] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peer, setPeer] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  /** The title as the server signed it for the link, once live. */
  const [signed, setSigned] = useState<SignedTitle>(null);
  /** The camera works but no microphone could be had: the webinar goes out silent. */
  const [noMicrophone, setNoMicrophone] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  /** The End dialog was opened by the logo: once it ends, the host goes home. */
  const [thenHome, setThenHome] = useState(false);
  const router = useRouter();
  /** When it went live (this browser's clock), for the timer and the summary. */
  const [since, setSince] = useState<number | null>(null);
  const [peak, setPeak] = useState(0);
  const preview = useRef<HTMLVideoElement>(null);
  const source = useRef<OverlaySource | null>(null);
  const hostKey = useRef<string | null>(null);
  /**
   * The webinar's end-to-end key (src/lib/live/e2ee.ts), made in this browser when it goes live.
   * It is only ever in the share link's fragment, which browsers never send to a server.
   */
  const [mediaKey, setMediaKey] = useState<{ key: Uint8Array; publicKey: Uint8Array; pass: string } | null>(null);
  const titleId = useId();

  const id = phase.t === "live" || phase.t === "ending" || phase.t === "ended" ? phase.id : null;
  const onAir = phase.t === "live" || phase.t === "ending";
  const tree = useLiveTree(onAir ? id : null);
  const ownKey = useOwnKey(peer);
  // Only viewers placed in the tree get the video; the rest are still connecting.
  const { watching, connecting } = audience(tree);
  // The largest audience so far, for the summary at the end (adjusted while rendering, not in an effect).
  if (onAir && watching > peak) setPeak(watching);

  const shareUrl = id && mediaKey ? viewerLink(location.origin, id, signed, mediaKey) : "";
  const copyLink = useCopied(() => copyText(shareUrl));
  const debug = useSyncExternalStore(noSubscription, debugHandles, () => false);

  // Whether this page is still shown: a camera that arrives after it has gone is stopped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const askForMedia = useCallback(async () => {
    setPhase({ t: "asking" });
    setNoMicrophone(false);
    setMicOn(true);
    setCamOn(true);
    // Camera and microphone together first. Asked for together, a device that lacks either one
    // fails outright (NotFoundError), so a missing device is tried around: plainly, then the camera
    // alone. Never the microphone alone: the overlay's program needs a picture (ProgramInput.video).
    const attempts: MediaStreamConstraints[] = [
      { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: { echoCancellation: true, noiseSuppression: true } },
      { video: true, audio: true },
      { video: true },
    ];
    let failure: unknown = null;
    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!mounted.current) {
          // The host left the page while the browser was asking: the camera is let go at once.
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setNoMicrophone(stream.getAudioTracks().length === 0);
        setMedia(stream);
        setPhase({ t: "ready" });
        return;
      } catch (e) {
        failure = e;
        const name = e instanceof Error ? e.name : "";
        // Only a missing device is worth another try; a refusal or a busy device is not.
        if (name !== "NotFoundError" && name !== "OverconstrainedError") break;
      }
    }
    setPhase({ t: "no-media", message: mediaMessage(failure) });
  }, []);

  useEffect(() => {
    // The camera is asked for once, on arrival: the host came here to broadcast.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the permission prompt is an external system; its answer sets the phase.
    void askForMedia();
  }, [askForMedia]);

  useEffect(() => {
    if (preview.current && media) preview.current.srcObject = media;
  }, [media, phase.t]);

  // Leaving the page ends the webinar: closing or reloading the tab (the browser asks first while
  // it is on), or following a link away from it (the logo asks first: askBeforeLeaving). A reload is a new webinar (the key lives as long
  // as the page), so without the end, viewers would be left on the last frame of one that can
  // never come back. `sendBeacon` still goes out as the page unloads.
  const liveId = phase.t === "live" ? phase.id : null;
  const leaving = useRef<string | null>(null);
  /** Ends the webinar that is live, if one is, as this page goes away. */
  const endOnLeave = useCallback(() => {
    const id = leaving.current;
    if (!id) return;
    leaving.current = null;
    navigator.sendBeacon(`/api/live/${id}/end`, new Blob([JSON.stringify({ hostKey: hostKey.current })], { type: "application/json" }));
  }, []);
  useEffect(() => {
    leaving.current = liveId;
    if (!liveId) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", endOnLeave);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", endOnLeave);
    };
  }, [liveId, endOnLeave]);

  useEffect(
    () => () => {
      endOnLeave();
      void source.current?.close();
    },
    [endOnLeave],
  );
  useEffect(() => () => media?.getTracks().forEach((track) => track.stop()), [media]);

  // The switches turn the track itself off: the overlay keeps sending, silence or a black picture.
  function toggle(kind: "audio" | "video") {
    const track = kind === "audio" ? media?.getAudioTracks()[0] : media?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    if (kind === "audio") setMicOn(track.enabled);
    else setCamOn(track.enabled);
  }

  async function goLive() {
    if (!media) return;
    setError(null);
    setConfirmEnd(false);
    setThenHome(false);
    setPhase({ t: "starting" });
    /** The source closed for good (ended or stopped) before going live finished: the phase says so already. */
    let closedEarly = false;
    try {
      const created = await postJson<{ id: string; hostKey: string; viewerPass: string; title: SignedTitle }>("/api/live", { title: cleanTitle(title) });
      // The key lives as long as this page: a reload is a new webinar (beta).
      hostKey.current = created.hostKey;
      setSigned(created.title ?? null);
      const { createOverlaySource, createSFrameEncryptor, generateSFrameSigner, importSFrameKey, sframeTransform } = await import("@meetly/overlay");
      // A new key for every webinar, made here and never sent anywhere: each frame is encrypted
      // with it before it leaves this browser, and signed with a key pair whose private half
      // never leaves this page (packages/overlay/media/sframe.ts).
      const key = await newWebinarKey();
      const { signer, publicKey } = await generateSFrameSigner();
      const encryptor = createSFrameEncryptor(await importSFrameKey(key), { signer });
      exposeE2eeStats(() => encryptor.stats());
      setMediaKey({ key, publicKey, pass: created.viewerPass });
      const overlay = createOverlaySource({
        frameTransform: sframeTransform({ encryptor }),
        coordinatorUrl: coordinatorUrl(created.id),
        ticket: async () => (await postJson<{ ticket: string }>(`/api/live/${created.id}/ticket`, { role: "source", hostKey: hostKey.current })).ticket,
      });
      source.current = overlay;
      const started = { at: 0 };
      overlay.on("closed", (reason) => {
        if (reason === "left") return;
        closedEarly = true;
        // Over for good: the camera is let go, as it is when the host ends it, and an End dialog
        // that was open goes with the webinar (it would open again on the next one otherwise).
        media.getTracks().forEach((track) => track.stop());
        setMedia(null);
        setConfirmEnd(false);
        setThenHome(false);
        setPhase({
          t: "ended",
          id: created.id,
          message: reason === "ended" ? "Your webinar has ended" : "Your webinar was stopped",
          seconds: started.at ? Math.round((Date.now() - started.at) / 1000) : null,
        });
      });
      await overlay.connect();
      // Ended or stopped while connecting: the ended state stands, and the camera is already let go.
      if (closedEarly) return;
      setPeer(overlay.status()?.path[0] ?? null);
      const video = media.getVideoTracks()[0];
      const audio = media.getAudioTracks()[0];
      await overlay.publish(audio ? { video, audio } : { video });
      if (closedEarly) return;
      started.at = Date.now();
      setSince(started.at);
      setPeak(0);
      setPhase({ t: "live", id: created.id });
    } catch (e) {
      await source.current?.close().catch(() => undefined);
      source.current = null;
      // A failure because it closed for good is already said by the ended state ("Start another").
      if (closedEarly) return;
      setError(e instanceof Error ? e.message : "Couldn’t go live.");
      setPhase({ t: "ready" });
    }
  }

  async function end() {
    if (phase.t !== "live") return;
    const liveId = phase.id;
    setConfirmEnd(false);
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
    setPhase({ t: "ended", id: liveId, message: "Your webinar has ended", seconds: since ? Math.round((Date.now() - since) / 1000) : null });
    if (thenHome) router.push("/");
  }

  // Following the logo while live would end the webinar without a word (leaving the page ends it),
  // so it asks first with the End dialog, as closing or reloading the tab asks. Opening the logo in
  // a new tab or window leaves this page alone, so that is not asked about (Link's onNavigate).
  function askBeforeLeaving(event: { preventDefault: () => void }) {
    if (phase.t !== "live") return;
    event.preventDefault();
    setThenHome(true);
    setConfirmEnd(true);
  }

  const name = signed?.title ?? cleanTitle(title);
  const before = phase.t === "asking" || phase.t === "no-media" || phase.t === "ready" || phase.t === "starting";
  const hasAudio = !!media && !noMicrophone;
  const micLabel = !hasAudio ? "No microphone" : micOn ? "Mute microphone" : "Unmute microphone";
  const camLabel = camOn ? "Turn off camera" : "Turn on camera";

  const switches = (
    <div className="flex gap-2">
      <Tip label={micLabel}>
        {/* Without a microphone the switch is shown, neutral and inert, so the row keeps its shape. */}
        <button
          className={CTRL}
          data-ctl={!hasAudio || micOn ? "on" : "off"}
          aria-label={micLabel}
          aria-disabled={!hasAudio || undefined}
          onClick={() => toggle("audio")}
          data-testid="host-mic"
        >
          {hasAudio && micOn ? <Mic className="size-5" aria-hidden="true" /> : <MicOff className="size-5" aria-hidden="true" />}
        </button>
      </Tip>
      <Tip label={camLabel}>
        <button className={CTRL} data-ctl={camOn ? "on" : "off"} aria-label={camLabel} disabled={!media} onClick={() => toggle("video")} data-testid="host-camera">
          {camOn ? <Video className="size-5" aria-hidden="true" /> : <VideoOff className="size-5" aria-hidden="true" />}
        </button>
      </Tip>
    </div>
  );

  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <LiveHeader onLeave={askBeforeLeaving} />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 pb-16 sm:px-8 lg:gap-6">
        {before ? (
          <WebinarHeading
            title="Start a serverless webinar"
            detail={
              <p className="max-w-[40rem] text-pretty text-muted">
                Your video goes browser to browser, from you to your viewers and on between them. It never passes through our servers. Up to {LIVE_VIEWER_CAP}{" "}
                viewers, with you the only one on camera.
              </p>
            }
          />
        ) : (
          <WebinarHeading title={name || "Your webinar"} />
        )}
        <div className="grid content-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-6">
          <div className="flex min-w-0 flex-col gap-5">
            {before && (
              <div className="flex flex-col gap-2">
                <label htmlFor={titleId} className="text-sm font-medium text-muted">
                  Title <span className="font-normal text-faint">(optional, shown to viewers)</span>
                </label>
                <input
                  id={titleId}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Product demo and Q&A"
                  maxLength={TITLE_MAX}
                  autoComplete="off"
                  disabled={phase.t === "starting"}
                  className="field"
                  data-testid="webinar-title-input"
                />
              </div>
            )}

            {phase.t === "ended" ? (
              <Card className="flex flex-col gap-4" data-testid="host-ended">
                <div className="flex flex-col gap-1.5">
                  <FocusedHeading>{phase.message}</FocusedHeading>
                  <p className="text-muted" role="status">
                    {phase.seconds !== null ? (
                      <>
                        It was live for <span className="font-semibold text-text">{durationWords(phase.seconds)}</span>, with at most{" "}
                        <span className="font-semibold text-text tabular-nums">{peak}</span> {peak === 1 ? "viewer" : "viewers"} watching at once.
                      </>
                    ) : (
                      "Viewers can no longer watch it."
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button className="btn btn-primary" onClick={() => void askForMedia()}>
                    <Radio className="size-[1.125rem]" strokeWidth={2.5} aria-hidden="true" />
                    Start another
                  </button>
                  <Link href="/" className="btn btn-secondary">
                    Back to home
                  </Link>
                </div>
              </Card>
            ) : (
              <div className="relative aspect-video overflow-hidden rounded-3xl bg-surface-2 ring-1 ring-border">
                {media ? (
                  <video ref={preview} className={`size-full -scale-x-100 object-cover ${camOn ? "" : "opacity-0"}`} autoPlay muted playsInline data-testid="host-preview" />
                ) : (
                  <div className="grid size-full place-items-center p-6 text-center text-sm text-muted">
                    {phase.t === "asking" ? (
                      <span className="inline-flex items-center gap-2" role="status">
                        <LoaderCircle className="anim-spin size-4" aria-hidden="true" /> Asking for your camera and microphone…
                      </span>
                    ) : phase.t === "no-media" ? (
                      <span className="flex max-w-sm flex-col items-center gap-3" role="alert">
                        <CircleAlert className="size-6 text-danger-text" aria-hidden="true" />
                        {phase.message}
                        <button className="btn btn-secondary h-10 rounded-xl px-4 text-sm" onClick={() => void askForMedia()}>
                          Try again
                        </button>
                      </span>
                    ) : null}
                  </div>
                )}
                {media && !camOn && (
                  <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted">
                    <span className="flex flex-col items-center gap-2">
                      <VideoOff className="size-6" aria-hidden="true" />
                      {onAir ? "Camera off. Viewers see a black picture." : "Camera off"}
                    </span>
                  </div>
                )}
                {onAir ? (
                  <LiveChip since={since} watching={watching} testId="host-viewers" />
                ) : (
                  media && <span className="chip absolute top-3 left-3 text-muted">Preview · only you see this</span>
                )}
                {media && hasAudio && !micOn && (
                  <span className="chip absolute bottom-3 left-3">
                    <MicOff className="size-3.5 text-danger-text" aria-hidden="true" />
                    Muted
                  </span>
                )}
              </div>
            )}

            {noMicrophone && media && phase.t !== "ended" && (
              <p className="-mt-2 text-sm text-muted" data-testid="no-microphone">
                No microphone found. Viewers will see you but not hear you.
              </p>
            )}

            {error && (
              <p className="flex items-start gap-2 text-sm text-danger-text" role="alert">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}

            {before && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                {switches}
                <button className="btn btn-primary" onClick={() => void goLive()} disabled={phase.t !== "ready"} data-testid="go-live">
                  {phase.t === "starting" ? <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" /> : <Radio className="size-[1.125rem]" strokeWidth={2.5} aria-hidden="true" />}
                  {phase.t === "starting" ? "Going live…" : "Go live"}
                </button>
              </div>
            )}

            {onAir && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3" role="group" aria-label="Host controls">
                  {switches}
                  <Dialog.Root
                    open={confirmEnd}
                    onOpenChange={(open) => {
                      setConfirmEnd(open);
                      if (!open) setThenHome(false);
                    }}
                  >
                    <Dialog.Trigger className="btn ctrl-danger" disabled={phase.t === "ending"} data-testid="end-live">
                      {phase.t === "ending" ? <LoaderCircle className="anim-spin size-4" aria-hidden="true" /> : <Square className="size-4 fill-current" aria-hidden="true" />}
                      {phase.t === "ending" ? "Ending…" : "End webinar"}
                    </Dialog.Trigger>
                    <Dialog.Portal>
                      <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
                      <Dialog.Content
                        className="dialog fixed top-1/2 left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 rounded-3xl bg-surface p-6 shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)]"
                        onOpenAutoFocus={(event) => {
                          // Cancel takes the focus, so a stray Enter does not end the webinar.
                          event.preventDefault();
                          (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-cancel]")?.focus();
                        }}
                      >
                        <div className="flex flex-col gap-2">
                          <Dialog.Title className="font-display text-xl font-semibold">End this webinar?</Dialog.Title>
                          <Dialog.Description className="text-sm leading-relaxed text-pretty text-muted">
                            {watching + connecting === 0
                              ? "The link stops working. To go live again, you start a new webinar with a new link."
                              : `It stops for ${everyone(watching + connecting)}, and the link stops working. To go live again, you start a new webinar with a new link.`}
                          </Dialog.Description>
                        </div>
                        <div className="flex flex-wrap justify-end gap-3">
                          <Dialog.Close className="btn btn-secondary" data-cancel>
                            Cancel
                          </Dialog.Close>
                          <button className="btn ctrl-danger" onClick={() => void end()} data-testid="end-live-confirm">
                            {thenHome ? "End and leave" : "End for everyone"}
                          </button>
                        </div>
                      </Dialog.Content>
                    </Dialog.Portal>
                  </Dialog.Root>
                </div>

                <Card className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium">Invite viewers</h2>
                  <button
                    type="button"
                    onClick={copyLink.copy}
                    // The full link, key and all, is in the page only for tests (meetly:debug):
                    // otherwise only the copy holds it, out of reach of whatever reads the DOM.
                    data-link={debug ? shareUrl : undefined}
                    className="btn btn-secondary h-12 w-full justify-between rounded-xl bg-surface-2 px-3.5 text-sm"
                    data-testid="share-link"
                  >
                    {/* Shown without its key, which is copied with it: the page may be on a shared screen. */}
                    <span className="min-w-0 truncate font-mono font-medium">{withoutKey(shareUrl).replace(/^https?:\/\//, "")}</span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-accent" role="status">
                      <CopyIcon copied={copyLink.copied} />
                      {copyLink.copied ? "Copied" : "Copy link"}
                    </span>
                  </button>
                  <p className="text-sm text-muted">
                    The link you copy ends with the video’s key. Anyone with the full link can watch, up to {tree?.cap ?? LIVE_VIEWER_CAP} at once.
                  </p>
                </Card>

                <ServerlessNote />
              </>
            )}
          </div>

          <div className="min-w-0">
            {onAir ? (
              <WhoIsConnected tree={tree} ownKey={ownKey} />
            ) : (
              <Card className="flex flex-col gap-4">
                <h2 className="font-display text-lg font-semibold tracking-tight">How it works</h2>
                <HowItWorks />
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
