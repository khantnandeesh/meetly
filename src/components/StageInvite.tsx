"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, CircleAlert, LoaderCircle, Undo2, UserX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCall, useConnectionStatus } from "@/lib/rtc/react";
import { usePreviewMedia, useSavedChoices } from "@/lib/usePreviewMedia";
import { useOnStage, useStageInvite } from "@/lib/useWebinar";
import { Preview } from "./PreJoin";
import { Dropdown } from "./ui/Menu";
import { useToast } from "./ui/Toaster";

/**
 * Being invited to speak in a webinar, from the audience's side: one centred dialog, the same
 * on a desktop and a phone. This is consent to be seen and heard by everyone watching, so it is
 * modal, hard to mis-tap and impossible to miss. Your camera preview, with its microphone and
 * camera switches, is in it from the first frame: what you choose here is what goes on stage.
 *
 * Focus starts on "Not now", never on "Join stage", and Esc means "Not now". While the
 * connection is down the dialog says so and "Join stage" waits; the invitation is not lost. If
 * the host withdraws it, the dialog closes and you are told.
 */
export function StageInvite() {
  const call = useCall();
  const toast = useToast();
  const invited = useStageInvite();
  const [busy, setBusy] = useState(false);
  // Set while you are answering, so the invitation going away is not taken for the host's doing.
  const answering = useRef(false);
  const wasInvited = useRef(invited);
  useEffect(() => {
    // A new invitation starts unanswered, however soon after the last one it comes.
    if (invited && !wasInvited.current) answering.current = false;
    if (wasInvited.current && !invited && !answering.current) {
      toast.push({ tag: "stage-invite", priority: "you", icon: <UserX className="size-5" />, title: "The host withdrew the invitation" });
    }
    wasInvited.current = invited;
  }, [invited, toast]);

  const fail = (title: string, error?: unknown) =>
    toast.push({
      tone: "danger",
      priority: "you",
      icon: <CircleAlert className="size-5" />,
      title,
      body: error instanceof Error ? error.message : "Check your browser's permissions for this site and try again.",
    });

  const answer = async (yes: boolean, media?: { microphone: boolean; camera: boolean }) => {
    if (answering.current) return;
    answering.current = true;
    setBusy(true);
    try {
      await call.moderate({ action: "stage", identity: call.local.identity, on: yes });
      if (!media) return;
      // The hand asked to speak; on stage it has been answered.
      if (call.local.handRaised) await call.setHandRaised(false).catch(() => {});
      // One at a time, so a camera that will not start leaves the microphone working.
      if (media.microphone) await call.setEnabled("microphone", true).catch(() => fail("Couldn't start your microphone"));
      if (media.camera) await call.setEnabled("camera", true).catch(() => fail("Couldn't start your camera"));
    } catch (error) {
      // Not answered after all: it can be tried again, and the host may still withdraw it.
      answering.current = false;
      fail(yes ? "Couldn't join the stage" : "Couldn't answer the invitation", error);
    } finally {
      // `answering` stays set: the invitation going away now is your answer, not the host's.
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={invited}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
        {invited && <InviteDialog busy={busy} onAnswer={answer} />}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InviteDialog({
  busy,
  onAnswer,
}: {
  busy: boolean;
  onAnswer: (yes: boolean, media?: { microphone: boolean; camera: boolean }) => void;
}) {
  const [saved] = useSavedChoices();
  const { audio, video, setEnabled, retry } = usePreviewMedia({ ...saved, audioEnabled: true, videoEnabled: true });
  const reconnecting = useConnectionStatus() === "reconnecting";
  const notNow = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Content
      aria-describedby="stage-invite-about"
      data-stage-invite
      className="dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-3xl bg-surface p-5 shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)] sm:p-6"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        notNow.current?.focus();
      }}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        if (!busy) onAnswer(false);
      }}
      // A decision about yourself is not made by clicking past it.
      onPointerDownOutside={(event) => event.preventDefault()}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <div className="flex flex-col gap-1.5">
        <Dialog.Title className="font-display text-xl font-semibold">The host invited you to speak</Dialog.Title>
        <Dialog.Description id="stage-invite-about" className="text-[0.9375rem] leading-relaxed text-muted">
          Everyone watching will see and hear you.
        </Dialog.Description>
      </div>
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
      {reconnecting && (
        <p role="status" className="flex items-center gap-2 text-sm text-warn" data-invite-reconnecting>
          <LoaderCircle className="anim-spin size-4 shrink-0" aria-hidden="true" />
          Reconnecting…
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button ref={notNow} className="btn btn-secondary h-12 rounded-xl" disabled={busy} onClick={() => onAnswer(false)}>
          Not now
        </button>
        <button
          className="btn btn-primary h-12 rounded-xl"
          disabled={busy || reconnecting}
          onClick={() => onAnswer(true, { microphone: audio.enabled && !!audio.track, camera: video.enabled && !!video.track })}
        >
          {busy ? <LoaderCircle className="anim-spin size-5" aria-hidden="true" /> : null}
          Join stage
        </button>
      </div>
    </Dialog.Content>
  );
}

