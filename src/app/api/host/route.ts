import { TrackSource } from "livekit-server-sdk";
import { roomService, verifyHost } from "@/lib/host.server";
import { RTC_PROVIDER } from "@/lib/rtc/config";
import { realtimeKitHostAction } from "@/lib/rtc/server/realtimekit";

/**
 * Host-only moderation: mute someone's microphone or remove them from the meeting.
 *
 * LiveKit builds:     { token, action, identity }
 * RealtimeKit builds: { session, action, participantId }
 *
 * Either way the first field is what proves who is asking, and it was signed by this server.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { action } = body;
  if (action !== "mute" && action !== "remove") {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  if (RTC_PROVIDER === "realtimekit") {
    const { session, participantId } = body;
    if (typeof session !== "string" || typeof participantId !== "string" || !participantId) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    const result = await realtimeKitHostAction(session, action, participantId);
    return result.status === 200
      ? Response.json({ ok: true })
      : Response.json({ error: result.error }, { status: result.status });
  }

  const { token, identity } = body;
  if (typeof token !== "string" || typeof identity !== "string") {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const host = await verifyHost(token);
  const service = roomService();
  if (!host || !service) {
    return Response.json({ error: "Only the meeting host can do that." }, { status: 403 });
  }
  if (identity === host.identity) {
    return Response.json({ error: "Use your own controls for that." }, { status: 400 });
  }

  try {
    if (action === "remove") {
      await service.removeParticipant(host.room, identity);
    } else {
      const target = await service.getParticipant(host.room, identity);
      const microphones = target.tracks.filter((track) => track.source === TrackSource.MICROPHONE && !track.muted);
      await Promise.all(microphones.map((track) => service.mutePublishedTrack(host.room, identity, track.sid, true)));
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "That person may have already left." }, { status: 404 });
  }
}
