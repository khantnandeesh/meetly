/**
 * `LayerGate`: the nine rules of SPEC §11.3 and the replay budget of §11.5, for one child and one
 * stream. It is asked once per frame, before the frame's first packet is handed to the channel,
 * and answers for the whole frame. It owns no timer: time is the `now` it is called with.
 */
import { MediaFlag, type MediaHeader } from "../protocol";
import type { LayerCap, LinkEstimate } from "../types";
import { Emitter } from "./emitter";
import { GATE_TUNING, bytesOf, type GateTuning } from "./tuning";
import type { LayerGate, LayerGateEvents, LayerGateOptions } from "./types";

/** Stage 1's audio stream (SPEC §2): what a gate that was not told its `kind` takes for audio. */
const STAGE1_AUDIO_STREAM = 1;

/** How many frames back the gate remembers what it did. `refDelta` is one byte, so this covers every reference. */
const MEMORY = 256;

/** Why a frame was not sent, or "sent". For tests and for the counters a relay reports. */
export type GateVerdict = "sent" | "above-cap" | "stale" | "starved" | "undecodable";

export type InspectableLayerGate = LayerGate & {
  /** Why the last frame asked about was or was not sent. */
  readonly lastVerdict: GateVerdict;
  /** Rule 7 holds: nothing is sent until a keyframe finds the link able to take it. */
  readonly starved: boolean;
  /** How long the link must stay *ok* before the cap next rises (rule 5). */
  readonly riseAfterMs: number;
  wasSent: NonNullable<LayerGate["wasSent"]>;
};

