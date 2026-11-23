import { connection } from "next/server";
import { generateCode } from "@/lib/code";
import { BodyTooLarge, badBody, failure, hostKey, json, liveTurn, readJsonBody, viewerPass } from "@/lib/live/server";
import { signTitle } from "@/lib/live/title.server";

/**
 * Live (beta): what the pages say of this deployment. GET → { turn }: whether viewers on strict
 * networks can watch, because TURN works here (a mint from the TURN key returned servers), for
 * "How it works". Read at request time, not at build: the secrets are the Worker's.
 */
export async function GET() {
  await connection();
  return json(200, { turn: await liveTurn() });
}

/**
 * Live (beta): "Go live". POST { title? } → { id, hostKey, viewerPass, title? }: a new stream's
 * share id (shaped like a meeting code), the key that makes this browser its host, the pass its
 * viewers' link carries (src/lib/live/server.ts), and its title signed for the share link
 * (src/lib/live/title.server.ts). An empty body is no title. See src/lib/live/server.ts.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(request);
  } catch (error) {
    // Only a body too large is refused; any other is read as no title, as before.
    if (error instanceof BodyTooLarge) return badBody(error);
  }
  try {
    const id = generateCode();
    return json(200, { id, hostKey: await hostKey(id), viewerPass: await viewerPass(id), title: await signTitle(id, body.title) });
  } catch (error) {
    return failure(error);
  }
}
