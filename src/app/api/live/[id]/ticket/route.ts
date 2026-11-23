import { badBody, failure, isHostKey, isLiveId, isViewerPass, json, liveTicket, readJsonBody } from "@/lib/live/server";

/**
 * Live (beta): a ticket for the stream's coordinator, asked for on every (re)connect.
 *
 * { role: "viewer", pass, identity? } → { ticket, identity }  anyone with the full link (its `a=`)
 * { role: "source", hostKey }         → { ticket, identity }  only the browser that pressed "Go live"
 */
export async function POST(request: Request, context: RouteContext<"/api/live/[id]/ticket">) {
  const { id } = await context.params;
  if (!isLiveId(id)) return json(404, { error: "No such stream." });
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return badBody(error);
  }
  try {
    if (body.role === "source") {
      if (!(await isHostKey(id, body.hostKey))) return json(403, { error: "Only the host can broadcast this stream." });
      return json(200, await liveTicket(id, "source"));
    }
    if (body.role === "viewer") {
      if (!(await isViewerPass(id, body.pass))) return json(403, { error: "This link can’t be used to watch. Ask the host for the full link." });
      return json(200, await liveTicket(id, "viewer", body.identity));
    }
    return json(400, { error: "Bad request." });
  } catch (error) {
    return failure(error);
  }
}
