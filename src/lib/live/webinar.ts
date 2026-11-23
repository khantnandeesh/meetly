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

export function cleanTitle(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX).trim() : "";
}

/**
 * The link viewers open, with the signed title when there is one, and the webinar's end-to-end
 * key in its fragment (`#k=…&s=…`, with the host's public signing key: ./e2ee.ts), which the
 * browser keeps to itself.
 */
export function viewerLink(origin: string, id: string, title: { title: string; sig: string } | null, key?: Uint8Array | null, publicKey?: Uint8Array | null): string {
  return `${origin}/live/${id}${title ? `?title=${encodeURIComponent(title.title)}&ts=${encodeURIComponent(title.sig)}` : ""}${key ? `#${keyFragment(key, publicKey)}` : ""}`;
}

/** "35 seconds", "12 min", "1 h 5 min": how long a webinar ran, said as a length, not a clock. */
export function durationWords(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
