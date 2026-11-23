import { generateCode } from "@/lib/code";
import { failure, hostKey, json } from "@/lib/live/server";
import { signTitle } from "@/lib/live/title.server";

/**
 * Live (beta): "Go live". POST { title? } → { id, hostKey, title? }: a new stream's share id
 * (shaped like a meeting code), the key that makes this browser its host, and its title signed for
 * the share link (src/lib/live/title.server.ts). See src/lib/live/server.ts.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { title?: unknown };
    const id = generateCode();
    return json(200, { id, hostKey: await hostKey(id), title: await signTitle(id, body?.title) });
  } catch (error) {
    return failure(error);
  }
}
