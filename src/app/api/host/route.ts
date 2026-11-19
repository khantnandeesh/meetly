import { TrackSource } from "livekit-server-sdk";
import { roomService, verifyHost } from "@/lib/host.server";

/** Host-only moderation: mute someone's microphone or remove them from the meeting. */
export async function POST(request: Request) {
  let body: { token?: unknown; action?: unknown; identity?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { token, action, identity } = body;
  if (typeof token !== "string" || typeof identity !== "string" || (action !== "mute" && action !== "remove")) {
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
