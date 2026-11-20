import { POLL_LIMITS, REACTIONS, type NewPoll, type RtcWaiter } from "./types";

/**
 * The few things both adapters do the same way: talking to our own /api/host, and the rules for
 * reactions.
 */

/** Posts to /api/host. Rejects with the server's message, which is fit to show. */
export type HostApi = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A request that could not be made says so in words, not as the browser's own "Failed to fetch". */
async function post(url: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Check your connection and try again.");
  }
}

export const postHost: HostApi = async (body) => {
  const response = await post("/api/host", body);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "That didn't work. Try again.");
  return data ?? {};
};

/**
 * The people asking to join, each with when they started waiting. `firstSeen` is the adapter's
 * memory of when this browser first saw each of them. It stands in where the provider gives no
 * time, and caps one that is later (a clock ahead of ours). Anyone no longer asking is forgotten.
 */
export function withSince(
  asking: { id: string; name: string; since?: number }[],
  firstSeen: Map<string, number>,
  now: number = Date.now(),
): RtcWaiter[] {
  const waiters = asking.map(({ id, name, since }) => {
    const seen = firstSeen.get(id) ?? now;
    firstSeen.set(id, seen);
    return { id, name, since: since === undefined ? seen : Math.min(since, seen) };
  });
  const present = new Set(asking.map((person) => person.id));
  for (const id of Array.from(firstSeen.keys())) if (!present.has(id)) firstSeen.delete(id);
  return waiters;
}

/** Admit all or Deny all that could not answer everyone. `failed`: who is still waiting because of it. */
export type BulkError = Error & { failed: string[] };

/** The one error for Admit all or Deny all, however many failed. The message is fit to show. */
export function bulkError(verb: "admit" | "deny", failed: string[]): BulkError {
  const n = failed.length;
  return Object.assign(new Error(`Couldn't ${verb} ${n === 1 ? "1 person" : `${n} people`}. Try again.`), { failed });
}

/** Who an Admit all or Deny all left waiting, if `error` is one; otherwise nobody. */
export function bulkFailures(error: unknown): string[] {
  const failed = (error as Partial<BulkError> | null)?.failed;
  return Array.isArray(failed) ? failed.filter((id): id is string => typeof id === "string") : [];
}

/** A host action that neither adapter carries out yet. The message is fit to show. */
export function notAvailableYet(action: "reactions" | "stage"): Error {
  return new Error(
    action === "reactions" ? "Turning reactions off isn't available yet." : "Inviting people on stage isn't available yet.",
  );
}

/** LiveKit: topic of our server's message to someone in the lobby that carries their way in. */
export const ADMIT_TOPIC = "meetly-admit";

/** Name of the message (LiveKit topic, RealtimeKit broadcast type) that carries a reaction. */
export const REACTION_MESSAGE = "meetly-reaction";
/** One reaction per person at most this often. Sooner ones are dropped, by sender and by receiver. */
export const REACTION_GAP_MS = 400;
/** Receivers allow a little less than senders promise, so network jitter drops nothing honest. */
const RECEIVE_GAP_MS = 250;

export function isReaction(value: unknown): value is string {
  return typeof value === "string" && (REACTIONS as readonly string[]).includes(value);
}

/** Says whether `key` may act now, and if so notes that it did. */
export function createThrottle(gapMs: number, now: () => number = () => performance.now()) {
  const last = new Map<string, number>();
  return (key: string): boolean => {
    const at = now();
    const before = last.get(key);
    if (before !== undefined && at - before < gapMs) return false;
    last.set(key, at);
    return true;
  };
}

/** The two throttles every call keeps for reactions: your own sends, and what arrives per sender. */
export function createReactionLimits(now?: () => number) {
  const send = createThrottle(REACTION_GAP_MS, now);
  const receive = createThrottle(RECEIVE_GAP_MS, now);
  return { maySend: () => send("self"), mayReceive: (sender: string) => receive(sender) };
}

/**
 * LiveKit: chat goes through our server (/api/chat), which checks who is sending, signs the
 * message and hands it to the room. `CHAT_TOPIC` carries those server-sent packets: a packet on
 * it that names a participant as its sender did not come from our server and is ignored.
 */
export const CHAT_TOPIC = "meetly-chat";
/**
 * LiveKit: how someone who has just joined gets what was said before. They ask one participant,
 * who answers with the signed messages they hold; our server then says which of them it really
 * signed. Nothing on this topic is believed until then.
 */
export const CHAT_SYNC_TOPIC = "meetly-chat-sync";
/** Longest chat message, in characters. The composer stops there and the server refuses more. */
export const CHAT_MAX_LENGTH = 2000;
/** How much history a newcomer is given: the newest this many messages. */
export const CHAT_HISTORY_LIMIT = 200;

/** A chat message as our server signed it (LiveKit builds). `mac` covers every other field. */
export type SignedChat = {
  id: string;
  room: string;
  identity: string;
  name: string;
  /** Milliseconds since the epoch, by the server's clock. */
  ts: number;
  text: string;
  mac: string;
};

export function isSignedChat(value: unknown): value is SignedChat {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.room === "string" &&
    typeof m.identity === "string" &&
    typeof m.name === "string" &&
    typeof m.ts === "number" &&
    Number.isFinite(m.ts) &&
    typeof m.text === "string" &&
    m.text.length <= CHAT_MAX_LENGTH &&
    typeof m.mac === "string"
  );
}

