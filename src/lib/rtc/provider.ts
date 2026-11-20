import { RTC_PROVIDER } from "./config";
import type { JoinGrant, MeetingPeek, RtcProviderModule } from "./types";

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
  // Offline, or an answer that is not ours: said in words, not as the browser's own "Failed to fetch".
  const response = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: code, name }),
  }).catch(() => null);
  const data = response ? await response.json().catch(() => null) : null;
  if (!response || !data) throw new Error("Couldn't reach Meetly. Check your connection and try again.");
  if (!response.ok) throw new Error(data.error ?? "Couldn't join the meeting. Try again.");
  return { ...data, provider: RTC_PROVIDER } as JoinGrant;
}

async function meeting<T>(body: object): Promise<T | null> {
  try {
    const response = await fetch("/api/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Starts a new meeting with this browser as its host, and returns its code. Null if the server
 * could not be asked; a code made up on the spot then works too, with the first person in as host.
 */
export async function createMeeting(): Promise<string | null> {
  return (await meeting<{ code: string }>({ action: "create" }))?.code ?? null;
}

/** What can be known about a meeting before joining it (see `MeetingPeek`). Null if the server could not be asked. */
export async function peekMeeting(code: string): Promise<MeetingPeek | null> {
  return meeting({ action: "peek", code });
}