/**
 * Webinars: made co-host (or no longer one), the call reconnects you with what the role needs
 * (see `RtcCall.switching`). A second or two, said rather than shown as a dropped call.
 */
export function Switching() {
  const call = useCall();
  const subscribe = useCallback((onChange: () => void) => call.on("status", onChange), [call]);
  const switching = useSyncExternalStore(subscribe, () => call.switching, () => null);
  if (!switching) return null;
  return (
    <div className="anim-fade fixed inset-0 z-60 grid place-items-center bg-black/60" data-switching={switching}>
      <p role="status" className="chip h-12 gap-3 px-5 text-[0.9375rem] font-medium shadow-lg">
        <LoaderCircle className="anim-spin size-5 text-accent" aria-hidden="true" />
        {switching === "cohost" ? "Switching to co-host…" : "Switching to the audience…"}
      </p>
    </div>
  );
}

/**
 * On a webinar's stage, from the speaker's side: "● Live · On stage", which is also where the way
 * back is, one tap behind it so nobody drops off stage by accident. On a desktop it sits in the
 * control bar's left cluster, in the clock's place; on a phone, in the top bar. The host never
 * sees it (the host stays on stage); in a meeting nobody does.
 */
export function OnStageChip({ compact = false }: { compact?: boolean }) {
  const call = useCall();
  const toast = useToast();
  const onStage = useOnStage();
  if (!onStage) return null;
  const leave = () =>
    void call.moderate({ action: "stage", identity: call.local.identity, on: false }).catch((error) =>
      toast.push({
        tone: "danger",
        priority: "you",
        icon: <CircleAlert className="size-5" />,
        title: "Couldn't go back to the audience",
        body: error instanceof Error ? error.message : undefined,
      }),
    );
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        data-on-stage
        aria-label="Live, on stage. Stage options"
        className={`group inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl font-medium text-text transition-colors hover:bg-surface-2 ${compact ? "h-11 bg-surface-2 px-3 text-sm active:bg-surface-3" : "-ml-2 h-10 px-2 text-sm"}`}
      >
        <span className="size-2 rounded-full bg-danger" aria-hidden="true" />
        <span className="font-semibold">Live</span>
        <span className="text-muted" aria-hidden="true">
          ·
        </span>
        <span>On stage</span>
        <ChevronDown className="size-4 text-muted transition-transform group-aria-expanded:rotate-180" aria-hidden="true" />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content side={compact ? "bottom" : "top"} align="start" sideOffset={8} collisionPadding={12} className="menu w-72">
          <Dropdown.Item className="menu-item" onSelect={leave}>
            <Undo2 className="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block font-medium">Back to audience</span>
              <span className="block text-xs text-muted">Your camera and microphone turn off.</span>
            </span>
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
