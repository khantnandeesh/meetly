"use client";

import { CalendarPlus, CircleAlert, CirclePause, DoorClosed, Download, Home, Hourglass, LogOut, PhoneOff, RotateCcw, ThumbsDown, ThumbsUp, Unplug, UserX } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { saveChat } from "@/lib/chatExport";
import { fullCount } from "@/lib/counts";
import { useMounted } from "@/lib/hooks";
import { loadProvider, peekMeeting, requestJoin } from "@/lib/rtc/provider";
import { CallRoom } from "@/lib/rtc/react";
import { NOTICE } from "@/lib/rtc/shared";
import type { ConnectionStatus, DisconnectReason, JoinChoices, MeetingPeek, RtcCall, RtcChatMessage } from "@/lib/rtc/types";
import { sounds } from "@/lib/sounds";
import { deviceClass, lengthBucket, sendUsageEvent, sizeBucket } from "@/lib/usage";
import { playCallEndedSound } from "@/lib/useSounds";
import { Conference } from "./Conference";
import { PreJoin, PreJoinSkeleton } from "./PreJoin";
import { ScheduleDialog } from "./ScheduleDialog";
import { ViewerPreJoin } from "./ViewerPreJoin";
import { Logo } from "./ui/Logo";
import { useToast } from "./ui/Toaster";

type Session = { call: RtcCall; joinedAt: number };
type Stage = "prejoin" | "joined" | "left";
type Departure = {
  minutes: number;
  reason: DisconnectReason;
  byYou: boolean;
  /** You were the host: the one who can plan the next meeting on this link. */
  host: boolean;
  /** The conversation as it stood when the call ended for you: the last chance to keep it. */
  chat: RtcChatMessage[];
  pinned: RtcChatMessage | null;
  /** The most people who were in the call at once while you were. */
  people: number;
  /** What it was called: the screen names a webinar as one. */
  noun: "meeting" | "webinar";
};

/** The status of a call that is not (yet) provided through context. */
function useStatusOf(call: RtcCall | null): ConnectionStatus | null {
  const subscribe = useCallback((onChange: () => void) => (call ? call.on("status", onChange) : () => {}), [call]);
  return useSyncExternalStore(
    subscribe,
    () => call?.status ?? null,
    () => null,
  );
}

