/**
 * Raised hands in the order they went up, so whoever asked to speak first is first in the list
 * and on the hands button. Neither provider says when a hand was raised, so the order is the
 * order this browser saw them; someone who joins later sees the hands already up in the call's
 * own order, then any new ones after them.
 */
let next = 0;
const raisedAt = new Map<string, number>();

export function handQueue<T extends { identity: string; handRaised: boolean }>(people: readonly T[]): T[] {
  const up = people.filter((p) => p.handRaised);
  const still = new Set(up.map((p) => p.identity));
  for (const id of raisedAt.keys()) if (!still.has(id)) raisedAt.delete(id);
  for (const p of up) if (!raisedAt.has(p.identity)) raisedAt.set(p.identity, next++);
  return up.sort((a, b) => raisedAt.get(a.identity)! - raisedAt.get(b.identity)!);
}
