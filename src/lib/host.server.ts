import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";

/**
 * Host rule (enforced here, on the server, never by trusting the browser):
 *
 * - When a token is minted for a room that does not exist yet, or exists with nobody connected,
 *   that joiner's server-generated identity is written to the LiveKit room metadata as `host`.
 *   Only the API secret can write room metadata, so a client cannot make itself host.
 * - A host action is authorised by the caller presenting their own LiveKit access token. It was
 *   signed with our secret, so its identity and room cannot be forged; we compare that identity
 *   with the room's `host`.
 *
 * Known limits: if two people request the very first token within the same instant, whichever
 * write lands last is host. The role is tied to that one connection: if the host leaves or
 * reloads while others remain, the meeting has no host until it empties. If the first person
 * never actually connects, the next joiner inherits the role only once the room is empty and
 * the claim is over a minute old.
 */
export type RoomMeta = { host?: string; claimedAt?: number };

/** A freshly minted host token gets this long to connect before the claim can be replaced. */
const CLAIM_WINDOW_MS = 60_000;

function config() {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !serverUrl) return null;
  return { apiKey, apiSecret, httpUrl: serverUrl.replace(/^ws/, "http") };
}

export function roomService(): RoomServiceClient | null {
  const c = config();
  return c ? new RoomServiceClient(c.httpUrl, c.apiKey, c.apiSecret) : null;
}

export function parseRoomMeta(metadata: string | undefined): RoomMeta {
  try {
    const value = JSON.parse(metadata || "{}");
    if (typeof value?.host !== "string") return {};
    return { host: value.host, claimedAt: typeof value.claimedAt === "number" ? value.claimedAt : undefined };
  } catch {
    return {};
  }
}

/** Makes `identity` the host if nobody is in the room yet. Never throws: joining must not depend on it. */
export async function claimHostIfFirst(room: string, identity: string): Promise<void> {
  const service = roomService();
  if (!service) return;
  try {
    const metadata = JSON.stringify({ host: identity, claimedAt: Date.now() } satisfies RoomMeta);
    const [existing] = await service.listRooms([room]);
    if (!existing) {
      await service.createRoom({ name: room, metadata });
      return;
    }
    // The room exists. Hand over the host role only if it is genuinely empty (a live count, the
    // room summary lags) and the previous claimant has had time to connect. Never while people
    // are in the call: otherwise a guest could wait for the host to drop and rejoin as host.
    const claimedAt = parseRoomMeta(existing.metadata).claimedAt ?? 0;
    if (Date.now() - claimedAt < CLAIM_WINDOW_MS) return;
    const present = await service.listParticipants(room);
    if (present.length === 0) await service.updateRoomMetadata(room, metadata);
  } catch (error) {
    console.error("Could not record meeting host", error);
  }
}

/** Resolves the caller from their LiveKit token and checks they are this room's host. */
export async function verifyHost(token: string): Promise<{ room: string; identity: string } | null> {
  const c = config();
  const service = roomService();
  if (!c || !service) return null;
  try {
    const claims = await new TokenVerifier(c.apiKey, c.apiSecret).verify(token);
    const room = claims.video?.room;
    const identity = claims.sub;
    if (!room || !identity) return null;
    const [info] = await service.listRooms([room]);
    if (!info || parseRoomMeta(info.metadata).host !== identity) return null;
    return { room, identity };
  } catch {
    return null;
  }
}
