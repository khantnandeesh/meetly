/**
 * How counts are written where there is little room: badges on the People and Chat buttons, and
 * the headcount in the phone's top bar. The short form is only for the eye; screen readers are
 * always given the full number (`fullCount`), because "99+" and "1.2k" lose what a host needs.
 */

/** The interface is written in English, so numbers are grouped the English way: "1,204". */
const grouped = new Intl.NumberFormat("en-US");

/** "1,204": the whole number, for screen readers and wherever there is room for it. */
export function fullCount(count: number): string {
  return grouped.format(count);
}

/**
 * A badge: up to 99, then "99+". The cap is 99 and not 9 because a host needs to tell 12 people
 * waiting from 120; past 99 the list itself has the number.
 */
export function badgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * The phone's headcount: the number as it is below 1,000, then "1.2k", "12k". The decimal is cut,
 * not rounded, so 1,999 people never read as "2k".
 */
export function shortCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) {
    const tenths = Math.floor(count / 100) / 10;
    return `${tenths % 1 === 0 ? tenths.toFixed(0) : tenths.toFixed(1)}k`;
  }
  if (count < 1_000_000) return `${Math.floor(count / 1000)}k`;
  return `${Math.floor(count / 100_000) / 10}M`;
}
