/**
 * The tree's depth under the gate's churn (SPEC §12.3, D28), in the coordinator's simulator:
 * 200 peers, then 10 minutes in which every 10 s one relay is killed without warning, one viewer
 * leaves and two join. The simulated peers do with the coordinator what topology's node does
 * (testkit.ts `Swarm`): warm repair to the backup (over the fan-out, D37), cold repair through
 * `need`, a new backup after a loss, the old parent as the backup after a move, a better backup
 * from a "rebalance", the short probe of D38 2 s after placement.
 *
 * The first 200-peer runs of the integrated engine reached depth 13 (SPEC §6.6 expects 4 or 5),
 * with a median of 10 repair or wait events per kill. In this simulator, six seeds each, seconds
 * of the 600 deeper than 5 (p95 depth), d9eb663 -> this:
 *
 *   almost all able to relay, D38's probe at 2 s:  339-402 (p95 7)    ->  1-13 (p95 5)
 *   a quarter, the relay killed replaced:          52-236  (p95 6-7)  ->  0-27 (p95 4-5)
 *
 * Moves that took a peer that relays, or could, deeper: 0-8 per 10 minutes (the rest of the
 * moves down are dead-end swaps within the bound, and relief of parents over their fan-out).
 * Each kill's events are everyone below the relay killed: each sees it, as a repair or as a wait
 * (D17). Their median is 4 here before and after; the simulator's trees were never as deep as
 * the run's, whose 10 is what a depth-13 tree gives.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Rig, Swarm, seeded } from "./testkit";

type Result = { overFive: number; maxDepth: number; p95Depth: number; eventsMedian: number; eventsP95: number; waitingMax: number; relays: number; deepening: number; swaps: number; relief: number };

async function churn(share: number, replaceKilled: boolean, seed: number): Promise<Result> {
  const random = seeded(seed * 7 + 1);
  const swarm = new Swarm(new Rig({ random: seeded(seed) }), undefined, { probeAfterMs: 2_000 });
  const capable = () => random() < share;
  await swarm.addSource();
  for (let joined = 0; joined < 199; ) {
    for (let k = 0; k < 10 && joined < 199; k++, joined++) await swarm.addViewer(capable());
    await swarm.second();
  }
  for (let s = 0; s < 60; s++) await swarm.second();
  swarm.killEvents.length = 0;
  const depths: number[] = [];
  let waitingMax = 0;
  for (let s = 0; s < 600; s++) {
    if (s % 10 === 0) {
      const relays = swarm.relays();
      if (relays.length > 0) await swarm.kill(relays[Math.floor(random() * relays.length)]);
      const viewers = [...swarm.peers.values()].filter((peer) => peer.alive && peer.role !== "source");
      await swarm.leave(viewers[Math.floor(random() * viewers.length)]);
      // With 25% able to relay, a relay killed every 10 s outruns the relays that arrive (half a
      // one per 10 s): the audience would run out of them whatever placement did. So there the
      // relay killed is replaced by one that can relay.
      await swarm.addViewer(replaceKilled ? true : capable());
      await swarm.addViewer(capable());
    }
    await swarm.second();
    const shape = swarm.shape();
    depths.push(shape.maxDepth);
    waitingMax = Math.max(waitingMax, shape.waiting);
  }
  const sorted = [...depths].sort((a, b) => a - b);
  const events = [...swarm.killEvents].sort((a, b) => a - b);
  return {
    overFive: depths.filter((depth) => depth > 5).length,
    maxDepth: sorted.at(-1)!,
    p95Depth: sorted[Math.floor(sorted.length * 0.95)],
    eventsMedian: events[Math.floor(events.length / 2)],
    eventsP95: events[Math.floor(events.length * 0.95)],
    waitingMax,
    relays: swarm.relays().length,
    deepening: swarm.deepeningMoves,
    swaps: swarm.deadEndSwaps,
    relief: swarm.reliefDown,
  };
}

describe("coordinator: the tree's depth under the gate's churn (SPEC §6.6, §12.3)", () => {
  for (const [label, share, replace, p95] of [
    ["almost everyone able to relay (the harness's headless desktops)", 0.95, false, 5],
    ["a quarter able to relay (SPEC §6.6), a relay killed replaced by one", 0.25, true, 5],
  ] as const) {
    it(`200 peers, 10 minutes of churn, ${label}: depth ${p95} or less at p95`, { timeout: 120_000 }, async () => {
      const result = await churn(share, replace, 1);
      console.log(`      ${share * 100}%: ${result.overFive} s of 600 deeper than 5, p95 ${result.p95Depth}, deepest ${result.maxDepth}; events per kill median ${result.eventsMedian}, p95 ${result.eventsP95}; moves deeper: ${result.deepening}, besides ${result.swaps} dead-end swaps and ${result.relief} reliefs; ${result.relays} relays at the end, ${result.waitingMax} without a parent at most`);
      assert.ok(result.p95Depth <= p95, `p95 depth ${result.p95Depth}`);
      assert.ok(result.overFive <= 60, `${result.overFive} s deeper than 5`);
      // The only moves that take anyone down: a dead end stepping down so that a relay comes up,
      // within the bound, and a leaf moved off a parent over its fan-out. A peer that relays, or
      // could, is moved only up (the integrator's rule; a few here are the simulator's peers
      // acting on a move while the coordinator's view of depths is a status behind).
      assert.ok(result.deepening <= 10, `${result.deepening} deepening moves`);
      assert.ok(result.eventsMedian <= 5, `median ${result.eventsMedian} events per kill`);
    });
  }
});
