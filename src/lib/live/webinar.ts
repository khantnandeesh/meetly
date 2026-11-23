/**
 * The one sentence a serverless webinar (Live, beta) is described by: on the home page's chooser
 * and on both Live pages. It says what is true of the engine (packages/overlay): the coordinator
 * exchanges only small messages, and the picture and sound go browser to browser. It does not
 * say "private" or "confidential". End-to-end encryption (./e2ee.ts) is said where it is
 * explained, with what it means: only people with the full link can see the video.
 */
export const SERVERLESS_LINE = "Video goes straight between viewers’ browsers — it never passes through our servers.";

import { keyFragment } from "./e2ee";

/**
 * A serverless webinar's title. Meetly stores nothing about a webinar, so the title the host types
 * travels in the link viewers open (`/live/<id>?title=…&ts=…`), signed by the server so it cannot
 * be edited (title.server.ts). Plain text, one line, `TITLE_MAX` characters at most; React
 * escapes it where it is shown.
 */
export const TITLE_MAX = 80;

/** A half of a UTF-16 surrogate pair without its other half: not text, and `encodeURIComponent` throws on it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
 * Invisible format and control characters: bidi overrides and isolates, zero-width spaces, BOMs,
 * which can make a title read as something else. The zero-width joiner stays, for emoji sequences.
 */
const INVISIBLE = /(?!‍)[\p{Cc}\p{Cf}]/gu;

/**
 * The title as signed and shown: one line, no invisible characters, at most `TITLE_MAX`
 * characters (code points, so an emoji is never cut in half). A long input is cut to a few times
 * that before any of it is looked at.
 */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.slice(0, TITLE_MAX * 4).replace(LONE_SURROGATE, "").replace(/\s+/g, " ").replace(INVISIBLE, "").trim();
  return Array.from(text).slice(0, TITLE_MAX).join("").trim();
}

/**
 * The link viewers open, with the signed title when there is one, and the webinar's end-to-end
 * key in its fragment (`#k=…&s=…&a=…`, with the host's public signing key and the viewers' pass:
 * ./e2ee.ts), which the browser keeps to itself.
 */
export function viewerLink(origin: string, id: string, title: { title: string; sig: string } | null, keys?: { key: Uint8Array; publicKey: Uint8Array; pass: string } | null): string {
  return `${origin}/live/${id}${title ? `?title=${encodeURIComponent(title.title)}&ts=${encodeURIComponent(title.sig)}` : ""}${keys ? `#${keyFragment(keys.key, keys.publicKey, keys.pass)}` : ""}`;
}

/** "35 seconds", "12 min", "1 h 5 min": how long a webinar ran, said as a length, not a clock. */
export function durationWords(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
