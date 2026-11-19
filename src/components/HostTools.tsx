"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRoomInfo } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { CircleAlert, EllipsisVertical, MicOff, UserX } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { displayName } from "@/lib/participant";
import { Dropdown } from "./ui/Menu";
import { useToast } from "./ui/Toaster";

type HostState = {
  /** Identity of the meeting host, as recorded by the server in the room metadata. */
  hostId: string | null;
  /** True when the local participant is that host. */
  isHost: boolean;
  mute: (participant: Participant) => void;
  /** `from` names the menu button it was asked from, so focus can return there. */
  askRemove: (participant: Participant, from?: string) => void;
};

const HostContext = createContext<HostState>({ hostId: null, isHost: false, mute: () => {}, askRemove: () => {} });
export const useHost = () => useContext(HostContext);

/**
 * Who the host is comes from room metadata, which only the server can write. The buttons here
 * are a convenience: /api/host re-checks the caller's signed token before doing anything.
 */
export function HostProvider({
  token,
  localIdentity,
  children,
}: {
  token: string;
  localIdentity: string;
  children: React.ReactNode;
}) {
  const { metadata } = useRoomInfo();
  const toast = useToast();
  const [removing, setRemoving] = useState<Participant | null>(null);
  const lastAsked = useRef<string | null>(null);

  const hostId = useMemo(() => {
    try {
      const host = JSON.parse(metadata || "{}")?.host;
      return typeof host === "string" ? host : null;
    } catch {
      return null;
    }
  }, [metadata]);

  const act = useCallback(
    async (action: "mute" | "remove", participant: Participant) => {
      const name = displayName(participant);
      try {
        const response = await fetch("/api/host", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, action, identity: participant.identity }),
        });
        if (!response.ok) throw new Error((await response.json()).error);
        toast.push({
          icon: action === "mute" ? <MicOff className="size-5" /> : <UserX className="size-5" />,
          title: action === "mute" ? `You muted ${name}` : `You removed ${name}`,
        });
      } catch (error) {
        toast.push({
          tone: "danger",
          icon: <CircleAlert className="size-5" />,
          title: action === "mute" ? `Couldn't mute ${name}` : `Couldn't remove ${name}`,
          body: error instanceof Error ? error.message : undefined,
        });
      }
    },
    [token, toast],
  );

  const value = useMemo<HostState>(
    () => ({
      hostId,
      isHost: hostId !== null && hostId === localIdentity,
      mute: (participant) => void act("mute", participant),
      askRemove: (participant, from) => {
        lastAsked.current = `${participant.identity}:${from ?? "row"}`;
        setRemoving(participant);
      },
    }),
    [hostId, localIdentity, act],
  );

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
            className="dialog fixed top-1/2 left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 rounded-3xl bg-surface p-6 shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)]">
            <div className="flex flex-col gap-2">
              <Dialog.Title className="font-display text-xl font-semibold">
                Remove {removing ? displayName(removing) : ""}?
              </Dialog.Title>
              <Dialog.Description className="text-[0.9375rem] leading-relaxed text-muted">
                They&apos;ll be disconnected straight away. Anyone with the link can still join again.
              </Dialog.Description>
            </div>
            <div className="flex justify-end gap-2">
              <Dialog.Close className="btn btn-quiet h-11 rounded-xl px-4">Cancel</Dialog.Close>
              <button
                className="btn h-11 rounded-xl bg-danger px-4 text-white hover:bg-(--danger-hover)"
                onClick={() => {
                  if (removing) void act("remove", removing);
                  setRemoving(null);
                }}
              >
                Remove
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </HostContext.Provider>
  );
}

/** "More" menu with the host's actions for one participant. Renders nothing for non-hosts. */
export function HostMenu({ participant, micOn, variant }: { participant: Participant; micOn: boolean; variant: "row" | "tile" }) {
  const { isHost, mute, askRemove } = useHost();
  if (!isHost || participant.isLocal) return null;
  const name = displayName(participant);
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
          <div className="menu-sep" />
          <Dropdown.Item className="menu-item text-danger-text" onSelect={() => askRemove(participant, variant)}>
            <UserX className="size-4" aria-hidden="true" />
            Remove from call
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
