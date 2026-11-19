"use client";

import { LiveKitRoom, type LocalUserChoices } from "@livekit/components-react";
import { DisconnectReason, type RoomOptions } from "livekit-client";
import { CircleAlert, Home, LogOut, RotateCcw, Unplug, UserX } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMounted } from "@/lib/hooks";
import { sounds } from "@/lib/sounds";
import { playCallEndedSound } from "@/lib/useSounds";
import { Conference } from "./Conference";
import { PreJoin, PreJoinSkeleton } from "./PreJoin";
import { Logo } from "./ui/Logo";
import { useToast } from "./ui/Toaster";

type Session = { token: string; serverUrl: string; choices: LocalUserChoices; joinedAt: number };
type Stage = "prejoin" | "joined" | "left";
type Departure = { minutes: number; dropped: boolean; removed: boolean };

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
  const [departure, setDeparture] = useState<Departure>({ minutes: 0, dropped: false, removed: false });

  const roomOptions = useMemo<RoomOptions>(
    () => ({
      adaptiveStream: true, // only pull the resolution each tile actually needs
      dynacast: true, // stop publishing layers nobody is watching
      publishDefaults: { simulcast: true },
    }),
    [],
  );

  async function join(choices: LocalUserChoices) {
    // Still inside the click that joins: the only moment a browser lets audio be switched on.
    sounds.unlock();
    setError(null);
    setJoining(true);
    try {
      const response = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: code, name: choices.username }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not join the meeting.");
      setSession({ token: data.token, serverUrl: data.serverUrl, choices, joinedAt: Date.now() });
      setReady(false);
      setCovered(true);
      setStage("joined");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join the meeting.");
    } finally {
      setJoining(false);
    }
  }

  if (stage === "left") {
    return <LeftScreen code={code} departure={departure} onRejoin={() => {
          setReady(false);
          setCovered(true);
          setStage("prejoin");
        }} />;
  }

  // The pre-join screen stays up, with its live preview, until the room is connected and the
  // stage is drawn underneath; then it fades away to reveal it. One hand-over, not three screens.
  const inCall = stage === "joined" && session !== null;
  return (
    <>
      {inCall && (
        <LiveKitRoom
          token={session.token}
          serverUrl={session.serverUrl}
          connect
          options={roomOptions}
          audio={session.choices.audioEnabled ? { deviceId: session.choices.audioDeviceId || undefined } : false}
          video={session.choices.videoEnabled ? { deviceId: session.choices.videoDeviceId || undefined } : false}
          onConnected={() => setReady(true)}
          onDisconnected={(reason) => {
            toast.clear();
            playCallEndedSound();
            setDeparture({
              minutes: Math.round((Date.now() - session.joinedAt) / 60_000),
              removed: reason === DisconnectReason.PARTICIPANT_REMOVED,
              dropped:
                reason !== undefined &&
                reason !== DisconnectReason.CLIENT_INITIATED &&
                reason !== DisconnectReason.PARTICIPANT_REMOVED,
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
          {/* Own wrapper for sizing: LiveKitRoom's element doesn't take part in layout. */}
          <div className="flex h-dvh flex-col" data-in-call inert={covered}>
            <Conference code={code} token={session.token} />
          </div>
        </LiveKitRoom>
      )}
      {covered &&
        // Saved name and device choices live in localStorage, so the form renders on the client only.
        (mounted ? (
          <div
            className={inCall ? `fixed inset-0 z-70 flex flex-col overflow-y-auto bg-bg ${ready ? "screen-out" : ""}` : "contents"}
            inert={inCall}
            onAnimationEnd={(event) => {
              if (ready && event.target === event.currentTarget) setCovered(false);
            }}
          >
            <PreJoin code={code} joining={joining || inCall} error={error} onJoin={join} />
          </div>
        ) : (
          <PreJoinSkeleton />
        ))}
    </>
  );
}

function LeftScreen({
  code,
  departure,
  onRejoin,
}: {
  code: string;
  departure: Departure;
  onRejoin: () => void;
}) {
  const { minutes, dropped, removed } = departure;
  const Icon = removed ? UserX : dropped ? Unplug : LogOut;
  const home = (
    <Link href="/" className={`btn ${removed ? "btn-primary" : "btn-secondary"}`}>
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
            {removed ? "The host removed you" : dropped ? "You were disconnected" : "You left the meeting"}
          </h1>
          <p className="text-lg text-muted">
            {dropped ? "The connection to the call was lost. " : ""}
            <span className="font-mono text-[0.9em]">{code}</span>
            {minutes >= 1 && ` · ${minutes} min in the call`}
          </p>
        </div>
        {/* Someone the host removed is shown the way out first; coming straight back is the quieter option. */}
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          {removed && home}
          <button className={`btn ${removed ? "btn-secondary" : "btn-primary"}`} onClick={onRejoin} autoFocus={!removed}>
            <RotateCcw className="size-[1.125rem]" aria-hidden="true" />
            Rejoin
          </button>
          {!removed && home}
        </div>
        <p className="text-sm text-faint">The meeting stays open for others until everyone has left.</p>
      </main>
    </div>
  );
}
