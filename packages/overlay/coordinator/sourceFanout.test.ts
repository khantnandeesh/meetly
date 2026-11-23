/**
 * [D77] The source's fan-out up to eight, not six, when its probe shows the uplink: depth under the
 * gate's churn in the coordinator's simulator, with the relays the gate's runs had. 200 peers at 4
 * a second, a minute to settle, then ten minutes in which every 10 s a relay is killed, a viewer
 * leaves and two join. Relays' probed fan-outs drawn as the gate's 176 relays' most children were
 * (61% six, 24% five, 15% two to four); 5% "slow" (their probe finds 900 kbps); 15% on bad networks
 * (their children report loss); standby backups and the nodes' own rebalancing as D67's test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PARAMS, type OverlayParams } from "@meetly/overlay/protocol";
import { Rig, Swarm, seeded } from "./testkit";

const B = 1232;
const kbpsFor = (fanout: number) => Math.ceil((fanout * 1.15 * B) / 0.7) + 50;

async function churn(seed: number, params: OverlayParams): Promise<{ deep: number; cold: number }> {
  const random = seeded(seed * 7 + 1);
  const swarm = new Swarm(new Rig({ random: seeded(seed), params }), undefined, {
    probeAfterMs: 2_000,
    standbyBackups: true,
    nodeRebalance: { perHopMs: 30, random: seeded(seed + 13) },
    badNetworks: { share: 0.15, odds: 0.3, random: seeded(seed + 17) },
  });
  const add = async () => {
    if (random() < 0.05) return swarm.addViewer(true, 900);
    const v = random();
    return swarm.addViewer(true, kbpsFor(v < 0.03 ? 2 : v < 0.06 ? 3 : v < 0.15 ? 4 : v < 0.39 ? 5 : 6));
  };
  await swarm.addSource();
  for (let joined = 0; joined < 199; ) {
    for (let k = 0; k < 4 && joined < 199; k++, joined++) await add();
    await swarm.second();
  }
  for (let s = 0; s < 60; s++) await swarm.second();
  const cold = swarm.coldRepairs;
  let seconds = 0;
  let deep = 0;
  for (let s = 0; s < 600; s++) {
    if (s % 10 === 0) {
      const relays = swarm.relays();
      if (relays.length > 0) await swarm.kill(relays[Math.floor(random() * relays.length)]);
      const viewers = [...swarm.peers.values()].filter((peer) => peer.alive && peer.role !== "source");
      await swarm.leave(viewers[Math.floor(random() * viewers.length)]);
      await add();
      await add();
    }
    await swarm.second();
    for (const peer of swarm.peers.values()) {
      if (!peer.alive || peer.role === "source" || peer.parent === null) continue;
      seconds++;
      if (peer.depth >= 4) deep++;
    }
  }
  return { deep: deep / seconds, cold: swarm.coldRepairs - cold };
}

describe("coordinator: the source's fan-out under the gate's churn (D77)", () => {
  it("up to eight, at a probed uplink with room for them, keeps fewer peers at depth 4 or more than six, with no more cold repairs", { timeout: 300_000 }, async () => {
    const seeds = [1, 2, 3, 4];
    const six = [];
    const eight = [];
    for (const seed of seeds) {
      six.push(await churn(seed, { ...DEFAULT_PARAMS, sourceAloneFanout: 6 }));
      eight.push(await churn(seed, DEFAULT_PARAMS));
    }
    const mean = (runs: { deep: number }[]) => runs.reduce((sum, run) => sum + run.deep, 0) / runs.length;
    const cold = (runs: { cold: number }[]) => runs.reduce((sum, run) => sum + run.cold, 0);
    console.log(`      peer-seconds at depth 4 or more: six ${(100 * mean(six)).toFixed(1)}%, eight ${(100 * mean(eight)).toFixed(1)}%; cold repairs ${cold(six)} and ${cold(eight)} (seeds ${seeds.join(", ")})`);
    assert.ok(mean(eight) < mean(six), "eight is shallower");
    assert.ok(cold(eight) <= cold(six) + 4, `cold repairs ${cold(six)} -> ${cold(eight)}`);
  });
});
