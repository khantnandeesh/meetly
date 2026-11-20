"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useCall, useParticipants } from "./rtc/react";
import { audienceOrder } from "./rtc/stage";
import type { RtcCall, RtcParticipant } from "./rtc/types";

/**
 * Webinars in the interface: who is in the audience, who is on stage, and your own place. In a
 * meeting everyone is on stage and the audience is empty, so these are safe to use anywhere.
 */

/** Re-reads `read` whenever somebody's place on stage, the host or the roster changes. */
function useStageValue<T>(call: RtcCall, read: () => T): T {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = (["stage", "host", "roster", "status"] as const).map((event) => call.on(event, onChange));
      return () => stops.forEach((stop) => stop());
    },
    [call],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** You are watching a webinar (not hosting it, and not on stage). */
export function useWatching(): boolean {
  const call = useCall();
  return useStageValue(call, () => call.mode === "webinar" && call.local.role === "viewer");
}

/** You are on a webinar's stage without being its host: the one who can step down. */
export function useOnStage(): boolean {
  const call = useCall();
  return useStageValue(call, () => call.mode === "webinar" && call.local.role === "speaker");
}

/** The host has invited you to speak and you have not answered yet. */
export function useStageInvite(): boolean {
  const call = useCall();
  return useStageValue(call, () => call.local.stageInvite);
}

/**
 * A stamp that changes whenever anyone's place on stage, or an invitation, does: for memoising
 * lists that depend on them, since the roster itself may be the same array.
 */
function useStageStamp(): string {
  const call = useCall();
  return useStageValue(call, () =>
    call.mode === "webinar" ? call.participants().map((p) => `${p.role[0]}${p.stageInvite ? "i" : ""}`).join("") : "",
  );
}

/** Everyone but the audience: who the stage and the people list are about. The same list in a meeting. */
export function useStageParticipants(): RtcParticipant[] {
  const call = useCall();
  const participants = useParticipants();
  const stamp = useStageStamp();
  return useMemo(
    () => (call.mode === "webinar" ? participants.filter((p) => p.role !== "viewer") : participants),
    // `stamp` is what changes when a role does; the list itself may be the same array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [call, participants, stamp],
  );
}

/**
 * Whose raised hands you are shown by name: everyone's in a meeting; in a webinar the audience's
 * only if you are the host or a co-host, since nobody else is told who is watching.
 */
export function useHandsShown(): RtcParticipant[] {
  const call = useCall();
  const participants = useParticipants();
  const onStage = useStageParticipants();
  const moderating = useStageValue(call, () => {
    const me = call.local.identity;
    return !!me && (call.hostIdentity === me || call.coHosts().includes(me));
  });
  return call.mode !== "webinar" || moderating ? participants : onStage;
}

/**
 * The audience, other than you: raised hands first, in the order they went up, then everyone
 * else A–Z. Empty in a meeting.
 */
export function useAudience(): RtcParticipant[] {
  const call = useCall();
  const participants = useParticipants();
  const stamp = useStageStamp();
  return useMemo(
    () => (call.mode === "webinar" ? audienceOrder(participants.filter((p) => p.role === "viewer" && !p.isLocal)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [call, participants, stamp],
  );
}

/** What the call is called in what people read: "webinar" in a webinar, "meeting" otherwise. */
export function useCallNoun(): "meeting" | "webinar" {
  return useCall().mode === "webinar" ? "webinar" : "meeting";
}

/** How many are watching, you included if you are. */
export function useWatchingCount(): number {
  const call = useCall();
  useParticipants();
  return useStageValue(call, () => (call.mode === "webinar" ? call.participants().filter((p) => p.role === "viewer").length : 0));
}
