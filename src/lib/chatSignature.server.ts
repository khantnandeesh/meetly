import { createHmac, timingSafeEqual } from "node:crypto";
import { isSignedChat, type SignedChat } from "./rtc/shared";

/**
 * Our server's signature on a chat message (LiveKit builds). It covers the meeting, the
 * author's identity and name, the time and the text, so none of them can be changed afterwards
 * by whoever is holding the message.
 */
const fields = (m: Omit<SignedChat, "mac">) => JSON.stringify([m.id, m.room, m.identity, m.name, m.ts, m.text]);

function mac(message: Omit<SignedChat, "mac">, secret: string): Buffer {
  return createHmac("sha256", `meetly-chat:${secret}`).update(fields(message)).digest();
}

export function signChat(message: Omit<SignedChat, "mac">, secret: string): SignedChat {
  const { id, room, identity, name, ts, text } = message;
  return { id, room, identity, name, ts, text, mac: mac(message, secret).toString("base64url") };
}

/** Whether this server signed exactly this message. */
export function verifyChat(message: unknown, secret: string): message is SignedChat {
  if (!secret || !isSignedChat(message)) return false;
  const expected = mac(message, secret);
  const given = Buffer.from(message.mac, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
