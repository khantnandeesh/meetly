import { randomUUID } from "node:crypto";
import { DataPacket_Kind } from "livekit-server-sdk";
import { signChat, verifyChat } from "./chatSignature.server";
import { isValidCode } from "./code";
import { clearPinIfIs, liveKitCaller, roomService } from "./host.server";
import type { Pass } from "./pass.server";
import { CHAT_HISTORY_LIMIT, CHAT_MAX_LENGTH, CHAT_TOPIC } from "./rtc/shared";

/**
 * Chat on LiveKit builds, by way of this server.
 *
 * LiveKit carries data between participants but keeps none of it, and this app has no storage
 * of its own. So the server does the two things only it can: it says who wrote a message (from
 * the token we signed for them, checked against who is in the room right now), and it signs what
 * it passes on.
 *
 * - Sending: the caller's token names them; the message is signed and handed to the room by the
 *   server. Clients ignore chat that a participant sent directly.
 * - History for someone who joins late: there is nowhere to keep it, so it comes from another
 *   participant, who passes on the signed messages they hold. `verify` then tells the newcomer
 *   which of those this server really signed. A participant can therefore withhold messages, or
 *   pass on one its author has since deleted, but cannot forge one, alter one, or attribute one.
 * - Deleting: the caller presents the signed message; it must be theirs (the same identity, or
 *   one this browser held before a reload, as its signed pass says).
 *
 * Known limits, all from having no storage: once everybody has left, the conversation is gone;
 * a deletion is not remembered by the server, only by the clients that were there; the rate
 * limit below is per server instance.
 */

/** No more than this many messages from one person in `RATE_WINDOW_MS`. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10_000;
const recent = new Map<string, number[]>();

function allowed(identity: string, now: number): boolean {
  const times = (recent.get(identity) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT) return false;
  times.push(now);
  recent.set(identity, times);
  if (recent.size > 5000) for (const [key, list] of recent) if (now - list[list.length - 1] > RATE_WINDOW_MS) recent.delete(key);
  return true;
}

export type ChatResult = { status: 200; data: Record<string, unknown> } | { status: 400 | 403 | 429 | 502; error: string };

const NOT_IN_CALL = { status: 403, error: "You need to be in the call to use its chat." } as const;

/**
 * Handles one /api/chat request. `token` is the LiveKit token we signed for the caller, and
 * `passFor` reads this browser's signed pass for a meeting (see ./pass.server.ts).
 */
export async function liveKitChat(
  token: unknown,
  body: Record<string, unknown>,
  passFor: (room: string) => Pass,
): Promise<ChatResult> {
  const secret = process.env.LIVEKIT_API_SECRET ?? "";
  const service = roomService();
  // Who is asking: the token says, and the room confirms they are in it at this moment. Someone
  // the host removed keeps their token, but not their place.
  const caller = typeof token === "string" ? await liveKitCaller(token) : null;
  if (!service || !secret || !caller || !isValidCode(caller.room)) return NOT_IN_CALL;
  const { room, identity, name } = caller;

  try {
    switch (body.action) {
      case "send": {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return { status: 400, error: "There is nothing to send." };
        if (text.length > CHAT_MAX_LENGTH) return { status: 400, error: "That message is too long." };
        const now = Date.now();
        if (!allowed(identity, now)) return { status: 429, error: "You're sending messages too quickly. Wait a moment." };
        const message = signChat({ id: randomUUID(), room, identity, name, ts: now, text }, secret);
        await service.sendData(room, new TextEncoder().encode(JSON.stringify({ type: "message", message })), DataPacket_Kind.RELIABLE, {
          topic: CHAT_TOPIC,
        });
        return { status: 200, data: { message } };
      }
      case "delete": {
        const message = body.message;
        if (!verifyChat(message, secret) || message.room !== room) return { status: 400, error: "That message can't be deleted." };
        const own = message.identity === identity || passFor(room).ids.includes(message.identity);
        if (!own) return { status: 403, error: "You can only delete your own messages." };
        await service.sendData(room, new TextEncoder().encode(JSON.stringify({ type: "delete", id: message.id })), DataPacket_Kind.RELIABLE, {
          topic: CHAT_TOPIC,
        });
        // A deleted message does not stay pinned.
        await clearPinIfIs(room, message.id);
        return { status: 200, data: {} };
      }
      case "verify": {
        const offered = Array.isArray(body.messages) ? body.messages.slice(0, CHAT_HISTORY_LIMIT) : [];
        const mine = new Set([identity, ...passFor(room).ids]);
        const valid: string[] = [];
        const own: string[] = [];
        for (const message of offered) {
          if (!verifyChat(message, secret) || message.room !== room) continue;
          valid.push(message.id);
          if (mine.has(message.identity)) own.push(message.id);
        }
        return { status: 200, data: { valid, mine: own } };
      }
    }
    return { status: 400, error: "Invalid request." };
  } catch (error) {
    console.error("Chat request failed", error);
    return { status: 502, error: "That didn't send. Try again." };
  }
}
