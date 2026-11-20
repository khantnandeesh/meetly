/**
 * When to tell someone that their own connection is the problem, and when to stop.
 *
 * One signal, and not a nagging one: the connection has to be poor for a while before anything
 * is said; what is said stays until the connection has been better for a moment or the person
 * dismisses it; and then nothing more is said for a good while, however the connection wobbles.
 *
 * Plain functions over a small state, so the timing can be tested without a call or a clock.
 */

/** The connection must be poor for this long, without a break, before the notice appears. */
export const POOR_HOLD_MS = 10_000;
/** Once shown, the notice goes when the connection has not been poor for this long. */
export const CLEAR_HOLD_MS = 5_000;
/** After the notice went by itself, it is not shown again for this long. */
export const REPEAT_QUIET_MS = 2 * 60_000;
/** After the person dismissed it, it is not shown again for this long. */
export const DISMISS_QUIET_MS = 10 * 60_000;

export type HealthState = {
  /** When the current unbroken run of "poor" began. */
  poorSince: number | null;
  /** When the connection last stopped being poor, while the notice is up. */
  betterSince: number | null;
  shown: boolean;
  /** No notice before this time. */
  quietUntil: number;
};

export const HEALTH_START: HealthState = { poorSince: null, betterSince: null, shown: false, quietUntil: 0 };

/** What the state becomes at `now`, given whether the connection is poor at this moment. */
export function stepHealth(state: HealthState, now: number, poor: boolean): HealthState {
  if (poor) {
    const poorSince = state.poorSince ?? now;
    const shown = state.shown || (now - poorSince >= POOR_HOLD_MS && now >= state.quietUntil);
    if (poorSince === state.poorSince && shown === state.shown && state.betterSince === null) return state;
    return { ...state, poorSince, betterSince: null, shown };
  }
  if (!state.shown) return state.poorSince === null && state.betterSince === null ? state : { ...state, poorSince: null, betterSince: null };
  const betterSince = state.betterSince ?? now;
  if (now - betterSince >= CLEAR_HOLD_MS) return { poorSince: null, betterSince: null, shown: false, quietUntil: now + REPEAT_QUIET_MS };
  return betterSince === state.betterSince ? state : { ...state, betterSince };
}

/** The person closed the notice: it goes, and stays away for a long while. */
export function dismissHealth(now: number): HealthState {
  return { poorSince: null, betterSince: null, shown: false, quietUntil: now + DISMISS_QUIET_MS };
}
