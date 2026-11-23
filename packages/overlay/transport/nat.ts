/**
 * What kind of NAT this browser is behind, for `Capabilities.nat` (SPEC §8.1): gather candidates
 * against two STUN servers and compare the addresses they report. The same public port from
 * both means "cone", different ports "symmetric", a public host address "open".
 *
 * Owner: E-transport+topology.
 */
import type { Capabilities, IceServer } from "../protocol";

/** The parts of an ICE candidate the classification needs. */
export type GatheredCandidate = { type: string; address: string; port: number; relatedAddress?: string | null; relatedPort?: number | null; protocol?: string };

const PROBE_TIMEOUT_MS = 3000;
/**
 * [D48] After the first server-reflexive candidate, how long a different mapping of the same
 * socket (from the other STUN server) is waited for before the answer is "cone". A browser
 * reports one candidate per distinct mapping, so a cone NAT never shows a second one: without
 * this the probe would run to the end of gathering, or to its 3 s timeout.
 */
export const NAT_SRFLX_GRACE_MS = 300;

function isPrivateAddress(address: string): boolean {
  if (address.endsWith(".local")) return true; // mDNS: Chromium hides the host address
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
}

/**
 * The verdict from what was gathered. `stunServers` is how many STUN servers were asked: with
 * fewer than two answering there is nothing to compare, and the answer is "unknown".
 */
export function classifyNat(candidates: readonly GatheredCandidate[], stunServers: number): Capabilities["nat"] {
  const udp = candidates.filter((c) => (c.protocol ?? "udp").toLowerCase() === "udp");
  if (udp.some((c) => c.type === "host" && !isPrivateAddress(c.address))) return "open";
  // The mapped addresses each local socket was given. A browser reports one server-reflexive
  // candidate per distinct mapping, so one mapping seen from two servers shows as one candidate.
  const mappings = new Map<string, Set<string>>();
  for (const c of udp) {
    if (c.type !== "srflx") continue;
    const base = `${c.relatedAddress ?? ""}:${c.relatedPort ?? ""}`;
    let set = mappings.get(base);
    if (!set) mappings.set(base, (set = new Set()));
    set.add(`${c.address}:${c.port}`);
  }
  if (mappings.size === 0) return udp.some((c) => c.type === "relay") ? "relay" : "unknown";
  if (stunServers < 2) return "unknown";
  for (const set of mappings.values()) if (set.size > 1) return "symmetric";
  return "cone";
}

/**
 * [D48] A verdict before gathering ends, if what has come already decides it: a public host
 * address is "open", one socket mapped two ways is "symmetric". Otherwise null: wait.
 */
export function earlyNat(candidates: readonly GatheredCandidate[], stunServers: number): Capabilities["nat"] | null {
  const verdict = classifyNat(candidates, stunServers);
  return verdict === "open" || verdict === "symmetric" ? verdict : null;
}

export async function probeNat(ice: IceServer[]): Promise<Capabilities["nat"]> {
  const stun = ice.flatMap((server) => server.urls).filter((url) => url.startsWith("stun:"));
  if (typeof RTCPeerConnection === "undefined") return "unknown";
  // STUN only: the probe compares mapped addresses, and a TURN allocation for it would be paid for ([D82]).
  const pc = new RTCPeerConnection({ iceServers: stun.map((url) => ({ urls: url })) });
  const gathered: GatheredCandidate[] = [];
  try {
    pc.createDataChannel("probe");
    const done = new Promise<void>((resolve) => {
      let grace = false;
      pc.onicecandidate = (event) => {
        const c = event.candidate;
        if (!c) return resolve();
        if (c.type && c.address && c.port !== null) gathered.push({ type: c.type, address: c.address, port: c.port, relatedAddress: c.relatedAddress, relatedPort: c.relatedPort, protocol: c.protocol ?? undefined });
        // [D48] Answer as soon as the candidates decide it, not at the end of gathering.
        if (earlyNat(gathered, stun.length) !== null) return resolve();
        if (c.type === "srflx" && !grace) {
          grace = true;
          globalThis.setTimeout(resolve, NAT_SRFLX_GRACE_MS);
        }
      };
      // The one place the engine waits on wall time without a `Clock`: a one-off, before a session exists.
      globalThis.setTimeout(resolve, PROBE_TIMEOUT_MS);
    });
    await pc.setLocalDescription();
    await done;
  } catch {
    return "unknown";
  } finally {
    pc.close();
  }
  return classifyNat(gathered, stun.length);
}
