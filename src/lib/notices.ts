/**
 * The rules for notifications in a call, kept apart from how they look so they can be tested.
 *
 * Four kinds, by what they ask of you:
 *
 * - "action": somebody is waiting for your answer (people asking to join). Stays until answered.
 * - "you": something happened to you, or to what you just did (the host muted you, a copy
 *   failed, blur was switched off). Short-lived, never pushed aside by news.
 * - "info": news from other people (a chat message, a pin, a poll). Each has a permanent home
 *   elsewhere (the chat badge), so it goes before anything above it.
 * - "presence": people coming and going. The people count already says it; it goes first.
 *
 * A hard cap on what is on screen at once; over it, a lower kind makes way for a higher one, news
 * that cannot be shown is dropped, and anything else waits its turn for a short while.
 * What is on screen is ordered by kind, highest nearest the edge the stack grows from, then by
 * age: a new arrival appears on the far side and never moves what was already there.
 */

export type NoticePriority = "action" | "you" | "info" | "presence";

export const RANK: Record<NoticePriority, number> = { presence: 0, info: 1, you: 2, action: 3 };

/** News: dropped rather than kept waiting, and held back while something else has your attention. */
export const isNews = (priority: NoticePriority): boolean => priority === "info" || priority === "presence";

/** What the screen can take right now. */
export type NoticeMode = {
  /** Most notifications on screen at once. */
  max: number;
  /** Whether news ("info", "presence") may interrupt at all (not while a dialog or a phone sheet has your attention). */
  info: boolean;
};

export const DESKTOP_MODE: NoticeMode = { max: 2, info: true };

/** How long a "you" notification may wait for room before it is no longer worth saying. */
export const QUEUE_MS = 6000;
/** A notification that updates in place (a count going up) changes at most this often. */
export const UPDATE_MS = 1000;

export type NoticeEntry = { id: number; priority: NoticePriority; tag?: string };

export type Placement =
  | { kind: "show" }
  | { kind: "replace"; evict: number }
  | { kind: "queue" }
  | { kind: "drop" };

/**
 * Where a new notification goes, given what is on screen (not counting any already leaving).
 */
export function place(visible: readonly NoticeEntry[], incoming: NoticeEntry, mode: NoticeMode): Placement {
  if (isNews(incoming.priority) && !mode.info) return { kind: "drop" };
  if (visible.length < mode.max) return { kind: "show" };
  // The lowest kind on screen, oldest first, makes way if it ranks below the newcomer.
  const lowest = [...visible].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.id - b.id)[0];
  if (lowest && RANK[lowest.priority] < RANK[incoming.priority]) return { kind: "replace", evict: lowest.id };
  return isNews(incoming.priority) ? { kind: "drop" } : { kind: "queue" };
}

/** Stack order: highest kind first (nearest the anchor), then oldest first. */
export function order<T extends NoticeEntry>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => RANK[b.priority] - RANK[a.priority] || a.id - b.id);
}

/**
 * When the screen gets smaller (a phone sheet opens, a dialog opens): which of what is showing
 * no longer fits. Returns them lowest first; news among them is dropped, the rest wait.
 */
export function overflow<T extends NoticeEntry>(visible: readonly T[], mode: NoticeMode): T[] {
  const kept = order(visible.filter((entry) => mode.info || !isNews(entry.priority)));
  const out = visible.filter((entry) => !kept.includes(entry));
  return [...out, ...kept.slice(mode.max).reverse()];
}

/** People joining or leaving, said in as few words as the number allows. */
export function crowdSentence(names: readonly string[], verb: "joined" | "left"): string {
  if (names.length === 1) return `${names[0]} ${verb}`;
  if (names.length === 2) return `${names[0]} and ${names[1]} ${verb}`;
  return `${names.length} people ${verb}`;
}

/** People asking to join, the same way. */
export function waitingSentence(count: number, firstName: string): string {
  return count === 1 ? `${firstName} wants to join` : `${count} people want to join`;
}
