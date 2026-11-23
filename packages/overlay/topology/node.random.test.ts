/**
 * PLAN T4: seeded random runs of 50 simulated nodes with joins, kills, graceful leaves, demotions
 * and unasked rebalancing advice (./churn.ts). In every run, at every step, no node is in its own
 * path and the parents form no cycle; and every live node is active, with fresh video, within 3 s
 * of the last event.
 *
 * PLAN asks for 1,000 runs. Each is about 15 s of simulated time and costs about 0.5 s of CPU, so
 * every push runs `OVERLAY_SIM_RUNS` of them (default 40) and the full thousand is run with
 * `OVERLAY_SIM_RUNS=1000 npm run test:overlay`. `OVERLAY_SIM_SEED` starts the seeds elsewhere, to
 * replay one run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NODES, churnRun, type ChurnOutcome } from "@meetly/overlay/topology/churn";

const RUNS = Number(process.env.OVERLAY_SIM_RUNS ?? 40);
const FIRST_SEED = Number(process.env.OVERLAY_SIM_SEED ?? 1);

describe("node: seeded random churn (PLAN T4)", () => {
  it(`${RUNS} runs of ${NODES} nodes: never in its own path, no cycles, everyone active within 3 s of the last event`, async () => {
    const failed: Omit<ChurnOutcome, "net">[] = [];
    for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed++) {
      const { net: _net, ...outcome } = await churnRun(seed);
      if (outcome.problems.length > 0) failed.push({ ...outcome, events: outcome.events.slice(NODES) });
    }
    assert.deepEqual(failed.slice(0, 3), [], `${failed.length} of ${RUNS} runs failed: seeds ${failed.map((f) => f.seed).join(", ")}`);
  });
});
