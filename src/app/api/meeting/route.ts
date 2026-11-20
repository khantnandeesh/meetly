import { generateCode, isValidCode } from "@/lib/code";
import { createMeetingRecord, liveKitPassSecret, peekMeeting } from "@/lib/host.server";
import { passCookie, readPass } from "@/lib/pass.server";
import { RTC_PROVIDER } from "@/lib/rtc/config";
import { createRealtimeKitMeeting, peekRealtimeKitMeeting, realtimeKitPassSecret } from "@/lib/rtc/server/realtimekit";

const passSecret = () => (RTC_PROVIDER === "realtimekit" ? realtimeKitPassSecret() : liveKitPassSecret());

/**
 * The meeting itself, before anyone is in it.
 *
 * { action: "create" }       → { code }                  a new meeting; this browser is its host
 * { action: "peek", code }   → { access, host, count }   what the pre-join screen may know
 *                                                        (`MeetingPeek` in src/lib/rtc/types.ts)
 *
 * Creating never fails outright: if the provider cannot be reached the code is still returned,
 * and the first person into it becomes host instead.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action === "peek") {
    const code = typeof body.code === "string" ? body.code : "";
    if (!isValidCode(code)) return Response.json({ error: "That isn't a valid meeting code." }, { status: 400 });
    const pass = readPass(request, code, passSecret());
    const seen = RTC_PROVIDER === "realtimekit" ? await peekRealtimeKitMeeting(code, pass) : await peekMeeting(code, pass);
    return Response.json(seen);
  }

  if (body.action !== "create") return Response.json({ error: "Invalid request." }, { status: 400 });
  const code = generateCode();
  const headers = new Headers();
  if (RTC_PROVIDER === "realtimekit") {
    const made = await createRealtimeKitMeeting(code);
    if (made) headers.append("Set-Cookie", passCookie(request, { code, key: made.key, ids: [made.identity] }, passSecret()));
  } else {
    const key = await createMeetingRecord(code);
    if (key) headers.append("Set-Cookie", passCookie(request, { code, key, ids: [] }, passSecret()));
  }
  return Response.json({ code }, { headers });
}
