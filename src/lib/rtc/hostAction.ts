import { POLL_ID } from "./shared";
import type { HostAction, JoinAccess } from "./types";

const ON_ONE = ["mute", "remove", "stopCamera", "lowerHand", "admit", "deny"] as const;
const ON_ALL = ["muteAll", "lowerAllHands", "end"] as const;
const ON_MANY = ["admitAll", "denyAll"] as const;
const ACCESS: readonly JoinAccess[] = ["open", "ask", "locked"];

/**
 * Most people one Admit all or Deny all answers. Far more than any waiting room we expect; a
 * longer list is refused whole rather than answered in part.
 */
export const MAX_BULK = 1000;

/** What a chat message's id may look like: both providers hand out short, plain ones. */
export const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * What only the host may do; everything else is open to co-hosts as well. Admit all and Deny all
 * are open to co-hosts because letting one person in is. Allowing reactions is open to them too:
 * it is a setting for the whole meeting, like who can join, which co-hosts already change.
 */
export function isHostOnly(action: HostAction): boolean {
  return action.action === "end" || action.action === "coHost";
}

/**
 * Reads a moderation request out of a /api/host body. `identity` is accepted under either name
 * the two providers' clients have used for it. Null if the body is not a request we know.
 */
export function parseHostAction(body: Record<string, unknown>): HostAction | null {
  const { action } = body;
  const identity = typeof body.identity === "string" ? body.identity : typeof body.participantId === "string" ? body.participantId : "";
  if ((ON_ONE as readonly unknown[]).includes(action)) {
    return identity ? { action: action as (typeof ON_ONE)[number], identity } : null;
  }
  if ((ON_ALL as readonly unknown[]).includes(action)) return { action: action as (typeof ON_ALL)[number] };
  if ((ON_MANY as readonly unknown[]).includes(action)) {
    const given: unknown[] = Array.isArray(body.identities) ? body.identities : [];
    if (given.length === 0 || given.length > MAX_BULK) return null;
    if (!given.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200)) return null;
    // The same person twice is answered once.
    return { action: action as (typeof ON_MANY)[number], identities: Array.from(new Set(given)) };
  }
  if (action === "coHost" || action === "stage") {
    return identity && typeof body.on === "boolean" ? { action, identity, on: body.on } : null;
  }
  if (action === "pin") {
    const id = body.messageId;
    if (id === null) return { action, messageId: null };
    return typeof id === "string" && MESSAGE_ID.test(id) ? { action, messageId: id } : null;
  }
  if (action === "closePoll") {
    return typeof body.pollId === "string" && POLL_ID.test(body.pollId) ? { action, pollId: body.pollId } : null;
  }
  if (action === "access") {
    return ACCESS.includes(body.access as JoinAccess) ? { action, access: body.access as JoinAccess } : null;
  }
  if (action === "reactions") {
    return typeof body.allowed === "boolean" ? { action, allowed: body.allowed } : null;
  }
  return null;
}

/**
 * `failed`, for Admit all and Deny all only: the people who are still waiting because answering
 * them went wrong. Someone who stopped asking in the meantime is not among them, since there is
 * nothing to try again for them.
 */
export type HostActionResult = { status: 200; failed?: string[] } | { status: 400 | 403 | 404 | 502; error: string };

export const DENIED = { status: 403, error: "Only the host or a co-host can do that." } as const satisfies HostActionResult;
export const HOST_ONLY = { status: 403, error: "Only the host can do that." } as const satisfies HostActionResult;
export const NOT_THE_HOST = { status: 403, error: "A co-host can't do that to the host." } as const satisfies HostActionResult;
export const OWN_CONTROLS = { status: 400, error: "Use your own controls for that." } as const satisfies HostActionResult;
export const GONE = { status: 404, error: "That person may have already left." } as const satisfies HostActionResult;
