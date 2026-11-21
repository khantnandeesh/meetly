/**
 * PLAN C3 on the real node, in one process: topology's `SimNet` (with its wire's rate cap), its
 * `OverlayNode`, and congestion's real estimator and gate. One of the source's three children has
 * its link capped under the 1,200 kbps stream; it settles on the middle layer within 2 s, and its
 * siblings and their children keep every frame. Proposed by E-congestion (congestion/README.md).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLayerGate, createLinkEstimator } from "../congestion/index";
import { SimNet } from "../topology/sim";

/** Frame sizes for a 1,200 kbps L1T3 stream: a 27 kB keyframe, then 6.7 kB base, 3.3 kB above. */
const bytes = (id: number): number => (id % 60 === 0 ? 26_667 : id % 4 === 0 ? 6_667 : 3_333);
const layerOf = (id: number): number => (id % 4 === 0 ? 0 : id % 2 === 0 ? 1 : 2);

async function slowChild(capKbps: number) {
  const net = new SimNet({ seed: 1, latencyMs: 15, createLinkEstimator, createLayerGate: createLayerGate as never });
  const src = net.join("src", "source", []);
  net.publish(src, { frameBytes: bytes });
  await net.runAsync(200);
  const peers = { a: net.join("a", "relay", ["src"]), b: net.join("b", "relay", ["src"]), slow: net.join("slow", "relay", ["src"]) };
  await net.runAsync(500);
  const below = { a1: net.join("a1", "leaf", ["a"]), s1: net.join("s1", "leaf", ["slow"]) };
  await net.runAsync(4300);
  const capAt = net.clock.now();
  const firstFrame = net.published;
  // The child's downlink: every wire into it, whoever it takes as parent.
  for (const from of ["src", "a", "b", "a1", "s1"]) net.setWire(from, "slow", { kbps: capKbps, queueMs: 300 }, false);
  await net.runAsync(20_000);
  const last = net.published - 30;
  const layers = net.messages.filter((m) => m.message.t === "layers" && m.at >= capAt);
  const frames = (peer: { video: Set<number> }) => {
    const got = [0, 0, 0];
    for (let id = firstFrame + 150; id < last; id++) if (peer.video.has(id)) got[layerOf(id)]++;
    return got;
  };
  const sent = [0, 0, 0];
  for (let id = firstFrame + 150; id < last; id++) sent[layerOf(id)]++;
  return { layers, capAt, frames, sent, all: { ...peers, ...below } };
}

describe("a slow child on the real node, with congestion's estimator and gate (PLAN C3, simulated)", () => {
  for (const capKbps of [900, 1100]) {
    it(`capped at ${capKbps} kbps: one \`layers\` to the middle layer within 2 s; it and its child get layers 0 and 1 whole; the others every frame`, async () => {
      const run = await slowChild(capKbps);
      assert.deepEqual(
        run.layers.map((m) => [m.from, m.to, (m.message as { maxTemporal: number }).maxTemporal]),
        [["src", "slow", 1]],
      );
      assert.ok(run.layers[0].at - run.capAt <= 2000, `${run.layers[0].at - run.capAt} ms`);
      for (const id of ["slow", "s1"] as const) assert.deepEqual(run.frames(run.all[id]), [run.sent[0], run.sent[1], 0], id);
      for (const id of ["a", "b", "a1"] as const) assert.deepEqual(run.frames(run.all[id]), run.sent, id);
      for (const peer of Object.values(run.all)) assert.deepEqual(peer.errors, []);
    });
  }
});
