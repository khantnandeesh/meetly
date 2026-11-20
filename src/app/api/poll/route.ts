import { liveKitPassSecret } from "@/lib/host.server";
import { readPass } from "@/lib/pass.server";
import { liveKitPoll } from "@/lib/polls.server";
import { RTC_PROVIDER } from "@/lib/rtc/config";

/**
 * Polls on LiveKit builds: { token, action: "create" | "vote" | "mine", ... }. See
 * src/lib/polls.server.ts for what each does and who may. Ending a poll is a host action and
 * goes through /api/host like the others.
 *
 * RealtimeKit builds do not use this route: polls there are RealtimeKit's own, and Cloudflare
 * decides from each participant's preset who may start one and who may vote.
 */
export async function POST(request: Request) {
  if (RTC_PROVIDER !== "livekit") return Response.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const result = await liveKitPoll(body.token, body, (room) => readPass(request, room, liveKitPassSecret()));
  return result.status === 200
    ? Response.json({ ok: true, ...result.data })
    : Response.json({ error: result.error }, { status: result.status });
}
