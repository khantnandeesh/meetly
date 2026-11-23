import { failure, isLiveId, json, liveTree } from "@/lib/live/server";

/**
 * Live (beta): "Who's connected". GET → `LiveTree` (src/lib/live/tree.ts): the coordinator's
 * tree map with nothing in it that identifies anyone, plus whether the stream is on, over or full.
 */
export async function GET(_request: Request, context: RouteContext<"/api/live/[id]/tree">) {
  const { id } = await context.params;
  if (!isLiveId(id)) return json(404, { error: "No such stream." });
  try {
    return json(200, await liveTree(id));
  } catch (error) {
    return failure(error);
  }
}