export function Meeting({ code }: { code: string }) {
  const mounted = useMounted();
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("prejoin");
  const [session, setSession] = useState<Session | null>(null);
  const [joining, setJoining] = useState(false);
  /** The room is connected and drawn. */
  const [ready, setReady] = useState(false);
  /** The pre-join screen is still on top (it leaves once `ready`). */
  const [covered, setCovered] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [departure, setDeparture] = useState<Departure>({ minutes: 0, reason: "left", byYou: false, host: false, chat: [], pinned: null, people: 1, noun: "meeting" });
  // The most people the call held while you were in it: a size for the rating, not a list of anyone.
  const mostPeople = useRef(1);
  const currentCall = session?.call;
  useEffect(() => {
    if (!currentCall) return;
    mostPeople.current = 1;
    return currentCall.on("roster", () => {
      mostPeople.current = Math.max(mostPeople.current, currentCall.participants().length);
    });
  }, [currentCall]);
  /**
   * Who may join, whether this browser is the host, and how many people are in already (null
   * where the provider can't say). Asked each time the pre-join screen is up.
   */
  const [seen, setSeen] = useState<MeetingPeek | null>(null);
  /**
   * The first answer has come (or could not). Until then neither pre-join is drawn: a webinar's
   * audience must never be asked for a camera, and which screen it is depends on the answer.
   */
  const [peeked, setPeeked] = useState(false);

  useEffect(() => {
    if (stage !== "prejoin") return;
    let current = true;
    // A server that does not answer in time leaves the meeting's own screen, as before webinars.
    const fallback = setTimeout(() => setPeeked(true), 4000);
    void peekMeeting(code).then((answer) => {
      clearTimeout(fallback);
      if (!current) return;
      if (answer) setSeen(answer);
      setPeeked(true);
    });
    return () => {
      current = false;
      clearTimeout(fallback);
    };
  }, [code, stage]);
  // A webinar's audience joins without devices (see ViewerPreJoin); its host as to any meeting.
  const watching = seen?.mode === "webinar" && !seen.host;

  async function join(choices: JoinChoices) {
    // Still inside the click that joins: the only moment a browser lets audio be switched on.
    sounds.unlock();
    setError(null);
    setJoining(true);
    try {
      // The provider's SDK is fetched here, alongside the token, and not a moment earlier.
      const [grant, provider] = await Promise.all([requestJoin(code, choices.username), loadProvider()]);
      setSession({ call: provider.createCall(grant, choices), joinedAt: Date.now() });
      setReady(false);
      setCovered(true);
      setStage("joined");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join the meeting. Check your connection and try again.");
    } finally {
      setJoining(false);
    }
  }

  const backToPreJoin = () => {
    setReady(false);
    setCovered(true);
    setSession(null);
    setStage("prejoin");
  };

  const inCall = stage === "joined" && session !== null;
  // Asked to join, not answered yet: the pre-join screen stays, saying so. Unmounting the call
  // (Cancel) hangs up quietly.
  const waiting = useStatusOf(inCall ? session.call : null) === "waiting";

  if (stage === "left") {
    return <LeftScreen code={code} departure={departure} onRejoin={backToPreJoin} />;
  }

  // The pre-join screen stays up, with its live preview, until the room is connected and the
  // stage is drawn underneath; then it fades away to reveal it. One hand-over, not three screens.
  return (
    <>
      {inCall && (
        <CallRoom
          call={session.call}
          onConnected={() => setReady(true)}
          onDisconnected={(reason) => {
            const { call } = session;
            toast.clear();
            playCallEndedSound();
            setDeparture({
              minutes: reason === "denied" ? 0 : Math.round((Date.now() - session.joinedAt) / 60_000),
              reason,
              byYou: reason === "ended" && call.hostIdentity !== null && call.hostIdentity === call.local.identity,
              host: call.hostIdentity !== null && call.hostIdentity === call.local.identity,
              chat: call.chatMessages(),
              pinned: call.pinnedMessage(),
              people: mostPeople.current,
              noun: call.mode === "webinar" ? "webinar" : "meeting",
            });
            setStage("left");
          }}
          onError={(e) =>
            toast.push({
              tag: "call-error",
              title: "Something went wrong",
              // Only our own sentences are shown; anything else is the provider's, and not for reading.
              body:
                e.name === NOTICE
                  ? e.message
                  : `If it keeps happening, leave and rejoin the ${session.call.mode === "webinar" ? "webinar" : "meeting"}.`,
              tone: "danger",
              icon: <CircleAlert className="size-5" />,
              duration: 8000,
            })
          }
        >
          <div className="flex h-dvh flex-col" data-in-call inert={covered}>
            <Conference code={code} />
          </div>
        </CallRoom>
      )}
      {covered &&
        // Saved name and device choices live in localStorage, so the form renders on the client only.
        (mounted ? (
          <div
            className={inCall ? `fixed inset-0 z-70 flex flex-col overflow-y-auto bg-bg ${ready ? "screen-out" : ""}` : "contents"}
            // While asking to join, the screen is still in use: it holds the way to stop asking.
            inert={inCall && !waiting}
            onAnimationEnd={(event) => {
              if (ready && event.target === event.currentTarget) setCovered(false);
            }}
          >
            {!peeked ? (
              <PreJoinSkeleton />
            ) : watching ? (
              <ViewerPreJoin
                code={code}
                joining={joining || inCall}
                waiting={waiting}
                access={seen.access}
                error={error}
                onJoin={join}
                onCancel={backToPreJoin}
              />
            ) : (
              <PreJoin
                code={code}
                joining={joining || inCall}
                waiting={waiting}
                access={seen?.access ?? "open"}
                isHost={seen?.host ?? false}
                peopleHere={seen?.count ?? null}
                noun={seen?.mode === "webinar" ? "webinar" : "meeting"}
                error={error}
                onJoin={join}
                onCancel={backToPreJoin}
              />
            )}
          </div>
        ) : (
          <PreJoinSkeleton />
        ))}
    </>
  );
}

