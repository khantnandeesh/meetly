import { viewerCap } from "./rtc/stage";

/**
 * Every check someone passes before joining a webinar, on either provider, in one place. The
 * token route (LiveKit) and src/lib/rtc/server/realtimekit.ts (RealtimeKit) both call this and
 * nothing else, so a new rule for webinars is added here once.
 *
 * Today there is one rule: the audience has a size limit (`MEETLY_WEBINAR_VIEWER_CAP`, 250 unless
 * set). The host is never turned away by it.
 */

/** Why someone was not let into a webinar, and the sentence they are shown. */
export type WebinarRefusal = { reason: "full"; message: string };

export const WEBINAR_FULL: WebinarRefusal = {
  reason: "full",
  // Not an error: the webinar is going well. Said as it is, with what the person can do about it.
  message: "This webinar is full. Try again in a few minutes.",
};

export type WebinarJoin = {
  /** They join as the webinar's host (as opposed to the audience). */
  host: boolean;
  /**
   * How many are watching now, asked only when it matters (it costs a call to the provider).
   * Null when the provider could not say; the door then stays open.
   */
  watching: () => Promise<number | null>;
};

/** Null to let them in, or why not. */
export async function webinarGate(join: WebinarJoin): Promise<WebinarRefusal | null> {
  if (join.host) return null;
  const watching = await join.watching().catch(() => null);
  if (watching !== null && watching >= viewerCap()) return WEBINAR_FULL;
  return null;
}
