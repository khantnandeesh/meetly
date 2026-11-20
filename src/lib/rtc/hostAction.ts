import type { HostAction, JoinAccess } from "./types";

const ON_ONE = ["mute", "remove", "stopCamera", "lowerHand", "admit", "deny"] as const;
const ON_ALL = ["muteAll", "lowerAllHands", "end"] as const;
const ACCESS: readonly JoinAccess[] = ["open", "ask", "locked"];

/** What a chat message's id may look like: both providers hand out short, plain ones. */
export const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** What only the host may do; everything else is open to co-hosts as well. */
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
  if (action === "coHost") {
    return identity && typeof body.on === "boolean" ? { action, identity, on: body.on } : null;
  }
  if (action === "pin") {
    const id = body.messageId;
    if (id === null) return { action, messageId: null };
    return typeof id === "string" && MESSAGE_ID.test(id) ? { action, messageId: id } : null;
  }
  if (action === "access") {
    return ACCESS.includes(body.access as JoinAccess) ? { action, access: body.access as JoinAccess } : null;
  }
  return null;
}

export type HostActionResult = { status: 200 } | { status: 400 | 403 | 404 | 502; error: string };

export const DENIED = { status: 403, error: "Only the meeting host can do that." } as const satisfies HostActionResult;
export const HOST_ONLY = { status: 403, error: "Only the host can do that, not a co-host." } as const satisfies HostActionResult;
export const NOT_THE_HOST = { status: 403, error: "A co-host can't do that to the host." } as const satisfies HostActionResult;
export const OWN_CONTROLS = { status: 400, error: "Use your own controls for that." } as const satisfies HostActionResult;
export const GONE = { status: 404, error: "That person may have already left." } as const satisfies HostActionResult;
