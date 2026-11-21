/**
 * harness's public face. Owner: E-harness. See ./README.md.
 *
 * Node only: `runShard` drives Playwright. The page imports ./impairment directly.
 */
export { GATE } from "./types";
export type * from "./types";
export { createImpairment, createLinkModel } from "./impairment";
export { buildReport, renderReport, reportJson, VALIDITY } from "./report";
export { GATE_MIX, PROFILES, SCENARIOS, churnSteps, gateChurn, profileOf, scenario } from "./scenarios";
export { runShard } from "./shard";
export { probeStubs } from "./stubs";
