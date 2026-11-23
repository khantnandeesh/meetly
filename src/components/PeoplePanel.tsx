"use client";

import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  DoorOpen,
  Ellipsis,
  Hand,
  Link2,
  Lock,
  Mic,
  MicOff,
  PhoneOff,
  Search,
  Smile,
  VideoOff,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { handQueue } from "@/lib/handQueue";
import { holdList, useFlip, useListHold, useOwnChanges } from "@/lib/listHold";
import { BULK_CONFIRM, FIRST_ROWS, matchesName, oldestFirst, ordinal, people, waitingFor, type Departure } from "@/lib/hostLists";
import { useParticipantState } from "@/lib/rtc/react";
import { displayName, type RtcParticipant, type RtcWaiter } from "@/lib/rtc/types";
import { useCallNoun } from "@/lib/useWebinar";
import { AudienceSection, AudienceView } from "./AudienceSection";
import { ACCESS_LABELS, HostMenu, useHost } from "./HostTools";
import { Dropdown } from "./ui/Menu";
import type { JoinAccess } from "@/lib/rtc/types";
import { useCopied } from "@/lib/hooks";
import { useBox } from "./Stage";
import { CopyIcon } from "./ui/CopyIcon";
import { Avatar } from "./ui/Avatar";

const ROW = 56;
const HEADER = 40;
const LEFT_ROW = 48;
const OVERSCAN = 6;

/**
 * The People panel. At any size it is one scrolling list, never a list inside a list: who is
 * waiting to join (the first few, oldest first), raised hands (the first few, in the order they
 * went up), everyone in the meeting, and for the host, who left. A section with more than it
 * shows has a "See all" view that takes the panel's place, with its own search.
 */
export function PeoplePanel({
  participants,
  code,
  onCopyLink,
}: {
  participants: RtcParticipant[];
  code: string;
  onCopyLink: () => Promise<boolean>;
}) {
  const { peopleView, setPeopleView, canModerate, waiting } = useHost();
  const hands = useMemo(() => handQueue(participants), [participants]);
  // The panel opens at everyone next time, unless something asks for a section first.
  useEffect(() => () => setPeopleView("main"), [setPeopleView]);
  // A "See all" view whose list has emptied has nothing to show: back to everyone.
  const emptied = (peopleView === "waiting" && (!canModerate || waiting.length === 0)) || (peopleView === "hands" && hands.length === 0);
  useEffect(() => {
    if (emptied) setPeopleView("main");
  }, [emptied, setPeopleView]);

  // Where focus goes on the way back: the "See all" row the view was opened from.
  const [cameFrom, setCameFrom] = useState<string | null>(null);
  const back = () => {
    setCameFrom(peopleView);
    setPeopleView("main");
  };

  if (peopleView === "waiting" && !emptied) return <WaitingView onBack={back} />;
  if (peopleView === "hands" && !emptied) return <HandsView hands={hands} onBack={back} />;
  if (peopleView === "audience") return <AudienceView onBack={back} />;
  return <MainView participants={participants} hands={hands} code={code} onCopyLink={onCopyLink} cameFrom={cameFrom} />;
}

/* ------------------------------------------------------------- everyone */

type Item =
  | { kind: "header"; key: string; label: string; count: number }
  | { kind: "row"; key: string; participant: RtcParticipant };

