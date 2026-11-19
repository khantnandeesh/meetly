import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { isValidCode } from "@/lib/code";
import { claimHostIfFirst } from "@/lib/host.server";

export async function POST(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !serverUrl) {
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

  // Identity is always minted server-side so a client can't impersonate another participant.
  const identity = randomUUID();
  // The first person into an empty room becomes its host (see src/lib/host.server.ts).
  await claimHostIfFirst(room, identity);
  const token = new AccessToken(apiKey, apiSecret, {
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

  return Response.json({ token: await token.toJwt(), serverUrl });
}
