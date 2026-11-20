"use client";

import { useEffect } from "react";
import type { RtcCall, RtcTile } from "./rtc/types";

/**
 * Only cameras that are on screen should cost bandwidth.
 *
 * The stage reports whose pictures it is showing; how that turns into less video on the
 * wire is the provider's business:
 *
 * - LiveKit stays subscribed to everything and pauses what no element is showing (adaptive
 *   stream, plus a nudge for cameras that were never shown). See `pauseUnattached` in
 *   src/lib/rtc/livekit.ts for why it does not unsubscribe.
 * - RealtimeKit only streams video for its "active" set, and unsubscribes the rest. Its size is
 *   set from what is on screen. See `setVideoDemand` in src/lib/rtc/realtimekit.ts.
 *
 * A tile the interface is deliberately not showing a picture for ("use less data") is not
 * counted: it has a place on the stage, but nothing needs to be streamed for it.
 *
 * Audio is never touched: everyone is always heard.
 */
export function useVideoDemand(call: RtcCall, onScreen: RtcTile[]): void {
  // People, not tiles: someone whose camera and screen are both showing is one stream source.
  const visible = Array.from(
    new Set(onScreen.filter((tile) => !tile.participant.isLocal && !tile.withheld).map((tile) => tile.participant.identity)),
  ).join("\n");
  useEffect(() => {
    call.setVideoDemand(visible ? visible.split("\n") : []);
  }, [call, visible]);
}
