"use client";

import { Crown, Hand, MicOff, MonitorUp, PictureInPicture2, Pin, PinOff, SignalLow, Sparkles } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { Rect } from "@/lib/motion";
import { useLocalEffects, useParticipantState, useVideoTrack } from "@/lib/rtc/react";
import type { RtcTile, RtcVideoTrack } from "@/lib/rtc/types";
import { HostMenu, useHost } from "./HostTools";
import { useMini } from "./MiniWindow";
import { TileReactionBadge } from "./Reactions";
import { avatarColor, initials } from "./ui/Avatar";
import { Tip } from "./ui/Tip";

type TileProps = {
  trackRef: RtcTile;
  pinned?: boolean;
  /** Must be referentially stable; tiles are memoised so large grids don't re-render on every event. */
  onTogglePin?: (ref: RtcTile) => void;
  className?: string;
  /** On the stage: where the tile sits. Applied as a transform, so moving a tile never costs layout. */
  rect?: Rect;
  slot?: "main" | "strip" | "grid";
  children?: React.ReactNode;
};

export const Tile = memo(TileView, (a, b) =>
  a.trackRef.participant === b.trackRef.participant &&
  a.trackRef.source === b.trackRef.source &&
  a.trackRef.track === b.trackRef.track &&
  a.pinned === b.pinned &&
  a.onTogglePin === b.onTogglePin &&
  a.className === b.className &&
  a.children === b.children &&
  a.slot === b.slot &&
  // A tile that only moved or changed size is not re-rendered: the stage writes its new place
  // straight onto the element (see placeTiles in Stage.tsx). Re-rendering every tile on every
  // reflow was the largest single cost of answering a click. Only "placed or not" matters here.
  !a.rect === !b.rect,
);

