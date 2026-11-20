"use client";

import { Hand, Smile } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePresence } from "@/lib/hooks";
import { REACTION_SHOW_MS, reactions, type LaneEntry } from "@/lib/reactions";
import { useCall, useConnectionStatus } from "@/lib/rtc/react";
import { REACTIONS, displayName } from "@/lib/rtc/types";
import { Dropdown } from "./ui/Menu";
import { Tip } from "./ui/Tip";

const NAMES: Record<(typeof REACTIONS)[number], string> = {
  "👍": "Thumbs up",
  "❤️": "Heart",
  "😂": "Laughing",
  "😮": "Surprised",
  "👏": "Clapping",
  "🎉": "Celebrate",
};

/**
 * Feeds the reaction store from the call, and speaks for it to screen readers. Mount once inside
 * the call. A reaction whose sender has a tile in view shows on that tile; any other rises in
 * the lane (see src/lib/reactions.ts).
 */
export function ReactionFeed() {
  const call = useCall();
  useEffect(() => {
    const stop = call.on("reaction", (participant, emoji) => {
      const onTile =
        document.querySelector(`[data-tile][data-key="${CSS.escape(`${participant.identity}:camera`)}"]`) !== null;
      const name = participant.isLocal ? "You" : displayName(participant).split(/\s+/)[0];
      reactions.add(participant.identity, name, emoji, onTile);
    });
    return () => {
      stop();
      reactions.clear();
    };
  }, [call]);
  const announcement = useSyncExternalStore(reactions.subscribeAnnouncement, reactions.announcement, () => "");
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {announcement}
    </p>
  );
}

/** Reactions from people whose tile is not in view, bottom-left of the stage. Toasts live bottom-right. */
export function ReactionLane() {
  const lane = useSyncExternalStore(reactions.subscribeLane, reactions.lane, reactions.lane);
  if (lane.length === 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-30 flex flex-col items-start gap-1.5" aria-hidden="true" data-reaction-lane>
      {lane.map((entry) => (
        <LaneItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function LaneItem({ entry }: { entry: LaneEntry }) {
  const [leaving, setLeaving] = useState(false);
  // A merged entry stays for as long as people keep adding to it.
  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), REACTION_SHOW_MS);
    return () => clearTimeout(timer);
  }, [entry.count]);
  useEffect(() => {
    if (!leaving) return;
    // Safety net for an animation that never reports back (hidden tab).
    const timer = setTimeout(() => reactions.drop(entry.id), 500);
    return () => clearTimeout(timer);
  }, [leaving, entry.id]);
  return (
    <span
      data-leaving={leaving}
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) reactions.drop(entry.id);
      }}
      className="anim-pop chip h-9 gap-2 pr-3 pl-2 text-sm shadow-lg"
    >
      <span className="text-xl leading-none">{entry.emoji}</span>
      <span className="max-w-28 truncate font-medium">{entry.count > 1 ? `×${entry.count}` : entry.name}</span>
    </span>
  );
}

/** The emoji a person just sent, on their tile, above the name label. */
export function TileReactionBadge({ identity }: { identity: string }) {
  const subscribe = useMemo(() => reactions.subscribeTile(identity), [identity]);
  const current = useSyncExternalStore(
    subscribe,
    () => reactions.tile(identity),
    () => undefined,
  );
  const presence = usePresence(!!current);
  const [kept, setKept] = useState(current);
  if (current && current !== kept) setKept(current);
  const shown = current ?? kept;
  if (!presence.mounted || !shown) return null;
  return (
    <span
      // A new reaction from the same person pops again.
      key={shown.id}
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      data-tile-reaction={shown.emoji}
      aria-hidden="true"
      className="anim-pop pointer-events-none absolute bottom-11 left-2 z-30 grid size-11 origin-bottom-left place-items-center rounded-2xl bg-[rgb(11_11_15/0.72)] text-2xl leading-none shadow-lg backdrop-blur-md"
    >
      {shown.emoji}
    </span>
  );
}

/**
 * The React button and its strip of six. The strip stays open for repeat taps; while it is open
 * 1 to 6 send. On a phone the bar has no room for a hand button as well, so the strip carries it.
 */
export function ReactMenu({
  phone,
  open,
  onOpenChange,
  handRaised,
  onToggleHand,
}: {
  phone: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  handRaised: boolean;
  onToggleHand: () => void;
}) {
  const call = useCall();
  const connected = useConnectionStatus() === "connected";
  // A failed send is dropped: a reaction that arrives late is worse than one that does not.
  const send = (emoji: string) => void call.sendReaction(emoji).catch(() => {});
  const label = phone ? (handRaised ? "Reactions, hand raised" : "Reactions and raise hand") : "React";
  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Tip label="React" shortcut={phone ? undefined : "R"} hoverOnly>
        <Dropdown.Trigger className="ctrl" aria-label={label} disabled={!connected} data-ctl={phone && handRaised ? "active" : "on"}>
          {phone && handRaised ? <Hand className="size-5" /> : <Smile className="size-5" />}
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content
          side="top"
          align="center"
          sideOffset={10}
          collisionPadding={12}
          data-reactions
          className="menu flex min-w-0 flex-col gap-1.5 p-1.5"
          onKeyDown={(event) => {
            const index = Number(event.key) - 1;
            if (Number.isInteger(index) && REACTIONS[index]) {
              event.preventDefault();
              send(REACTIONS[index]);
            }
          }}
        >
          <div className="flex gap-1">
            {REACTIONS.map((emoji, index) => (
              <Dropdown.Item
                key={emoji}
                aria-label={NAMES[emoji]}
                aria-keyshortcuts={String(index + 1)}
                // Stay open: reactions come in runs.
                onSelect={(event) => {
                  event.preventDefault();
                  send(emoji);
                }}
                className="menu-item size-11 min-h-0 justify-center p-0 text-2xl leading-none active:scale-(--scale-press)"
              >
                <span aria-hidden="true">{emoji}</span>
              </Dropdown.Item>
            ))}
          </div>
          {phone && (
            <Dropdown.Item className="menu-item justify-center bg-surface-3 font-medium" onSelect={onToggleHand}>
              <Hand className="size-4" aria-hidden="true" />
              {handRaised ? "Lower hand" : "Raise hand"}
            </Dropdown.Item>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
