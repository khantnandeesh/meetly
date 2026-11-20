import { GONE, NOT_THE_HOST, OWN_CONTROLS, DENIED, type HostActionResult } from "./rtc/hostAction";
import { STAGE_ATTRIBUTE, STAGE_INVITED } from "./rtc/stage";
import type { HostAction } from "./rtc/types";
import { mintJoinToken, parseRoomMeta, roomService, type Caller } from "./host.server";

/**
 * Webinars on LiveKit, on the server: who may publish, and how many may watch.
 *
 * A webinar is a room whose record says `mode: "webinar"`, written once when "New webinar" made
 * it (see `createMeetingRecord` in ./host.server.ts). Its host joins with an ordinary token. Everyone
 * else joins as a viewer: a token that cannot publish (`canPublish: false`), so LiveKit itself
 * refuses a viewer's microphone, camera and screen, whatever their browser does.
 *
 * Bringing someone on stage changes that participant's permissions on the LiveKit server
 * (`RoomService.updateParticipant`), which only our API secret can do. Sending them back to the
 * audience takes the right away again, and LiveKit stops whatever they were publishing.
 */

/** What a viewer may do: watch and listen, raise a hand and react (data and their own attributes), nothing more. */
const VIEWER = { canSubscribe: true, canPublish: false, canPublishData: true, canUpdateMetadata: true, hidden: false };
const SPEAKER = { ...VIEWER, canPublish: true };

const NOT_A_WEBINAR = { status: 400, error: "Only a webinar has a stage." } as const satisfies HostActionResult;
const HOST_STAYS = { status: 400, error: "The host stays on stage." } as const satisfies HostActionResult;

/**
 * A fresh token for someone whose role in a webinar just changed (made co-host, or no longer),
 * for the same identity. On LiveKit a co-host needs nothing new (our server reads the record on
 * every request), but the client reconnects all the same, so that "Switching to co-host…" is the
 * same moment on both providers. The token keeps what they may publish now: someone on stage
 * stays on stage.
 */
export async function liveKitRejoin(caller: Caller): Promise<{ status: 200; token: string } | Exclude<HostActionResult, { status: 200 }>> {
  const service = roomService();
  if (!service) return DENIED;
  if (caller.meta.mode !== "webinar" || caller.role === "host") return { status: 400, error: "Invalid request." };
  try {
    const person = await service.getParticipant(caller.room, caller.identity);
    const kind = person.permission?.canPublish ? "member" : "viewer";
    return { status: 200, token: await mintJoinToken(caller.room, caller.identity, person.name, kind) };
  } catch {
    return GONE;
  }
}

/**
 * Whether `identity` is in a webinar's audience and so reads the chat without writing in it:
 * not on stage (cannot publish), and neither its host nor a co-host, who moderate from wherever
 * they are. False if LiveKit could not be asked.
 */
export async function liveKitChatReadOnly(room: string, identity: string, canPublish: boolean): Promise<boolean> {
  if (canPublish) return false;
  const service = roomService();
  if (!service) return false;
  try {
    const [existing] = await service.listRooms([room]);
    if (!existing) return false;
    const meta = parseRoomMeta(existing.metadata);
    return meta.mode === "webinar" && meta.host !== identity && !meta.cohosts?.includes(identity);
  } catch {
    return false;
  }
}

/**
 * How many people are watching (in the room, unable to publish) right now. One call that lists
 * the room, made only when someone asks to join a webinar. Null if LiveKit could not be asked.
 */
export async function liveKitViewerCount(room: string): Promise<number | null> {
  const service = roomService();
  if (!service) return null;
  try {
    const present = await service.listParticipants(room);
    return present.filter((person) => !person.permission?.canPublish && !person.permission?.hidden).length;
  } catch {
    return null;
  }
}

/**
 * Invites a viewer to speak (`on`), or sends someone back to the audience. `caller` came from a
 * token we signed and the room's record, never from the request.
 *
 * - The host and co-hosts may invite anyone but the host, and send anyone but the host back.
 * - Anyone may send themselves back: "Not now" and "Back to audience" are always theirs to say.
 * - Saying yes to an invitation is not a request at all: the invitation already carried the
 *   right to publish, and the viewer's own client clears the "invited" mark (see
 *   src/lib/rtc/stage.livekit.ts).
 */
export async function liveKitStage(caller: Caller, request: Extract<HostAction, { action: "stage" }>): Promise<HostActionResult> {
  const service = roomService();
  if (!service) return DENIED;
  if (caller.meta.mode !== "webinar") return NOT_A_WEBINAR;
  const { room, meta } = caller;
  const self = request.identity === caller.identity;
  if (self) {
    if (request.on) return OWN_CONTROLS;
    if (caller.role === "host") return HOST_STAYS;
  } else {
    if (caller.role === "guest") return DENIED;
    if (request.identity === meta.host) return NOT_THE_HOST;
  }
  try {
    // Throws, and so answers "may have left", unless they are in the webinar right now.
    const person = await service.getParticipant(room, request.identity);
    if (request.on) {
      // Already able to speak (on stage, or invited and not answered yet): nothing to change.
      if (person.permission?.canPublish) return { status: 200 };
      // Two steps, in this order, so that no client ever sees the right to publish without the
      // "invited" mark (which would read as on stage): the mark first, then the right. If the
      // right cannot be given, the mark goes again; a mark alone means nothing.
      await service.updateParticipant(room, request.identity, { attributes: { [STAGE_ATTRIBUTE]: STAGE_INVITED } });
      try {
        await service.updateParticipant(room, request.identity, { permission: SPEAKER });
      } catch (error) {
        await service.updateParticipant(room, request.identity, { attributes: { [STAGE_ATTRIBUTE]: "" } }).catch(() => {});
        throw error;
      }
    } else {
      // The reverse: the right goes first, so nobody is ever seen on stage on the way out.
      await service.updateParticipant(room, request.identity, { permission: VIEWER });
      await service.updateParticipant(room, request.identity, { attributes: { [STAGE_ATTRIBUTE]: "" } }).catch(() => {});
    }
    return { status: 200 };
  } catch {
    return GONE;
  }
}
