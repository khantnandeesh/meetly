/**
 * Who may relay, how good a relay is, and what a parent costs. SPEC §8. All pure: the
 * coordinator's placement imports `judgeRelay` and `parentCost` so that it and every peer rank
 * the same way.
 *
 * Owner: E-transport+topology.
 */
import type { Capabilities, OverlayParams, PeerId } from "../protocol";
import type { Candidate, JudgeRelay, ParentCost, ParentSelector, RelayVerdict } from "./types";

/** Room kept for retransmissions and replays on top of a stream's bitrate (SPEC §8.1). */
export const BITRATE_HEADROOM = 1.15;
/** The share of a peer's spare uplink that relaying may use; the rest is the peer's own (SPEC §8.1). */
export const UPLINK_SHARE = 0.7;
/** A relay must be able to feed this many children (SPEC §8.1, "uplink"). */
export const MIN_RELAY_CHILDREN = 2;
/** SPEC D18, when `OverlayParams.probationMs` does not say otherwise. */
export const PROBATION_MS = 20_000;
/** A relay's own loss from its parent must be under this, in percent (SPEC §8.1, "loss"). */
export const RELAY_MAX_LOSS_PCT = 2;
/** The uptime at which the score's uptime term is full (SPEC §8.2). */
export const SCORE_FULL_UPTIME_MS = 10 * 60_000;

/** What `parentCost` charges for a round trip that has not been measured yet (SPEC §8.3). */
export const UNMEASURED_RTT_MS = 150;
export const COST_PER_HOP_MS = 30;
export const COST_PER_LOSS_PCT_MS = 20;
export const COST_TURN_MS = 100;

/** A switch must be better by this share and by this much, three comparisons running (SPEC §7.6). */
export const SWITCH_MIN_GAIN = 0.2;
export const SWITCH_MIN_GAIN_MS = 20;
export const SWITCH_COMPARISONS = 3;

/**
 * The spare uplink the verdict is made on: what was measured by a probe if anything was, else
 * what the peer says of itself, else nothing. (The coordinator cannot probe a peer; the peer's
 * own probe result reaches it as `Capabilities.uplinkKbps`.)
 */
const spareUplink = (caps: Capabilities, observed: { spareUplinkKbps: number | null }): number | null => observed.spareUplinkKbps ?? caps.uplinkKbps;

const unit = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : x > 0 ? 1 : 0);

/** SPEC §8.2, 0..1. Exported for the tests that check the formula to the digit. */
export function relayScore(caps: Capabilities, observed: Parameters<JudgeRelay>[1], streamKbps: number, params: OverlayParams): number {
  const spare = spareUplink(caps, observed) ?? 0;
  const wanted = params.maxFanout * BITRATE_HEADROOM * streamKbps;
  return (
    0.35 * unit(wanted > 0 ? spare / wanted : 1) +
    0.25 * unit(observed.uptimeMs / SCORE_FULL_UPTIME_MS) +
    0.2 * (1 - unit(observed.lossPct / 2)) +
    0.1 * (caps.onPower === true ? 1 : 0) +
    0.1 * (1 - unit(observed.churnPerMin / 2))
  );
}

/** SPEC §8.1: how many active children a relay with this much spare uplink takes. */
export function relayFanout(spareUplinkKbps: number, streamKbps: number, maxFanout: number): number {
  if (!(streamKbps > 0)) return maxFanout;
  return Math.max(0, Math.min(maxFanout, Math.floor((UPLINK_SHARE * spareUplinkKbps) / (BITRATE_HEADROOM * streamKbps))));
}

