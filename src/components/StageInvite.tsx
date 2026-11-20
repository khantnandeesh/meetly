"use client";

import { CircleAlert, Mic, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCall } from "@/lib/rtc/react";
import { usePreviewMedia, useSavedChoices } from "@/lib/usePreviewMedia";
import { useOnStage, useStageInvite } from "@/lib/useWebinar";
import { Preview } from "./PreJoin";
import { useToast } from "./ui/Toaster";

/**
 * Being invited to speak in a webinar, from the audience's side. The invitation asks first:
 * nothing of yours is sent until you say yes. "Join stage…" opens a check of your microphone and
 * camera (the first time anything here asks the browser for them), and "Join stage" there puts
 * you on stage with what you chose. "Not now" turns the invitation down; the host can ask again.
 */
export function StageInvite() {
  const call = useCall();
  const toast = useToast();
  const invited = useStageInvite();
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  // A withdrawn invitation takes the check with it.
  if (!invited && checking) setChecking(false);
  if (!invited) return null;

  const answer = async (yes: boolean, media?: { microphone: boolean; camera: boolean }) => {
    setBusy(true);
    setChecking(false);
    try {
      await call.moderate({ action: "stage", identity: call.local.identity, on: yes });
      if (!media) return;
      // The hand asked to speak; on stage it has been answered.
      if (call.local.handRaised) await call.setHandRaised(false).catch(() => {});
      // On stage: the microphone and camera come on as they were in the check, one at a time,
      // so a camera that will not start leaves the microphone working.
      if (media.microphone) await call.setEnabled("microphone", true).catch(() => fail("Couldn't start your microphone"));
      if (media.camera) await call.setEnabled("camera", true).catch(() => fail("Couldn't start your camera"));
    } catch (error) {
      fail(yes ? "Couldn't join the stage" : "Couldn't answer the invitation", error);
    } finally {
      setBusy(false);
    }
  };
  function fail(title: string, error?: unknown) {
    toast.push({
      tone: "danger",
      priority: "you",
      icon: <CircleAlert className="size-5" />,
      title,
      body: error instanceof Error ? error.message : "Check your browser's permissions for this site and try again.",
    });
  }

  return (
    <section
      aria-label="Invitation to speak"
      className="anim-pop pointer-events-auto w-[min(26rem,calc(100vw-2.5rem))] rounded-2xl bg-[rgb(20_20_26/0.94)] p-4 shadow-[inset_0_0_0_1px_var(--border-strong),0_20px_50px_-15px_rgb(0_0_0/0.8)] backdrop-blur-md"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink">
          <Mic className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold" role="status">
            The host invited you to speak
          </h2>
          <p className="mt-0.5 text-sm leading-relaxed text-muted">
            {checking ? "Check your microphone and camera. Everyone will see and hear you." : "Everyone watching will see and hear you."}
          </p>
        </div>
      </div>
      {checking ? (
        <DeviceCheck busy={busy} onNotNow={() => void answer(false)} onJoin={(media) => void answer(true, media)} />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="btn btn-secondary h-11 rounded-xl text-sm" disabled={busy} onClick={() => void answer(false)}>
            Not now
          </button>
          <button className="btn btn-primary h-11 rounded-xl text-sm" disabled={busy} onClick={() => setChecking(true)} autoFocus>
            Join stage…
          </button>
        </div>
      )}
    </section>
  );
}

/** The device check: the same preview as the pre-join screen, without the parts a stage does not need. */
function DeviceCheck({
  busy,
  onNotNow,
  onJoin,
}: {
  busy: boolean;
  onNotNow: () => void;
  onJoin: (media: { microphone: boolean; camera: boolean }) => void;
}) {
  const [saved] = useSavedChoices();
  const { audio, video, setEnabled, retry } = usePreviewMedia({ ...saved, audioEnabled: true, videoEnabled: true });
  const joinRef = useRef<HTMLButtonElement>(null);
  useEffect(() => joinRef.current?.focus(), []);
  return (
    <div className="mt-4 flex flex-col gap-3">
      <Preview
        name={saved.username}
        audio={audio}
        video={video}
        shown={video.enabled ? video.track : undefined}
        blur={null}
        onToggleBlur={() => {}}
        onToggle={(kind) => setEnabled(kind, !(kind === "audio" ? audio.enabled : video.enabled))}
        onRetry={retry}
      />
      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-secondary h-11 rounded-xl text-sm" disabled={busy} onClick={onNotNow}>
          Not now
        </button>
        <button
          ref={joinRef}
          className="btn btn-primary h-11 rounded-xl text-sm"
          disabled={busy}
          onClick={() => onJoin({ microphone: audio.enabled && !!audio.track, camera: video.enabled && !!video.track })}
        >
          Join stage
        </button>
      </div>
    </div>
  );
}

/**
 * On stage, from the speaker's side: a way back to the audience that is always in view. The host
 * never sees it (the host stays on stage); in a meeting nobody does.
 */
export function OnStageBar() {
  const call = useCall();
  const toast = useToast();
  const onStage = useOnStage();
  const [busy, setBusy] = useState(false);
  if (!onStage) return null;
  const leave = () => {
    setBusy(true);
    call
      .moderate({ action: "stage", identity: call.local.identity, on: false })
      .catch((error) =>
        toast.push({
          tone: "danger",
          priority: "you",
          icon: <CircleAlert className="size-5" />,
          title: "Couldn't go back to the audience",
          body: error instanceof Error ? error.message : undefined,
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div
      data-on-stage
      className="anim-pop fixed top-[calc(max(0.5rem,env(safe-area-inset-top))+3.25rem)] left-3 z-40 flex items-center gap-1 rounded-full bg-[rgb(20_20_26/0.92)] py-1 pr-1 pl-3.5 text-sm shadow-[inset_0_0_0_1px_var(--border-strong)] backdrop-blur-md md:top-6 md:left-6"
    >
      <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
      <span className="font-medium">You&apos;re on stage</span>
      <button className="ml-1 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 font-semibold text-accent transition-colors hover:bg-surface-3 disabled:opacity-50" disabled={busy} onClick={leave}>
        <Undo2 className="size-4" aria-hidden="true" />
        Back to audience
      </button>
    </div>
  );
}
