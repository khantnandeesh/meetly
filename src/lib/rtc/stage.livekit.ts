import type { Participant, Room } from "livekit-client";
import { postHost } from "./shared";
import { STAGE_ATTRIBUTE, STAGE_INVITED } from "./stage";
import type { CallMode, HostAction, ParticipantRole } from "./types";

/**
 * Webinars on LiveKit, in the browser: who is on stage, and saying yes or no to it.
 *
 * What someone may do is LiveKit's own record of their permissions, which only our server can
 * change (src/lib/webinar.server.ts): a viewer's token cannot publish, and the host inviting them
 * gives them the right. The invitation also marks them "invited" (a participant attribute), and
 * until they clear that mark by saying yes they are still a viewer: no tile, nothing sent.
 */

/** What someone is in the call. `host` is the call's `hostIdentity`. */
export function liveKitRole(person: Participant, mode: CallMode, host: string | null): ParticipantRole {
  if (person.identity && person.identity === host) return "host";
  if (mode !== "webinar") return "speaker";
  return person.permissions?.canPublish && !invited(person) ? "speaker" : "viewer";
}

/** The host has invited this person on stage and they have not answered. Only ever true in a webinar. */
export function liveKitStageInvite(person: Participant, mode: CallMode): boolean {
  return mode === "webinar" && !!person.permissions?.canPublish && invited(person);
}

const invited = (person: Participant) => person.attributes[STAGE_ATTRIBUTE] === STAGE_INVITED;

/**
 * Carries out `{ action: "stage" }`. Saying yes to your own invitation is done here, by clearing
 * the mark: the right to publish came with the invitation. Everything else is a request to our
 * server: inviting someone or sending them back (the host and co-hosts), and "Not now" or "Back
 * to audience" for yourself (anyone).
 */
export async function liveKitStageAction(
  room: Room,
  mode: CallMode,
  token: string,
  action: Extract<HostAction, { action: "stage" }>,
): Promise<void> {
  if (mode !== "webinar") throw new Error("Only a webinar has a stage.");
  const local = room.localParticipant;
  if (action.identity === local.identity && action.on) {
    if (!liveKitStageInvite(local, mode)) throw new Error("The invitation to speak has been withdrawn.");
    await local.setAttributes({ [STAGE_ATTRIBUTE]: "" });
    return;
  }
  await postHost({ token, action: "stage", identity: action.identity, on: action.on });
}

/**
 * You lost the right to publish (back to the audience, by you or the host): whatever you were
 * sending is switched off here too, so the controls and your own view say what everyone sees.
 * LiveKit has already stopped it reaching anyone.
 */
export function stopPublishingIfViewer(room: Room, mode: CallMode): void {
  const local = room.localParticipant;
  if (mode !== "webinar" || local.permissions?.canPublish !== false) return;
  const ignore = () => {};
  if (local.isMicrophoneEnabled) local.setMicrophoneEnabled(false).catch(ignore);
  if (local.isCameraEnabled) local.setCameraEnabled(false).catch(ignore);
  if (local.isScreenShareEnabled) local.setScreenShareEnabled(false).catch(ignore);
}
