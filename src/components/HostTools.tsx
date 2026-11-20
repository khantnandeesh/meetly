"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  CircleAlert,
  EllipsisVertical,
  Hand,
  MicOff,
  PhoneOff,
  ShieldCheck,
  ShieldMinus,
  UserX,
  VideoOff,
} from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useAccess, useCall, useCoHosts, useHostIdentity, useWaiting } from "@/lib/rtc/react";
import { displayName, type HostAction, type JoinAccess, type RtcParticipant, type RtcWaiter } from "@/lib/rtc/types";
import { Dropdown } from "./ui/Menu";
import { useToast } from "./ui/Toaster";

type HostState = {
  /** Identity of the meeting host, as recorded by the server. */
  hostId: string | null;
  coHosts: string[];
  /** True when the local participant is that host. */
  isHost: boolean;
  /** Host or co-host: may mute, remove, let people in and change who can join. */
  canModerate: boolean;
  access: JoinAccess;
  waiting: RtcWaiter[];
  /** What this meeting's provider can enforce (see `RtcCall.supports`). */
  supports: { askToJoin: boolean; stopCamera: boolean };
  mute: (participant: RtcParticipant) => void;
  stopCamera: (participant: RtcParticipant) => void;
  lowerHand: (participant: RtcParticipant) => void;
  setCoHost: (participant: RtcParticipant, on: boolean) => void;
  /** `from` names the menu button it was asked from, so focus can return there. */
  askRemove: (participant: RtcParticipant, from?: string) => void;
  muteAll: () => void;
  lowerAllHands: () => void;
  setAccess: (access: JoinAccess) => void;
  admit: (waiter: RtcWaiter) => void;
  deny: (waiter: RtcWaiter) => void;
  admitAll: () => void;
  /** Asks first: ending the call for everyone cannot be undone. */
  askEnd: () => void;
};

const nothing = () => {};
const HostContext = createContext<HostState>({
  hostId: null,
  coHosts: [],
  isHost: false,
  canModerate: false,
  access: "open",
  waiting: [],
  supports: { askToJoin: false, stopCamera: false },
  mute: nothing,
  stopCamera: nothing,
  lowerHand: nothing,
  setCoHost: nothing,
  askRemove: nothing,
  muteAll: nothing,
  lowerAllHands: nothing,
  setAccess: nothing,
  admit: nothing,
  deny: nothing,
  admitAll: nothing,
  askEnd: nothing,
});
export const useHost = () => useContext(HostContext);

export const ACCESS_LABELS: Record<JoinAccess, { label: string; hint: string }> = {
  open: { label: "Anyone with the link", hint: "People join straight away" },
  ask: { label: "People ask to join", hint: "You let each person in" },
  locked: { label: "Locked", hint: "Nobody new can join" },
};

const dialogClass =
  "dialog fixed top-1/2 left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 rounded-3xl bg-surface p-6 shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)]";

/**
 * Who the host and co-hosts are comes from the provider, in a form only our server can write.
 * The buttons here are a convenience: every one of them is a request to /api/host, which looks
 * up what the caller may do from their signed token before doing anything.
 */
