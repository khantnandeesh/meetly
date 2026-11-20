"use client";

import { DoorOpen, ShieldCheck, ShieldMinus, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { cameraToggledByYou } from "@/lib/ownToggles";
import { useCall } from "@/lib/rtc/react";
import { playKnockSound } from "@/lib/useSounds";
import { useHost } from "./HostTools";
import { useToast } from "./ui/Toaster";

/**
 * What moderation looks like from the receiving end, one signal each:
 *
 * - Somebody asks to join: the host and co-hosts get a notification that stays until it is
 *   answered, with the answer on it, and one knock. (The count on the People button is the
 *   standing reminder, not a second announcement.)
 * - You were made a co-host, or stopped being one: a notification.
 * - The host turned your camera off: a notification. Being muted has had its own since before
 *   (see useCallSounds); "mute all" arrives the same way.
 *
 * Mount once, inside <HostProvider>.
 */
export function ModerationNotices({ localIdentity, onShowPeople }: { localIdentity: string; onShowPeople: () => void }) {
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
    const [first] = waiting;
    toast.push(
      waiting.length === 1
        ? {
            tag: "knock",
            duration: Infinity,
            icon: <DoorOpen className="size-5" />,
            title: `${first.name || "Guest"} wants to join`,
            secondary: { label: "Deny", onClick: () => answers.current.deny(first) },
            action: { label: "Admit", onClick: () => answers.current.admit(first) },
          }
        : {
            tag: "knock",
            duration: Infinity,
            icon: <DoorOpen className="size-5" />,
            title: `${waiting.length} people want to join`,
            action: { label: "View", onClick: () => answers.current.onShowPeople() },
          },
    );
  }, [waiting, canModerate, toast]);

  const wasCoHost = useRef<boolean | null>(null);
  useEffect(() => {
    if (!localIdentity) return;
    const now = coHosts.includes(localIdentity);
    if (wasCoHost.current !== null && now !== wasCoHost.current) {
      toast.push(
        now
          ? {
              icon: <ShieldCheck className="size-5" />,
              title: "You're now a co-host",
              body: "You can mute and remove people, and decide who joins.",
              duration: 7000,
            }
          : { icon: <ShieldMinus className="size-5" />, title: "You're no longer a co-host" },
      );
    }
    wasCoHost.current = now;
  }, [coHosts, localIdentity, toast]);

  useEffect(() => {
    let was = call.localMedia().camera;
    return call.on("localMedia", () => {
      const now = call.localMedia().camera;
      if (was && !now && call.status === "connected" && !cameraToggledByYou()) {
        toast.push({ icon: <VideoOff className="size-5" />, title: "The host turned off your camera" });
      }
      was = now;
    });
  }, [call, toast]);

  return null;
}
