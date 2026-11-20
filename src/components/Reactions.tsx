"use client";

import { Hand, Smile } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useIsPhone, usePresence } from "@/lib/hooks";
import { LANE_LIMIT, PHONE_LANE_LIMIT, REACTION_SHOW_MS, reactions, type LaneEntry } from "@/lib/reactions";
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
  const limit = useIsPhone() ? PHONE_LANE_LIMIT : LANE_LIMIT;
  useEffect(() => {
    // The size of the meeting is read as each reaction arrives (the roster is cached by the
    // adapter), not followed through every join and leave.
    const rules = () => reactions.setRules({ limit, people: call.participants().length });
    rules();
    const stop = call.on("reaction", (participant, emoji) => {
      const onTile =
        document.querySelector(`[data-tile][data-key="${CSS.escape(`${participant.identity}:camera`)}"]`) !== null;
      const name = participant.isLocal ? "You" : displayName(participant).split(/\s+/)[0];
      rules();
      reactions.add(participant.identity, name, emoji, onTile);
    });
    return stop;
  }, [call, limit]);
  useEffect(() => () => reactions.clear(), [call]);
  const announcement = useSyncExternalStore(reactions.subscribeAnnouncement, reactions.announcement, () => "");
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {announcement}
    </p>
  );
}

/**
 * Reactions from people whose tile is not in view, bottom-left of the stage. Notifications live
 * bottom-right. The lane starts 3.25rem above the bottom of the bottom-left tile, clear of its name
 * label (see `laneAnchor`), and
 * grows upward: rows are in the DOM oldest first and drawn bottom-up, so a new row appears on
 * top and nothing already on screen moves. When a row leaves, the rows above it glide down into
 * its place instead of jumping.
 */
export function ReactionLane() {
  const lane = useSyncExternalStore(reactions.subscribeLane, reactions.lane, reactions.lane);
  const box = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  const tops = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    if (box.current) {
      const anchor = laneAnchor(box.current);
      box.current.style.bottom = `${anchor.bottom}px`;
      box.current.style.left = `${anchor.left}px`;
      reactions.setRoom(anchor.rows);
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<number, number>();
    rows.current.forEach((row, id) => {
      const top = row.getBoundingClientRect().top;
      next.set(id, top);
      const before = tops.current.get(id);
      if (still || before === undefined || before === top) return;
      // `translate`, not `transform`: the pop-in animation owns transform, and the two would fight.
      row.style.transition = "none";
      row.style.translate = `0 ${before - top}px`;
      row.getBoundingClientRect();
      row.style.transition = "translate var(--dur-base) var(--ease-move)";
      row.style.translate = "";
    });
    tops.current = next;
  }, [lane]);
  if (lane.length === 0) return null;
  return (
    <div
      ref={box}
      className="pointer-events-none absolute bottom-[3.25rem] left-3 z-30 flex flex-col-reverse items-start gap-1.5"
      aria-hidden="true"
      data-reaction-lane
    >
      {lane.map((entry) => (
        <LaneItem
          key={entry.id}
          entry={entry}
          rowRef={(row) => {
            if (row) rows.current.set(entry.id, row);
            else rows.current.delete(entry.id);
          }}
        />
      ))}
    </div>
  );
}

/** 3.25rem: the name label (0.5rem in, up to 1.75rem tall) and a clear rem above it. */
const ABOVE_LABEL = 52;
/** How far the name label sits in from the tile's edge (0.5rem). */
const LABEL_INSET = 8;
/** A lane row (h-9) and the gap between rows (gap-1.5). */
const ROW = 36;
const ROW_GAP = 6;

/**
 * Where the lane goes: 3.25rem above the bottom of the stage's bottom-left tile, in line with
 * that tile's name label, and how many rows fit before it would reach the tile above. That tile
 * does not always reach the stage's edge: a phone's filmstrip runs along the bottom, and a paged
 * gallery has its page bar there. Filmstrip tiles and the self view are never covered, so they
 * don't count. The tile's place is read from where the stage put it (its `translate` and size),
 * not from the screen, so a tile still gliding into place is measured where it will end up.
 */
function laneAnchor(lane: HTMLElement): { bottom: number; left: number; rows: number } {
  const stage = lane.parentElement;
  if (!stage) return { bottom: ABOVE_LABEL, left: LABEL_INSET + 4, rows: Infinity };
  let lowest: { bottom: number; left: number; height: number } | null = null;
  for (const tile of stage.querySelectorAll<HTMLElement>('[data-tile][data-slot="main"], [data-tile][data-slot="grid"]')) {
    const at = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(tile.style.transform);
    const height = parseFloat(tile.style.height);
    if (!at || Number.isNaN(height)) continue;
    const place = { bottom: Number(at[2]) + height, left: Number(at[1]), height };
    if (!lowest || place.bottom > lowest.bottom + 1 || (Math.abs(place.bottom - lowest.bottom) <= 1 && place.left < lowest.left)) lowest = place;
  }
  if (!lowest) return { bottom: ABOVE_LABEL, left: LABEL_INSET + 4, rows: Infinity };
  return {
    bottom: Math.max(0, stage.clientHeight - lowest.bottom) + ABOVE_LABEL,
    // In line with the name label beneath it.
    left: lowest.left + LABEL_INSET,
    // The rows that fit between the label and the top edge of the tile, so the lane never reaches the
    // name label of the tile above.
    rows: Math.floor((lowest.height - ABOVE_LABEL + ROW_GAP) / (ROW + ROW_GAP)),
  };
}

function LaneItem({ entry, rowRef }: { entry: LaneEntry; rowRef: (row: HTMLElement | null) => void }) {
  const [leaving, setLeaving] = useState(false);
  // A row stays for as long as people keep adding to it, even one that had started to leave.
  const [count, setCount] = useState(entry.count);
  if (entry.count !== count) {
    setCount(entry.count);
    setLeaving(false);
  }
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
      ref={rowRef}
      data-leaving={leaving}
      data-lane-row={entry.emoji}
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) reactions.drop(entry.id);
      }}
      className="anim-pop chip h-9 shrink-0 gap-2 pr-3 pl-2 text-sm shadow-lg"
    >
      <span className="text-xl leading-none">{entry.emoji}</span>
      {/* A row shared by several people, or any row in a meeting too big for names, is a count. */}
      <span className="max-w-28 truncate font-medium tabular-nums">{entry.name || `×${entry.count}`}</span>
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
