/**
 * The swarm smoke test CI runs on every push (`npm run overlay:smoke`, the `overlay` job in
 * .github/workflows/ci.yml): a handful of peers, one killed relay, and a check that the overlay
 * repaired itself. Small enough for a shared runner; the gate itself is a separate, sharded run
 * (docs/overlay/PLAN.md, E-harness M5).
 *
 * Until the harness exists this is a placeholder that says so and passes. E-harness replaces the
 * body at M2, and from then on a failure here fails CI.
 *
 * Owner: E-harness.
 */
import { NotImplementedError } from "../runtime";
import { runShard } from "./index";

async function main(): Promise<number> {
  try {
    await runShard({
      runId: "smoke",
      seed: 1,
      coordinatorUrl: "http://127.0.0.1:4100",
      room: "smoke",
      admissionSecret: "smoke",
      peers: 7,
      shard: { index: 0, count: 1 },
      durationS: 20,
      joinPerS: 2,
      profiles: [],
      mix: [],
      churn: [{ atS: 10, action: "kill", pick: "relay", count: 1 }],
      decodeEvery: 1,
      pagesPerBrowser: 7,
      ice: "host",
    });
  } catch (error) {
    if (error instanceof NotImplementedError) {
      // GitHub Actions shows `::notice::` lines on the run's summary page.
      console.log(`::notice title=Overlay swarm smoke test::Skipped: ${error.message}`);
      return 0;
    }
    throw error;
  }
  throw new Error("The harness now runs: replace this placeholder with the real smoke test and its assertions.");
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
