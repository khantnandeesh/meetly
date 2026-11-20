"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ChartNoAxesColumn, Check, ChevronDown, CircleAlert, LoaderCircle, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useCall, useConnectionStatus } from "@/lib/rtc/react";
import { checkNewPoll } from "@/lib/rtc/shared";
import { POLL_LIMITS, type RtcPoll } from "@/lib/rtc/types";
import { deviceClass, sendUsageEvent, sizeBucket } from "@/lib/usage";
import { useChatStore } from "./ChatStore";
import { useHost } from "./HostTools";
import { useToast } from "./ui/Toaster";

/** Above this many votes a named poll shows counts only: a wall of names helps nobody. */
const NAMES_UP_TO = 20;

const votesLabel = (count: number) => (count === 1 ? "1 vote" : `${count} votes`);

/**
 * Polls sit at the top of the chat panel: no third panel, no new button in the bar. Open polls
 * are shown whole; finished ones fold down to a line. The host and co-hosts start and end them
 * (our server, or on RealtimeKit the preset, decides that; the buttons only follow).
 */
export function PollsSection() {
  const call = useCall();
  const { canModerate } = useHost();
  const { polls } = useChatStore();
  const [creating, setCreating] = useState(false);
  // Known once connected; the chat store re-renders this on every status change.
  const { polls: available, createPolls } = call.supports;
  const canCreate = canModerate && createPolls;
  if (!available || (polls.length === 0 && !canCreate)) return null;

  const open = polls.filter((poll) => poll.open);
  const ended = polls.filter((poll) => !poll.open);
  const full = open.length >= POLL_LIMITS.open;
  return (
    <section aria-label="Polls" data-polls className="scroll-quiet flex max-h-[55%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-border px-3 pt-1 pb-3">
      <div className="flex min-h-9 items-center justify-between gap-2 pl-1">
        <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-faint uppercase">
          <ChartNoAxesColumn className="size-3.5" aria-hidden="true" />
          Polls
        </h3>
        {canCreate && (
          <button
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-accent transition-colors hover:bg-surface-2 aria-disabled:cursor-default aria-disabled:text-faint aria-disabled:hover:bg-transparent"
            aria-disabled={full || undefined}
            title={full ? `${POLL_LIMITS.open} polls are open. End one to start another.` : undefined}
            onClick={() => {
              if (!full) setCreating(true);
            }}
          >
            <Plus className="size-4" aria-hidden="true" />
            Start a poll
          </button>
        )}
      </div>
      {polls.length === 0 && <p className="px-1 pb-1 text-sm text-muted">Ask everyone a quick question. Each person gets one vote.</p>}
      {open.map((poll) => (
        <PollCard key={poll.id} poll={poll} canModerate={canModerate} />
      ))}
      {ended.map((poll) => (
        <EndedPoll key={poll.id} poll={poll} />
      ))}
      <NewPollDialog open={creating} onOpenChange={setCreating} />
    </section>
  );
}