function MainView({
  participants,
  hands,
  code,
  onCopyLink,
  cameFrom,
}: {
  participants: RtcParticipant[];
  hands: RtcParticipant[];
  code: string;
  onCopyLink: () => Promise<boolean>;
  /** The "See all" row to give focus back to, after its view's back arrow. */
  cameFrom: string | null;
}) {
  const { isHost, departures } = useHost();
  const noun = useCallNoun();
  const [query, setQuery] = useState("");
  const copyState = useCopied(onCopyLink);
  const [scrollTop, setScrollTop] = useState(0);
  const [boxRef, box] = useBox<HTMLDivElement>();
  const [aboveRef, above] = useBox<HTMLDivElement>();
  const [leftOpen, setLeftOpen] = useState(false);

  // A list being read holds still (src/lib/listHold.ts): while it is scrolled or touched, nobody
  // is added to it or moved in it, so a flood of hands or arrivals never shifts the row under
  // your finger. What arrived meanwhile waits behind the "N new" pill.
  const hold = useListHold(boxRef);
  // Left live (at the top, untouched), rows that move glide rather than jump.
  useFlip(boxRef);
  const [snapshot, setSnapshot] = useState<{ hands: RtcParticipant[]; participants: RtcParticipant[] } | null>(null);
  if (hold.held && !snapshot) setSnapshot({ hands, participants });
  if (!hold.held && snapshot) setSnapshot(null);
  // What you did yourself shows at once (see `noteOwnChange`). A webinar's Speakers are never
  // held: a short list that changes only by the host's and co-hosts' own decisions.
  const yours = useOwnChanges();
  const heldHands = useMemo(() => (snapshot ? holdList(snapshot.hands, hands, identityOf, yours) : { shown: hands, added: 0 }), [snapshot, hands, yours]);
  const heldPeople = useMemo(
    () => (snapshot && noun !== "webinar" ? holdList(snapshot.participants, participants, identityOf, yours) : { shown: participants, added: 0 }),
    [snapshot, participants, yours, noun],
  );
  const showNew = () => {
    boxRef.current?.scrollTo({ top: 0 });
    hold.release();
  };

  useEffect(() => {
    if (cameFrom) document.querySelector<HTMLElement>(`[data-see-all="${cameFrom}"]`)?.focus();
  }, [cameFrom]);

  // You, then everyone else A–Z. Speaking never reorders the list, and neither do hands: they
  // have their own section above.
  const shownPeople = heldPeople.shown;
  const { items, matches } = useMemo(() => {
    const found = shownPeople
      .filter((p) => matchesName(displayName(p), query))
      .sort((a, b) => (a.isLocal !== b.isLocal ? (a.isLocal ? -1 : 1) : displayName(a).localeCompare(displayName(b))));
    const list: Item[] = [];
    // The count is everyone here now, even while the rows hold still.
    const searching = query.trim() !== "";
    if (found.length > 0) list.push({ kind: "header", key: "h:everyone", label: searching ? "Matches" : noun === "webinar" ? "Speakers" : "In this meeting", count: searching ? found.length : participants.length });
    for (const participant of found) list.push({ kind: "row", key: participant.identity, participant });
    return { items: list, matches: found.length };
  }, [shownPeople, participants, query, noun]);

  const searching = query.trim() !== "";
  const showLeft = isHost && !searching && departures.length > 0;
  const height = items.reduce((sum, item) => sum + (item.kind === "header" ? HEADER : ROW), 0);
  // Windowing: only rows near the viewport exist in the DOM, so a thousand people stay cheap.
  // The list starts below the waiting and hands sections, whose height is measured.
  const viewTop = scrollTop - above.h;
  const visible = useMemo(() => {
    let top = 0;
    const placed: (Item & { top: number })[] = [];
    for (const item of items) {
      const h = item.kind === "header" ? HEADER : ROW;
      if (top + h >= viewTop - OVERSCAN * ROW && top <= viewTop + box.h + OVERSCAN * ROW) placed.push({ ...item, top });
      top += h;
    }
    return placed;
  }, [items, viewTop, box.h]);

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
              {copyState.copied ? "Link copied" : `Copy ${noun} link`}
            </span>
            <span className="block truncate font-mono text-xs text-muted">{code}</span>
          </span>
        </button>
        <SearchField
          value={query}
          onChange={(value) => {
            setQuery(value);
            setScrollTop(0);
            boxRef.current?.scrollTo({ top: 0 });
          }}
          placeholder="Search people"
        />
        <p className="sr-only" role="status">
          {searching ? `${matches} ${matches === 1 ? "person matches" : "people match"}` : ""}
        </p>
        <ModeratorBar />
      </div>

      <div ref={boxRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto">
        <NewPill hands={heldHands.added} people={heldPeople.added} onShow={showNew} />
        <div ref={aboveRef}>
          {!searching && <WaitingSection />}
          {!searching && <HandsSection hands={hands} shown={heldHands.shown} />}
          {/* Webinars: who is watching, for the host and co-hosts only. */}
          {!searching && <AudienceSection />}
        </div>
        {matches === 0 ? (
          <p className="px-6 pt-10 text-center text-sm leading-relaxed text-muted">Nobody here is called “{query.trim()}”.</p>
        ) : (
          <div data-flip="everyone" role="list" aria-label="Participants" style={{ height }} className="relative">
            {visible.map((item) =>
              item.kind === "header" ? (
                <h3 key={item.key} data-flip={item.key} className="eyebrow absolute inset-x-0 flex items-end gap-2 px-5 pb-1.5" style={{ top: item.top, height: HEADER }}>
                  {item.label}
                  <span className="tracking-normal tabular-nums">{item.count.toLocaleString("en-US")}</span>
                </h3>
              ) : (
                <div key={item.key} data-flip={`row:${item.key}`} role="listitem" className="absolute inset-x-2" style={{ top: item.top, height: ROW }}>
                  <PersonRow participant={item.participant} hand={item.participant.handRaised} />
                </div>
              ),
            )}
          </div>
        )}
        {showLeft && (
          <LeftSection
            departures={departures}
            open={leftOpen}
            onToggle={() => setLeftOpen((open) => !open)}
            viewTop={viewTop - height}
            viewHeight={box.h}
          />
        )}
      </div>
    </div>
  );
}

