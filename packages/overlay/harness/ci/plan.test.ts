/**
 * What overlay-swarm.yml runs for a push, a manual run and the nightly one (./plan.mjs).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

function plan(env: Record<string, string>): Record<string, string> {
  const text = execFileSync(process.execPath, [join(import.meta.dirname, "plan.mjs")], { env: { ...process.env, EVENT: "", COMMIT_MESSAGE: "", RUNS_INPUT: "", GITHUB_OUTPUT: "", ...env }, encoding: "utf8" });
  return Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

describe("overlay-swarm plan", () => {
  it("runs nothing big for a push that does not ask", () => {
    const out = plan({ EVENT: "push", COMMIT_MESSAGE: "Fix a typo" });
    assert.deepEqual([out.any, out.has_shards, out.has_single], ["false", "false", "false"]);
  });

  it("runs what a push's message asks for, counting every [swarm: ...] in it", () => {
    const out = plan({ EVENT: "push", COMMIT_MESSAGE: "Title\n\nUse [swarm: ...] to ask.\n\n[swarm: sharded merge]\n[swarm: sizes]" });
    const shards = JSON.parse(out.shards).include as { run: string; shard: number; shards: number; peers: number }[];
    assert.deepEqual(
      shards.map((s) => [s.run, s.shard, s.shards, s.peers]),
      [0, 1, 2, 3].map((i) => ["sharded", i, 4, 100]),
    );
    assert.deepEqual(
      (JSON.parse(out.single).include as { dir: string; peers: number }[]).map((s) => [s.dir, s.peers]),
      [["sizes-30", 30], ["sizes-40", 40], ["sizes-50", 50], ["sizes-60", 60]],
    );
    assert.equal(out.merge, "true");
  });

  it("runs the gate, 19 shards of about 10 on the merged engine, nightly", () => {
    const out = plan({ EVENT: "schedule" });
    const shards = JSON.parse(out.shards).include as { run: string; peers: number }[];
    assert.deepEqual([shards.length, shards[0].run, shards[0].peers, out.merge], [19, "gate", 200, "true"]);
  });

  it("runs the small named scenarios, each alone", () => {
    const out = plan({ EVENT: "push", COMMIT_MESSAGE: "[swarm: scenarios]" });
    assert.deepEqual(
      (JSON.parse(out.single).include as { scenario: string }[]).map((s) => s.scenario),
      ["proof-tree", "chain-kill", "slow-child"],
    );
  });

  it("merges the integrator's branch instead of the separate ones when asked", () => {
    const out = plan({ EVENT: "push", COMMIT_MESSAGE: "[swarm: gate integration]" });
    assert.deepEqual([out.merge, out.merge_mode], ["true", "integration"]);
    assert.equal(plan({ EVENT: "push", COMMIT_MESSAGE: "[swarm: gate merge]" }).merge_mode, "branches");
  });

  it("runs a manual run's input", () => {
    const out = plan({ EVENT: "workflow_dispatch", RUNS_INPUT: "experiment" });
    const shards = JSON.parse(out.shards).include as { run: string; scenario: string }[];
    assert.deepEqual([shards.length, shards[0].scenario, out.merge], [2, "two-runner", "false"]);
  });
});
