import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meetly's own session token for RealtimeKit calls.
 *
 * A RealtimeKit participant token is signed by Cloudflare with a key we do not hold, so our
 * server cannot check one that a browser hands back. When /api/token lets someone into a
 * meeting it therefore also signs this small token (HS256, in JWT form) saying who they are
 * and whether they are the host. /api/host accepts nothing else as proof.
 */
export type Session = {
  /** RealtimeKit meeting id. */
  meetingId: string;
  /** RealtimeKit participant id (the REST API's `id`). */
  participantId: string;
  /** The identity every client sees for this person (`custom_participant_id`). */
  identity: string;
  role: "host" | "guest";
  /** Seconds since the epoch. */
  exp: number;
};

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signSession(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${HEADER}.${payload}.${sign(`${HEADER}.${payload}`, secret).toString("base64url")}`;
}

/** The session inside `token`, or null if it was not signed by us, was altered, or has expired. */
export function verifySession(token: unknown, secret: string, now: number = Date.now()): Session | null {
  if (typeof token !== "string" || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (
      typeof value?.meetingId !== "string" ||
      typeof value.participantId !== "string" ||
      typeof value.identity !== "string" ||
      (value.role !== "host" && value.role !== "guest") ||
      typeof value.exp !== "number" ||
      value.exp * 1000 <= now
    ) {
      return null;
    }
    return {
      meetingId: value.meetingId,
      participantId: value.participantId,
      identity: value.identity,
      role: value.role,
      exp: value.exp,
    };
  } catch {
    return null;
  }
}
