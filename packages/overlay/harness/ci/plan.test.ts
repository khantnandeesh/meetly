/**
 * What overlay-swarm.yml runs for a push, a manual run and the nightly one (./plan.mjs).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

function plan(env: Record<string, string>): Record<string, string> {
  const text = execFileSync(process.execPath, [join(import.meta.dirname, "plan.mjs")], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  return Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

describe("overlay-swarm plan", () => {
  it("runs nothing big for a push that does not ask", () => {
    const out = plan({ EVENT: "push", COMMIT_MESSAGE: "Fix a typo" });
    assert.deepEqual([out.any, out.has_shards, out.has_sizes], ["false", "false", "false"]);
  });

  it("runs what a push's message asks for, counting every [swarm: ...] in it", () => {
    const out = plan({ EVENT: "push", COMMIT_MESSAGE: "Title\n\nUse [swarm: ...] to ask.\n\n[swarm: sharded merge]\n[swarm: sizes]" });
    const shards = JSON.parse(out.shards).include as { run: string; shard: number; shards: number; peers: number }[];
    assert.deepEqual(
      shards.map((s) => [s.run, s.shard, s.shards, s.peers]),
      [0, 1, 2, 3].map((i) => ["sharded", i, 4, 100]),
    );
    assert.deepEqual(JSON.parse(out.sizes), [30, 40, 50, 60]);
    assert.equal(out.merge, "true");
  });

  it("runs the gate, 8 shards of 25 on the merged engine, nightly", () => {
    const out = plan({ EVENT: "schedule" });
    const shards = JSON.parse(out.shards).include as { run: string; peers: number }[];
    assert.deepEqual([shards.length, shards[0].run, shards[0].peers, out.merge], [8, "gate", 200, "true"]);
  });

  it("runs a manual run's input", () => {
    const out = plan({ EVENT: "workflow_dispatch", RUNS_INPUT: "experiment" });
    const shards = JSON.parse(out.shards).include as { run: string; scenario: string }[];
    assert.deepEqual([shards.length, shards[0].scenario, out.merge], [2, "two-runner", "false"]);
  });
});
