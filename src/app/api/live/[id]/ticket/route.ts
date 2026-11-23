import { failure, isHostKey, isLiveId, json, liveTicket } from "@/lib/live/server";

/**
 * Live (beta): a ticket for the stream's coordinator, asked for on every (re)connect.
 *
 * { role: "viewer", identity? }  → { ticket, identity }  anyone with the link
 * { role: "source", hostKey }    → { ticket, identity }  only the browser that pressed "Go live"
 */
export async function POST(request: Request, context: RouteContext<"/api/live/[id]/ticket">) {
  const { id } = await context.params;
  if (!isLiveId(id)) return json(404, { error: "No such stream." });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
  } catch {
    return json(400, { error: "Bad request." });
  }
  try {
    if (body.role === "source") {
      if (!(await isHostKey(id, body.hostKey))) return json(403, { error: "Only the host can broadcast this stream." });
      return json(200, await liveTicket(id, "source"));
    }
    if (body.role === "viewer") return json(200, await liveTicket(id, "viewer", body.identity));
    return json(400, { error: "Bad request." });
  } catch (error) {
    return failure(error);
  }
}