export function createLayerGate(options: LayerGateOptions): InspectableLayerGate {
  const tuning: GateTuning = { ...GATE_TUNING, ...options.tuning };
  const emitter = new Emitter<LayerGateEvents>();
  const top = Math.max(0, options.temporalLayers - 1);
  const topSpatial = Math.max(0, (options.spatialLayers ?? 1) - 1);
  const staleBytes = bytesOf(options.bitrateKbps, tuning.staleBufferMs);
  const replayBytes = bytesOf(options.bitrateKbps, tuning.replayBufferMs);

  /** What the link can carry, as rules 3–5 have worked it out. */
  let fits = top;
  /** Rule 9: what the child asked for. */
  let wanted: LayerCap = { maxSpatial: topSpatial, maxTemporal: top };
  /** Rule 8. */
  let overloaded = false;
  let cap: LayerCap = { maxSpatial: topSpatial, maxTemporal: top };

  let okSince: number | null = null;
  let lastDropAt = -Infinity;
  /** A rise still on probation (rule 5), or null. */
  let lastRiseAt: number | null = null;
  let riseAfterMs = tuning.riseAfterMs;
  /** Since when the link has been congested with the cap at the base layer (rule 7). */
  let baseCongestedSince: number | null = null;
  let starved = false;
  let lastReplayAt = -Infinity;
  let lastVerdict: GateVerdict = "sent";

  // What became of the last frames, by frame id. A frame whose reference was not sent cannot be
  // decoded, so it is not sent either: a frame held back by rule 6 or 7 takes its dependants with it.
  const sent = new Float64Array(MEMORY).fill(-1);
  const refused = new Float64Array(MEMORY).fill(-1);

  /** The ceiling that is not the link's doing: the child's wish and this relay's overload. */
  const ceiling = (): number => Math.min(wanted.maxTemporal, overloaded ? Math.max(0, top - 1) : top);

  const settle = (reason: "congestion" | "overload" | "restore" | null): void => {
    const next: LayerCap = { maxSpatial: Math.min(wanted.maxSpatial, topSpatial), maxTemporal: Math.max(0, Math.min(fits, ceiling())) };
    if (next.maxSpatial === cap.maxSpatial && next.maxTemporal === cap.maxTemporal) return;
    cap = next;
    if (reason !== null) emitter.emit("change", { ...cap }, reason);
  };

  /** Rules 3, 4, 5 and 7: move the cap with the state of the link. */
  const step = (estimate: LinkEstimate, now: number): void => {
    let state = estimate.state;
    // A replay fills the channel on purpose (§11.5). Until it has had time to drain, a backlog
    // with no loss and no queue on the path says nothing about the link: hold, do not shed.
    if (state === "congested" && now - lastReplayAt < tuning.replayGraceMs && estimate.lossPct < 10 && estimate.queueDelayMs < 100) state = "strained";

    if (state !== "ok") okSince = null;
    else if (okSince === null) okSince = now;

    // A rise that has held for its probation: the wait is back to where it started.
    if (lastRiseAt !== null && now - lastRiseAt >= tuning.riseProbationMs) {
      lastRiseAt = null;
      riseAfterMs = tuning.riseAfterMs;
    }

    if (state === "congested") {
      if (fits > 0) {
        baseCongestedSince = null;
        if (now - lastDropAt >= tuning.dropEveryMs) {
          if (lastRiseAt !== null) {
            // Rule 5: the rise did not hold. Back down, and wait twice as long before the next.
            riseAfterMs = Math.min(riseAfterMs * 2, tuning.riseAfterMaxMs);
            lastRiseAt = null;
          }
          fits--;
          lastDropAt = now;
          if (fits === 0) baseCongestedSince = now;
          settle("congestion");
        }
      } else {
        if (baseCongestedSince === null) baseCongestedSince = now;
        if (!starved && now - baseCongestedSince >= tuning.starvedAfterMs) {
          starved = true;
          emitter.emit("starved");
        }
      }
      return;
    }
    baseCongestedSince = null;

    // Rule 4 is the absence of a branch: strained moves nothing.
    // Rule 5. The link's cap rises only while it is the one that binds: a layer the child does not
    // want, or that overload forbids, would be a rise nothing tested.
    if (state === "ok" && okSince !== null && now - okSince >= riseAfterMs && fits < ceiling()) {
      fits++;
      lastRiseAt = now;
      okSince = now;
      settle("restore");
    }
  };

  const isAudio = (header: MediaHeader): boolean => (options.kind !== undefined ? options.kind === "audio" : header.streamId === STAGE1_AUDIO_STREAM);

  const verdict = (header: MediaHeader, estimate: LinkEstimate, now: number): GateVerdict => {
    const key = (header.flags & MediaFlag.Key) !== 0;
    if (starved) {
      // Rule 7: resume only at a keyframe that the link can take.
      if (!key || estimate.state === "congested" || estimate.bufferedBytes > staleBytes) return "starved";
      starved = false;
      baseCongestedSince = null;
    }
    if (header.temporal > cap.maxTemporal || header.spatial > cap.maxSpatial) return "above-cap"; // rule 2
    // Rule 6. While a replay is draining the limit is the replay's own (§11.5), or the first live
    // frame after a catch-up would be refused for the backlog the catch-up was allowed to make.
    const limit = now - lastReplayAt < tuning.replayGraceMs ? Math.max(staleBytes, replayBytes) : staleBytes;
    if (estimate.bufferedBytes > limit) return "stale";
    if (!key && header.refDelta > 0) {
      const reference = header.frameId - header.refDelta;
      if (refused[reference & (MEMORY - 1)] === reference) return "undecodable";
    }
    return "sent";
  };

  return {
    on: (event, listener) => emitter.on(event, listener),

    admit(header, _frameBytes, estimate, now) {
      if (isAudio(header)) return true; // rule 1: audio is never refused
      step(estimate, now);
      lastVerdict = verdict(header, estimate, now);
      const slot = header.frameId & (MEMORY - 1);
      if (lastVerdict === "sent") {
        sent[slot] = header.frameId;
        if (refused[slot] === header.frameId) refused[slot] = -1;
      } else {
        refused[slot] = header.frameId;
        if (sent[slot] === header.frameId) sent[slot] = -1;
      }
      return lastVerdict === "sent";
    },

    setWanted(next) {
      const before = cap.maxTemporal;
      wanted = { maxSpatial: Math.max(0, next.maxSpatial), maxTemporal: Math.max(0, next.maxTemporal) };
      // The child knows what it asked for. Only a rise it did not ask for by name is news.
      settle(Math.min(fits, ceiling()) > before ? "restore" : null);
    },

    setOverload(on) {
      if (overloaded === on) return;
      overloaded = on;
      settle(on ? "overload" : "restore");
    },

    get cap() {
      return { ...cap };
    },

    replayBudget(estimate, now) {
      const room = Math.max(0, Math.floor(replayBytes - estimate.bufferedBytes));
      if (room > 0) lastReplayAt = now;
      return room;
    },

    wasSent(frameId) {
      return sent[frameId & (MEMORY - 1)] === frameId;
    },

    get lastVerdict() {
      return lastVerdict;
    },
    get starved() {
      return starved;
    },
    get riseAfterMs() {
      return riseAfterMs;
    },
  };
}
