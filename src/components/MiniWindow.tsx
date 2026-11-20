"use client";

import { Mic, MicOff, MonitorUp, PhoneOff, PictureInPicture2, Undo2, Video, VideoOff } from "lucide-react";
import { createContext, useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { noteOwnCameraToggle } from "@/lib/ownToggles";
import { useCall, useLocalToggle, useParticipantState, useVideoTrack } from "@/lib/rtc/react";
import type { RtcTile, RtcVideoTrack } from "@/lib/rtc/types";
import { noteOwnMicToggle } from "@/lib/useSounds";
import { useVideoDemand } from "@/lib/videoDemand";
import { avatarColor, initials } from "./ui/Avatar";

/** What the rest of the call needs to know about the mini window: whether to offer it, and how. */
export type MiniControl = { supported: boolean; open: boolean; toggle: () => void };
const MiniContext = createContext<MiniControl>({ supported: false, open: false, toggle: () => {} });
export const MiniProvider = MiniContext.Provider;
export const useMini = () => useContext(MiniContext);

/** The call, small: one picture, and the three controls nobody should have to go looking for. */
export function MiniWindow({ target, tile, onBack }: { target: Window; tile: RtcTile | undefined; onBack: () => void }) {
  return createPortal(<MiniView tile={tile} onBack={onBack} />, target.document.body);
}

function MiniView({ tile, onBack }: { tile: RtcTile | undefined; onBack: () => void }) {
  const call = useCall();
  const mic = useLocalToggle("microphone");
  const cam = useLocalToggle("camera");
  // While the call is in here, this picture is the only one being looked at.
  useVideoDemand(call, tile ? [tile] : []);
  const micLabel = mic.enabled ? "Mute microphone" : "Unmute microphone";
  const camLabel = cam.enabled ? "Turn off camera" : "Turn on camera";
  return (
    <div data-mini-window className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-surface shadow-[inset_0_0_0_1px_var(--border)]">
        {tile ? <MiniTile key={`${tile.participant.identity}:${tile.source}`} tile={tile} /> : <p className="grid h-full place-items-center text-sm text-muted">Nobody else is here yet</p>}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2" role="toolbar" aria-label="Meeting controls">
        <button
          className="ctrl"
          data-ctl={mic.enabled ? "on" : "off"}
          aria-label={micLabel}
          title={micLabel}
          onClick={() => {
            noteOwnMicToggle();
            mic.toggle();
          }}
        >
          {mic.enabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
        </button>
        <button
          className="ctrl"
          data-ctl={cam.enabled ? "on" : "off"}
          aria-label={camLabel}
          title={camLabel}
          onClick={() => {
            noteOwnCameraToggle();
            cam.toggle();
          }}
        >
          {cam.enabled ? <Video className="size-5" /> : <VideoOff className="size-5" />}
        </button>
        <button className="ctrl" aria-label="Close mini window" title="Close mini window" onClick={onBack}>
          <Undo2 className="size-5" />
        </button>
        <button className="ctrl ctrl-danger ml-1 w-14" aria-label="Leave meeting" title="Leave meeting" onClick={() => call.disconnect().catch(() => {})}>
          <PhoneOff className="size-5" />
        </button>
      </div>
    </div>
  );
}

function MiniTile({ tile }: { tile: RtcTile }) {
  const { participant, source, track } = tile;
  const { name: rawName, micOn, camOn, speaking } = useParticipantState(participant);
  const name = rawName || "Guest";
  const isScreen = source === "screen_share";
  const color = avatarColor(participant.identity);
  return (
    <div
      data-mini-showing={`${participant.identity}:${source}`}
      data-speaking={!isScreen && speaking && micOn}
      role="group"
      aria-label={isScreen ? `${name}'s screen` : name}
      className="absolute inset-0"
    >
      <div
        className="absolute inset-0 grid place-items-center"
        style={{ background: `radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, ${color} 18%, var(--surface-2)), var(--surface) 75%)` }}
      >
        <span aria-hidden="true" className="avatar-disc w-20 text-3xl" style={{ "--c": color } as React.CSSProperties}>
          {initials(name)}
        </span>
      </div>
      {track && (isScreen || camOn) && <MiniVideo track={track} contain={isScreen} mirror={participant.isLocal && !isScreen} />}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)]">
        <span className="chip min-w-0">
          {isScreen ? (
            <MonitorUp className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
          ) : !micOn ? (
            <MicOff className="size-3.5 shrink-0 text-danger-text" aria-label="Muted" />
          ) : speaking ? (
            <span className="bars shrink-0 text-accent" aria-label="Speaking">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          <span className="truncate">{isScreen ? `${name}'s screen` : participant.isLocal ? `${name} (You)` : name}</span>
        </span>
      </div>
    </div>
  );
}

function MiniVideo({ track, contain, mirror }: { track: RtcVideoTrack; contain: boolean; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useVideoTrack(track, ref);
  // The window is a different document: nothing there starts a video by itself.
  useEffect(() => {
    ref.current?.play().catch(() => {});
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`absolute inset-0 size-full ${contain ? "bg-black object-contain" : "object-cover"}`}
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}

/** What the stage shows while the call is in the mini window. */
export function MiniPlaceholder({
  onBack,
  onShare,
  onShareChange,
}: {
  onBack: () => void;
  /** Open the mini window whenever you start presenting. */
  onShare: boolean;
  onShareChange: (on: boolean) => void;
}) {
  return (
    <div
      data-mini-placeholder
      className="anim-fade absolute inset-0 grid place-items-center overflow-y-auto rounded-[1.25rem] bg-surface p-6 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-surface-2 text-accent">
          <PictureInPicture2 className="size-6" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-2xl font-semibold">The meeting is in a mini window</h2>
          <p className="leading-relaxed text-muted">It stays on top of your other windows. You&apos;re still in the meeting.</p>
        </div>
        <button className="btn btn-primary" onClick={onBack} autoFocus>
          <Undo2 className="size-[1.125rem]" aria-hidden="true" />
          Close mini window
        </button>
        <label className="flex cursor-pointer items-center gap-3 text-left text-sm text-muted">
          <input type="checkbox" role="switch" checked={onShare} onChange={(event) => onShareChange(event.target.checked)} className="peer sr-only" />
          <span
            aria-hidden="true"
            className="switch peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
            data-on={onShare}
          />
          Open it when I share my screen
        </label>
      </div>
    </div>
  );
}
