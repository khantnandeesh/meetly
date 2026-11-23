/**
 * `UplinkProbe`: SPEC §11.6. Loads one link with PROBE packets for a moment and reads from the
 * peer's feedback how much of it arrived.
 *
 * It sends at `targetKbps` at most, and it obeys the module's one rule itself: it does not queue
 * what the link cannot take. Each call adds no more to the channel than the link took since the
 * call before, and a little. So on a link slower than the target it ends up sending at the link's
 * own pace, the queue it builds stays a few packets deep, and what the receiver counts over the
 * probe is the link's capacity. It can never report more than `targetKbps`: a caller that wants
 * to know whether a peer can feed four children must probe at what four children cost.
 *
 * Call `next` on every tick of a fast timer (10 ms, the failure detector's) with the link's
 * estimate for the sending direction (`probeView`), until `spareKbps` is a number.
 */
import type { LinkEstimate } from "../types";
import { PROBE_TUNING, type ProbeTuning } from "./tuning";
import type { LinkEstimator, UplinkProbe } from "./types";

export type UplinkProbeOptions = { targetKbps: number; durationMs: number; tuning?: Partial<ProbeTuning> };

export function createUplinkProbe(options: UplinkProbeOptions): UplinkProbe {
  const tuning: ProbeTuning = { ...PROBE_TUNING, ...options.tuning };
  const headroom = tuning.headroomPackets * tuning.packetBytes;
  let startedAt: number | null = null;
  let lastAt = 0;
  /** Bytes the target rate has earned and that have not been sent. */
  let credit = 0;
  /**
   * How much the channel may hold once this call has added to it. While the channel is found
   * empty the link is keeping up and this doubles; once it is not, it is what the link took since
   * the last call, and a little: enough that the link never idles, never more than it will send
   * before the next call.
   */
  let window = headroom;
  /** What the channel held after the last call. */
  let left = 0;
  let stoppedAt: number | null = null;
  let best = 0;
  let result: number | null = null;

  return {
    next(estimate, now) {
      if (result !== null) return [];
      if (startedAt === null) {
        startedAt = now;
        lastAt = now - 1;
      }
      // The answer is the most the receiver took in any one second of the probe while the link
      // was ok: "the highest rate before it left ok" (§11.6). Only congestion stops the probe
      // early; strained, it goes on, and what it sees then does not count.
      if (estimate.state === "ok") best = Math.max(best, estimate.deliveredKbps);

      if (stoppedAt === null && (now - startedAt >= options.durationMs || estimate.state === "congested")) stoppedAt = now;
      if (stoppedAt !== null) {
        if (now - stoppedAt >= tuning.settleMs) result = Math.round(Math.min(best, options.targetKbps));
        return [];
      }

      const held = estimate.bufferedBytes;
      if (held <= 0) window = Math.min(window * 2, tuning.maxWindowBytes);
      else window = Math.max(0, left - held) + headroom;

      credit += (options.targetKbps * Math.min(now - lastAt, tuning.maxCatchUpMs)) / 8;
      lastAt = now;
      const count = Math.max(0, Math.floor(Math.min(credit, window - held) / tuning.packetBytes));
      // What could not be sent now is not owed later: a probe never bursts to catch up.
      credit = Math.min(credit - count * tuning.packetBytes, tuning.packetBytes);
      left = held + count * tuning.packetBytes;
      return new Array<number>(count).fill(tuning.packetBytes);
    },

    get spareKbps() {
      return result;
    },
  };
}

/** The estimate a probe should be shown: the sending direction, when the estimator can say. */
export const probeView = (estimator: Pick<LinkEstimator, "estimate" | "directed">, now: number): LinkEstimate =>
  estimator.directed ? estimator.directed("sent", now) : estimator.estimate(now);
