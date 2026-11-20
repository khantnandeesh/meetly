/**
 * Webinars: what both sides of the LiveKit stage agree on, and the audience limit. Kept apart
 * from the adapters and the server so either can import it without the other's dependencies.
 */

/**
 * LiveKit: participant attribute our server sets to "invited" when the host invites a viewer to
 * speak. The invitation comes with the right to publish, so that saying yes needs no second
 * round trip; until the viewer says yes (and clears the attribute) they are still a viewer: no
 * tile, nothing published. Raising the right is only ever done by our server, so a viewer who
 * writes the attribute on themselves gains nothing.
 */
export const STAGE_ATTRIBUTE = "stage";
export const STAGE_INVITED = "invited";

/** How many people may watch one webinar when `MEETLY_WEBINAR_VIEWER_CAP` does not say. */
export const DEFAULT_VIEWER_CAP = 250;

/** The audience limit from the environment value, or the default if it is unset or not a positive whole number. */
export function viewerCap(value: string | undefined = process.env.MEETLY_WEBINAR_VIEWER_CAP): number {
  const cap = Number(value);
  return value && Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_VIEWER_CAP;
}