const identityOf = (participant: RtcParticipant) => participant.identity;

/**
 * Over a held list, 8px below its top: how much arrived while it held still. One tap shows it:
 * the hold ends and the list goes back to the top, where new hands are. It floats in a sticky
 * strip of no height, so its coming and going never moves a row. It lines up with the names and
 * stops short of the row buttons (a hand, the camera, the microphone and the host's menu, which
 * is larger for a finger), because a hold is exactly when the host is pressing those.
 */
function NewPill({ hands, people, onShow }: { hands: number; people: number; onShow: () => void }) {
  const count = hands + people;
  if (count === 0) return null;
  const label = count > 99 ? "99+" : count.toLocaleString("en-US");
  const parts = [hands > 0 && `${hands.toLocaleString("en-US")} raised ${hands === 1 ? "hand" : "hands"}`, people > 0 && `${people.toLocaleString("en-US")} ${people === 1 ? "person" : "people"}`].filter(Boolean);
  return (
    <div className="pointer-events-none sticky top-2 z-10 flex h-0 justify-start pr-[10.5rem] pl-[4.25rem] pointer-coarse:pr-[11.25rem]">
      <button
        data-new-pill
        onClick={onShow}
        aria-label={`Show what's new: ${parts.join(" and ")}`}
        className="anim-pop pointer-events-auto inline-flex h-9 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full bg-accent pr-3 pl-2.5 text-sm font-semibold whitespace-nowrap text-accent-ink shadow-[0_8px_24px_-8px_rgb(0_0_0/0.7)] pointer-coarse:h-11"
      >
        <ArrowUp className="size-4 shrink-0" aria-hidden="true" />
        {label} new
      </button>
    </div>
  );
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="field h-11 rounded-xl px-10 text-sm"
      />
      {value && (
        <button className="icon-btn absolute top-1/2 right-1 size-9 -translate-y-1/2" aria-label="Clear search" onClick={() => onChange("")}>
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** Subscribes to its own participant, so one person talking re-renders one row. */
const PersonRow = memo(function PersonRow({
  participant,
  hand,
  note,
}: {
  participant: RtcParticipant;
  hand: boolean;
  /** Said first under the name: a raised hand's place in the queue ("1st"). */
  note?: string;
}) {
  const { hostId, coHosts, canModerate } = useHost();
  const { name: rawName, speaking, micOn, camOn, handRaised } = useParticipantState(participant);
  const name = rawName || "Guest";
  const role = hostId === participant.identity ? "Host" : coHosts.includes(participant.identity) ? "Co-host" : null;
  const details = [note, participant.isLocal && "You", role].filter(Boolean);
  return (
    <div className="group/row flex h-full items-center gap-3 rounded-xl px-3 hover:bg-surface-2/60">
      <Avatar name={name} seed={participant.identity} speaking={speaking && micOn} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-medium">{name}</span>
        {details.length > 0 && <span className="block text-xs text-muted">{details.join(" · ")}</span>}
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
function ModeratorBar() {
  const { canModerate, isHost, access, supports, setAccess, muteAll, askEnd, reactionsAllowed, setReactionsAllowed } = useHost();
  const noun = useCallNoun();
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
                    {ACCESS_LABELS[choice].hint && <span className="block text-xs text-muted">{ACCESS_LABELS[choice].hint}</span>}
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
          <Dropdown.Content align="end" sideOffset={6} collisionPadding={12} className="menu w-72">
            <Dropdown.CheckboxItem
              checked={reactionsAllowed}
              onCheckedChange={setReactionsAllowed}
              // Stay open: the switch is seen to move.
              onSelect={(event) => event.preventDefault()}
              className="menu-item"
            >
              <Smile className="size-4 shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Allow reactions</span>
                <span className="block text-xs text-muted">Off: hosts only</span>
              </span>
              <span className="switch" data-on={reactionsAllowed} aria-hidden="true" />
            </Dropdown.CheckboxItem>
            {isHost && (
              <>
                <div className="menu-sep" />
                <Dropdown.Item className="menu-item text-danger-text" onSelect={askEnd}>
                  <PhoneOff className="size-4" aria-hidden="true" />
                  End {noun} for everyone
                </Dropdown.Item>
              </>
            )}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}

/* --------------------------------------------------------------- waiting */

/** Re-renders every `ms` so "Waiting 4 min" keeps up. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** One person asking to join. A long name wraps rather than being cut off: it is how the host decides. */
function WaiterRow({ person, now, virtual = false }: { person: RtcWaiter; now: number; virtual?: boolean }) {
  const { admit, deny } = useHost();
  const name = person.name || "Guest";
  return (
    <li
      className={`flex min-h-13 items-center gap-2.5 py-1.5 pr-1 pl-2 ${virtual ? "[contain-intrinsic-size:auto_3.5rem] [content-visibility:auto] max-md:min-h-14" : ""}`}
    >
      <Avatar name={name} seed={person.id} />
      <span className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] leading-snug font-medium [overflow-wrap:anywhere]">{name}</span>
        <span className="block text-xs text-muted">{waitingFor(person.since, now)}</span>
      </span>
      {/* The two answers sit close together, so the name keeps as much of the row as it can. */}
      <span className="flex shrink-0 gap-0.5">
        <button className="btn btn-quiet h-9 rounded-lg px-2.5 text-sm" aria-label={`Deny ${name}`} onClick={() => deny(person)}>
          Deny
        </button>
        <button className="btn btn-primary h-9 rounded-lg px-3 text-sm" aria-label={`Admit ${name}`} onClick={() => admit(person)}>
          Admit
        </button>
      </span>
    </li>
  );
}

type Bulk = { asking: "admit" | "deny" | null; ask: (verb: "admit" | "deny") => void; cancel: () => void; confirm: () => void };

/** Admit all and Deny all for `people`, asking first above `BULK_CONFIRM`: a mis-tap can't be undone. */
function useBulk(everyone: RtcWaiter[]): Bulk {
  const { admitAll, denyAll } = useHost();
  const [asking, setAsking] = useState<"admit" | "deny" | null>(null);
  const run = (verb: "admit" | "deny") => (verb === "admit" ? admitAll(everyone) : denyAll(everyone));
  return {
    asking,
    ask: (verb) => (everyone.length > BULK_CONFIRM ? setAsking(verb) : run(verb)),
    cancel: () => setAsking(null),
    confirm: () => {
      if (asking) run(asking);
      setAsking(null);
    },
  };
}

/** The small inline question, in place of a dialog: "Admit 128 people?" Cancel / Admit 128. */
function BulkConfirm({ bulk, count }: { bulk: Bulk; count: number }) {
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    yes.current?.focus();
  }, []);
  if (!bulk.asking) return null;
  const verb = bulk.asking === "admit" ? "Admit" : "Deny";
  return (
    <div
      role="group"
      aria-label={`${verb} ${people(count)}?`}
      className="flex items-center gap-2 rounded-xl bg-surface-3 py-1.5 pr-1.5 pl-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Answers the question only; the panel stays open.
        event.preventDefault();
        bulk.cancel();
      }}
    >
      <p className="min-w-0 flex-1 text-sm font-medium">
        {verb} {people(count)}?
      </p>
      <button className="btn btn-quiet h-9 rounded-lg px-3 text-sm" onClick={bulk.cancel}>
        Cancel
      </button>
      <button
        ref={yes}
        className={`btn h-9 rounded-lg px-3 text-sm ${bulk.asking === "admit" ? "btn-primary" : "bg-danger text-white hover:bg-(--danger-hover)"}`}
        onClick={bulk.confirm}
      >
        {verb} {count.toLocaleString("en-US")}
      </button>
    </div>
  );
}

/** People asking to join, as the first section of the panel. Only the host and co-hosts are told about them. */
function WaitingSection() {
  const { canModerate, waiting, setPeopleView } = useHost();
  const now = useNow(30_000);
  const ordered = useMemo(() => oldestFirst(waiting), [waiting]);
  const bulk = useBulk(ordered);
  if (!canModerate || waiting.length === 0) return null;
  const count = waiting.length;
  return (
    <section
      aria-label="Waiting to join"
      className="anim-fade mx-3 mb-2 flex flex-col gap-0.5 rounded-2xl bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface-2))] p-1.5"
    >
      <div className="flex min-h-9 items-center justify-between gap-2 pr-1 pl-2.5">
        <h3 className="eyebrow flex gap-2 whitespace-nowrap text-muted">
          Waiting to join
          <span className="tracking-normal tabular-nums">{count.toLocaleString("en-US")}</span>
        </h3>
        {count > 1 && !bulk.asking && (
          <span className="flex shrink-0 whitespace-nowrap">
            <button className="h-8 cursor-pointer rounded-lg px-2 text-sm font-semibold text-muted transition-colors hover:bg-surface-3 hover:text-text" onClick={() => bulk.ask("deny")}>
              Deny all
            </button>
            <button className="h-8 cursor-pointer rounded-lg px-2 text-sm font-semibold text-accent transition-colors hover:bg-surface-3" onClick={() => bulk.ask("admit")}>
              Admit all
            </button>
          </span>
        )}
      </div>
      {bulk.asking && <BulkConfirm bulk={bulk} count={count} />}
      <ul>
        {ordered.slice(0, FIRST_ROWS).map((person) => (
          <WaiterRow key={person.id} person={person} now={now} />
        ))}
      </ul>
      {count > FIRST_ROWS && (
        <button
          data-see-all="waiting"
          onClick={() => setPeopleView("waiting")}
          className="flex h-11 cursor-pointer items-center justify-center gap-1 rounded-xl bg-surface-2/70 text-sm font-semibold transition-colors hover:bg-surface-3"
        >
          See all {count.toLocaleString("en-US")} waiting
          <ChevronRight className="size-4 text-muted" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

/** A section's "See all" view: back, its title and count, then what it holds. */
function SubViewHeader({ title, count, onBack }: { title: string; count: number; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <button data-autofocus className="icon-btn size-10 shrink-0" aria-label="Back to everyone" onClick={onBack}>
        <ChevronLeft className="size-5" aria-hidden="true" />
      </button>
      <h3 className="flex items-baseline gap-2 font-display text-base font-semibold">
        {title}
        <span className="font-sans text-sm font-medium text-muted tabular-nums">{count.toLocaleString("en-US")}</span>
      </h3>
    </div>
  );
}

/** Everyone waiting, searchable, with Admit all and Deny all for the whole list. */
function WaitingView({ onBack }: { onBack: () => void }) {
  const { waiting } = useHost();
  const [query, setQuery] = useState("");
  const now = useNow(30_000);
  const ordered = useMemo(() => oldestFirst(waiting), [waiting]);
  const shown = useMemo(() => ordered.filter((person) => matchesName(person.name, query)), [ordered, query]);
  const bulk = useBulk(ordered);
  const count = waiting.length;
  return (
    <section aria-label="Waiting to join" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3 pb-2">
        <SubViewHeader title="Waiting to join" count={count} onBack={onBack} />
        <SearchField value={query} onChange={setQuery} placeholder={`Search ${count.toLocaleString("en-US")} waiting`} />
        {count > 1 &&
          (bulk.asking ? (
            <BulkConfirm bulk={bulk} count={count} />
          ) : (
            <div className="grid grid-cols-[2fr_3fr] gap-2">
              <button className="btn btn-secondary h-11 rounded-xl px-3 text-sm" onClick={() => bulk.ask("deny")}>
                Deny all
              </button>
              <button className="btn btn-primary h-11 rounded-xl px-3 text-sm" onClick={() => bulk.ask("admit")}>
                Admit all {count.toLocaleString("en-US")}
              </button>
            </div>
          ))}
        <p className="px-1 text-xs leading-relaxed text-muted">
          Oldest first.
        </p>
        <p className="sr-only" role="status">
          {query.trim() ? `${shown.length} waiting ${shown.length === 1 ? "matches" : "match"}` : ""}
        </p>
      </div>
      {shown.length === 0 ? (
        <p className="px-6 pt-8 text-center text-sm leading-relaxed text-muted">Nobody waiting is called “{query.trim()}”.</p>
      ) : (
        // Rows off screen are not laid out or painted (content-visibility), so a long list stays
        // cheap while a name that wraps still gets the height it needs.
        <ul className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          {shown.map((person) => (
            <WaiterRow key={person.id} person={person} now={now} virtual />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- hands */

/** Raised hands, in the order they went up. Lower all is one tap for the host and co-hosts. */
function HandsSection({ hands, shown = hands }: { hands: RtcParticipant[]; /** The rows, which hold still while the list is read. */ shown?: RtcParticipant[] }) {
  const { canModerate, lowerAllHands, setPeopleView } = useHost();
  // Rows and the "See all" button follow what is shown, so a held list keeps its height; the
  // counts are always the current ones.
  if (shown.length === 0) return null;
  return (
    <section aria-label="Raised hands" className="mb-1">
      <div className="flex h-10 items-end justify-between gap-2 pr-3 pb-0.5 pl-5">
        <h3 className="eyebrow flex gap-2 pb-1">
          Raised hands
          <span className="tracking-normal tabular-nums">{hands.length.toLocaleString("en-US")}</span>
        </h3>
        {canModerate && (
          <button className="h-8 cursor-pointer rounded-lg px-2.5 text-sm font-semibold text-accent transition-colors hover:bg-surface-2" onClick={lowerAllHands}>
            Lower all
          </button>
        )}
      </div>
      <ul className="px-2">
        {shown.slice(0, FIRST_ROWS).map((participant, index) => (
          <li key={participant.identity} data-flip={`hand:${participant.identity}`} style={{ height: ROW }}>
            <PersonRow participant={participant} hand note={ordinal(index + 1)} />
          </li>
        ))}
      </ul>
      {shown.length > FIRST_ROWS && (
        <button
          data-see-all="hands"
          data-flip="see-all-hands"
          onClick={() => setPeopleView("hands")}
          aria-label={`See all ${hands.length} raised hands`}
          className="mx-3 flex h-11 w-[calc(100%-1.5rem)] cursor-pointer items-center justify-center gap-1 rounded-xl bg-surface-2/70 text-sm font-semibold transition-colors hover:bg-surface-3"
        >
          See all {hands.length.toLocaleString("en-US")}
          <ChevronRight className="size-4 text-muted" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

/** Every raised hand in order, searchable, windowed like the people list. */
function HandsView({ hands, onBack }: { hands: RtcParticipant[]; onBack: () => void }) {
  const { canModerate, lowerAllHands } = useHost();
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [boxRef, box] = useBox<HTMLDivElement>();
  // The place in the queue stays the person's own while searching.
  const shown = useMemo(
    () => hands.map((participant, index) => ({ participant, place: index + 1 })).filter(({ participant }) => matchesName(displayName(participant), query)),
    [hands, query],
  );
  const from = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const to = Math.min(shown.length, Math.ceil((scrollTop + box.h) / ROW) + OVERSCAN);
  return (
    <section aria-label="Raised hands" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3 pb-2">
        <SubViewHeader title="Raised hands" count={hands.length} onBack={onBack} />
        <SearchField
          value={query}
          onChange={(value) => {
            setQuery(value);
            setScrollTop(0);
            boxRef.current?.scrollTo({ top: 0 });
          }}
          placeholder={`Search ${hands.length.toLocaleString("en-US")} raised hands`}
        />
        {canModerate && (
          <button className="btn btn-secondary h-11 rounded-xl px-3 text-sm" onClick={lowerAllHands}>
            <Hand className="size-4" aria-hidden="true" />
            Lower all
          </button>
        )}
        <p className="px-1 text-xs leading-relaxed text-muted">In the order they went up.</p>
      </div>
      <div ref={boxRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-6 pt-8 text-center text-sm leading-relaxed text-muted">Nobody with a hand up is called “{query.trim()}”.</p>
        ) : (
          <ul aria-label="Raised hands, in order" style={{ height: shown.length * ROW }} className="relative">
            {shown.slice(from, to).map(({ participant, place }, i) => (
              <li key={participant.identity} className="absolute inset-x-2" style={{ top: (from + i) * ROW, height: ROW }}>
                <PersonRow participant={participant} hand note={ordinal(place)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ left */

const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * The host's answer to "did Sam leave?": the last section, collapsed, newest first. It holds only
 * what this browser saw happen, so it says so.
 */
function LeftSection({
  departures,
  open,
  onToggle,
  viewTop,
  viewHeight,
}: {
  departures: readonly Departure[];
  open: boolean;
  onToggle: () => void;
  /** Where the visible part of the panel starts, measured from the top of this section. */
  viewTop: number;
  viewHeight: number;
}) {
  const noun = useCallNoun();
  const rowsTop = HEADER;
  const from = Math.max(0, Math.floor((viewTop - rowsTop) / LEFT_ROW) - OVERSCAN);
  const to = Math.min(departures.length, Math.ceil((viewTop - rowsTop + viewHeight) / LEFT_ROW) + OVERSCAN);
  return (
    <section aria-label={`Left the ${noun}`} className="pb-2">
      <button
        aria-expanded={open}
        onClick={onToggle}
        className="group flex w-full cursor-pointer items-end gap-2 px-5 pb-1.5 text-left"
        style={{ height: HEADER }}
      >
        <span className="eyebrow flex gap-2">
          Left the {noun}
          <span className="tracking-normal tabular-nums">{departures.length.toLocaleString("en-US")}</span>
        </span>
        <ChevronRight className="mb-px size-4 text-muted transition-transform group-aria-expanded:rotate-90" aria-hidden="true" />
      </button>
      {open && (
        <ul style={{ height: departures.length * LEFT_ROW }} className="relative">
          {departures.slice(from, to).map((person, i) => {
            const name = person.name || "Guest";
            return (
              <li key={person.identity} className="absolute inset-x-2 flex items-center gap-3 px-3" style={{ top: (from + i) * LEFT_ROW, height: LEFT_ROW }}>
                <Avatar name={name} seed={person.identity} className="size-8 text-xs opacity-70" />
                <span className="min-w-0 flex-1 truncate text-sm text-muted">{name}</span>
                <span className="shrink-0 text-xs text-faint tabular-nums">Left {timeOf(person.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-5 pt-1 text-xs text-faint">Since you joined</p>
    </section>
  );
}
