import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { isValidCode } from "@/lib/code";
import { claimHostIfFirst } from "@/lib/host.server";
import { RTC_PROVIDER } from "@/lib/rtc/config";
import { issueRealtimeKitJoin, missingRealtimeKitEnv } from "@/lib/rtc/server/realtimekit";

/** Lets someone into a meeting. What comes back depends on the provider this build uses. */
export async function POST(request: Request) {
  if (RTC_PROVIDER === "realtimekit") {
    const missing = missingRealtimeKitEnv();
    if (missing.length > 0) {
      return Response.json({ error: `Server is missing ${missing.join(", ")}.` }, { status: 500 });
    }
  } else if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_URL) {
    return Response.json(
      { error: "Server is missing LIVEKIT_URL, LIVEKIT_API_KEY or LIVEKIT_API_SECRET." },
      { status: 500 },
    );
  }

  let body: { room?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const room = typeof body.room === "string" ? body.room : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
  if (!isValidCode(room)) {
    return Response.json({ error: "Invalid meeting code." }, { status: 400 });
  }
  if (!name) {
    return Response.json({ error: "A display name is required." }, { status: 400 });
  }

  if (RTC_PROVIDER === "realtimekit") {
    try {
      // { authToken, session, participantId, meetingId, role, hostPreset }
      return Response.json(await issueRealtimeKitJoin(room, name));
    } catch (error) {
      console.error("Could not issue a RealtimeKit token", error);
      return Response.json({ error: "Could not reach the meeting service. Try again." }, { status: 502 });
    }
  }
  return Response.json(await liveKitJoin(room, name));
}

async function liveKitJoin(room: string, name: string): Promise<{ token: string; serverUrl: string }> {
  // Identity is always minted server-side so a client can't impersonate another participant.
  const identity = randomUUID();
  // The first person into an empty room becomes its host (see src/lib/host.server.ts).
  await claimHostIfFirst(room, identity);
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: "6h",
  });
  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true, // lets a participant raise/lower their own hand
  });
  return { token: await token.toJwt(), serverUrl: process.env.LIVEKIT_URL! };
}
