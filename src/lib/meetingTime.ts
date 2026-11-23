import type { CallMode, MeetingStart } from "./rtc/types";

/**
 * How long the meeting has been running: what the timer shows, what it is counted from, and what
 * a screen reader hears. Pure, so the choices can be tested without a call.
 */

/** "0:00" … "59:59", then "1:00:00" … "10:00:00": minutes and seconds until an hour, then hours too. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Whole seconds from `from` to `now`, never below zero. */
export function elapsedSeconds(from: number, now: number): number {
  return Math.max(0, Math.floor((now - from) / 1000));
}

/**
 * What the timer counts from.
 *
 * - The server knew when the meeting began: from then. If that is a moment after you joined (the
 *   two clocks can disagree by a few milliseconds), from when you joined instead.
 * - Nobody was in the meeting when you were let in ("now"): it began as you joined.
 * - The server could not say (null): from when you joined, and `known` is false, so the timer is
 *   labelled as time since you joined, not as the meeting's.
 *
 * `joinedAt` is when this browser was first let into the meeting, or null until it has been. Null
 * comes back while the answer depends on a moment that has not happened yet.
 */
export function meetingClock(start: MeetingStart, joinedAt: number | null): { from: number; known: boolean } | null {
  if (typeof start === "number" && Number.isFinite(start)) {
    return { from: joinedAt === null ? start : Math.min(start, joinedAt), known: true };
  }
  if (joinedAt === null) return null;
  return { from: joinedAt, known: start === "now" };
}

/**
 * The server's `started` (milliseconds before it answered that the meeting began, or "now"), as a
 * `MeetingStart` by this browser's clock. `receivedAt` is when the answer arrived. Anything else,
 * including nothing, is "not known".
 */
export function startFromAnswer(started: unknown, receivedAt: number): MeetingStart {
  if (started === "now") return "now";
  if (typeof started === "number" && Number.isFinite(started) && started >= 0) return receivedAt - started;
  return null;
}

/** "Meeting time" or "Webinar time"; "Time since you joined" when the start could not be known. */
export function timerName(mode: CallMode, known: boolean): string {
  if (!known) return "Time since you joined";
  return mode === "webinar" ? "Webinar time" : "Meeting time";
}

/**
 * What a screen reader hears, in whole minutes so it changes once a minute, not every second:
 * "Meeting time, 23 minutes", "Webinar time, 1 hour 5 minutes", "Meeting time, under a minute".
 */
export function spokenElapsed(name: string, seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const amount = minutes === 0 ? "under a minute" : [h > 0 ? plural(h, "hour") : "", m > 0 ? plural(m, "minute") : ""].filter(Boolean).join(" ");
  return `${name}, ${amount}`;
}
