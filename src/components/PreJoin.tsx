"use client";

import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Crown,
  Link2,
  LoaderCircle,
  Lock,
  Mic,
  MicOff,
  RotateCw,
  Sparkles,
  Video,
  VideoOff,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { blurUnavailable } from "@/lib/effects/blur";
import { useBackgroundPreview, useEffectSettings } from "@/lib/effects/settings";
import { fullCount } from "@/lib/counts";
import { copyText } from "@/lib/hooks";
import type { JoinAccess, JoinChoices } from "@/lib/rtc/types";
import {
  useDeviceList,
  usePreviewMedia,
  useSavedChoices,
  useTrackVolume,
  type MediaProblem,
  type MediaSlot,
} from "@/lib/usePreviewMedia";
import { Avatar } from "./ui/Avatar";
import { Logo } from "./ui/Logo";
import { DeviceRadioGroup, Dropdown, deviceLabel } from "./ui/Menu";
import { Tip } from "./ui/Tip";
import { useToast } from "./ui/Toaster";

/** With more than this many people already in the meeting, you join with the microphone off. */
const MUTE_JOINERS_ABOVE = 5;

export function PreJoin({
  code,
  joining,
  waiting = false,
  access = "open",
  isHost = false,
  peopleHere = null,
  error,
  onJoin,
  onCancel,
  noun = "meeting",
}: {
  code: string;
  joining: boolean;
  /** Asked to join; nobody has answered yet. */
  waiting?: boolean;
  /** Who may join, as far as is known before asking. */
  access?: JoinAccess;
  /** This browser holds the meeting's host key. */
  isHost?: boolean;
  /** How many people are in the meeting now, or null where the provider can't say. */
  peopleHere?: number | null;
  error: string | null;
  onJoin: (choices: JoinChoices) => void;
  /** Stop asking to join. */
  onCancel?: () => void;
  /** What the call is called: a webinar's host joins here too. */
  noun?: "meeting" | "webinar";
}) {
  const [saved, save] = useSavedChoices();
  const [effects, saveEffects] = useEffectSettings();
  const { audio, video, setEnabled, setDevice, retry } = usePreviewMedia({ ...saved, noiseSuppression: effects.noiseSuppression });
  const [name, setName] = useState(saved.username);
  const [nameError, setNameError] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const nameErrorId = useId();
  const toast = useToast();

  const microphones = useDeviceList("audioinput", audio.track);
  const cameras = useDeviceList("videoinput", video.track);

  // Background blur, chosen here or in an earlier call. Where the browser cannot do it the
  // control is simply not offered. The preview runs the same code the call will.
  const canBlur = useMemo(() => blurUnavailable() === null, []);
  const background = canBlur ? effects.background : "none";
  const preview = useBackgroundPreview(video.enabled ? video.track : undefined, background);

  // Walking into a meeting that is already under way with the microphone on puts your room into
  // theirs. With more than five people there, the microphone starts off and the screen says why.
  // The person's own choice wins: once they touch the microphone here, it is theirs. This is the
  // pre-join screen only; nobody is ever muted after they have connected. Where the provider
  // can't say how many are there (null), nothing changes.
  const [micChosen, setMicChosen] = useState(false);
  const crowd = peopleHere !== null && peopleHere > MUTE_JOINERS_ABOVE ? peopleHere : null;
  const joinMuted = crowd !== null && !micChosen;
  const audioOn = audio.enabled;
  useEffect(() => {
    // Not while joining: by then the choice has been handed to the call.
    if (joinMuted && audioOn && !joining && !waiting) setEnabled("audio", false);
  }, [joinMuted, audioOn, joining, waiting, setEnabled]);

  function toggle(kind: "audio" | "video") {
    const next = !(kind === "audio" ? audio.enabled : video.enabled);
    if (kind === "audio") setMicChosen(true);
    setEnabled(kind, next);
    save(kind === "audio" ? { audioEnabled: next } : { videoEnabled: next });
  }

  function chooseDevice(kind: "audio" | "video", deviceId: string) {
    setDevice(kind, deviceId);
    save(kind === "audio" ? { audioDeviceId: deviceId } : { videoDeviceId: deviceId });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const username = name.trim();
    if (!username) {
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    save({ username });
    onJoin({
      username,
      audioEnabled: audio.enabled && !!audio.track,
      videoEnabled: video.enabled && !!video.track,
      audioDeviceId: audio.deviceId,
      videoDeviceId: video.deviceId,
      noiseSuppression: effects.noiseSuppression,
      background,
    });
  }

  async function copyLink() {
    if (!(await copyText(`${window.location.origin}/${code}`))) {
      toast.push({ title: "Couldn't copy the link", tone: "danger", icon: <CircleAlert className="size-5" /> });
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const micOn = audio.enabled && !!audio.track;
  const camOn = video.enabled && !!video.track;
  const blocked = audio.problem === "denied" || video.problem === "denied";
  // The host walks straight in whatever the meeting is set to.
  const mustAsk = access === "ask" && !isHost;
  const locked = access === "locked" && !isHost;

  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl px-5 py-5 sm:px-8">
        <Logo />
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 content-center items-center gap-x-14 gap-y-8 px-5 pt-2 pb-12 sm:px-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:pb-24">
        <section aria-label="Camera and microphone preview" className="anim-rise flex min-w-0 flex-col gap-3">
          <Preview
            name={name.trim()}
            audio={audio}
            video={video}
            shown={preview.track}
            blur={canBlur ? { on: background !== "none", state: preview.state } : null}
            onToggleBlur={() => saveEffects({ background: background === "none" ? "blur" : "none" })}
            onToggle={toggle}
            onRetry={retry}
          />
          <div className="grid grid-cols-2 gap-2">
            <DevicePicker
              label="Microphone"
              icon={<Mic className="size-4 shrink-0" aria-hidden="true" />}
              devices={microphones}
              activeId={audio.deviceId}
              onSelect={(id) => chooseDevice("audio", id)}
              emptyText={audio.problem === "denied" ? "Microphone blocked" : "No microphone"}
            />
            <DevicePicker
              label="Camera"
              icon={<Video className="size-4 shrink-0" aria-hidden="true" />}
              devices={cameras}
              activeId={video.deviceId}
              onSelect={(id) => chooseDevice("video", id)}
              emptyText={video.problem === "denied" ? "Camera blocked" : "No camera"}
            />
          </div>
        </section>

        <section className="anim-rise flex min-w-0 flex-col gap-7 [animation-delay:80ms]">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm tracking-tight text-muted">{code}</span>
              <button
                type="button"
                onClick={copyLink}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[0.8125rem] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                {copied ? (
                  <Check className="size-3.5 text-accent" aria-hidden="true" />
                ) : (
                  <Link2 className="size-3.5" aria-hidden="true" />
                )}
                <span aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
              </button>
            </div>
            <h1 className="font-display text-4xl leading-[1.05] font-semibold tracking-[-0.02em] sm:text-5xl">
              {waiting ? "Asking to join…" : "Ready to join?"}
            </h1>
            {isHost && !waiting && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Crown className="size-4 shrink-0 text-accent" aria-hidden="true" />
                You&apos;re the host when you join from this browser.
              </p>
            )}
          </div>

          {waiting ? (
            <div className="anim-fade flex flex-col gap-4">
              <p role="status" className="flex items-center gap-3.5 rounded-2xl bg-surface-2 p-4 shadow-[inset_0_0_0_1px_var(--border)]">
                <LoaderCircle className="anim-spin size-5 shrink-0 text-accent" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block font-medium">Someone in the {noun} will let you in</span>
                  <span className="block text-sm break-words text-muted">You&apos;ll join as {name.trim() || "Guest"} as soon as they do.</span>
                </span>
              </p>
              <button type="button" className="btn btn-secondary h-13 text-base" onClick={onCancel}>
                Cancel
              </button>
            </div>
          ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
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
                placeholder={`Shown to everyone in the ${noun}`}
                autoComplete="name"
                maxLength={40}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? nameErrorId : undefined}
                className="field"
              />
              {nameError && (
                <p id={nameErrorId} role="alert" className="anim-fade text-sm text-danger-text">
                  Add your name so people know who joined.
                </p>
              )}
            </div>

            {locked && !error && (
              <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-sm text-muted">
                <Lock className="mt-px size-4 shrink-0" aria-hidden="true" />
                This {noun} is locked. Nobody new can join until the host unlocks it.
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
                  {mustAsk ? "Ask to join" : "Join now"}
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

          <p className="text-sm leading-relaxed text-faint" aria-live="polite">
            {blocked
              ? "You can still join and listen. Allow access any time to be seen and heard."
              : crowd !== null && joinMuted && !micOn
                ? `You'll join muted. ${fullCount(crowd)} people are here.`
                : `You'll join with your camera ${camOn ? "on" : "off"}${camOn && background !== "none" ? " (background blurred)" : ""} and microphone ${micOn ? "on" : "off"}.`}
            {mustAsk && !waiting && ` Someone in the ${noun} has to let you in.`}
          </p>
        </section>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ preview */

const PROBLEM_COPY: Record<MediaProblem, (what: string) => { title: string; body: string }> = {
  denied: (what) => ({
    title: `${what} blocked`,
    body: "Allow access from the site settings in your browser's address bar, then try again.",
  }),
  missing: (what) => ({
    title: `No ${what.toLowerCase().replace(" and ", " or ")} found`,
    body: "Plug one in and try again, or join without it.",
  }),
  busy: (what) => ({
    title: `${what} unavailable`,
    body: "Another app may be using it. Close that app and try again.",
  }),
  unknown: (what) => ({
    title: `Couldn't start your ${what.toLowerCase()}`,
    body: "Check that it's connected and try again.",
  }),
};

export function Preview({
  name,
  audio,
  video,
  shown,
  blur,
  onToggleBlur,
  onToggle,
  onRetry,
}: {
  name: string;
  audio: MediaSlot;
  video: MediaSlot;
  /** What the preview shows: the camera, or the camera with its background blurred. */
  shown: MediaStreamTrack | undefined;
  /** Background blur, where this browser can do it. */
  blur: { on: boolean; state: "off" | "starting" | "on" | "failed" } | null;
  onToggleBlur: () => void;
  onToggle: (kind: "audio" | "video") => void;
  onRetry: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const track = video.track;

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !shown) return;
    element.srcObject = new MediaStream([shown]);
    element.play().catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [shown]);

  const micOn = audio.enabled && !!audio.track;
  const camOn = video.enabled && !!track;

  const both = video.problem && video.problem === audio.problem;
  const videoIssue = video.enabled && video.problem
    ? PROBLEM_COPY[video.problem](both ? "Camera and microphone" : "Camera")
    : null;
  const audioIssue = !both && audio.enabled && audio.problem ? PROBLEM_COPY[audio.problem]("Microphone") : null;

  return (
    <div className="relative isolate aspect-[4/3] overflow-hidden rounded-[1.75rem] bg-surface shadow-[inset_0_0_0_1px_var(--border)] sm:aspect-video">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`absolute inset-0 size-full -scale-x-100 object-cover transition-opacity duration-(--dur-base) ${camOn ? "opacity-100" : "opacity-0"}`}
      />

      {!camOn && (
        <div className="anim-fade absolute inset-0 grid place-items-center px-6 pt-4 pb-20 text-center">
          {video.pending ? (
            <div className="flex flex-col items-center gap-3 text-muted">
              <LoaderCircle className="anim-spin size-7" aria-hidden="true" />
              <p className="text-sm">Starting your camera…</p>
            </div>
          ) : videoIssue ? (
            <div className="flex max-w-sm flex-col items-center gap-3" role="alert">
              <span className="grid size-12 place-items-center rounded-2xl bg-danger/15 text-danger-text">
                <VideoOff className="size-6" aria-hidden="true" />
              </span>
              <div>
                <p className="font-display text-xl font-semibold">{videoIssue.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{videoIssue.body}</p>
              </div>
              <button type="button" className="btn btn-secondary h-10 rounded-xl px-4 text-sm" onClick={onRetry}>
                <RotateCw className="size-4" aria-hidden="true" />
                Try again
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              {name ? (
                <Avatar name={name} className="size-24 text-4xl sm:size-28" />
              ) : (
                <span className="grid size-24 place-items-center rounded-full bg-surface-2 text-faint sm:size-28">
                  <VideoOff className="size-9" aria-hidden="true" />
                </span>
              )}
              <p className="text-sm text-muted">Your camera is off</p>
            </div>
          )}
        </div>
      )}

      {/* Scrim keeps the controls legible over any video. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-linear-to-t from-black/55 to-transparent" />

      <div className="absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2">
        <span className="chip">
          {micOn ? <MicMeter track={audio.track} /> : <MicOff className="size-3.5 text-danger-text" aria-hidden="true" />}
          <span className="truncate">{name || "You"}</span>
        </span>
        {audioIssue && (
          <span className="chip h-auto items-start py-1.5 text-warn" role="alert">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{audioIssue.title}</span>
            <button type="button" className="cursor-pointer rounded font-semibold text-text underline underline-offset-2" onClick={onRetry}>
              Try again
            </button>
          </span>
        )}
        {camOn && blur?.on && blur.state !== "on" && (
          <span className={`chip anim-fade ${blur.state === "failed" ? "text-warn" : ""}`} role="status" data-blur-status={blur.state}>
            {blur.state === "failed" ? (
              <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <LoaderCircle className="anim-spin size-3.5 shrink-0" aria-hidden="true" />
            )}
            {blur.state === "failed" ? "Blur couldn't start" : "Starting blur…"}
          </span>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-4 flex justify-center gap-3">
        <PreviewToggle
          on={micOn}
          pending={audio.pending}
          label={micOn ? "Mute microphone" : "Unmute microphone"}
          onClick={() => onToggle("audio")}
          iconOn={<Mic className="size-[1.375rem]" aria-hidden="true" />}
          iconOff={<MicOff className="size-[1.375rem]" aria-hidden="true" />}
        />
        <PreviewToggle
          on={camOn}
          pending={video.pending}
          label={camOn ? "Turn off camera" : "Turn on camera"}
          onClick={() => onToggle("video")}
          iconOn={<Video className="size-[1.375rem]" aria-hidden="true" />}
          iconOff={<VideoOff className="size-[1.375rem]" aria-hidden="true" />}
        />
        {blur && (
          <Tip label={blur.on ? "Stop blurring your background" : "Blur your background"}>
            <button
              type="button"
              aria-label="Blur background"
              aria-pressed={blur.on}
              onClick={onToggleBlur}
              className={`grid size-14 cursor-pointer place-items-center rounded-[1.25rem] backdrop-blur-md transition-[background-color,transform] duration-(--dur-fast) active:scale-(--scale-press) ${
                blur.on ? "bg-accent text-accent-ink hover:bg-(--accent-hover)" : "bg-white/16 text-white hover:bg-white/26"
              }`}
            >
              <Sparkles className="size-[1.375rem]" aria-hidden="true" />
            </button>
          </Tip>
        )}
      </div>
    </div>
  );
}

function PreviewToggle({
  on,
  pending,
  label,
  onClick,
  iconOn,
  iconOff,
}: {
  on: boolean;
  pending: boolean;
  label: string;
  onClick: () => void;
  iconOn: React.ReactNode;
  iconOff: React.ReactNode;
}) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={pending || undefined}
        onClick={pending ? undefined : onClick}
        className={`grid size-14 cursor-pointer place-items-center rounded-[1.25rem] backdrop-blur-md transition-[background-color,transform] duration-(--dur-fast) active:scale-(--scale-press) ${
          on ? "bg-white/16 text-white hover:bg-white/26" : "bg-danger text-white hover:bg-(--danger-hover)"
        }`}
      >
        {pending ? <LoaderCircle className="anim-spin size-[1.375rem]" aria-hidden="true" /> : on ? iconOn : iconOff}
      </button>
    </Tip>
  );
}

/** Three bars that follow the live microphone level. */
function MicMeter({ track }: { track?: MediaStreamTrack }) {
  const volume = useTrackVolume(track);
  const level = Math.min(1, volume * 2.2);
  return (
    <span className="flex h-3 items-center gap-0.5 text-accent" aria-hidden="true">
      {[0.6, 1, 0.6].map((weight, i) => (
        <i
          key={i}
          className="h-full w-[2.5px] rounded-full bg-current transition-transform duration-(--dur-instant)"
          style={{ transform: `scaleY(${Math.max(0.25, level * weight)})` }}
        />
      ))}
    </span>
  );
}

function DevicePicker({
  label,
  icon,
  devices,
  activeId,
  onSelect,
  emptyText,
}: {
  label: string;
  icon: React.ReactNode;
  devices: MediaDeviceInfo[];
  activeId: string;
  onSelect: (deviceId: string) => void;
  emptyText: string;
}) {
  const active = devices.find((d) => d.deviceId === activeId) ?? devices[0];
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        disabled={devices.length === 0}
        aria-label={`${label}: ${active ? deviceLabel(active) : emptyText}`}
        className="group flex h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent data-[state=open]:bg-surface-2 data-[state=open]:text-text"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{active ? deviceLabel(active) : emptyText}</span>
        <ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="start" sideOffset={6} collisionPadding={12} className="menu">
          <DeviceRadioGroup
            label={label}
            devices={devices}
            activeId={activeId}
            onSelect={onSelect}
            emptyText={emptyText}
          />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Layout-matched placeholder shown while the page streams in and before hydration. */
export function PreJoinSkeleton() {
  return (
    <div className="backdrop-glow flex flex-1 flex-col" aria-busy="true" aria-label="Loading meeting">
      <header className="mx-auto flex w-full max-w-6xl px-5 py-5 sm:px-8">
        <Logo />
      </header>
      <div className="mx-auto grid w-full max-w-6xl flex-1 content-center items-center gap-x-14 gap-y-8 px-5 pt-2 pb-12 sm:px-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:pb-24">
        <div className="flex flex-col gap-3">
          <div className="anim-shimmer aspect-[4/3] rounded-[1.75rem] bg-surface sm:aspect-video" />
          <div className="h-11" />
        </div>
        <div className="flex flex-col gap-4">
          <div className="anim-shimmer h-5 w-40 rounded-lg bg-surface" />
          <div className="anim-shimmer h-12 w-72 max-w-full rounded-xl bg-surface" />
          <div className="anim-shimmer mt-6 h-12 rounded-2xl bg-surface" />
          <div className="anim-shimmer h-13 rounded-2xl bg-surface" />
        </div>
      </div>
    </div>
  );
}
