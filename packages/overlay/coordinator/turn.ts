/**
 * Cloudflare's TURN servers for one peer, from the TURN key's `generate-ice-servers` answer
 * (SPEC §6.7 [D80]). Apart from ./durableObject.ts, which is a Worker's entry module: everything
 * that exports must be a handler or a class.
 *
 * Owner: E-coordinator.
 */
import type { IceServer } from "../protocol";

type MintedServer = { urls: string | string[]; username?: string; credential?: string };

/**
 * Cloudflare's TURN servers for one peer, from its answer: TURN URLs only (the configured STUN
 * servers are kept, see ./durableObject.ts `iceServers`), and none on port 53, which browsers block (Cloudflare's
 * own advice: an ICE agent would wait on it for nothing).
 */
export function turnFrom(answer: unknown): IceServer[] {
  const raw = (answer as { iceServers?: MintedServer | MintedServer[] } | null)?.iceServers;
  // The older `generate` endpoint answers with one object, `generate-ice-servers` with a list.
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const server of list) {
    const urls = (Array.isArray(server?.urls) ? server.urls : [server?.urls]).filter((url): url is string => typeof url === "string" && /^turns?:/i.test(url) && !/:53(\?|$)/.test(url));
    if (urls.length === 0 || typeof server.username !== "string" || typeof server.credential !== "string") continue;
    out.push({ urls: urls.slice(0, 8), username: server.username, credential: server.credential });
  }
  return out;
}