/** Posts to /api/chat. Rejects with the server's message, which is fit to show. */
export async function postChat(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await post("/api/chat", body);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "That didn't send. Try again.");
  return data ?? {};
}

/* --------------------------------------------------------------- less data */

/**
 * "Use less data": what your camera is captured at while it is on. A quarter of the pixels of
 * the usual 720p and half the frames.
 *
 * It is not smaller still for a reason that was measured: the camera goes out in several sizes
 * at once (simulcast), each a fraction of what is captured, and a browser sends fewer of them
 * the smaller the capture is, keeping the smallest. Chromium, given 320 × 180, sent one version
 * of 80 × 45. Given 640 × 360 it sends 160 × 90 and 320 × 180, which is the intent: the largest
 * picture anyone receives is 320 × 180.
 */
export const SAVER_WIDTH = 640;
export const SAVER_HEIGHT = 360;
export const SAVER_FPS = 15;
/** LiveKit: the most any one version of the camera may use while saving data, in bits a second. */
export const SAVER_MAX_BITRATE = 150_000;

/* ------------------------------------------------------------------- polls */

/** What a poll's id may look like, on either provider. */
export const POLL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Checks a new poll against the limits and tidies it: trimmed text, no empty or repeated
 * options. Returns the poll to make, or a sentence saying what is wrong with it. Used by the
 * form, by both adapters and by our server.
 */
export function checkNewPoll(input: unknown): NewPoll | string {
  const poll = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const question = typeof poll.question === "string" ? poll.question.trim() : "";
  if (!question) return "A poll needs a question.";
  if (question.length > POLL_LIMITS.question) return `Keep the question under ${POLL_LIMITS.question} characters.`;
  const given = Array.isArray(poll.options) ? poll.options : [];
  const options: string[] = [];
  for (const option of given) {
    const text = typeof option === "string" ? option.trim() : "";
    if (!text) continue;
    if (text.length > POLL_LIMITS.option) return `Keep each option under ${POLL_LIMITS.option} characters.`;
    if (options.some((other) => other.toLowerCase() === text.toLowerCase())) return "Two options are the same.";
    options.push(text);
  }
  if (options.length < POLL_LIMITS.minOptions) return `A poll needs at least ${POLL_LIMITS.minOptions} options.`;
  if (options.length > POLL_LIMITS.maxOptions) return `A poll can have at most ${POLL_LIMITS.maxOptions} options.`;
  return { question, options, anonymous: poll.anonymous === true };
}

/**
 * LiveKit: a poll as the meeting's record holds it (room metadata, which only our server can
 * write). `v` is one entry per voter: for a named poll the key is the voter's identity, for an
 * anonymous one a keyed hash of it that only our server can compute, so the record says that
 * somebody voted without saying who. A closed poll keeps the counts (`c`) and drops the voters.
 */
export type StoredPoll = {
  id: string;
  q: string;
  o: string[];
  /** Anonymous. */
  a?: 1;
  /** Name of whoever started it. */
  by: string;
  at: number;
  v?: Record<string, number>;
  c?: number[];
};

export function readStoredPolls(value: unknown): StoredPoll[] {
  if (!Array.isArray(value)) return [];
  const polls: StoredPoll[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const poll = entry as Record<string, unknown>;
    if (typeof poll.id !== "string" || !POLL_ID.test(poll.id) || typeof poll.q !== "string" || !Array.isArray(poll.o)) continue;
    const options = poll.o.filter((option): option is string => typeof option === "string");
    if (options.length < 2 || options.length !== poll.o.length) continue;
    const inRange = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < options.length;
    const stored: StoredPoll = {
      id: poll.id,
      q: poll.q,
      o: options,
      ...(poll.a === 1 ? { a: 1 as const } : {}),
      by: typeof poll.by === "string" ? poll.by : "",
      at: typeof poll.at === "number" ? poll.at : 0,
    };
    if (Array.isArray(poll.c)) {
      const counts = poll.c as unknown[];
      stored.c = options.map((_, index) => {
        const count = counts[index];
        return typeof count === "number" && count >= 0 ? Math.floor(count) : 0;
      });
    } else {
      stored.v = {};
      if (typeof poll.v === "object" && poll.v !== null) {
        for (const [voter, choice] of Object.entries(poll.v as Record<string, unknown>)) if (inRange(choice)) stored.v[voter] = choice;
      }
    }
    polls.push(stored);
  }
  return polls;
}

/** Votes per option for a stored poll, open or closed. */
export function tally(poll: StoredPoll): number[] {
  if (poll.c) return poll.c;
  const counts = poll.o.map(() => 0);
  for (const choice of Object.values(poll.v ?? {})) counts[choice]++;
  return counts;
}

/** Posts to /api/poll (LiveKit builds). Rejects with the server's message, which is fit to show. */
export async function postPoll(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await post("/api/poll", body);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "That didn't work. Try again.");
  return data ?? {};
}

/** An error whose message was written for the person in the meeting, and can be shown to them as it is. */
export const NOTICE = "MeetlyNotice";
export function notice(message: string): Error {
  return Object.assign(new Error(message), { name: NOTICE });
}
