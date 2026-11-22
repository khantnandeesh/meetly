import { it } from "node:test";
import { DEFAULT_PARAMS } from "@meetly/overlay/protocol";
import { Rig, Swarm, seeded } from "./testkit";

// Gate-like: 200 peers at 4 a second, 80% able to relay, uplink for 4 children; then a relay
// killed and a viewer added every 10 s for 600 s. Depth of every placed peer, every 5 s.
for (const leafPlacement of ["deep", "shallow"] as const)
  for (const seed of [1, 2, 3])
    it(`depth ${leafPlacement} seed ${seed}`, { timeout: 600_000 }, async () => {
      const random = seeded(seed * 7 + 1);
      const swarm = new Swarm(new Rig({ random: seeded(seed), params: { ...DEFAULT_PARAMS }, leafPlacement } as never), undefined, { linkMs: 60, probedUplinkKbps: 8900, probeAt: ({ placedAt }) => placedAt + 2500 });
      await swarm.addSource();
      for (let joined = 0; joined < 199; ) {
        for (let k = 0; k < 4 && joined < 199; k++, joined++) await swarm.addViewer(random() < 0.8);
        await swarm.step(1000);
      }
      await swarm.step(10_000);
      const depths: number[] = [];
      for (let t = 0; t < 600; t += 5) {
        if (t % 10 === 0) {
          const relays = [...swarm.peers.values()].filter((p) => p.alive && p.role === "relay");
          if (relays.length > 0) await swarm.kill(relays[Math.floor(random() * relays.length)]);
          await swarm.addViewer(random() < 0.8);
        }
        await swarm.step(5000);
        for (const p of swarm.peers.values()) if (p.alive && p.parent !== null && p.role !== "source") depths.push(p.depth);
      }
      depths.sort((a, b) => a - b);
      const q = (p: number) => depths[Math.floor(depths.length * p)];
      const hist: Record<number, number> = {};
      for (const d of depths) hist[d] = (hist[d] ?? 0) + 1;
      console.log(JSON.stringify({ leafPlacement, seed, p50: q(0.5), p95: q(0.95), max: depths.at(-1), share: Object.fromEntries(Object.entries(hist).map(([d, n]) => [d, Math.round((100 * n) / depths.length)])), moves: swarm.moves }));
    });
