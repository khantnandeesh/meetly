import { badBody, endLive, failure, isHostKey, isLiveId, json, readJsonBody } from "@/lib/live/server";

/** Live (beta): the host's "End". { hostKey } → { ended: true }; every viewer is told it is over. */
export async function POST(request: Request, context: RouteContext<"/api/live/[id]/end">) {
  const { id } = await context.params;
  if (!isLiveId(id)) return json(404, { error: "No such stream." });
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return badBody(error);
  }
  try {
    if (!(await isHostKey(id, body.hostKey))) return json(403, { error: "Only the host can end this stream." });
    await endLive(id);
    return json(200, { ended: true });
  } catch (error) {
    return failure(error);
  }
}
