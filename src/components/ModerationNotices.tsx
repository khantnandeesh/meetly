"use client";

import { DoorOpen, ShieldCheck, ShieldMinus, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { cameraToggledByYou } from "@/lib/ownToggles";
import { useCall } from "@/lib/rtc/react";
import { waitingSentence } from "@/lib/notices";
import { playKnockSound } from "@/lib/useSounds";
import { useHost } from "./HostTools";
import { useToast } from "./ui/Toaster";

/**
 * What moderation looks like from the receiving end, one signal each:
 *
 * - Somebody asks to join: the host and co-hosts get a notification that stays until it is
 *   answered, with the answer on it, and one knock for each burst of arrivals. It counts rather
 *   than names once there are two, and is left out while the people list (where they are
 *   listed, with the same buttons) is open; closing the list brings it back if anyone is still
 *   waiting. (The count on the People button is the standing reminder, not a second
 *   announcement.) It outranks every other notification (src/lib/notices.ts).
 * - You were made a co-host, or stopped being one: a notification.
 * - The host turned your camera off: a notification. Being muted has had its own since before
 *   (see useCallSounds); "mute all" arrives the same way.
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
  const { waiting, canModerate, coHosts, admit, deny } = useHost();

  // Read when a notification's button is pressed, so a new function identity never re-raises one.
  const answers = useRef({ admit, deny, onShowPeople });
  useEffect(() => {
    answers.current = { admit, deny, onShowPeople };
  });

  const known = useRef(new Set<string>());
  useEffect(() => {
    if (!canModerate || waiting.length === 0) {
      known.current = new Set();
      toast.dismissTag("knock");
      return;
    }
    const someoneNew = waiting.some((person) => !known.current.has(person.id));
    known.current = new Set(waiting.map((person) => person.id));
    // The notification updates in place as people come and go; only a new arrival knocks.
    if (someoneNew) playKnockSound();
    if (peopleOpen) {
      toast.dismissTag("knock");
      return;
    }
    const [first] = waiting;
    const title = waitingSentence(waiting.length, first.name || "Guest");
    toast.push(
      waiting.length === 1
        ? {
            tag: "knock",
            priority: "action",
            duration: Infinity,
            icon: <DoorOpen className="size-5" />,
            title,
            secondary: { label: "Deny", onClick: () => answers.current.deny(first) },
            action: { label: "Admit", onClick: () => answers.current.admit(first) },
          }
        : {
            tag: "knock",
            priority: "action",
            duration: Infinity,
            icon: <DoorOpen className="size-5" />,
            title,
            action: { label: "View", onClick: () => answers.current.onShowPeople() },
          },
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
              priority: "you",
              icon: <ShieldCheck className="size-5" />,
              title: "You're now a co-host",
              body: "You can mute and remove people, and decide who joins.",
              duration: 7000,
            }
          : { priority: "you", icon: <ShieldMinus className="size-5" />, title: "You're no longer a co-host" },
      );
    }
    wasCoHost.current = now;
  }, [coHosts, localIdentity, toast]);

  useEffect(() => {
    let was = call.localMedia().camera;
    return call.on("localMedia", () => {
      const now = call.localMedia().camera;
      if (was && !now && call.status === "connected" && !cameraToggledByYou()) {
        toast.push({ priority: "you", icon: <VideoOff className="size-5" />, title: "The host turned off your camera" });
      }
      was = now;
    });
  }, [call, toast]);

  return null;
}
