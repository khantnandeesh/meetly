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
 * that cannot be shown is dropped, and anything else waits its turn.
 * What is on screen is ordered by kind, highest nearest the edge the stack grows from, then by
 * age: a new arrival appears on the far side and never moves what was already there.
 *
 * What may be lost when there is no room, and what may not:
 *
 * 1. News may be dropped, because it has a home: the chat badge, the people count, the list.
 * 2. A change to your own state may not be dropped: it waits for room however long that takes,
 *    because nothing else says why your microphone went off or why you can now admit people.
 * 3. Errors and confirmations may expire, because they go stale: after QUEUE_MS they are not said.
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

/** How long an error or a confirmation may wait for room before it is no longer worth saying. */
export const QUEUE_MS = 6000;
/** A notification that updates in place (a count going up) changes at most this often. */
export const UPDATE_MS = 1000;

export type NoticeEntry = { id: number; priority: NoticePriority; tag?: string };

/**
 * Tags of the notifications that tell you your own state changed (rule 2 above): the host muted
 * your microphone or turned off your camera, you became or stopped being a co-host, background
 * blur was turned off for you. These are never dropped for want of room.
 */
export const STATE_TAGS: ReadonlySet<string> = new Set(["muted-by-host", "cam-by-host", "role-self", "blur-slow"]);

/** Whether a notification says that your own state changed (rule 2), and so must not be lost. */
export const isStateChange = (entry: { tag?: string }): boolean => entry.tag !== undefined && STATE_TAGS.has(entry.tag);

/**
 * Until when a notification that found no room keeps waiting for one. Something waiting for your
 * answer (`duration: Infinity`) and a change to your state wait for as long as it takes; anything
 * else that matters waits QUEUE_MS. (News never waits: it is dropped; see `place`.)
 */
export function queueUntil(entry: { tag?: string; duration?: number }, now: number): number {
  return entry.duration === Infinity || isStateChange(entry) ? Infinity : now + QUEUE_MS;
}

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

/* ------------------------------------------------------------- your devices */

/**
 * "Couldn't start your microphone", with its tag: one per device, so tapping a failing button five
 * times updates one notification instead of stacking five. The caller adds the icon.
 */
export function deviceError(kind: "microphone" | "camera") {
  return {
    tag: `device-${kind}`,
    title: `Couldn't start your ${kind}`,
    body: "Check your browser's permissions for this site and try again.",
    tone: "danger" as const,
    duration: 7000,
  };
}

/* ------------------------------------------------------------- chat previews */

/** Chat must have been quiet this long for the next message to be previewed (and heard). */
export const CHAT_LULL_MS = 4000;
/** From this many people, at most one preview every CHAT_PREVIEW_EVERY_MS. */
export const CHAT_CADENCE_FROM = 25;
export const CHAT_PREVIEW_EVERY_MS = 30_000;
/** From this many people there are no previews at all: the unread badge on Chat is the signal. */
export const CHAT_PREVIEWS_OFF_FROM = 200;

/**
 * Decides, message by message, whether a chat message gets a preview while chat is closed.
 *
 * - Up to 24 people: the first message after a quiet spell (CHAT_LULL_MS).
 * - 25 to 199: the same, and at most one preview every CHAT_PREVIEW_EVERY_MS.
 * - 200 and more: never. Nor when the viewer has switched previews off.
 *
 * In every case the rest are counted on the chat button. Call it for every incoming message,
 * shown or not, so the quiet spell is measured from the last message, not the last preview.
 */
export function createChatPreviewGate() {
  let lastMessageAt = -Infinity;
  let lastPreviewAt = -Infinity;
  return (now: number, headcount: number, enabled: boolean): boolean => {
    const quiet = now - lastMessageAt > CHAT_LULL_MS;
    lastMessageAt = now;
    if (!quiet || !enabled || headcount >= CHAT_PREVIEWS_OFF_FROM) return false;
    if (headcount >= CHAT_CADENCE_FROM && now - lastPreviewAt < CHAT_PREVIEW_EVERY_MS) return false;
    lastPreviewAt = now;
    return true;
  };
}

/* ------------------------------------------------------------------ status lane */

/** The banners about the meeting itself, at the top of the stage. */
export type StatusBanner = "reconnecting" | "sound" | "weak";

/**
 * The one banner the status lane shows: Reconnecting › Turn on sound › Weak connection. They all
 * point at the same problem (you can't hear or be heard); the most urgent one is enough.
 */
export function statusBanner(state: { reconnecting: boolean; soundBlocked: boolean; weak: boolean }): StatusBanner | null {
  if (state.reconnecting) return "reconnecting";
  if (state.soundBlocked) return "sound";
  if (state.weak) return "weak";
  return null;
}

/**
 * How many notifications fit beside the status lane. On a large screen the lane has its own
 * place, so two. On a phone the banner heads the same column and counts toward the two. With a
 * phone sheet open there is one line over the top bar: Reconnecting or Turn on sound takes it
 * (nothing else matters while you can't hear or be heard), a weak connection gives way to the
 * sheet, and otherwise the one line is for what concerns you.
 */
export function laneSurface(phone: boolean, sheetOpen: boolean, banner: StatusBanner | null): NoticeMode & { compact?: boolean } {
  if (phone && sheetOpen) return { max: banner === "reconnecting" || banner === "sound" ? 0 : 1, info: false, compact: true };
  if (phone && banner) return { max: 1, info: true };
  return DESKTOP_MODE;
}
