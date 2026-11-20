import type { RtcWaiter } from "./rtc/types";

/**
 * The plain logic behind the People panel's sections at scale: who is waiting and for how long,
 * raised hands in order, and who left. Kept apart from the components so it can be tested.
 */

/** Rows a section shows before "See all": enough to act on, few enough to leave room for the rest. */
export const FIRST_ROWS = 5;

/** Admitting or denying more people than this at once asks first: a mis-tap can't be undone. */
export const BULK_CONFIRM = 25;

/** Most departures remembered. A long meeting with a lot of coming and going keeps the newest. */
export const MAX_DEPARTURES = 2000;

/** "1st", "2nd", "3rd", "4th" … "11th", "12th", "13th" … "21st", "101st". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** How long someone has been waiting, in whole minutes: "Just now" under a minute. */
export function waitingFor(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  return minutes < 1 ? "Just now" : `Waiting ${minutes} min`;
}

/** Oldest first: whoever has waited longest is answered first. Ties keep the provider's order. */
export function oldestFirst(waiters: readonly RtcWaiter[]): RtcWaiter[] {
  return waiters
    .map((waiter, index) => ({ waiter, index }))
    .sort((a, b) => a.waiter.since - b.waiter.since || a.index - b.index)
    .map(({ waiter }) => waiter);
}

/** "1 person" or "N people". */
export const people = (n: number) => (n === 1 ? "1 person" : `${n.toLocaleString("en-US")} people`);

/** Somebody this browser saw leave. */
export type Departure = { identity: string; name: string; at: number };

/** Notes a departure, newest first. Someone who leaves twice is listed once, at the newest. */
export function recordLeave(list: readonly Departure[], left: Departure): Departure[] {
  return [left, ...list.filter((d) => d.identity !== left.identity)].slice(0, MAX_DEPARTURES);
}

/**
 * Someone came (back) in: they are no longer someone who left. A rejoin can come with a new
 * identity (LiveKit mints one per join), so the newest departure under the same name goes too.
 * Returns the same list when nothing changed.
 */
export function recordJoin(list: readonly Departure[], joined: { identity: string; name: string }): readonly Departure[] {
  if (list.length === 0) return list;
  let index = list.findIndex((d) => d.identity === joined.identity);
  if (index < 0 && joined.name) index = list.findIndex((d) => d.name === joined.name);
  return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
}

/** Case-insensitive name search, as the people search does it. */
export function matchesName(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || (name || "Guest").toLowerCase().includes(needle);
}