function Options({
  poll,
  showResults,
  pending,
  onVote,
}: {
  poll: RtcPoll;
  showResults: boolean;
  pending?: number | null;
  onVote?: (option: number) => void;
}) {
  const names = !poll.anonymous && poll.total <= NAMES_UP_TO;
  return (
    <ul className="flex flex-col gap-1.5">
      {poll.options.map((option, index) => {
        const share = poll.total > 0 ? option.votes / poll.total : 0;
        const mine = poll.myVote === index;
        const row = (
          <>
            {/* The bar is always full width and scaled, so a changing count only ever moves a transform. */}
            <span
              aria-hidden="true"
              className="absolute inset-0 origin-left bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-transform duration-(--dur-move) ease-(--ease-move)"
              style={{ transform: `scaleX(${showResults ? share : 0})` }}
            />
            <span className="relative flex min-h-11 items-center gap-2 px-3 py-2 text-left text-[0.9375rem] leading-snug">
              {pending === index ? (
                <LoaderCircle className="anim-spin size-4 shrink-0 text-accent" aria-hidden="true" />
              ) : (
                mine && <Check className="size-4 shrink-0 text-accent" aria-label="Your vote" />
              )}
              <span className="min-w-0 flex-1 break-words">{option.text}</span>
              {showResults && (
                <span className="shrink-0 text-sm text-muted tabular-nums" data-poll-count={option.votes}>
                  {option.votes} · {Math.round(share * 100)}%
                </span>
              )}
            </span>
          </>
        );
        const box = "relative w-full overflow-hidden rounded-xl bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]";
        return (
          <li key={index}>
            {onVote ? (
              <button
                data-poll-option={index}
                disabled={pending !== null && pending !== undefined}
                onClick={() => onVote(index)}
                className={`${box} block cursor-pointer transition-colors hover:bg-surface-3 hover:shadow-[inset_0_0_0_1px_var(--border-strong)] disabled:cursor-default`}
              >
                {row}
              </button>
            ) : (
              <div data-poll-option={index} className={`${box} ${mine ? "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_45%,var(--border))]" : ""}`}>
                {row}
              </div>
            )}
            {showResults && names && option.voters.length > 0 && (
              <p className="truncate px-3 pt-1 text-xs text-muted" data-poll-voters>
                {option.voters.join(", ")}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** An open poll: options to press until you have voted, then the counts. */
function PollCard({ poll, canModerate }: { poll: RtcPoll; canModerate: boolean }) {
  const call = useCall();
  const toast = useToast();
  const [pending, setPending] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  // Whoever can end the poll needs to see how it is going; everyone else sees it once they have voted.
  const showResults = poll.voted || canModerate;

  async function vote(option: number) {
    setPending(option);
    setFailed(null);
    try {
      await call.votePoll(poll.id, option);
      sendUsageEvent({ kind: "feature", feature: "poll-voted", size: sizeBucket(call.participants().length), device: deviceClass() });
    } catch (error) {
      setFailed(error instanceof Error && error.message ? error.message : "Your vote wasn't counted. Try again.");
    } finally {
      setPending(null);
    }
  }

  async function end() {
    setEnding(true);
    try {
      await call.moderate({ action: "closePoll", pollId: poll.id });
    } catch (error) {
      toast.push({
        tone: "danger",
        icon: <CircleAlert className="size-5" />,
        title: "Couldn't end the poll",
        body: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setEnding(false);
    }
  }

  return (
    <article
      data-poll={poll.id}
      data-poll-open="true"
      data-poll-voted={poll.voted}
      aria-label={`Poll: ${poll.question}`}
      className="anim-fade flex shrink-0 flex-col gap-2.5 rounded-2xl bg-surface p-3 shadow-[inset_0_0_0_1px_var(--border-strong)]"
    >
      <div className="flex flex-col gap-0.5 px-1">
        <p className="text-[0.9375rem] leading-snug font-semibold break-words">{poll.question}</p>
        <p className="text-xs text-muted">
          {poll.createdBy ? `${poll.createdBy} asked` : "Poll"}
          {poll.anonymous ? " · votes are anonymous" : " · votes are shown by name"}
        </p>
      </div>
      <Options poll={poll} showResults={showResults} pending={pending} onVote={poll.voted ? undefined : vote} />
      {failed && (
        <p role="alert" className="px-1 text-sm text-danger-text">
          {failed}
        </p>
      )}
      <div className="flex min-h-8 items-center justify-between gap-2 px-1 text-xs text-muted">
        <p role="status">
          {showResults ? votesLabel(poll.total) : "Results show once you vote"}
          {poll.voted ? " · you voted" : ""}
        </p>
        {canModerate && (
          <button
            data-poll-end
            disabled={ending}
            onClick={end}
            className="h-8 cursor-pointer rounded-lg px-2.5 text-sm font-semibold text-text transition-colors hover:bg-surface-3 disabled:cursor-default disabled:text-faint"
          >
            End poll
          </button>
        )}
      </div>
    </article>
  );
}

/** A finished poll: one line, which opens to the final counts. */
function EndedPoll({ poll }: { poll: RtcPoll }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <article
      data-poll={poll.id}
      data-poll-open="false"
      aria-label={`Ended poll: ${poll.question}`}
      className="shrink-0 rounded-2xl bg-surface shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <button
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-2xl px-4 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{poll.question}</span>
          <span className="block text-xs text-muted">Ended · {votesLabel(poll.total)}</span>
        </span>
        <ChevronDown className={`size-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={panel} className="anim-fade px-3 pb-3">
          <Options poll={poll} showResults />
        </div>
      )}
    </article>
  );
}

function NewPollDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const call = useCall();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [anonymous, setAnonymous] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const questionId = useId();
  const errorId = useId();
  const lastOption = useRef<HTMLInputElement>(null);
  const added = useRef(false);
  useEffect(() => {
    if (!added.current) return;
    added.current = false;
    lastOption.current?.focus();
  }, [options.length]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const poll = checkNewPoll({ question, options, anonymous });
    if (typeof poll === "string") return setProblem(poll);
    setProblem(null);
    setSending(true);
    try {
      await call.createPoll(poll);
      sendUsageEvent({ kind: "feature", feature: "poll-created", size: sizeBucket(call.participants().length), device: deviceClass() });
      setQuestion("");
      setOptions(["", ""]);
      onOpenChange(false);
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : "The poll couldn't be started. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          className="dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-surface shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)]"
        >
          <div className="flex items-center justify-between py-3 pr-3 pl-6">
            <Dialog.Title className="font-display text-xl font-semibold">Start a poll</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <form onSubmit={submit} className="scroll-quiet flex flex-col gap-5 overflow-y-auto px-6 pb-6">
            <div className="flex flex-col gap-2">
              <label htmlFor={questionId} className="text-sm font-medium text-muted">
                Question
              </label>
              <input
                id={questionId}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={POLL_LIMITS.question}
                placeholder="What should we decide?"
                autoComplete="off"
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? errorId : undefined}
                className="field"
              />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium text-muted">Options</legend>
              {options.map((option, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <input
                    ref={index === options.length - 1 ? lastOption : undefined}
                    value={option}
                    onChange={(event) => setOptions(options.map((other, at) => (at === index ? event.target.value : other)))}
                    maxLength={POLL_LIMITS.option}
                    placeholder={`Option ${index + 1}`}
                    aria-label={`Option ${index + 1}`}
                    autoComplete="off"
                    className="field h-11"
                  />
                  {options.length > POLL_LIMITS.minOptions && (
                    <button
                      type="button"
                      className="icon-btn size-11"
                      aria-label={`Remove option ${index + 1}`}
                      onClick={() => setOptions(options.filter((_, at) => at !== index))}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
              {options.length < POLL_LIMITS.maxOptions && (
                <button
                  type="button"
                  className="inline-flex h-10 cursor-pointer items-center gap-1.5 self-start rounded-lg px-2.5 text-sm font-semibold text-accent transition-colors hover:bg-surface-2"
                  onClick={() => {
                    added.current = true;
                    setOptions([...options, ""]);
                  }}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Add option
                </button>
              )}
            </fieldset>
            <label className="flex cursor-pointer items-center justify-between gap-4">
              <span>
                <span className="block text-[0.9375rem] font-medium">Anonymous votes</span>
                <span className="block text-sm text-muted">
                  {anonymous ? "Only the counts are shown, never who chose what." : "Everyone sees who chose what."}
                </span>
              </span>
              <input type="checkbox" role="switch" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} className="peer sr-only" />
              <span
                aria-hidden="true"
                className="relative h-7 w-12 shrink-0 rounded-full bg-surface-3 transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5 peer-checked:after:bg-accent-ink"
              />
            </label>
            {problem && (
              <p id={errorId} role="alert" className="anim-fade flex items-start gap-2 text-sm text-danger-text">
                <CircleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
                {problem}
              </p>
            )}
            <div className="flex flex-col gap-2">
              <button type="submit" className="btn btn-primary" disabled={sending}>
                {sending && <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" />}
                Start poll
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A poll starting while the chat panel is closed is announced once, with the way to it. A poll
 * that was already there when you arrived is not news: the badge on the chat button says it is
 * waiting. Renders nothing.
 */
export function PollToasts({ open, onShow }: { open: boolean; onShow: () => void }) {
  const { polls } = useChatStore();
  const toast = useToast();
  const openNow = useRef(open);
  const known = useRef<Set<string> | null>(null);
  // "Arrived" is a moment after connecting: the polls reach a newcomer just after the call does.
  const connected = useConnectionStatus() === "connected";
  const settled = useRef(false);
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => {
      settled.current = true;
    }, 2000);
    return () => clearTimeout(timer);
  }, [connected]);
  useEffect(() => {
    openNow.current = open;
    if (open) toast.dismissTag("poll");
  }, [open, toast]);
  useEffect(() => {
    const before = known.current;
    known.current = new Set(polls.map((poll) => poll.id));
    if (!before || !settled.current || openNow.current) return;
    const fresh = polls.findLast((poll) => !before.has(poll.id) && poll.open && !poll.voted);
    if (!fresh) return;
    toast.push({
      tag: "poll",
      icon: <ChartNoAxesColumn className="size-5" />,
      title: fresh.createdBy ? `${fresh.createdBy} started a poll` : "A poll started",
      body: fresh.question,
      duration: 8000,
      action: { label: "Vote", onClick: onShow },
    });
  }, [polls, toast, onShow]);
  return null;
}
