import { GONE, NOT_THE_HOST, OWN_CONTROLS, DENIED, type HostActionResult } from "./rtc/hostAction";
import { STAGE_ATTRIBUTE, STAGE_INVITED } from "./rtc/stage";
import type { HostAction } from "./rtc/types";
import { roomService, type Caller } from "./host.server";

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
      await service.updateParticipant(room, request.identity, { permission: SPEAKER, attributes: { [STAGE_ATTRIBUTE]: STAGE_INVITED } });
    } else {
      await service.updateParticipant(room, request.identity, { permission: VIEWER, attributes: { [STAGE_ATTRIBUTE]: "" } });
    }
    return { status: 200 };
  } catch {
    return GONE;
  }
}
