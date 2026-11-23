"use client";

import { ArrowRight, CircleAlert, LoaderCircle, Lock, RotateCw, Users, VideoOff } from "lucide-react";
import { useId, useRef, useState } from "react";
import { WEBINAR_FULL_MESSAGE } from "@/lib/rtc/stage";
import type { JoinAccess, JoinChoices } from "@/lib/rtc/types";
import { useSavedChoices } from "@/lib/usePreviewMedia";
import { Fact, Facts } from "./ui/Fact";
import { Logo } from "./ui/Logo";

/**
 * Joining a webinar's audience: a name and "Watch". Nothing here touches the camera or the
 * microphone, so the browser asks for neither; the audience has none until the host invites
 * someone to speak, and the device check happens then (see StageInvite.tsx).
 */
export function ViewerPreJoin({
  code,
  joining,
  waiting = false,
  access = "open",
  error,
  onJoin,
  onCancel,
}: {
  code: string;
  joining: boolean;
  /** Asked to join; nobody has answered yet. */
  waiting?: boolean;
  access?: JoinAccess;
  error: string | null;
  onJoin: (choices: JoinChoices) => void;
  onCancel?: () => void;
}) {
  const [saved, save] = useSavedChoices();
  const [name, setName] = useState(saved.username);
  const [nameError, setNameError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const hintId = useId();
  const nameErrorId = useId();
  const full = error === WEBINAR_FULL_MESSAGE;
  const mustAsk = access === "ask";

  function watch(event?: React.FormEvent) {
    event?.preventDefault();
    const username = name.trim();
    if (!username) {
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    save({ username });
    // The device ids are left as they were saved: the audience opens no device at all.
    onJoin({ username, audioEnabled: false, videoEnabled: false, audioDeviceId: saved.audioDeviceId, videoDeviceId: saved.videoDeviceId });
  }

  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl px-5 py-5 sm:px-8">
        <Logo />
      </header>
      <main className="anim-rise mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-7 px-5 pt-2 pb-24">
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-sm text-muted">
            <span className="chip h-7 gap-1.5 px-2.5 text-xs font-semibold">
              <Users className="size-3.5" aria-hidden="true" />
              Webinar
            </span>
            <span className="font-mono tracking-tight">{code}</span>
          </p>
          <h1 className="font-display text-4xl leading-[1.05] font-semibold tracking-[-0.02em] sm:text-5xl">
            {waiting ? "Asking to join…" : full ? "This webinar is full" : "Ready to watch?"}
          </h1>
          {full ? (
            <p className="leading-relaxed text-muted">Try again in a few minutes.</p>
          ) : (
            <Facts className="text-muted">
              <Fact
                icon={<VideoOff />}
                label="Camera and mic off"
                detail="You'll see and hear the people on stage. Your camera and microphone stay off unless the host invites you to speak."
              />
            </Facts>
          )}
        </div>

        {waiting ? (
          <div className="anim-fade flex flex-col gap-4">
            <p role="status" className="flex items-center gap-3.5 rounded-2xl bg-surface-2 p-4 shadow-[inset_0_0_0_1px_var(--border)]">
              <LoaderCircle className="anim-spin size-5 shrink-0 text-accent" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block font-medium">Waiting to be let in</span>
                <span className="block text-sm break-words text-muted">You&apos;ll join as {name.trim() || "Guest"} once you&apos;re let in.</span>
              </span>
            </p>
            <button type="button" className="btn btn-secondary h-13 text-base" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : full ? (
          // Not an error: there is nothing wrong to fix, only a moment to wait.
          <div className="anim-fade flex flex-col gap-4" role="status">
            <button type="button" className="btn btn-primary h-13 text-base" onClick={() => watch()} disabled={joining}>
              {joining ? <LoaderCircle className="anim-spin size-5" aria-hidden="true" /> : <RotateCw className="size-[1.125rem]" aria-hidden="true" />}
              Try again
            </button>
          </div>
        ) : (
          <form onSubmit={watch} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <label htmlFor={nameId} className="text-sm font-medium text-muted">
                Your name
              </label>
              <input
                ref={nameRef}
                id={nameId}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(false);
                }}
                autoComplete="name"
                maxLength={40}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? `${nameErrorId} ${hintId}` : hintId}
                className="field"
              />
              <p id={hintId} className="text-sm text-faint">
                Only hosts see your name.
              </p>
              {nameError && (
                <p id={nameErrorId} role="alert" className="anim-fade text-sm text-danger-text">
                  Add your name.
                </p>
              )}
            </div>

            {access === "locked" && !error && (
              <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-sm text-muted">
                <Lock className="mt-px size-4 shrink-0" aria-hidden="true" />
                This webinar is locked.
              </p>
            )}

            <button type="submit" className="btn btn-primary h-13 text-base" disabled={joining}>
              {joining ? (
                <>
                  <LoaderCircle className="anim-spin size-5" aria-hidden="true" />
                  {mustAsk ? "Asking…" : "Joining…"}
                </>
              ) : (
                <>
                  {mustAsk ? "Ask to watch" : "Watch"}
                  <ArrowRight className="size-[1.125rem]" strokeWidth={2.5} aria-hidden="true" />
                </>
              )}
            </button>

            {error && (
              <p role="alert" className="anim-fade flex items-start gap-2 rounded-xl bg-danger/12 px-3.5 py-3 text-sm text-danger-text">
                <CircleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}
          </form>
        )}
      </main>
    </div>
  );
}
