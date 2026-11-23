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


/** [D80] A mint that has not answered in this long has failed: the room is not held up for it. */
export const TURN_MINT_TIMEOUT_MS = 3_000;

/** What one mint gave: TURN servers, or why there are none (never the key or the credentials). */
export type TurnMint = { servers: IceServer[]; problem: string | null };

/**
 * TURN servers minted from a Cloudflare TURN key, to last `ttlS`. The key's id and token are
 * trimmed: a secret put with a trailing newline would otherwise name another key (HTTP 404).
 * Used by the coordinator for each peer, and by the app's `GET /api/live` to say whether TURN works.
 */
export async function mintTurn(keyId: string | undefined, token: string | undefined, ttlS: number, fetcher: typeof fetch = fetch): Promise<TurnMint> {
  const id = keyId?.trim();
  const bearer = token?.trim();
  if (!id || !bearer) return { servers: [], problem: "TURN key not configured" };
  let response: Response;
  try {
    response = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: ttlS }),
      signal: AbortSignal.timeout(TURN_MINT_TIMEOUT_MS),
    });
  } catch (error) {
    return { servers: [], problem: (error as { name?: string } | null)?.name === "TimeoutError" ? `no answer in ${TURN_MINT_TIMEOUT_MS / 1000} s` : "no answer" };
  }
  if (!response.ok) return { servers: [], problem: `HTTP ${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { servers: [], problem: "an answer that is not JSON" };
  }
  const servers = turnFrom(body);
  return servers.length > 0 ? { servers, problem: null } : { servers, problem: "no TURN servers in the answer" };
}
