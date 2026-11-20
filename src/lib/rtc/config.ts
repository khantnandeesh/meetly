import type { RtcProviderName } from "./types";

/**
 * Which media provider this build talks to. `NEXT_PUBLIC_` values are fixed when the app is
 * built, so the browser bundle and the server routes always agree.
 */
export const RTC_PROVIDER: RtcProviderName =
  process.env.NEXT_PUBLIC_RTC_PROVIDER === "realtimekit" ? "realtimekit" : "livekit";
