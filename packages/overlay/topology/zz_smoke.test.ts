import { it } from "node:test";
import { createLayerGate, createLinkEstimator } from "@meetly/overlay/congestion/index";
import { SimNet } from "@meetly/overlay/topology/sim";

for (const seed of [1, 2, 3, 4, 5, 6]) it(`dbg smoke repair loss ${seed}`, async () => {
  const net = new SimNet({ seed, latencyMs: 10, backups: false, params: { sourceFanout: 2, maxFanout: 2 }, createLinkEstimator, createLayerGate: createLayerGate as never });
  const source = net.join("0", "source", []);
  net.publish(source, { frameBytes: (id) => (id % 60 === 0 ? 20_000 : id % 4 === 0 ? 6000 : 3500) });
  await net.runAsync(300);
  net.join("1", "relay", ["0"]);
  net.join("2", "relay", ["0"]);
  await net.runAsync(300);
  const kids = [net.join("3", "leaf", ["1"], ["2"]), net.join("4", "leaf", ["1"], ["2"]), net.join("5", "leaf", ["2"], ["1"]), net.join("6", "leaf", ["2"], ["1"])];
  for (const [a, b] of [["1", "3"], ["1", "4"], ["2", "3"], ["2", "4"], ["2", "5"], ["2", "6"]]) net.setWire(a, b, { kbps: 4000, queueMs: 500 }, false);
  await net.runAsync(3000 + seed * 13);
  net.kill("1");
  await net.runAsync(2500);
  for (const k of kids.slice(0, 2)) {
    const r = k.metrics.filter((m) => m.t === "repair") as never as { framesLost: number; freezeMs: number }[];
    const caps = net.messages.filter((m) => m.to === k.id && m.message.t === "layers").map((m) => (m.message as { maxTemporal: number; reason: string }));
    console.log(JSON.stringify({ seed, peer: k.id, repairs: r.map((x) => [x.framesLost, Math.round(x.freezeMs)]), caps }));
  }
});
