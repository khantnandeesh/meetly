import { liveKitHostAction, lobbyWatchToken, verifyCaller } from "@/lib/host.server";
import { RTC_PROVIDER } from "@/lib/rtc/config";
import { DENIED, parseHostAction } from "@/lib/rtc/hostAction";
import { realtimeKitHostAction, realtimeKitWebinarRejoin, realtimeKitWhyStopped } from "@/lib/rtc/server/realtimekit";
import { liveKitRejoin, liveKitStage } from "@/lib/webinar.server";

/**
 * Moderation by the host and co-hosts (see `HostAction` in src/lib/rtc/types.ts for the list).
 *
 * LiveKit builds:     { token, action, identity?, ... }  (pinning a chat message also sends
 *                     `message`: the message as this server signed it)
 * RealtimeKit builds: { session, action, participantId?, ... }
 *
 * Either way the first field is what proves who is asking, and it was signed by this server.
 *
 * Admit all and Deny all are one request however many are waiting: { action, identities: [...] }.
 * The answer is { ok: true } even if some of them could not be answered; those are listed in
 * `failed`, so the host can be told how many and try them again.
 * What the caller may do is looked up from the meeting's record on every request; nothing in
 * the body, and nothing a browser can write about itself, is taken as proof of a role.
 *
 * RealtimeKit builds also answer { session, action: "roles" } for any participant: who the
 * co-hosts are and who may join; and { session, action: "why" }: why a webinar was ended for
 * everyone (its free time limit, or webinars switched off). LiveKit builds answer
 * { token, action: "lobby" } for the host and co-hosts with a token to watch who is asking to join.
 *
 * Webinars, both providers: { session | token, action: "rejoin" } answers anyone whose role just
 * changed (made co-host, or no longer) with a fresh way in for the same person (see
 * src/lib/webinar.server.ts and src/lib/rtc/server/realtimekit.ts).
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (RTC_PROVIDER === "realtimekit") {
    if (body.action === "why") {
      // Asked by everyone removed from a webinar at once; see `realtimeKitWhyStopped`.
      const result = await realtimeKitWhyStopped(body.session);
      return result.status === 200
        ? Response.json({ ok: true, ...result.data })
        : Response.json({ error: result.error }, { status: result.status });
    }
    const wanted = body.action === "roles" ? ({ action: "roles" } as const) : parseHostAction(body);
    if (body.action !== "rejoin" && (!wanted || typeof body.session !== "string")) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    // Webinars: a fresh token for someone whose role changed (see src/lib/rtc/server/realtimekit.ts).
    const result =
      body.action === "rejoin" ? await realtimeKitWebinarRejoin(body.session) : await realtimeKitHostAction(body.session, wanted!);
    return result.status === 200
      ? Response.json({ ok: true, ...result.data })
      : Response.json({ error: result.error }, { status: result.status });
  }

  if (typeof body.token !== "string") return Response.json({ error: "Invalid request." }, { status: 400 });
  if (body.action === "rejoin") {
    const caller = await verifyCaller(body.token);
    const result = caller ? await liveKitRejoin(caller) : DENIED;
    return result.status === 200 ? Response.json({ ok: true, token: result.token }) : Response.json({ error: result.error }, { status: result.status });
  }
  if (body.action === "lobby") {
    // A way to see who is asking to join (see `lobbyOf` in src/lib/host.server.ts).
    const caller = await verifyCaller(body.token);
    const token = caller && (await lobbyWatchToken(caller));
    return token ? Response.json({ ok: true, token }) : Response.json({ error: DENIED.error }, { status: 403 });
  }
  const wanted = parseHostAction(body);
  if (!wanted) return Response.json({ error: "Invalid request." }, { status: 400 });
  const caller = await verifyCaller(body.token);
  // The stage has rules of its own (anyone may step down), so it is decided apart from moderation.
  const result = !caller ? DENIED : wanted.action === "stage" ? await liveKitStage(caller, wanted) : await liveKitHostAction(caller, wanted, body.message);
  return result.status === 200
    ? Response.json({ ok: true, ...(result.failed ? { failed: result.failed } : {}) })
    : Response.json({ error: result.error }, { status: result.status });
}
