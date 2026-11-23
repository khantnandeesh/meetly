"use client";

import { DoorOpen, ShieldCheck, ShieldMinus, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { cameraToggledByYou } from "@/lib/ownToggles";
import { useCall } from "@/lib/rtc/react";
import { waitingSentence } from "@/lib/notices";
import { playKnockSound, setOffByHost } from "@/lib/useSounds";
import { useHost } from "./HostTools";
import { useToast } from "./ui/Toaster";

/**
 * What moderation looks like from the receiving end, one signal each:
 *
 * - Somebody asks to join: the host and co-hosts get a notification that stays until it is
 *   answered, with the answer on it, and a knock for a new arrival, at most one every 30 seconds
 *   (see SOUNDS in src/lib/sounds.ts). It counts rather than names once there are two, and is
 *   left out while the people list (where they are listed, with the same buttons) is open;
 *   closing the list brings it back if anyone is still waiting. Closed with its ×, it stays away
 *   until somebody new arrives: people leaving the queue, or the list opening and closing, do
 *   not bring it back. (The count on the People button is the standing reminder, not a second
 *   announcement.) It outranks every other notification (src/lib/notices.ts).
 * - You were made a co-host, or stopped being one: a notification, one at a time, the latest
 *   replacing the one before.
 * - The host turned your camera off: a notification, and the camera button says so until you
 *   turn it back on. Being muted has had its own since before (see useCallSounds); "mute all"
 *   arrives the same way.
 *
 * Mount once, inside <HostProvider>.
 */
export function ModerationNotices({
  localIdentity,
  peopleOpen,
  onShowPeople,
}: {
  localIdentity: string;
  /** The people list, which shows who is waiting, is open. */
  peopleOpen: boolean;
  onShowPeople: () => void;
}) {
  const call = useCall();
  const toast = useToast();
  const { waiting, canModerate, coHosts, admit, deny, openWaiting } = useHost();

  // Read when a notification's button is pressed, so a new function identity never re-raises one.
  const answers = useRef({ admit, deny, onShowPeople, openWaiting });
  useEffect(() => {
    answers.current = { admit, deny, onShowPeople, openWaiting };
  });

  const known = useRef(new Set<string>());
  // Who was waiting when the notification was closed with its ×. It stays closed while nobody
  // outside this group is waiting.
  const dismissed = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!canModerate || waiting.length === 0) {
      known.current = new Set();
      dismissed.current = null;
      toast.dismissTag("knock");
      return;
    }
    const someoneNew = waiting.some((person) => !known.current.has(person.id));
    known.current = new Set(waiting.map((person) => person.id));
    // The notification updates in place as people come and go; only a new arrival knocks.
    if (someoneNew) playKnockSound();
    const closed = dismissed.current;
    if (closed && waiting.every((person) => closed.has(person.id))) return;
    dismissed.current = null;
    if (peopleOpen) {
      toast.dismissTag("knock");
      return;
    }
    const [first] = waiting;
    const title = waitingSentence(waiting.length, first.name || "Guest");
    const ids = waiting.map((person) => person.id);
    // View opens the people list: with more than 5 waiting, straight at the "Waiting to join"
    // view (openWaiting decides which), otherwise at the top, where they are listed with Admit all.
    const view = () => {
      answers.current.openWaiting();
      answers.current.onShowPeople();
    };
    const common = {
      tag: "knock",
      priority: "action" as const,
      duration: Infinity,
      icon: <DoorOpen className="size-5" />,
      title,
      // In the one-line strip over a phone's top bar there is room for one answer.
      compactAction: { label: "View", onClick: view },
      onDismiss: () => {
        dismissed.current = new Set(ids);
      },
    };
    toast.push(
      waiting.length === 1
        ? {
            ...common,
            secondary: { label: "Deny", onClick: () => answers.current.deny(first) },
            action: { label: "Admit", onClick: () => answers.current.admit(first) },
          }
        : { ...common, action: { label: "View", onClick: view } },
    );
  }, [waiting, canModerate, peopleOpen, toast]);

  const wasCoHost = useRef<boolean | null>(null);
  useEffect(() => {
    if (!localIdentity) return;
    const now = coHosts.includes(localIdentity);
    if (wasCoHost.current !== null && now !== wasCoHost.current) {
      toast.push(
        now
          ? {
              tag: "role-self",
              priority: "you",
              icon: <ShieldCheck className="size-5" />,
              title: "You're now a co-host",
              body: "You can mute, remove and admit people.",
              duration: 7000,
            }
          : { tag: "role-self", priority: "you", icon: <ShieldMinus className="size-5" />, title: "You're no longer a co-host" },
      );
    }
    wasCoHost.current = now;
  }, [coHosts, localIdentity, toast]);

  useEffect(() => {
    let was = call.localMedia().camera;
    return call.on("localMedia", () => {
      const now = call.localMedia().camera;
      if (now) setOffByHost("camera", false);
      if (was && !now && call.status === "connected" && !cameraToggledByYou()) {
        setOffByHost("camera", true);
        toast.push({ tag: "cam-by-host", priority: "you", icon: <VideoOff className="size-5" />, title: "The host turned off your camera" });
      }
      was = now;
    });
  }, [call, toast]);

  return null;
}