/** What the screen says for each way the call ended. A webinar is named as one. */
const endings = (noun: "meeting" | "webinar"): Record<DisconnectReason, { icon: typeof LogOut; title: string; note: string }> => ({
  left: { icon: LogOut, title: `You left the ${noun}`, note: `The ${noun} stays open for others until everyone has left.` },
  dropped: {
    icon: Unplug,
    title: "You were disconnected",
    note: `The ${noun} stays open for others until everyone has left.`,
  },
  removed: { icon: UserX, title: "The host removed you", note: `You can't rejoin this ${noun} from this browser.` },
  denied: {
    icon: DoorClosed,
    title: "The host didn't let you in",
    note: "If that was a mistake, ask again or check with whoever sent you the link.",
  },
  ended: { icon: PhoneOff, title: `The host ended the ${noun}`, note: "The link still works if people want to meet again." },
  // Ended by our server's watchdog, not by the host (see src/lib/costGuard.server.ts). Only ever a webinar.
  limit: {
    icon: Hourglass,
    title: "This webinar reached its free time limit",
    note: "Webinars are free for now, so each one has a time limit. This link can't be joined again.",
  },
  paused: { icon: CirclePause, title: "Webinars are paused right now", note: "The webinar was ended for everyone. Try again later." },
});

function LeftScreen({
  code,
  departure,
  onRejoin,
}: {
  code: string;
  departure: Departure;
  onRejoin: () => void;
}) {
  const { minutes, reason, byYou, host, chat, pinned, people, noun } = departure;
  const said = chat.filter((message) => !message.deleted).length;
  const { icon: Icon, title, note } = endings(noun)[reason];
  const [planning, setPlanning] = useState(false);
  // Someone the host turned away is shown the way out first; coming back is the quieter option,
  // and for someone who was removed it is not an option at all. When the host ended the meeting
  // there is nobody to go back to, so the way out leads there too.
  const turnedAway = reason === "removed" || reason === "denied";
  // A webinar our server ended: there is nothing to rejoin, and no follow-up on a closed link.
  const closed = reason === "limit" || reason === "paused";
  const homeFirst = turnedAway || closed || (reason === "ended" && !byYou);
  const home = (
    <Link href="/" className={`btn ${homeFirst ? "btn-primary" : "btn-secondary"}`}>
      <Home className="size-[1.125rem]" aria-hidden="true" />
      Back to home
    </Link>
  );
  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl px-5 py-5 sm:px-8">
        <Logo />
      </header>
      {/* One column, top to bottom: what happened, the two ways on, what can still be kept, and
          only then the question about the call. On a phone it starts at the top, so the rating is
          on screen without scrolling; on a large screen it sits in the middle. */}
      <main className="anim-rise mx-auto flex w-full max-w-[34rem] flex-1 flex-col items-center gap-[1.125rem] px-4 pt-2 pb-10 text-center sm:justify-center sm:gap-6 sm:pb-28">
        <span className="grid size-16 shrink-0 place-items-center rounded-3xl bg-surface-2 text-muted shadow-[inset_0_0_0_1px_var(--border)]">
          <Icon className="size-7" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-2.5">
          <h1 className="font-display text-4xl leading-[1.05] font-semibold tracking-[-0.02em] sm:text-5xl">
            {byYou ? `You ended the ${noun}` : title}
          </h1>
          <p className="text-lg text-muted">
            <span className="font-mono text-[0.9em]">{code}</span>
            {minutes >= 1 && ` · ${minutes} min`}
          </p>
        </div>
        {/* Exactly two ways on (one for someone who was removed, or whose webinar our server ended): leaving, or coming back. */}
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center" data-leave-actions>
          {homeFirst && home}
          {reason !== "removed" && !closed && (
            <button className={`btn ${homeFirst ? "btn-secondary" : "btn-primary"}`} onClick={onRejoin} autoFocus={!homeFirst}>
              <RotateCcw className="size-[1.125rem]" aria-hidden="true" />
              {reason === "denied" ? "Ask again" : byYou ? "Start again" : "Rejoin"}
            </button>
          )}
          {!homeFirst && home}
        </div>
        {(said > 0 || (host && !closed)) && (
          // Keeping things is a different decision from where to go next, so it gets its own shape.
          <section
            aria-label={`Keep from this ${noun}`}
            className="w-full divide-y divide-border rounded-[1.25rem] bg-surface p-1.5 text-left shadow-[inset_0_0_0_1px_var(--border)]"
            data-keep
          >
            {/* First, because it is the only thing that is lost when this page closes. */}
            {said > 0 && (
              <KeepRow
                icon={Download}
                title="Save the chat"
                help={`${said === 1 ? "1 message" : `${fullCount(said)} messages`}. It's gone once you close this page.`}
                action="Save"
                actionLabel="Save chat"
                onAction={() => saveChat(code, chat, pinned)}
              />
            )}
            {/* The moment a follow-up is decided is when the meeting ends, and the host is the one
                who sends it. It keeps this link, so the host stays the host. */}
            {host && !closed && (
              <KeepRow
                icon={CalendarPlus}
                title="Schedule a follow-up"
                help="Same link. Add it to your calendar."
                action="Schedule"
                actionLabel="Schedule a follow-up"
                onAction={() => setPlanning(true)}
              />
            )}
          </section>
        )}
        {host && <ScheduleDialog code={code} mode="follow-up" open={planning} onOpenChange={setPlanning} />}
        <p className="text-sm text-faint">{byYou ? `Everyone has left the ${noun}. The link still works.` : note}</p>
        {/* Asked of people who were in the call and left it in the ordinary way; not of someone who was turned away. */}
        {!turnedAway && RATING_ENABLED && <CallRating minutes={minutes} people={people} />}
      </main>
    </div>
  );
}

