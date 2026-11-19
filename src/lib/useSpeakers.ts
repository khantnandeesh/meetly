"use client";

import { RoomEvent, type Participant, type Room } from "livekit-client";
import { useEffect, useMemo, useRef, useState } from "react";

/** Someone must keep talking this long before the layout reacts (coughs and "mm-hm" don't count). */
export const SPEAKER_ONSET_MS = 600;
/** Once the main tile switches it stays put at least this long. */
export const SPEAKER_HOLD_MS = 2500;

/** The slice of the ordered participant list that is currently on screen. */
export type VisibleRange = { start: number; size: number; pinned?: string };

function reconcile(order: string[], localId: string, remoteIds: string[]): string[] {
  const present = new Set(remoteIds);
  const kept = order.filter((id) => present.has(id));
  const known = new Set(kept);
  return [localId, ...kept, ...remoteIds.filter((id) => !known.has(id))];
}

/**
 * Debounced active-speaker tracking for the stage.
 *
 * - `stageSpeaker`: the remote participant who should hold the main tile. Never the local user.
 *   Sticks to the last speaker during silence.
 * - `ordered`: every participant identity, you first, in a stable order. A confirmed speaker who
 *   is off screen swaps places with the on-screen person who spoke least recently, so tiles
 *   only move when somebody new actually needs to be seen.
 */
export function useSpeakers(room: Room, participantCount: number, visible: VisibleRange) {
  const [stage, setStage] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>([]);

  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const lastSpoke = new Map<string, number>();
    const talking = new Map<string, { timer?: ReturnType<typeof setTimeout>; confirmed: boolean }>();
    let stageId: string | null = null;
    let lastSwitch = 0;
    let stageTimer: ReturnType<typeof setTimeout> | undefined;

    const remoteIds = () => Array.from(room.remoteParticipants.keys());
    const isRemote = (p: Participant) => !p.isLocal;

    function switchStage(id: string) {
      const previous = stageId;
      stageId = id;
      lastSwitch = Date.now();
      setStage(id);
      // The outgoing speaker takes the incoming one's place in the order. In the speaker view
      // that means the hand-over changes the main tile and one filmstrip slot, and nothing else
      // shuffles along.
      if (previous && previous !== id) {
        setOrder((list) => {
          const order = reconcile(list, room.localParticipant.identity, remoteIds());
          const a = order.indexOf(previous);
          const b = order.indexOf(id);
          if (a < 0 || b < 0) return order;
          [order[a], order[b]] = [order[b], order[a]];
          return order;
        });
      }
    }

    /** Loudest confirmed remote speaker right now, if any. */
    function dominant(): string | undefined {
      return room.activeSpeakers.find((p) => isRemote(p) && talking.get(p.identity)?.confirmed)?.identity;
    }

    function considerStage() {
      const candidate = dominant();
      if (!candidate || candidate === stageId) return;
      // While the current speaker is still louder, leave them up.
      const speakers = room.activeSpeakers;
      const currentRank = speakers.findIndex((p) => p.identity === stageId);
      const candidateRank = speakers.findIndex((p) => p.identity === candidate);
      if (currentRank !== -1 && currentRank < candidateRank) return;
      const wait = lastSwitch + SPEAKER_HOLD_MS - Date.now();
      clearTimeout(stageTimer);
      if (wait <= 0) switchStage(candidate);
      else stageTimer = setTimeout(considerStage, wait);
    }

    function promote(id: string) {
      setOrder((previous) => {
        const list = reconcile(previous, room.localParticipant.identity, remoteIds());
        const { start, size, pinned } = visibleRef.current;
        const index = list.indexOf(id);
        if (index < 0 || (index >= start && index < start + size)) return list;
        let victim = -1;
        let oldest = Infinity;
        for (let i = Math.min(list.length, start + size) - 1; i >= Math.max(1, start); i--) {
          const other = list[i];
          if (other === pinned || room.remoteParticipants.get(other)?.isSpeaking) continue;
          const spoke = lastSpoke.get(other) ?? 0;
          if (spoke < oldest) {
            oldest = spoke;
            victim = i;
          }
        }
        if (victim < 0) return list;
        const next = [...list];
        [next[victim], next[index]] = [next[index], next[victim]];
        return next;
      });
    }

    function confirm(id: string) {
      const entry = talking.get(id);
      if (!entry || !room.remoteParticipants.get(id)?.isSpeaking) return;
      entry.confirmed = true;
      lastSpoke.set(id, Date.now());
      promote(id);
      considerStage();
    }

    function onSpeakers(speakers: Participant[]) {
      const now = new Set<string>();
      for (const p of speakers) {
        if (!isRemote(p)) continue;
        now.add(p.identity);
        if (!talking.has(p.identity)) {
          const id = p.identity;
          talking.set(id, { confirmed: false, timer: setTimeout(() => confirm(id), SPEAKER_ONSET_MS) });
        }
      }
      for (const [id, entry] of talking) {
        if (now.has(id)) continue;
        clearTimeout(entry.timer);
        if (entry.confirmed) lastSpoke.set(id, Date.now());
        talking.delete(id);
      }
      // The person on stage went quiet: hand over to whoever is already talking.
      if (stageId && !now.has(stageId)) considerStage();
    }

    function onLeft(p: Participant) {
      talking.delete(p.identity);
      lastSpoke.delete(p.identity);
      if (p.identity !== stageId) return;
      // Fall back to whoever spoke most recently and is still here.
      let best: string | null = null;
      let bestAt = -1;
      for (const [id, at] of lastSpoke) {
        if (at > bestAt && room.remoteParticipants.has(id)) {
          best = id;
          bestAt = at;
        }
      }
      stageId = best;
      setStage(best);
    }

    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
      clearTimeout(stageTimer);
      talking.forEach((entry) => clearTimeout(entry.timer));
    };
  }, [room]);

  // The local identity is empty until the room connects. It has to be a dependency: someone alone
  // in a call gets no other change that would recompute the list, and would never see themselves.
  const localId = room.localParticipant.identity;
  const ordered = useMemo(
    () => reconcile(order, localId, Array.from(room.remoteParticipants.keys())),
    // participantCount stands in for "the remote participant map changed".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, room, localId, participantCount],
  );

  const stageSpeaker = stage && room.remoteParticipants.has(stage) ? stage : null;
  return { stageSpeaker, ordered };
}
