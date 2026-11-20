/**
 * The two cost controls on webinars, as the founder set them, and the facts they leave in a
 * meeting's record. Kept apart from the watchdog (./costGuard.server.ts), the join gate
 * (./webinarGate.server.ts) and the RealtimeKit server so that all three can read them without
 * importing each other.
 *
 * - `MEETLY_WEBINARS_ENABLED`: the switch. On unless it says otherwise. Off, nobody can start or
 *   join a webinar, and the watchdog ends the ones running.
 * - `MEETLY_WEBINAR_MINUTE_LIMIT`: how many participant-minutes one webinar session may use (5,000
 *   unless set). The watchdog warns the host at 80% and ends the session once it is passed.
 *
 * Every viewer of a webinar is a billed RealtimeKit participant-minute and webinars are free, so
 * these are what keep one runaway session, or all of them at once, from running up the bill.
 */

/** Said to anyone who tries to start or join a webinar while the switch is off. */
export const WEBINARS_PAUSED = "Webinars are paused right now.";
/** Said on the leave screen, and to anyone who tries the link afterwards. */
export const WEBINAR_LIMIT_REACHED = "This webinar reached its free time limit.";

/** The limit when `MEETLY_WEBINAR_MINUTE_LIMIT` does not say. */
export const DEFAULT_MINUTE_LIMIT = 5000;
/** The share of the limit at which the host and co-hosts are told how long is left. */
export const WARN_SHARE = 0.8;

/** Whether webinars are switched on. Only an explicit "off" turns them off, so a typo never does. */
export function webinarsEnabled(value: string | undefined = process.env.MEETLY_WEBINARS_ENABLED): boolean {
  return !["0", "false", "off", "no"].includes((value ?? "").trim().toLowerCase());
}

/** The per-session limit, or the default if it is unset or not a positive whole number. */
export function webinarMinuteLimit(value: string | undefined = process.env.MEETLY_WEBINAR_MINUTE_LIMIT): number {
  const limit = Number(value);
  return value && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_MINUTE_LIMIT;
}

/**
 * RealtimeKit marker records (see src/lib/rtc/server/realtimekit.ts):
 *
 * - "meetly-limit:<session id>": the session used up the limit. Written before anyone is removed,
 *   so that a removed client can find out why, and never taken away: the link stays closed.
 * - "meetly-limit-warning:<session id>:<epoch ms>": the host was warned, and when the session is
 *   expected to end. Written once per session, which is what makes the warning happen once.
 */
export const LIMIT_MARKER = "meetly-limit:";
export const LIMIT_WARNING_MARKER = "meetly-limit-warning:";

export type LimitWarning = { session: string; endsAt: number };

export const limitFact = (session: string) => `${LIMIT_MARKER}${session}`;
export const limitWarningFact = (warning: LimitWarning) => `${LIMIT_WARNING_MARKER}${warning.session}:${Math.round(warning.endsAt)}`;

export type LimitRecord = {
  /** Sessions that reached the limit. Any at all means the link is closed. */
  limited: string[];
  /** Warnings given, newest last. */
  warnings: LimitWarning[];
};

/** Reads both kinds of fact out of a meeting's marker ids. Anything malformed is ignored. */
export function readLimitFacts(facts: readonly string[]): LimitRecord {
  const limited: string[] = [];
  const warnings: LimitWarning[] = [];
  for (const fact of facts) {
    if (fact.startsWith(LIMIT_WARNING_MARKER)) {
      const rest = fact.slice(LIMIT_WARNING_MARKER.length);
      const split = rest.lastIndexOf(":");
      const endsAt = Number(rest.slice(split + 1));
      if (split > 0 && Number.isFinite(endsAt)) warnings.push({ session: rest.slice(0, split), endsAt });
    } else if (fact.startsWith(LIMIT_MARKER) && fact.length > LIMIT_MARKER.length) {
      limited.push(fact.slice(LIMIT_MARKER.length));
    }
  }
  return { limited, warnings };
}

/** "This webinar ends in about N minutes (free limit).", counted from `now`. Never less than one minute. */
export function limitWarningText(endsAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((endsAt - now) / 60_000));
  return `This webinar ends in about ${minutes} ${minutes === 1 ? "minute" : "minutes"} (free limit).`;
}
