/**
 * The swarm smoke test CI runs on every push (`npm run overlay:smoke`, the `overlay` job in
 * .github/workflows/ci.yml): the proof's tree of seven real peers in headless Chromium, one relay
 * killed without warning, and a check that the overlay repaired itself: every viewer that lost
 * its parent rendered again within a second and lost no frame (PLAN H2).
 *
 * It runs whatever is built. Until the composition root (`createOverlayViewer`,
 * `createOverlaySource`) and the Node coordinator exist, the peers and the coordinator are the
 * harness's stand-ins, and the test says so, loudly, in the log and in a notice on the run's
 * summary page: a pass then proves the harness, not the overlay.
 *
 * Owner: E-harness.
 */
import { buildReport, renderReport } from "./report";
import { scenario } from "./scenarios";
import { runShard } from "./shard";

const REPAIR_WITHIN_MS = 1000;

async function main(): Promise<number> {
  const config = scenario("smoke", { port: Number(process.env.OVERLAY_SMOKE_PORT ?? 4290) });
  config.log = (line) => console.log(`  ${line}`);
  const result = await runShard(config);
  const report = buildReport([result]);
  console.log(renderReport(report));

  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    if (!ok) failures.push(what);
  };
  const kills = (result.churnLog ?? []).filter((entry) => entry.action === "kill" && !entry.targets[0]?.startsWith("nobody"));
  const repairs = result.samples.flatMap((sample) => sample.events.filter((event) => event.t === "repair"));
  const joins = result.samples.flatMap((sample) => sample.events.filter((event) => event.t === "join"));

  check(result.peersFailed.length === 0, `peers failed: ${result.peersFailed.map((f) => `${f.index} (${f.why})`).join("; ")}`);
  check(joins.length === config.peers - 1, `${joins.length} of ${config.peers - 1} viewers rendered a first frame`);
  check(kills.length === 1, `one relay was to be killed; ${kills.length} were`);
  // The proof's tree: each relay has two children, so a killed relay orphans two viewers.
  check(repairs.length >= 2, `${repairs.length} repairs were reported; a killed relay orphans two viewers`);
  for (const repair of repairs) {
    check(repair.freezeMs <= REPAIR_WITHIN_MS, `a viewer froze for ${Math.round(repair.freezeMs)} ms across the repair (limit ${REPAIR_WITHIN_MS})`);
    check(repair.framesLost === 0, `a viewer lost ${repair.framesLost} frames across the repair`);
    check(repair.firstPacket !== null, "a viewer never heard from its new parent");
  }
  check(report.frames.rendered > 0, "no frame was rendered");
  check(report.gate.validity.every((v) => v.pass || v.name.startsWith("repair events")), `the run was not a clean measurement: ${report.gate.validity.filter((v) => !v.pass).map((v) => v.name).join("; ")}`);

  const standin = report.stubbed.length > 0;
  if (standin) {
    // GitHub Actions shows `::notice::` and `::warning::` lines on the run's summary page.
    console.log(`::warning title=Overlay swarm smoke test ran against stand-ins::${report.stubbed.length} parts of the overlay are not built. The peers and the coordinator were the harness's stand-ins: this run tested the harness, not the overlay.`);
  }
  if (failures.length) {
    for (const failure of failures) console.log(`::error title=Overlay swarm smoke test::${failure}`);
    return 1;
  }
  const worst = Math.max(...repairs.map((repair) => repair.freezeMs));
  console.log(`::notice title=Overlay swarm smoke test::${standin ? "STAND-IN engine. " : ""}7 peers, 1 relay killed, ${repairs.length} repairs, worst freeze ${Math.round(worst)} ms, 0 frames lost.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