/** One thing that can be kept from the meeting: what it is, a line on why, and a quiet button. */
function KeepRow({
  icon: Icon,
  title,
  help,
  action,
  actionLabel,
  onAction,
}: {
  icon: typeof Download;
  title: string;
  help: string;
  /** The button's visible word. */
  action: string;
  /** The button's full name, for screen readers and voice control; it starts with `action`. */
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3 pr-3 pl-2.5 sm:gap-3.5 sm:pl-3.5" data-keep-row>
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[0.8125rem] text-muted">{help}</span>
      </span>
      <button className="btn btn-secondary h-11 rounded-xl px-3.5 text-sm" onClick={onAction} aria-label={actionLabel}>
        {action}
      </button>
    </div>
  );
}

/** Off until answers have somewhere to go: asking and then discarding the answer would mislead. */
const RATING_ENABLED = process.env.NEXT_PUBLIC_CALL_RATING === "1";

/**
 * "How was the call?", answered with one tap. The answer goes to `sendUsageEvent`, which today
 * reaches nothing (see src/lib/usage.ts): there is no storage to keep it in.
 */
function CallRating({ minutes, people }: { minutes: number; people: number }) {
  const [rated, setRated] = useState(false);
  const label = useId();
  const rate = (rating: "good" | "bad") => {
    sendUsageEvent({ kind: "call-rating", rating, size: sizeBucket(people), length: lengthBucket(minutes), device: deviceClass() });
    setRated(true);
  };
  return (
    <div data-call-rating className="flex min-h-11 w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 border-t border-border pt-6 text-sm text-muted max-sm:[&>p]:w-full">
      {rated ? (
        <p role="status" className="anim-fade">
          Thanks.
        </p>
      ) : (
        <>
          <p id={label}>How were the sound and video?</p>
          <div role="group" aria-labelledby={label} className="flex gap-2">
            <button className="btn btn-secondary h-11 rounded-xl px-4 text-sm" onClick={() => rate("good")}>
              <ThumbsUp className="size-4" aria-hidden="true" />
              Good
            </button>
            <button className="btn btn-secondary h-11 rounded-xl px-4 text-sm" onClick={() => rate("bad")}>
              <ThumbsDown className="size-4" aria-hidden="true" />
              Not good
            </button>
          </div>
        </>
      )}
    </div>
  );
}
