"use client";

import { useIsSpeaking } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { Hand, Link2, Mic, MicOff, Search, VideoOff, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { HAND, displayName, useMediaState } from "@/lib/participant";
import { HostMenu, useHost } from "./HostTools";
import { useBox } from "./Stage";
import { Avatar } from "./ui/Avatar";

const ROW = 56;
const HEADER = 40;
const OVERSCAN = 6;

type Item =
  | { kind: "header"; key: string; label: string; count: number; top: number }
  | { kind: "row"; key: string; participant: Participant; hand: boolean; top: number };

export function PeoplePanel({
  participants,
  code,
  onCopyLink,
}: {
  participants: Participant[];
  code: string;
  onCopyLink: () => void;
}) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [boxRef, box] = useBox<HTMLDivElement>();

  // Raised hands first, then you, then everyone else A–Z. Speaking never reorders the list.
  const { items, height, matches } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byName = (a: Participant, b: Participant) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return displayName(a).localeCompare(displayName(b));
    };
    const found = needle
      ? participants.filter((p) => displayName(p).toLowerCase().includes(needle))
      : participants;
    const hands = found.filter((p) => p.attributes[HAND] === "1").sort(byName);
    const rest = found.filter((p) => p.attributes[HAND] !== "1").sort(byName);
    const list: Item[] = [];
    let top = 0;
    const section = (label: string, people: Participant[], hand: boolean) => {
      if (people.length === 0) return;
      list.push({ kind: "header", key: `h:${label}`, label, count: people.length, top });
      top += HEADER;
      for (const participant of people) {
        list.push({ kind: "row", key: participant.identity, participant, hand, top });
        top += ROW;
      }
    };
    section("Raised hands", hands, true);
    section(needle ? "Matches" : "In this call", rest, false);
    return { items: list, height: top, matches: found.length };
  }, [participants, query]);

  // Windowing: only rows near the viewport exist in the DOM, so 100+ people stay cheap.
  const from = scrollTop - OVERSCAN * ROW;
  const to = scrollTop + box.h + OVERSCAN * ROW;
  const visible = items.filter((item) => item.top + ROW >= from && item.top <= to);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3 pb-2">
        <button
          data-autofocus
          onClick={onCopyLink}
          className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl bg-surface-2 p-3 text-left transition-colors hover:bg-surface-3"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink">
            <Link2 className="size-5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Copy invite link</span>
            <span className="block truncate font-mono text-xs text-muted">{code}</span>
          </span>
        </button>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setScrollTop(0);
            }}
            placeholder="Search people"
            aria-label="Search people"
            autoComplete="off"
            spellCheck={false}
            className="field h-11 rounded-xl px-10 text-sm"
          />
          {query && (
            <button
              className="icon-btn absolute top-1/2 right-1 size-9 -translate-y-1/2"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="sr-only" role="status">
          {query ? `${matches} ${matches === 1 ? "person matches" : "people match"}` : ""}
        </p>
      </div>

      <div
        ref={boxRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto"
        tabIndex={0}
        role="list"
        aria-label="Participants"
      >
        {matches === 0 ? (
          <p className="px-6 pt-10 text-center text-sm leading-relaxed text-muted">
            Nobody here is called “{query.trim()}”.
          </p>
        ) : (
          <div style={{ height }} className="relative">
            {visible.map((item) =>
              item.kind === "header" ? (
                <h3
                  key={item.key}
                  className="eyebrow absolute inset-x-0 flex items-end gap-2 px-5 pb-1.5"
                  style={{ top: item.top, height: HEADER }}
                >
                  {item.label}
                  <span className="tracking-normal tabular-nums">{item.count}</span>
                </h3>
              ) : (
                <div
                  key={item.key}
                  role="listitem"
                  className="absolute inset-x-2"
                  style={{ top: item.top, height: ROW }}
                >
                  <PersonRow participant={item.participant} hand={item.hand} />
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Subscribes to its own participant, so one person talking re-renders one row. */
const PersonRow = memo(function PersonRow({
  participant,
  hand,
}: {
  participant: Participant;
  hand: boolean;
}) {
  const { hostId, isHost } = useHost();
  const name = displayName(participant);
  const speaking = useIsSpeaking(participant);
  const { micOn, camOn } = useMediaState(participant);
  return (
    <div className="group/row flex h-full items-center gap-3 rounded-xl px-3 hover:bg-surface-2/60">
      <Avatar name={name} seed={participant.identity} speaking={speaking && micOn} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-medium">{name}</span>
        {(participant.isLocal || hostId === participant.identity) && (
          <span className="block text-xs text-muted">
            {[participant.isLocal && "You", hostId === participant.identity && "Host"].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {hand && (
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-ink">
            <Hand className="size-4" aria-hidden="true" />
            <span className="sr-only">Hand raised</span>
          </span>
        )}
        {!camOn && (
          <span className="grid size-8 place-items-center text-faint">
            <VideoOff className="size-[1.125rem]" aria-hidden="true" />
            <span className="sr-only">Camera off</span>
          </span>
        )}
        <span className={`grid size-8 place-items-center ${micOn ? "text-muted" : "text-danger-text"}`}>
          {micOn ? (
            speaking ? (
              <span className="bars text-accent" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <Mic className="size-[1.125rem]" aria-hidden="true" />
            )
          ) : (
            <MicOff className="size-[1.125rem]" aria-hidden="true" />
          )}
          <span className="sr-only">{micOn ? "Microphone on" : "Muted"}</span>
        </span>
        {/* The host's menu trails the row; your own row keeps the column so the icons line up. */}
        <HostMenu participant={participant} micOn={micOn} variant="row" />
        {isHost && participant.isLocal && <span className="size-8 pointer-coarse:size-11" aria-hidden="true" />}
      </span>
    </div>
  );
});
