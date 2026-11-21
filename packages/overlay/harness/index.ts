/**
 * harness's public face. Owner: E-harness. See ./README.md.
 */
import { notImplemented } from "../runtime";
import type { ImpairmentFactory, ImpairmentProfile, ShardResult, SwarmConfig, SwarmReport } from "./types";

export { GATE } from "./types";
export type * from "./types";

/** Networks to test against. "clean" is the proof's condition; the gate is run on "mixed". */
export const PROFILES: Record<string, ImpairmentProfile> = {
  clean: { name: "clean", delayMs: 0, jitterMs: 0, lossPct: 0 },
  good: { name: "good", delayMs: 15, jitterMs: 5, lossPct: 0.1 },
  home: { name: "home", delayMs: 30, jitterMs: 15, lossPct: 1 },
  bad: { name: "bad", delayMs: 60, jitterMs: 40, lossPct: 3, burst: { enterPct: 1, leavePct: 30, lossPctInBurst: 50 } },
  slow: { name: "slow", delayMs: 40, jitterMs: 20, lossPct: 1, kbps: 900, queueMs: 300 },
};

/** The gate's audience: mostly ordinary connections, some bad, a few too slow for every layer. */
export const GATE_MIX: SwarmConfig["mix"] = [
  { profile: "good", share: 0.5 },
  { profile: "home", share: 0.3 },
  { profile: "bad", share: 0.15 },
  { profile: "slow", share: 0.05 },
];

export const createImpairment: ImpairmentFactory = () => notImplemented("E-harness", "harness.createImpairment");

/** Runs this process's share of a swarm to the end and returns what its peers measured. */
export const runShard: (config: SwarmConfig) => Promise<ShardResult> = () => notImplemented("E-harness", "harness.runShard");

/** Puts the shards of one run together and judges it against the gate. */
export const buildReport: (results: ShardResult[]) => SwarmReport = () => notImplemented("E-harness", "harness.buildReport");
