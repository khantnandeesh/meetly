import { randomUUID } from "node:crypto";
import { isValidCode } from "@/lib/code";
import { decideJoin, liveKitPassSecret, mintJoinToken } from "@/lib/host.server";
import { extendPass, passCookie, readPass } from "@/lib/pass.server";
import { RTC_PROVIDER } from "@/lib/rtc/config";
import { issueRealtimeKitJoin, missingRealtimeKitEnv, realtimeKitPassSecret } from "@/lib/rtc/server/realtimekit";

const REFUSALS = {
  removed: "The host removed you from this meeting.",
  locked: "This meeting is locked. Nobody new can join right now.",
} as const;

function refuse(reason: keyof typeof REFUSALS): Response {
  return Response.json({ error: REFUSALS[reason], reason }, { status: 403 });
}

/** Lets someone into a meeting, or says why not. What comes back depends on the provider this build uses. */
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
    const secret = realtimeKitPassSecret();
    const pass = readPass(request, room, secret);
    try {
      const outcome = await issueRealtimeKitJoin(room, name, pass);
      if (outcome.refused) return refuse(outcome.refused);
      // { authToken, session, participantId, meetingId, role, hostPreset, coHosts, access, canAsk }
      return Response.json(outcome.join, {
        headers: { "Set-Cookie": passCookie(request, extendPass(pass, outcome.identity, outcome.key), secret) },
      });
    } catch (error) {
      console.error("Could not issue a RealtimeKit token", error);
      return Response.json({ error: "Could not reach the meeting service. Try again." }, { status: 502 });
    }
  }

  const secret = liveKitPassSecret();
  const pass = readPass(request, room, secret);
  // Identity is always minted server-side so a client can't impersonate another participant.
  const identity = randomUUID();
  // Host, guest, a guest who has to ask first, or nobody (see src/lib/host.server.ts).
  const decision = await decideJoin(room, identity, pass);
  if (decision.refused) return refuse(decision.refused);
  // Someone who has to ask is given a token for the lobby, not for the meeting.
  const asking = decision.role === "guest" && decision.access === "ask";
  return Response.json(
    {
      token: await mintJoinToken(room, identity, name, asking ? "asking" : "member"),
      serverUrl: process.env.LIVEKIT_URL!,
      ...(asking ? { lobby: true } : {}),
    },
    { headers: { "Set-Cookie": passCookie(request, extendPass(pass, identity, decision.key), secret) } },
  );
}