export const judgeRelay: JudgeRelay = (caps, observed, streamKbps, params) => {
  const reasons: RelayVerdict["reasons"] = [];
  const spare = spareUplink(caps, observed);
  if (caps.browser !== "chromium") reasons.push("browser");
  if (!caps.desktop) reasons.push("mobile");
  // "Unknown" (null) is allowed; it scores lower.
  if (caps.onPower === false) reasons.push("battery");
  // Only a peer others can reach. "unknown" is not known to be reachable, so it is a leaf.
  if (caps.nat !== "open" && caps.nat !== "cone") reasons.push("nat");
  if (caps.dataSaver) reasons.push("data-saver");
  if (!caps.visible) reasons.push("hidden");
  if (spare === null || spare < MIN_RELAY_CHILDREN * BITRATE_HEADROOM * streamKbps) reasons.push("uplink");
  if (observed.uptimeMs < (params.probationMs ?? PROBATION_MS)) reasons.push("probation");
  if (!(observed.lossPct < RELAY_MAX_LOSS_PCT)) reasons.push("lossy");
  const eligible = reasons.length === 0;
  return {
    eligible,
    reasons,
    fanout: eligible && spare !== null ? relayFanout(spare, streamKbps, params.maxFanout) : 0,
    score: relayScore(caps, observed, streamKbps, params),
  };
};

/** SPEC §8.1 [D38]: the fan-out of a provisional relay. */
export const PROVISIONAL_FANOUT = 2;

/**
 * SPEC §8.1 [D38]: whether a peer may be a provisional relay, before its probation is over: every
 * check of `judgeRelay` but probation, with its uplink measured by the short probe, and then a
 * fan-out of `PROVISIONAL_FANOUT` at most. The coordinator places joiners under such a relay only
 * when no full relay has a free slot.
 */
export const judgeProvisional: JudgeRelay = (caps, observed, streamKbps, params) => {
  const full = judgeRelay(caps, observed, streamKbps, params);
  const reasons = full.reasons.filter((reason) => reason !== "probation");
  const spare = observed.spareUplinkKbps ?? caps.uplinkKbps;
  const fanout = reasons.length === 0 && spare !== null ? Math.min(PROVISIONAL_FANOUT, relayFanout(spare, streamKbps, params.maxFanout)) : 0;
  return { eligible: reasons.length === 0 && fanout >= PROVISIONAL_FANOUT, reasons, fanout: reasons.length === 0 && fanout >= PROVISIONAL_FANOUT ? fanout : 0, score: full.score };
};

export const parentCost: ParentCost = (candidate) => {
  if (candidate.free <= 0) return Infinity;
  return (candidate.rttMs ?? UNMEASURED_RTT_MS) + COST_PER_HOP_MS * candidate.depth + COST_PER_LOSS_PCT_MS * candidate.lossPct + (candidate.turn ? COST_TURN_MS : 0);
};

/** The cost of the parent a peer already has: its own slot there is taken, so "no free slot" does not apply. */
export const currentParentCost = (current: Candidate): number => parentCost(current.free > 0 ? current : { ...current, free: 1 });

/**
 * Ranks candidates, and decides on a voluntary switch with the hysteresis of SPEC §7.6. The
 * selector remembers how many comparisons running the same candidate has been better enough:
 * call `shouldSwitch` once per comparison (every 10 s), not more often.
 */
export function createParentSelector(options: { rebalanceMinMs: number }): ParentSelector {
  let streakPeer: PeerId | null = null;
  let streak = 0;
  return {
    rank(self, candidates) {
      return candidates
        .filter((c) => c.peer !== self && !(c.path?.includes(self) ?? false) && parentCost(c) < Infinity)
        .map((c, index) => ({ c, index, cost: parentCost(c) }))
        .sort((a, b) => a.cost - b.cost || a.index - b.index)
        .map((entry) => entry.c);
    },
    shouldSwitch(current, best, sinceLastSwitchMs) {
      const now = currentParentCost(current);
      const then = parentCost(best);
      const better = best.peer !== current.peer && then <= now * (1 - SWITCH_MIN_GAIN) && now - then >= SWITCH_MIN_GAIN_MS;
      if (!better) {
        streakPeer = null;
        streak = 0;
        return false;
      }
      streak = streakPeer === best.peer ? streak + 1 : 1;
      streakPeer = best.peer;
      if (streak < SWITCH_COMPARISONS || sinceLastSwitchMs < options.rebalanceMinMs) return false;
      streakPeer = null;
      streak = 0;
      return true;
    },
  };
}
