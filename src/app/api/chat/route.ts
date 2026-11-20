import { liveKitChat } from "@/lib/chat.server";
import { liveKitPassSecret } from "@/lib/host.server";
import { readPass } from "@/lib/pass.server";
import { RTC_PROVIDER } from "@/lib/rtc/config";

/**
 * Chat on LiveKit builds: { token, action: "send" | "delete" | "verify", ... }. See
 * src/lib/chat.server.ts for what each does and why it goes through the server.
 *
 * RealtimeKit builds do not use this route: RealtimeKit's own chat is kept by Cloudflare.
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
  const result = await liveKitChat(body.token, body, (room) => readPass(request, room, liveKitPassSecret()));
  return result.status === 200
    ? Response.json({ ok: true, ...result.data })
    : Response.json({ error: result.error }, { status: result.status });
}
