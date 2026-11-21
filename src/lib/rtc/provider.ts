import { startFromAnswer } from "../meetingTime";
import { RTC_PROVIDER } from "./config";
import type { CallMode, JoinGrant, MeetingPeek, RtcProviderModule } from "./types";

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
  // The server says how long ago the meeting began, not when: this browser's clock may be off.
  const { started, ...grant } = data;
  return { ...grant, provider: RTC_PROVIDER, meetingStart: startFromAnswer(started, Date.now()) } as JoinGrant;
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

/**
 * Starts a new webinar with this browser as its host. Unlike a meeting, a made-up code will not
 * do (it would be a meeting), so this throws with a message fit to show if it could not be made.
 */
export async function createWebinar(): Promise<string> {
  const response = await fetch("/api/meeting", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", mode: "webinar" satisfies CallMode }),
  }).catch(() => null);
  const data = response ? ((await response.json().catch(() => null)) as { code?: unknown; error?: unknown } | null) : null;
  if (response?.ok && typeof data?.code === "string") return data.code;
  throw new Error(typeof data?.error === "string" ? data.error : "Couldn't reach Meetly. Check your connection and try again.");
}

/** What can be known about a meeting before joining it (see `MeetingPeek`). Null if the server could not be asked. */
export async function peekMeeting(code: string): Promise<MeetingPeek | null> {
  return meeting({ action: "peek", code });
}