export function HostProvider({ localIdentity, children }: { localIdentity: string; children: React.ReactNode }) {
  const call = useCall();
  const hostId = useHostIdentity();
  const coHosts = useCoHosts();
  const access = useAccess();
  const waiting = useWaiting();
  const toast = useToast();
  const [removing, setRemoving] = useState<RtcParticipant | null>(null);
  const [alsoAsk, setAlsoAsk] = useState(false);
  const [ending, setEnding] = useState(false);
  const lastAsked = useRef<string | null>(null);

  const isHost = hostId !== null && hostId === localIdentity;
  const canModerate = isHost || (!!localIdentity && coHosts.includes(localIdentity));
  // Known once the call is connected; this component re-renders then (the host hook follows the status).
  const { askToJoin, stopCamera: canStopCamera } = call.supports;
  const supports = useMemo(() => ({ askToJoin, stopCamera: canStopCamera }), [askToJoin, canStopCamera]);

  /** One request, one answer: a quiet confirmation, or what went wrong. */
  const run = useCallback(
    async (action: HostAction, done: { icon: React.ReactNode; title: string } | null, failed: string) => {
      try {
        await call.moderate(action);
        if (done) toast.push({ ...done, priority: "you" });
        return true;
      } catch (error) {
        toast.push({
          // One at a time: "Admit all" that fails for fifty people is one notification, not fifty.
          tag: "host-error",
          tone: "danger",
          icon: <CircleAlert className="size-5" />,
          title: failed,
          body: error instanceof Error ? error.message : undefined,
        });
        return false;
      }
    },
    [call, toast],
  );

  const value = useMemo<HostState>(() => {
    const named = (participant: RtcParticipant) => displayName(participant);
    const waiter = (person: RtcWaiter) => person.name || "Guest";
    return {
      hostId,
      coHosts,
      isHost,
      canModerate,
      access,
      waiting,
      supports,
      mute: (p) =>
        void run(
          { action: "mute", identity: p.identity },
          // Their microphone icon changing, on the row you pressed, is the confirmation.
          null,
          `Couldn't mute ${named(p)}`,
        ),
      stopCamera: (p) =>
        void run(
          { action: "stopCamera", identity: p.identity },
          null,
          `Couldn't turn off ${named(p)}'s camera`,
        ),
      // The hand going down in front of you is the confirmation.
      lowerHand: (p) => void run({ action: "lowerHand", identity: p.identity }, null, `Couldn't lower ${named(p)}'s hand`),
      setCoHost: (p, on) =>
        void run(
          { action: "coHost", identity: p.identity, on },
          {
            icon: on ? <ShieldCheck className="size-5" /> : <ShieldMinus className="size-5" />,
            title: on ? `${named(p)} is now a co-host` : `${named(p)} is no longer a co-host`,
          },
          on ? `Couldn't make ${named(p)} a co-host` : `Couldn't remove ${named(p)} as co-host`,
        ),
      askRemove: (participant, from) => {
        lastAsked.current = `${participant.identity}:${from ?? "row"}`;
        setAlsoAsk(false);
        setRemoving(participant);
      },
      muteAll: () =>
        void run({ action: "muteAll" }, { icon: <MicOff className="size-5" />, title: "You muted everyone" }, "Couldn't mute everyone"),
      lowerAllHands: () => void run({ action: "lowerAllHands" }, null, "Couldn't lower everyone's hands"),
      // The control showing the new choice is the confirmation.
      setAccess: (next) => void run({ action: "access", access: next }, null, "Couldn't change who can join"),
      // Their tile arriving, or their row going, is the confirmation.
      admit: (person) => void run({ action: "admit", identity: person.id }, null, `Couldn't admit ${waiter(person)}`),
      deny: (person) => void run({ action: "deny", identity: person.id }, null, `Couldn't deny ${waiter(person)}`),
      admitAll: () => waiting.forEach((person) => void run({ action: "admit", identity: person.id }, null, `Couldn't admit ${waiter(person)}`)),
      askEnd: () => setEnding(true),
    };
  }, [hostId, coHosts, isHost, canModerate, access, waiting, supports, run]);

  async function remove(participant: RtcParticipant, thenAsk: boolean) {
    const name = displayName(participant);
    const removed = await run(
      { action: "remove", identity: participant.identity },
      { icon: <UserX className="size-5" />, title: `You removed ${name}` },
      `Couldn't remove ${name}`,
    );
    if (removed && thenAsk) await run({ action: "access", access: "ask" }, null, "Couldn't change who can join");
  }

  return (
    <HostContext.Provider value={value}>
      {children}
      <Dialog.Root open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
          <Dialog.Content
            onCloseAutoFocus={(event) => {
              // The menu item that opened this is gone; go back to the button that opened the menu.
              const id = lastAsked.current;
              const button = id ? document.querySelector<HTMLElement>(`[data-host-menu="${CSS.escape(id)}"]`) : null;
              if (button) {
                event.preventDefault();
                button.focus();
              }
            }}
            className={dialogClass}
          >
            <div className="flex flex-col gap-2">
              <Dialog.Title className="font-display text-xl font-semibold">
                Remove {removing ? displayName(removing) : ""}?
              </Dialog.Title>
              <Dialog.Description className="text-[0.9375rem] leading-relaxed text-muted">
                They leave the meeting now and can&apos;t rejoin from that browser.
              </Dialog.Description>
            </div>
            {access === "open" && supports.askToJoin && (
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-surface-2 p-3.5 text-[0.9375rem] leading-snug">
                <input
                  type="checkbox"
                  checked={alsoAsk}
                  onChange={(event) => setAlsoAsk(event.target.checked)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md text-transparent shadow-[inset_0_0_0_1.5px_var(--border-strong)] transition-colors peer-checked:bg-accent peer-checked:text-accent-ink peer-checked:shadow-none peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
                >
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
                <span>
                  <span className="block font-medium">Make new people ask to join</span>
                  <span className="block text-sm text-muted">Stops them rejoining from another browser.</span>
                </span>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close className="btn btn-quiet h-11 rounded-xl px-4">Cancel</Dialog.Close>
              <button
                className="btn h-11 rounded-xl bg-danger px-4 text-white hover:bg-(--danger-hover)"
                onClick={() => {
                  if (removing) void remove(removing, alsoAsk);
                  setRemoving(null);
                }}
              >
                Remove from meeting
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={ending} onOpenChange={setEnding}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
          <Dialog.Content className={dialogClass}>
            <div className="flex flex-col gap-2">
              <Dialog.Title className="font-display text-xl font-semibold">End the meeting for everyone?</Dialog.Title>
              <Dialog.Description className="text-[0.9375rem] leading-relaxed text-muted">
                Everyone leaves the meeting, including you. The link still works if you want to meet again.
              </Dialog.Description>
            </div>
            <div className="flex justify-end gap-2">
              <Dialog.Close className="btn btn-quiet h-11 rounded-xl px-4">Cancel</Dialog.Close>
              <button
                className="btn h-11 rounded-xl bg-danger px-4 text-white hover:bg-(--danger-hover)"
                onClick={() => {
                  setEnding(false);
                  // The goodbye screen is the confirmation.
                  void run({ action: "end" }, null, "Couldn't end the meeting");
                }}
              >
                <PhoneOff className="size-[1.125rem]" aria-hidden="true" />
                End meeting
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </HostContext.Provider>
  );
}

/**
 * "More" menu with the moderation actions for one participant. Renders nothing for people who
 * may not moderate, for yourself, and (for a co-host) for the host.
 */
export function HostMenu({
  participant,
  micOn,
  camOn,
  handRaised,
  variant,
}: {
  participant: RtcParticipant;
  micOn: boolean;
  camOn: boolean;
  handRaised: boolean;
  variant: "row" | "tile";
}) {
  const { canModerate, isHost, hostId, coHosts, supports, mute, stopCamera, lowerHand, setCoHost, askRemove } = useHost();
  if (!canModerate || participant.isLocal || participant.identity === hostId) return null;
  const name = displayName(participant);
  const isCoHost = coHosts.includes(participant.identity);
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        aria-label={`Host controls for ${name}`}
        data-host-menu={`${participant.identity}:${variant}`}
        className={
          variant === "tile"
            ? "grid size-10 cursor-pointer place-items-center rounded-xl bg-[rgb(11_11_15/0.72)] text-text backdrop-blur-md hover:bg-[rgb(40_40_52/0.9)] pointer-coarse:size-11"
            : "icon-btn size-8 pointer-coarse:size-11"
        }
      >
        <EllipsisVertical className="size-[1.125rem]" />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={6} collisionPadding={12} className="menu">
          <Dropdown.Label className="menu-label">{name}</Dropdown.Label>
          <Dropdown.Item className="menu-item" disabled={!micOn} onSelect={() => mute(participant)}>
            <MicOff className="size-4 text-muted" aria-hidden="true" />
            {micOn ? "Mute microphone" : "Already muted"}
          </Dropdown.Item>
          {supports.stopCamera && (
            <Dropdown.Item className="menu-item" disabled={!camOn} onSelect={() => stopCamera(participant)}>
              <VideoOff className="size-4 text-muted" aria-hidden="true" />
              {camOn ? "Turn off camera" : "Camera already off"}
            </Dropdown.Item>
          )}
          {handRaised && (
            <Dropdown.Item className="menu-item" onSelect={() => lowerHand(participant)}>
              <Hand className="size-4 text-muted" aria-hidden="true" />
              Lower hand
            </Dropdown.Item>
          )}
          {isHost && (
            <Dropdown.Item className="menu-item" onSelect={() => setCoHost(participant, !isCoHost)}>
              {isCoHost ? (
                <ShieldMinus className="size-4 text-muted" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-4 text-muted" aria-hidden="true" />
              )}
              {isCoHost ? "Remove as co-host" : "Make co-host"}
            </Dropdown.Item>
          )}
          <div className="menu-sep" />
          <Dropdown.Item className="menu-item text-danger-text" onSelect={() => askRemove(participant, variant)}>
            <UserX className="size-4" aria-hidden="true" />
            Remove from meeting
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
