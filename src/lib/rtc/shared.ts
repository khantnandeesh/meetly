import { REACTIONS } from "./types";

/**
 * The few things both adapters do the same way: talking to our own /api/host, and the rules for
 * reactions.
 */

/** Posts to /api/host. Rejects with the server's message, which is fit to show. */
export type HostApi = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const postHost: HostApi = async (body) => {
  const response = await fetch("/api/host", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "That didn't work. Try again.");
  return data ?? {};
};

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
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "That didn't send. Try again.");
  return data ?? {};
}
