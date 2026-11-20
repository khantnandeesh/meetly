import { generateCode, isValidCode } from "@/lib/code";
import { createMeetingRecord, liveKitPassSecret, peekMeeting } from "@/lib/host.server";
import { passCookie, readPass } from "@/lib/pass.server";
import { RTC_PROVIDER } from "@/lib/rtc/config";
import { createRealtimeKitMeeting, missingWebinarEnv, peekRealtimeKitMeeting, realtimeKitPassSecret } from "@/lib/rtc/server/realtimekit";
import { WEBINARS_PAUSED, webinarsEnabled } from "@/lib/webinarLimit";

const passSecret = () => (RTC_PROVIDER === "realtimekit" ? realtimeKitPassSecret() : liveKitPassSecret());

/**
 * The meeting itself, before anyone is in it.
 *
 * { action: "create" }       → { code }                  a new meeting; this browser is its host
 * { action: "create",        → { code }                  a new webinar, the same way
 *   mode: "webinar" }
 * { action: "peek", code }   → { access, host, count }   what the pre-join screen may know
 *                                                        (`MeetingPeek` in src/lib/rtc/types.ts)
 * { action: "webinars" }     → { enabled }               whether "New webinar" is offered
 *                                                        (`MEETLY_WEBINARS_ENABLED`)
 *
 * Creating a meeting never fails outright: if the provider cannot be reached the code is still
 * returned, and the first person into it becomes host instead. Creating a webinar can fail: a
 * code without its record would be a meeting, so no code is given out unless the record was made.
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

  if (body.action === "webinars") {
    // Asked by the home page, which is static: the switch is read here so that turning it off
    // takes effect at once, without a rebuild. A server that cannot make webinars says no too.
    const ready = RTC_PROVIDER !== "realtimekit" || missingWebinarEnv().length === 0;
    return Response.json({ enabled: webinarsEnabled() && ready }, { headers: { "Cache-Control": "no-store" } });
  }

  if (body.action !== "create") return Response.json({ error: "Invalid request." }, { status: 400 });
  const webinar = body.mode === "webinar";
  if (webinar && !webinarsEnabled()) return Response.json({ error: WEBINARS_PAUSED, reason: "paused" }, { status: 403 });
  if (webinar && RTC_PROVIDER === "realtimekit" && missingWebinarEnv().length > 0) {
    // The names are for whoever runs the site, not for the person trying to start one.
    console.error(`Server is missing ${missingWebinarEnv().join(", ")}, which webinars need.`);
    return Response.json({ error: "Webinars aren't set up on this server yet." }, { status: 500 });
  }
  const code = generateCode();
  const headers = new Headers();
  let made = false;
  if (RTC_PROVIDER === "realtimekit") {
    const host = await createRealtimeKitMeeting(code, webinar ? "webinar" : "meeting");
    if (host) headers.append("Set-Cookie", passCookie(request, { code, key: host.key, ids: [host.identity] }, passSecret()));
    made = !!host;
  } else {
    const key = await createMeetingRecord(code, webinar ? "webinar" : "meeting");
    if (key) headers.append("Set-Cookie", passCookie(request, { code, key, ids: [] }, passSecret()));
    made = !!key;
  }
  if (webinar && !made) return Response.json({ error: "Couldn't start the webinar. Try again in a moment." }, { status: 502 });
  return Response.json({ code }, { headers });
}
