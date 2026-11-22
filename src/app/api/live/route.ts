import { generateCode } from "@/lib/code";
import { failure, hostKey, json } from "@/lib/live/server";

/**
 * Live (beta): "Go live". POST → { id, hostKey }: a new stream's share id (shaped like a meeting
 * code) and the key that makes this browser its host. See src/lib/live/server.ts.
 */
export async function POST() {
  try {
    const id = generateCode();
    return json(200, { id, hostKey: await hostKey(id) });
  } catch (error) {
    return failure(error);
  }
}
