/**
 * Anonymous usage events: what they would look like, and the one place they would leave from.
 *
 * NOTHING IS SENT. Meetly has no storage and no analytics service, so `sendUsageEvent` ends in
 * `NOT_SENT_no_storage_configured`, which does nothing at all: no request, no log, nothing kept
 * in the browser. The call sites are real, so that turning this on is one function body.
 *
 * What an event may hold is fixed by the type below, on purpose: a feature's name, a rating, and
 * three coarse buckets. No meeting code, no names, no identities, no text anybody typed, no
 * address, no user agent.
 *
 * The smallest thing that would make these real: one counter per (day, event, buckets), e.g. a
 * Workers Analytics Engine dataset written from a route that accepts exactly this shape, or a
 * Durable Object holding the same counters. Either is new infrastructure and needs a decision.
 */

/** The features worth counting: the ones a person chooses to use. */
export type UsageFeature = "mini-window" | "poll-created" | "poll-voted" | "data-saver" | "call-quality-opened";

/** How many people were in the call, coarsely. */
export type SizeBucket = "1" | "2" | "3-5" | "6-12" | "13-49" | "50+";
/** How long the call lasted for this person, coarsely. */
export type LengthBucket = "under-1m" | "1-10m" | "10-30m" | "30-60m" | "over-60m";
export type DeviceClass = "phone" | "desktop";

export type UsageEvent =
  | { kind: "feature"; feature: UsageFeature; size: SizeBucket; device: DeviceClass }
  /** The one-tap answer to "How was the call?" on the screen you see after leaving. */
  | { kind: "call-rating"; rating: "good" | "bad"; size: SizeBucket; length: LengthBucket; device: DeviceClass };

export function sizeBucket(people: number): SizeBucket {
  if (people <= 1) return "1";
  if (people === 2) return "2";
  if (people <= 5) return "3-5";
  if (people <= 12) return "6-12";
  return people < 50 ? "13-49" : "50+";
}

export function lengthBucket(minutes: number): LengthBucket {
  if (minutes < 1) return "under-1m";
  if (minutes < 10) return "1-10m";
  if (minutes < 30) return "10-30m";
  return minutes < 60 ? "30-60m" : "over-60m";
}

/** By layout, the same test the interface uses: no user agent is read. */
export function deviceClass(): DeviceClass {
  return typeof window !== "undefined" && window.matchMedia("(width < 48rem)").matches ? "phone" : "desktop";
}

/** Where events would go. There is nowhere, so this does nothing. */
function NOT_SENT_no_storage_configured(event: UsageEvent): void {
  void event;
}

/** The single way out for a usage event. Today it reaches nothing (see the top of this file). */
export function sendUsageEvent(event: UsageEvent): void {
  NOT_SENT_no_storage_configured(event);
}
