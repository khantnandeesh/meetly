import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What a browser is to a meeting, in one signed, HttpOnly cookie per meeting code.
 *
 * There are no accounts, so "the same person" can only mean "the same browser". When /api/token
 * lets a browser in, it notes here who that browser was in the call (`ids`), and for the browser
 * that created the meeting, the meeting's host key (`key`). Coming back with the cookie is what
 * makes the creator host again after a reload, and what stops someone the host removed from
 * walking straight back in.
 *
 * The cookie is signed with a secret only the server holds, so a browser can throw it away but
 * cannot write one: nobody can mint themselves a host key, and nobody can pretend to be a browser
 * that was not removed (only one that was never there). JavaScript on the page cannot read it.
 */
export type Pass = {
  code: string;
  /** Proves this browser is the meeting's host. What it is compared with is the provider's business. */
  key?: string;
  /** Identities this browser has held in this meeting, newest last. */
  ids: string[];
};

/** A month: long enough for a weekly meeting to keep its host. Renewed on every join. */
export const PASS_MAX_AGE_S = 30 * 24 * 60 * 60;
const MAX_IDS = 12;

export const passCookieName = (code: string) => `meetly.${code}`;

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", `meetly-pass:${secret}`).update(data).digest();
}

export function signPass(pass: Pass, secret: string, now: number = Date.now()): string {
  const body = { c: pass.code, k: pass.key, i: pass.ids.slice(-MAX_IDS), x: Math.floor(now / 1000) + PASS_MAX_AGE_S };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

/** The pass inside `value`, or an empty one if it is missing, not ours, altered, expired or for another meeting. */
export function verifyPass(value: unknown, code: string, secret: string, now: number = Date.now()): Pass {
  const empty: Pass = { code, ids: [] };
  if (typeof value !== "string" || !secret) return empty;
  const parts = value.split(".");
  if (parts.length !== 2) return empty;
  const expected = sign(parts[0], secret);
  const given = Buffer.from(parts[1], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return empty;
  try {
    const body = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (body?.c !== code || typeof body.x !== "number" || body.x * 1000 <= now) return empty;
    return {
      code,
      key: typeof body.k === "string" && body.k ? body.k : undefined,
      ids: Array.isArray(body.i) ? body.i.filter((id: unknown): id is string => typeof id === "string") : [],
    };
  } catch {
    return empty;
  }
}

/** Reads this meeting's pass from a request's Cookie header. */
export function readPass(request: Request, code: string, secret: string): Pass {
  const name = passCookieName(code);
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return verifyPass(part.slice(at + 1).trim(), code, secret);
  }
  return { code, ids: [] };
}

/** The Set-Cookie value that stores `pass` in the browser that made `request`. */
export function passCookie(request: Request, pass: Pass, secret: string): string {
  const https =
    request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https" || new URL(request.url).protocol === "https:";
  return [
    `${passCookieName(pass.code)}=${signPass(pass, secret)}`,
    "Path=/",
    `Max-Age=${PASS_MAX_AGE_S}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(https ? ["Secure"] : []),
  ].join("; ");
}

/** The same pass with one more identity noted, and the host key set or cleared when one is given. */
export function extendPass(pass: Pass, identity: string, key?: string | null): Pass {
  return {
    code: pass.code,
    key: key === null ? undefined : (key ?? pass.key),
    ids: [...pass.ids.filter((id) => id !== identity), identity].slice(-MAX_IDS),
  };
}
