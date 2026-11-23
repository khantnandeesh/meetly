/**
 * How shard 0 lays a sharded run out: the coordinator alone, the source alone, the viewers over
 * the rest, and the runners behind a symmetric NAT, or late, left out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideLayout } from "@meetly/overlay/harness/layout";
import { churnSteps, scenario, shardOf } from "@meetly/overlay/harness/scenarios";

describe("harness layout", () => {
  it("gives the source a runner of its own and leaves out the symmetric and the late", () => {
    const layout = decideLayout(6, [
      { shard: 1, symmetric: true },
      { shard: 2, symmetric: false },
      { shard: 3, symmetric: false },
      { shard: 5, symmetric: null },
    ]);
    assert.deepEqual([layout.coordinatorShard, layout.sourceShard, layout.viewerShards], [0, 2, [3, 5]]);
    assert.deepEqual(layout.excluded.map((e) => [e.shard, e.why.split(" ")[0]]), [[1, "symmetric"], [4, "late:"]]);
    // One open runner: the source shares it with the viewers.
    assert.deepEqual(decideLayout(3, [{ shard: 1, symmetric: false }, { shard: 2, symmetric: true }]).viewerShards, [1]);
  });

  it("spreads every viewer and every churn step over the viewer shards only", () => {
    const config = { ...scenario("gate", { shard: { index: 0, count: 6 } }), layout: decideLayout(6, [2, 3, 4, 5].map((shard) => ({ shard, symmetric: shard === 4 }))) };
    assert.equal(shardOf(0, config), 2);
    const counts = new Map<number, number>();
    for (let i = 1; i < config.peers; i++) counts.set(shardOf(i, config), (counts.get(shardOf(i, config)) ?? 0) + 1);
    assert.deepEqual([...counts.keys()].sort((a, b) => a - b), [3, 5]);
    assert.deepEqual([...counts.values()].sort((a, b) => a - b), [99, 100]);
    for (const step of churnSteps(config)) assert.ok(step.shard === -1 || [3, 5].includes(step.shard), `${step.event.action} on ${step.shard}`);
  });
});
