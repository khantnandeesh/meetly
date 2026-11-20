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
