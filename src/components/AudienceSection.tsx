"use client";

import { ChevronLeft, ChevronRight, CircleAlert, Hand, Search, Undo2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { FIRST_ROWS, matchesName, ordinal } from "@/lib/hostLists";
import { useCall } from "@/lib/rtc/react";
import { displayName, type RtcParticipant } from "@/lib/rtc/types";
import { useAudience } from "@/lib/useWebinar";
import { HostMenu, useHost } from "./HostTools";
import { useBox } from "./Stage";
import { Avatar } from "./ui/Avatar";
import { Dropdown } from "./ui/Menu";
import { useToast } from "./ui/Toaster";

/**
 * A webinar's audience, in People, for the host and co-hosts only: nobody else is shown who is
 * watching. Raised hands come first, in the order they went up, then everyone else A–Z. The
 * section shows the first few; "See all" gives the whole audience its own view, searchable, with
 * only the rows in view drawn, so a full webinar costs a screenful of rows.
 *
 * "Invite to speak" asks the viewer first (see StageInvite.tsx); v1 invites one person at a time.
 */

const ROW = 56;
const OVERSCAN = 6;

/** Invites someone on stage, or sends them (or an unanswered invitation) back. Failures are said. */
export function useStageAction() {
  const call = useCall();
  const toast = useToast();
  return useCallback(
    (participant: RtcParticipant, on: boolean) => {
      call.moderate({ action: "stage", identity: participant.identity, on }).catch((error) =>
        toast.push({
          tone: "danger",
          icon: <CircleAlert className="size-5" />,
          tag: "stage",
          title: on ? `Couldn't invite ${displayName(participant)} to speak` : `Couldn't move ${displayName(participant)} to the audience`,
          body: error instanceof Error ? error.message : undefined,
        }),
      );
    },
    [call, toast],
  );
}

/** Who may change the stage here: the host or a co-host, where the provider lets them. */
function useMayStage(): boolean {
  const call = useCall();
  const { canModerate } = useHost();
  return canModerate && call.supports.stage;
}

/** The audience as a section of People: the first few, and "See all". */
export function AudienceSection() {
  const { canModerate, setPeopleView } = useHost();
  const audience = useAudience();
  const call = useCall();
  if (call.mode !== "webinar" || !canModerate) return null;
  const count = audience.length;
  const pending = audience.some((p) => p.stageInvite);
  return (
    <section aria-label="Audience" className="mb-1">
      <div className="flex h-10 items-end gap-2 pr-3 pb-1.5 pl-5">
        <h3 className="eyebrow flex gap-2">
          Audience
          <span className="tracking-normal tabular-nums">{count.toLocaleString("en-US")}</span>
        </h3>
      </div>
      {count === 0 ? (
        <p className="px-5 pb-2 text-sm text-muted">Nobody is watching yet.</p>
      ) : (
        <ul className="px-2">
          {audience.slice(0, FIRST_ROWS).map((participant, index) => (
            <li key={participant.identity} style={{ height: ROW }}>
              <AudienceRow participant={participant} place={participant.handRaised ? index + 1 : undefined} pending={pending} />
            </li>
          ))}
        </ul>
      )}
      {count > FIRST_ROWS && (
        <button
          data-see-all="audience"
          onClick={() => setPeopleView("audience")}
          aria-label={`See all ${count} in the audience`}
          className="mx-3 flex h-11 w-[calc(100%-1.5rem)] cursor-pointer items-center justify-center gap-1 rounded-xl bg-surface-2/70 text-sm font-semibold transition-colors hover:bg-surface-3"
        >
          See all {count.toLocaleString("en-US")}
          <ChevronRight className="size-4 text-muted" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

/** The whole audience, searchable, drawing only the rows in view. */
export function AudienceView({ onBack }: { onBack: () => void }) {
  const audience = useAudience();
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [boxRef, box] = useBox<HTMLDivElement>();
  // A raised hand's place in the queue stays its own while searching.
  const shown = useMemo(
    () =>
      audience
        .map((participant, index) => ({ participant, place: participant.handRaised ? index + 1 : undefined }))
        .filter(({ participant }) => matchesName(displayName(participant), query)),
    [audience, query],
  );
  const pending = audience.some((p) => p.stageInvite);
  const from = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const to = Math.min(shown.length, Math.ceil((scrollTop + box.h) / ROW) + OVERSCAN);
  const count = audience.length;
  return (
    <section aria-label="Audience" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3 pb-2">
        <div className="flex items-center gap-1">
          <button data-autofocus className="icon-btn size-10 shrink-0" aria-label="Back to everyone" onClick={onBack}>
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <h3 className="flex items-baseline gap-2 font-display text-base font-semibold">
            Audience
            <span className="font-sans text-sm font-medium text-muted tabular-nums">{count.toLocaleString("en-US")}</span>
          </h3>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setScrollTop(0);
              boxRef.current?.scrollTo({ top: 0 });
            }}
            placeholder={`Search ${count.toLocaleString("en-US")} in the audience`}
            aria-label="Search the audience"
            autoComplete="off"
            spellCheck={false}
            className="field h-11 rounded-xl px-10 text-sm"
          />
          {query && (
            <button className="icon-btn absolute top-1/2 right-1 size-9 -translate-y-1/2" aria-label="Clear search" onClick={() => setQuery("")}>
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="px-1 text-xs leading-relaxed text-muted">Raised hands first, in the order they went up.</p>
        <p className="sr-only" role="status">
          {query.trim() ? `${shown.length} in the audience ${shown.length === 1 ? "matches" : "match"}` : ""}
        </p>
      </div>
      <div ref={boxRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-6 pt-8 text-center text-sm leading-relaxed text-muted">
            {query.trim() ? `Nobody in the audience is called “${query.trim()}”.` : "Nobody is watching yet."}
          </p>
        ) : (
          <ul aria-label="Audience, hands first" data-audience-list style={{ height: shown.length * ROW }} className="relative">
            {shown.slice(from, to).map(({ participant, place }, i) => (
              <li key={participant.identity} className="absolute inset-x-2" style={{ top: (from + i) * ROW, height: ROW }}>
                <AudienceRow participant={participant} place={place} pending={pending} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * One person watching. The action is "Invite to speak", or, once invited, "Cancel" until they
 * answer. While one invitation is out, nobody else can be invited (v1: one at a time).
 */
function AudienceRow({ participant, place, pending }: { participant: RtcParticipant; place?: number; pending: boolean }) {
  const mayStage = useMayStage();
  const stage = useStageAction();
  const { coHosts } = useHost();
  const name = displayName(participant);
  const invited = participant.stageInvite;
  const details = [place && ordinal(place), coHosts.includes(participant.identity) && "Co-host", invited && "Invited to speak"].filter(Boolean);
  return (
    <div className="flex h-full items-center gap-3 rounded-xl px-3 hover:bg-surface-2/60" data-audience-row={participant.identity}>
      <Avatar name={name} seed={participant.identity} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-medium">{name}</span>
        {details.length > 0 && <span className="block text-xs text-muted">{details.join(" · ")}</span>}
      </span>
      {participant.handRaised && (
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-ink">
          <Hand className="size-4" aria-hidden="true" />
          <span className="sr-only">Hand raised</span>
        </span>
      )}
      {mayStage &&
        (invited ? (
          <button className="btn btn-quiet h-9 shrink-0 rounded-lg px-2.5 text-sm" aria-label={`Cancel the invitation to ${name}`} onClick={() => stage(participant, false)}>
            Cancel
          </button>
        ) : (
          <button
            className="btn btn-secondary h-9 shrink-0 rounded-lg px-3 text-sm"
            aria-label={`Invite ${name} to speak`}
            // One invitation at a time: answering it (or cancelling) frees the button.
            disabled={pending}
            title={pending ? "Wait for the person you invited to answer, or cancel that invitation." : undefined}
            onClick={() => stage(participant, true)}
          >
            Invite to speak
          </button>
        ))}
      {/* Make co-host, lower a hand, remove: the host's menu, as on every other row. */}
      <HostMenu participant={participant} micOn={false} camOn={false} handRaised={participant.handRaised} variant="row" />
    </div>
  );
}

/**
 * For the host's menu on someone who is on stage: back to the audience. Nothing in a meeting,
 * for someone in the audience, or for a co-host whose provider would refuse it.
 */
export function BackToAudienceItem({ participant }: { participant: RtcParticipant }) {
  const call = useCall();
  const mayStage = useMayStage();
  const stage = useStageAction();
  if (call.mode !== "webinar" || !mayStage || participant.role !== "speaker") return null;
  return (
    <Dropdown.Item className="menu-item" onSelect={() => stage(participant, false)}>
      <Undo2 className="size-4 text-muted" aria-hidden="true" />
      Back to audience
    </Dropdown.Item>
  );
}
