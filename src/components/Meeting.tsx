"use client";

import { CircleAlert, DoorClosed, Download, Home, LogOut, PhoneOff, RotateCcw, ThumbsDown, ThumbsUp, Unplug, UserX } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { saveChat } from "@/lib/chatExport";
import { useMounted } from "@/lib/hooks";
import { loadProvider, peekMeeting, requestJoin } from "@/lib/rtc/provider";
import { CallRoom } from "@/lib/rtc/react";
import type { ConnectionStatus, DisconnectReason, JoinAccess, JoinChoices, RtcCall, RtcChatMessage } from "@/lib/rtc/types";
import { sounds } from "@/lib/sounds";
import { deviceClass, lengthBucket, sendUsageEvent, sizeBucket } from "@/lib/usage";
import { playCallEndedSound } from "@/lib/useSounds";
import { Conference } from "./Conference";
import { PreJoin, PreJoinSkeleton } from "./PreJoin";
import { Logo } from "./ui/Logo";
import { useToast } from "./ui/Toaster";

type Session = { call: RtcCall; joinedAt: number };
type Stage = "prejoin" | "joined" | "left";
type Departure = {
  minutes: number;
  reason: DisconnectReason;
  byYou: boolean;
  /** The conversation as it stood when the call ended for you: the last chance to keep it. */
  chat: RtcChatMessage[];
  pinned: RtcChatMessage | null;
  /** The most people who were in the call at once while you were. */
  people: number;
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
  const [departure, setDeparture] = useState<Departure>({ minutes: 0, reason: "left", byYou: false, chat: [], pinned: null, people: 1 });
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
  /** Who may join, and whether this browser is the host. Asked each time the pre-join screen is up. */
  const [seen, setSeen] = useState<{ access: JoinAccess; host: boolean } | null>(null);

  useEffect(() => {
    if (stage !== "prejoin") return;
    let current = true;
    void peekMeeting(code).then((answer) => {
      if (current && answer) setSeen(answer);
    });
    return () => {
      current = false;
    };
  }, [code, stage]);

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
      setError(e instanceof Error ? e.message : "Could not join the meeting.");
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
              chat: call.chatMessages(),
              pinned: call.pinnedMessage(),
              people: mostPeople.current,
            });
            setStage("left");
          }}
          onError={(e) =>
            toast.push({
              title: "Something went wrong",
              body: e.message,
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
            <PreJoin
              code={code}
              joining={joining || inCall}
              waiting={waiting}
              access={seen?.access ?? "open"}
              isHost={seen?.host ?? false}
              error={error}
              onJoin={join}
              onCancel={backToPreJoin}
            />
          </div>
        ) : (
          <PreJoinSkeleton />
        ))}
    </>
  );
}

const ENDINGS: Record<DisconnectReason, { icon: typeof LogOut; title: string; note: string }> = {
  left: { icon: LogOut, title: "You left the meeting", note: "The meeting stays open for others until everyone has left." },
  dropped: {
    icon: Unplug,
    title: "You were disconnected",
    note: "The meeting stays open for others until everyone has left.",
  },
  removed: { icon: UserX, title: "The host removed you", note: "You can't rejoin this meeting from this browser." },
  denied: {
    icon: DoorClosed,
    title: "The host didn't let you in",
    note: "If that was a mistake, ask again or check with whoever sent you the link.",
  },
  ended: { icon: PhoneOff, title: "The host ended the meeting", note: "The link works again if the host starts a new call." },
};

function LeftScreen({
  code,
  departure,
  onRejoin,
}: {
  code: string;
  departure: Departure;
  onRejoin: () => void;
}) {
  const { minutes, reason, byYou, chat, pinned, people } = departure;
  const canSaveChat = chat.some((message) => !message.deleted);
  const { icon: Icon, title, note } = ENDINGS[reason];
  // Someone the host turned away is shown the way out first; coming back is the quieter option,
  // and for someone who was removed it is not an option at all.
  const turnedAway = reason === "removed" || reason === "denied";
  const home = (
    <Link href="/" className={`btn ${turnedAway ? "btn-primary" : "btn-secondary"}`}>
      <Home className="size-[1.125rem]" aria-hidden="true" />
      Back to home
    </Link>
  );
  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl px-5 py-5 sm:px-8">
        <Logo />
      </header>
      <main className="anim-rise mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-5 pb-28 text-center">
        <span className="grid size-16 place-items-center rounded-3xl bg-surface-2 text-muted shadow-[inset_0_0_0_1px_var(--border)]">
          <Icon className="size-7" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-4xl leading-[1.05] font-semibold tracking-[-0.02em] sm:text-5xl">
            {byYou ? "You ended the meeting" : title}
          </h1>
          <p className="text-lg text-muted">
            {reason === "dropped" ? "The connection to the call was lost. " : ""}
            <span className="font-mono text-[0.9em]">{code}</span>
            {minutes >= 1 && ` · ${minutes} min in the call`}
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          {turnedAway && home}
          {reason !== "removed" && (
            <button className={`btn ${turnedAway ? "btn-secondary" : "btn-primary"}`} onClick={onRejoin} autoFocus={!turnedAway}>
              <RotateCcw className="size-[1.125rem]" aria-hidden="true" />
              {reason === "denied" ? "Ask again" : byYou ? "Start again" : "Rejoin"}
            </button>
          )}
          {!turnedAway && home}
          {canSaveChat && (
            <button className="btn btn-quiet" onClick={() => saveChat(code, chat, pinned)}>
              <Download className="size-[1.125rem]" aria-hidden="true" />
              Save chat
            </button>
          )}
        </div>
        <p className="text-sm text-faint">{byYou ? "Everyone was disconnected. The link still works." : note}</p>
        {/* Asked of people who were in the call and left it in the ordinary way; not of someone who was turned away. */}
        {!turnedAway && <CallRating minutes={minutes} people={people} />}
      </main>
    </div>
  );
}

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
    <div data-call-rating className="flex min-h-11 flex-wrap items-center justify-center gap-x-3 gap-y-2 border-t border-border pt-6 text-sm text-muted">
      {rated ? (
        <p role="status" className="anim-fade">
          Thanks.
        </p>
      ) : (
        <>
          <p id={label}>How was the call?</p>
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
