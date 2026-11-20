"use client";

import { Check, ChevronDown, DoorOpen, Ellipsis, Hand, Link2, Lock, Mic, MicOff, PhoneOff, Search, VideoOff, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { handQueue } from "@/lib/handQueue";
import { useParticipantState } from "@/lib/rtc/react";
import { displayName, type RtcParticipant } from "@/lib/rtc/types";
import { ACCESS_LABELS, HostMenu, useHost } from "./HostTools";
import { Dropdown } from "./ui/Menu";
import type { JoinAccess } from "@/lib/rtc/types";
import { useCopied } from "@/lib/hooks";
import { useBox } from "./Stage";
import { CopyIcon } from "./ui/CopyIcon";
import { Avatar } from "./ui/Avatar";

const ROW = 56;
const HEADER = 40;
const OVERSCAN = 6;

type Item =
  | { kind: "header"; key: string; label: string; count: number; top: number }
  | { kind: "row"; key: string; participant: RtcParticipant; hand: boolean; top: number };

export function PeoplePanel({
  participants,
  code,
  onCopyLink,
}: {
  participants: RtcParticipant[];
  code: string;
  onCopyLink: () => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const copyState = useCopied(onCopyLink);
  const [scrollTop, setScrollTop] = useState(0);
  const [boxRef, box] = useBox<HTMLDivElement>();

  // Raised hands first, in the order they went up, then you, then everyone else A–Z. Speaking
  // never reorders the list.
  const { items, height, matches } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byName = (a: RtcParticipant, b: RtcParticipant) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return displayName(a).localeCompare(displayName(b));
    };
    const found = needle
      ? participants.filter((p) => displayName(p).toLowerCase().includes(needle))
      : participants;
    const shown = new Set(found);
    const hands = handQueue(participants).filter((p) => shown.has(p));
    const rest = found.filter((p) => !p.handRaised).sort(byName);
    const list: Item[] = [];
    let top = 0;
    const section = (label: string, people: RtcParticipant[], hand: boolean) => {
      if (people.length === 0) return;
      list.push({ kind: "header", key: `h:${label}`, label, count: people.length, top });
      top += HEADER;
      for (const participant of people) {
        list.push({ kind: "row", key: participant.identity, participant, hand, top });
        top += ROW;
      }
    };
    section("Raised hands", hands, true);
    section(needle ? "Matches" : "In this meeting", rest, false);
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
          onClick={copyState.copy}
          className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl bg-surface-2 p-3 text-left transition-colors hover:bg-surface-3"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink">
            <CopyIcon copied={copyState.copied} className="size-5 !text-accent-ink" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold" role="status">
              {copyState.copied ? "Link copied" : "Copy meeting link"}
            </span>
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
        <ModeratorBar anyHands={participants.some((p) => p.handRaised)} />
      </div>
      <WaitingList />

      <div
        ref={boxRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto"
        tabIndex={0}
        role="list"
        aria-label="People in the meeting"
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
  participant: RtcParticipant;
  hand: boolean;
}) {
  const { hostId, coHosts, canModerate } = useHost();
  const { name: rawName, speaking, micOn, camOn, handRaised } = useParticipantState(participant);
  const name = rawName || "Guest";
  const role = hostId === participant.identity ? "Host" : coHosts.includes(participant.identity) ? "Co-host" : null;
  return (
    <div className="group/row flex h-full items-center gap-3 rounded-xl px-3 hover:bg-surface-2/60">
      <Avatar name={name} seed={participant.identity} speaking={speaking && micOn} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-medium">{name}</span>
        {(participant.isLocal || role) && (
          <span className="block text-xs text-muted">{[participant.isLocal && "You", role].filter(Boolean).join(" · ")}</span>
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
        <HostMenu participant={participant} micOn={micOn} camOn={camOn} handRaised={handRaised} variant="row" />
        {canModerate && (participant.isLocal || hostId === participant.identity) && (
          <span className="size-8 pointer-coarse:size-11" aria-hidden="true" />
        )}
      </span>
    </div>
  );
});

const ACCESS_ICONS: Record<JoinAccess, typeof Lock> = { open: Link2, ask: DoorOpen, locked: Lock };

/** Host and co-hosts only: who can join, mute everyone, and the rarer things in a menu. */
function ModeratorBar({ anyHands }: { anyHands: boolean }) {
  const { canModerate, isHost, access, supports, setAccess, muteAll, lowerAllHands, askEnd } = useHost();
  if (!canModerate) return null;
  const AccessIcon = ACCESS_ICONS[access];
  const choices = (Object.keys(ACCESS_LABELS) as JoinAccess[]).filter((choice) => choice !== "ask" || supports.askToJoin);
  return (
    <div className="flex flex-wrap gap-2">
      <Dropdown.Root>
        <Dropdown.Trigger
          aria-label={`Who can join: ${ACCESS_LABELS[access].label}`}
          className="group inline-flex h-11 min-w-0 basis-full cursor-pointer items-center gap-2 rounded-xl bg-surface-2 px-3 text-left text-sm font-medium transition-colors hover:bg-surface-3"
        >
          <AccessIcon className={`size-4 shrink-0 ${access === "open" ? "text-muted" : "text-accent"}`} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{ACCESS_LABELS[access].label}</span>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-aria-expanded:rotate-180" aria-hidden="true" />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content align="start" sideOffset={6} collisionPadding={12} className="menu w-72">
            <Dropdown.Label className="menu-label">Who can join</Dropdown.Label>
            <Dropdown.RadioGroup value={access} onValueChange={(value) => setAccess(value as JoinAccess)}>
              {choices.map((choice) => (
                <Dropdown.RadioItem key={choice} value={choice} className="menu-item pr-10">
                  <span className="min-w-0">
                    <span className="block font-medium">{ACCESS_LABELS[choice].label}</span>
                    <span className="block text-xs text-muted">{ACCESS_LABELS[choice].hint}</span>
                  </span>
                  <Dropdown.ItemIndicator className="absolute right-3 text-accent">
                    <Check className="size-4" aria-hidden="true" />
                  </Dropdown.ItemIndicator>
                </Dropdown.RadioItem>
              ))}
            </Dropdown.RadioGroup>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <button className="btn btn-secondary h-11 flex-1 rounded-xl px-3 text-sm" onClick={muteAll}>
        <MicOff className="size-4" aria-hidden="true" />
        Mute everyone
      </button>
      <Dropdown.Root>
        <Dropdown.Trigger className="icon-btn size-11 bg-surface-2" aria-label="More actions for everyone">
          <Ellipsis className="size-[1.125rem]" />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content align="end" sideOffset={6} collisionPadding={12} className="menu">
            <Dropdown.Item className="menu-item" disabled={!anyHands} onSelect={lowerAllHands}>
              <Hand className="size-4 text-muted" aria-hidden="true" />
              Lower all hands
            </Dropdown.Item>
            {isHost && (
              <>
                <div className="menu-sep" />
                <Dropdown.Item className="menu-item text-danger-text" onSelect={askEnd}>
                  <PhoneOff className="size-4" aria-hidden="true" />
                  End meeting for everyone
                </Dropdown.Item>
              </>
            )}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}

/** People asking to join, above everyone who is in. Only the host and co-hosts are told about them. */
function WaitingList() {
  const { canModerate, waiting, admit, deny, admitAll } = useHost();
  if (!canModerate || waiting.length === 0) return null;
  return (
    <section
      aria-label="Waiting to join"
      className="anim-fade mx-3 mb-1 rounded-2xl bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface-2))] p-1.5"
    >
      <div className="flex h-9 items-center justify-between gap-2 pr-1 pl-2.5">
        <h3 className="eyebrow flex gap-2 text-muted">
          Waiting to join
          <span className="tracking-normal tabular-nums">{waiting.length}</span>
        </h3>
        {waiting.length > 1 && (
          <button
            className="h-8 cursor-pointer rounded-lg px-2.5 text-sm font-semibold text-accent transition-colors hover:bg-surface-3"
            onClick={admitAll}
          >
            Admit all
          </button>
        )}
      </div>
      <ul className="scroll-quiet max-h-44 overflow-y-auto">
        {waiting.map((person) => {
          const name = person.name || "Guest";
          return (
            <li key={person.id} className="flex h-13 items-center gap-3 pr-1 pl-2.5">
              <Avatar name={name} seed={person.id} />
              <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium">{name}</span>
              <button className="btn btn-quiet h-9 rounded-lg px-3 text-sm" aria-label={`Deny ${name}`} onClick={() => deny(person)}>
                Deny
              </button>
              <button className="btn btn-primary h-9 rounded-lg px-3 text-sm" aria-label={`Admit ${name}`} onClick={() => admit(person)}>
                Admit
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
