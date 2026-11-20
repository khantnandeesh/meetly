import type { RtcTile } from "./rtc/types";

/**
 * What the mini window shows: whoever the stage would (the person talking, a pin, somebody's
 * shared screen), with one exception. Your own shared screen is never shown to you there: you
 * opened the mini window to see the call while you look at that very screen. `fallbacks` are
 * tried in order when the stage's choice is ruled out.
 */
export function miniTile(main: RtcTile | undefined, fallbacks: (RtcTile | undefined)[]): RtcTile | undefined {
  const ownScreen = (tile: RtcTile) => tile.participant.isLocal && tile.source === "screen_share";
  return [main, ...fallbacks].find((tile): tile is RtcTile => !!tile && !ownScreen(tile));
}
