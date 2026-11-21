/**
 * `SourceRateController`: SPEC §11.4. The encoder's target follows two things only, the source's
 * own uplink and the audience as a whole, and never one viewer [D27]: a single slow child is what
 * its `LayerGate` is for.
 */
import { Emitter } from "./emitter";
import { SOURCE_RATE_TUNING, type SourceRateTuning } from "./tuning";
import type { SourceRateController, SourceRateEvents, SourceRateOptions } from "./types";

export function createSourceRateController(options: SourceRateOptions): SourceRateController {
  const tuning: SourceRateTuning = { ...SOURCE_RATE_TUNING, ...options.tuning };
  const emitter = new Emitter<SourceRateEvents>();
  const maxKbps = options.maxKbps;
  const minKbps = Math.min(options.minKbps, maxKbps);

  /** What the uplink rule has arrived at, before the coordinator's ceiling. */
  let uplinkKbps = maxKbps;
  /** The coordinator's `hint`: a ceiling. Infinity when there is none. */
  let ceilingKbps = Infinity;
  let targetKbps = maxKbps;
  let lastStepAt: number | null = null;
  let allOkSince: number | null = null;
  /** Since the rule last ran, the uplink was seen full. */
  let fullSeen = false;

  const settle = (): void => {
    const next = Math.round(Math.max(minKbps, Math.min(uplinkKbps, ceilingKbps, maxKbps)));
    if (next === targetKbps) return;
    targetKbps = next;
    emitter.emit("target", targetKbps);
  };

  return {
    on: (event, listener) => emitter.on(event, listener),

    onChildren(estimates, now) {
      const congested = estimates.filter((estimate) => estimate.state === "congested").length;
      // Half the children or more, and never one link on its own unless it is the only one: with
      // two children, one congested link is one viewer's trouble, not the uplink's [D27].
      if (congested >= estimates.length * tuning.congestedShare && (congested >= 2 || estimates.length === 1)) fullSeen = true;
      // The rule runs once a second, but a caller may look more often than that, and what it saw
      // in between counts: congestion that the children's gates shed within the second was still
      // congestion, and a link that was strained between two looks was not ok for ten seconds.
      const allOk = estimates.length > 0 && estimates.every((estimate) => estimate.state === "ok");
      if (!allOk) allOkSince = null;
      else if (allOkSince === null) allOkSince = now;

      if (lastStepAt !== null && now - lastStepAt < tuning.everyMs) return;
      lastStepAt = now;
      if (fullSeen) uplinkKbps = Math.max(minKbps, uplinkKbps * tuning.downFactor);
      else if (allOkSince !== null && now - allOkSince >= tuning.okForMs) uplinkKbps = Math.min(maxKbps, uplinkKbps * tuning.upFactor);
      fullSeen = false;
      settle();
    },

    onHint(bitrateKbps) {
      ceilingKbps = bitrateKbps >= maxKbps ? Infinity : Math.max(minKbps, bitrateKbps);
      settle();
    },

    get targetKbps() {
      return targetKbps;
    },
  };
}
