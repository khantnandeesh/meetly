import { viewerCap } from "./rtc/stage";
import { WEBINAR_LIMIT_REACHED, WEBINARS_PAUSED, webinarsEnabled } from "./webinarLimit";

/**
 * Every check someone passes before joining a webinar, on either provider, in one place. The
 * token route (LiveKit) and src/lib/rtc/server/realtimekit.ts (RealtimeKit) both call this and
 * nothing else, so a new rule for webinars is added here once.
 *
 * The rules, in order:
 *
 * - Webinars are switched off (`MEETLY_WEBINARS_ENABLED`, see ./webinarLimit.ts): nobody, the
 *   host included, since the switch is there to stop the cost at once.
 * - A session of this webinar used up its free participant-minutes: nobody, the host included.
 *   The link stays closed (see ./costGuard.server.ts).
 * - The audience has a size limit (`MEETLY_WEBINAR_VIEWER_CAP`, 250 unless set). The host is
 *   never turned away by it.
 */

/** Why someone was not let into a webinar, and the sentence they are shown. */
export type WebinarRefusal = { reason: "full" | "paused" | "limit"; message: string };

export const WEBINAR_FULL: WebinarRefusal = {
  reason: "full",
  // Not an error: the webinar is going well. Said as it is, with what the person can do about it.
  message: "This webinar is full. Try again in a few minutes.",
};

export const WEBINAR_PAUSED: WebinarRefusal = { reason: "paused", message: WEBINARS_PAUSED };
export const WEBINAR_LIMIT: WebinarRefusal = { reason: "limit", message: WEBINAR_LIMIT_REACHED };

export type WebinarJoin = {
  /** They join as the webinar's host (as opposed to the audience). */
  host: boolean;
  /**
   * How many are watching now, asked only when it matters (it costs a call to the provider).
   * Null when the provider could not say; the door then stays open.
   */
  watching: () => Promise<number | null>;
  /**
   * The record says a session of this webinar reached the free limit. Only RealtimeKit has the
   * watchdog that writes that, so only it says so.
   */
  limited?: boolean;
};

/** Null to let them in, or why not. */
export async function webinarGate(join: WebinarJoin): Promise<WebinarRefusal | null> {
  if (!webinarsEnabled()) return WEBINAR_PAUSED;
  if (join.limited) return WEBINAR_LIMIT;
  if (join.host) return null;
  const watching = await join.watching().catch(() => null);
  if (watching !== null && watching >= viewerCap()) return WEBINAR_FULL;
  return null;
}