function TileView({ trackRef, pinned = false, onTogglePin, className = "", rect, slot, children }: TileProps) {
  const { participant, source } = trackRef;
  const { name: rawName, speaking, micOn, camOn, handRaised, weakConnection: weak } = useParticipantState(participant);
  const name = rawName || "Guest";

  // Touch has no hover: a tap on the tile reveals its actions for a few seconds.
  const [revealed, setRevealed] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function reveal(event: React.PointerEvent) {
    if (event.pointerType === "mouse") return;
    clearTimeout(hideTimer.current);
    setRevealed(true);
    hideTimer.current = setTimeout(() => setRevealed(false), 3500);
  }

  const { hostId, canModerate } = useHost();
  // The main picture is what the mini window would show, so that is where it is offered.
  const mini = useMini();
  const showMini = slot === "main" && mini.supported;
  const isScreen = source === "screen_share";
  const isLocal = participant.isLocal;
  const showVideo = isScreen || camOn;
  const color = avatarColor(participant.identity);
  const who = isLocal ? "You" : name;
  const label = isScreen
    ? isLocal
      ? "Your screen"
      : `${name}'s screen`
    : [isLocal ? `${name} (you)` : name, !micOn && "muted", handRaised && "hand raised", speaking && "speaking"]
        .filter(Boolean)
        .join(", ");

  return (
    <div
      role="group"
      aria-label={label}
      data-tile
      data-key={`${participant.identity}:${source}`}
      data-slot={slot}
      data-placed={rect ? "" : undefined}
      data-source={source}
      data-speaking={!isScreen && speaking && micOn}
      data-mirror={isLocal && !isScreen}
      data-pinned={pinned}
      data-revealed={revealed}
      onPointerUp={reveal}
      className={`tile ${isScreen ? "bg-black" : ""} ${className}`}
      style={rect ? { width: rect.w, height: rect.h, transform: `translate(${rect.x}px, ${rect.y}px)` } : undefined}
    >
      {/* Picture layer. While the tile glides between sizes it is counter-scaled, so nothing in it stretches. */}
      <div className="tile-media absolute inset-0">
      {/* The avatar stays underneath the video, so a stream that is still starting never shows black. */}
      {!isScreen && (
        <div
          className="absolute inset-0 grid place-items-center"
          style={{
            background: `radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, ${color} 18%, var(--surface-2)), var(--surface) 75%)`,
          }}
        >
          <span
            aria-hidden="true"
            className="avatar-disc"
            style={
              {
                "--c": color,
                width: "clamp(2.5rem, 32cqmin, 8.5rem)",
                fontSize: "clamp(1rem, 13cqmin, 3.5rem)",
              } as React.CSSProperties
            }
          >
            {initials(name)}
          </span>
        </div>
      )}
      {trackRef.track && showVideo && <FadeInVideo track={trackRef.track} />}
      {/* After the video in the document (so a plain sibling selector can hide it), behind it on screen. */}
      {isScreen && (
        <p className="share-wait absolute inset-0 -z-1 flex flex-col items-center justify-center gap-3 px-6 text-center text-muted">
          <MonitorUp className="size-8 text-accent" aria-hidden="true" />
          <span>{isLocal ? "Starting your screen share…" : `${name} is starting to share…`}</span>
        </p>
      )}
      </div>

      {(onTogglePin || showMini || (canModerate && !isLocal && !isScreen)) && (
        <div className="tile-actions absolute top-2 right-2 z-30 flex origin-top-right gap-1.5">
          {!isScreen && <HostMenu participant={participant} micOn={micOn} camOn={camOn} handRaised={handRaised} variant="tile" />}
          {showMini && (
            <Tip label="Open mini window" shortcut="⇧P" side="bottom">
              <button
                aria-label="Open mini window"
                onClick={mini.toggle}
                className="grid size-10 cursor-pointer place-items-center rounded-xl bg-[rgb(11_11_15/0.72)] text-text backdrop-blur-md transition-colors hover:bg-[rgb(40_40_52/0.9)] pointer-coarse:size-11"
              >
                <PictureInPicture2 className="size-[1.125rem]" />
              </button>
            </Tip>
          )}
          {onTogglePin && (
          <Tip label={pinned ? "Unpin" : "Pin to main view"} side="bottom">
            <button
              aria-label={pinned ? `Unpin ${isScreen ? label : who}` : `Pin ${isScreen ? label : who}`}
              aria-pressed={pinned}
              onClick={() => onTogglePin(trackRef)}
              className={`grid size-10 cursor-pointer place-items-center rounded-xl backdrop-blur-md pointer-coarse:size-11 transition-colors ${
                pinned ? "bg-accent text-accent-ink" : "bg-[rgb(11_11_15/0.72)] text-text hover:bg-[rgb(40_40_52/0.9)]"
              }`}
            >
              {pinned ? <PinOff className="size-[1.125rem]" /> : <Pin className="size-[1.125rem]" />}
            </button>
          </Tip>
          )}
        </div>
      )}

      {children}

      {!isScreen && <TileReactionBadge identity={participant.identity} />}
      <div className="tile-meta absolute bottom-2 left-2 z-30 flex max-w-[calc(100%-1rem)] origin-bottom-left items-center gap-1.5">
        {handRaised && !isScreen && (
          <span className="anim-pop grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-accent-ink" aria-hidden="true">
            <Hand className="size-4" />
          </span>
        )}
        <span className="chip min-w-0" aria-hidden="true">
          {isScreen ? (
            <MonitorUp className="size-3.5 shrink-0 text-accent" />
          ) : !micOn ? (
            <MicOff className="size-3.5 shrink-0 text-danger-text" />
          ) : speaking ? (
            <span className="bars shrink-0 text-accent">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          <span className="truncate">{isScreen ? (isLocal ? "Your screen" : `${name}'s screen`) : isLocal ? `${name} (You)` : name}</span>
          {!isScreen && hostId === participant.identity && <Crown className="size-3.5 shrink-0 text-accent" />}
          {isLocal && !isScreen && camOn && <BlurBadge />}
          {weak && <SignalLow className="size-3.5 shrink-0 text-warn" />}
        </span>
      </div>
    </div>
  );
}

/** On your own tile: what others see of you has its background blurred. */
function BlurBadge() {
  const { backgroundState } = useLocalEffects();
  if (backgroundState !== "on") return null;
  return <Sparkles className="size-3.5 shrink-0 text-accent" data-blur-badge />;
}

/**
 * Video that stays transparent until it has a frame to show, then fades in over the avatar
 * underneath. Without this a tile cuts from avatar to picture whenever a stream starts or resumes.
 * The flag is set straight on the element: a page of sixteen videos becoming ready should not
 * mean sixteen React renders.
 */
function FadeInVideo({ track }: { track: RtcVideoTrack }) {
  const ref = useRef<HTMLVideoElement>(null);
  useVideoTrack(track, ref);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const show = () => video.setAttribute("data-ready", "true");
    if (video.readyState >= 2 && video.videoWidth > 0) show();
    const events = ["loadeddata", "playing", "resize"] as const;
    events.forEach((name) => video.addEventListener(name, show));
    // Belt and braces: never leave a playing video hidden because an event was missed.
    const timer = setTimeout(show, 2500);
    return () => {
      events.forEach((name) => video.removeEventListener(name, show));
      clearTimeout(timer);
    };
  }, []);
  return <video ref={ref} autoPlay playsInline muted />;
}
