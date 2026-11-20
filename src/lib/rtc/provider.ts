import { RTC_PROVIDER } from "./config";
import type { JoinGrant, RtcProviderModule } from "./types";

export { RTC_PROVIDER };

/**
 * Fetches the adapter for the chosen provider, and with it that provider's SDK. Nothing calls
 * this before the user presses Join, so the pre-join page carries neither SDK; the comparison
 * is written out against the literal so the bundler can drop the branch that is not built.
 */
export function loadProvider(): Promise<RtcProviderModule> {
  if (process.env.NEXT_PUBLIC_RTC_PROVIDER === "realtimekit") return import("./realtimekit");
  return import("./livekit");
}

/** Asks our server for a way into the meeting. Throws with a message fit to show the user. */
export async function requestJoin(code: string, name: string): Promise<JoinGrant> {
  const response = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: code, name }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not join the meeting.");
  return { ...data, provider: RTC_PROVIDER } as JoinGrant;
}

/** The body /api/host expects for this provider. The server re-checks who is asking. */
export function hostRequest(grant: JoinGrant, action: "mute" | "remove", identity: string): object {
  return grant.provider === "realtimekit"
    ? { session: grant.session, action, participantId: identity }
    : { token: grant.token, action, identity };
}
