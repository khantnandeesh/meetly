/**
 * [D76] The start-up deadlock of gate run 45243574215. The first six viewers to reach the source
 * were "slow" (900 kbps): at join nothing told them from a relay (no probe yet), so they took the
 * source's three slots and the three over its fan-out (D37); their probes then showed no uplink,
 * and the source's own probes toward them (D49, D75) measured their 900 kbps, so it stayed at
 * three. No relay existed anywhere, nobody else could get a parent, so nobody could probe or be
 * promoted: welcome to linked was 60-107 s for the fill's joiners.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PARAMS } from "@meetly/overlay/protocol";
import { Rig, Swarm, seeded } from "./testkit";

/** The gate's "slow" viewer: claims all a relay needs, and its probe finds 900 kbps (SPEC §12.3). */
const SLOW_KBPS = 900;
/** The engine's timers, as provisional.test.ts has them: a link 0.5 s, the NAT type 3 s after welcome, the short probe 1 s. */
const LINK_MS = 500;
const NAT_MS = 3_000;
const probeAt = ({ joinedAt, placedAt }: { joinedAt: number; placedAt: number }) => Math.max(placedAt + LINK_MS + 200, joinedAt + NAT_MS) + 1_000;

/**
 * The source probed toward slow children (fan-out 3); `slow` viewers join first, then `able`
 * ones, all at the gate's 4 a second; then `settleS` seconds pass.
 */
async function startUp(slow: number, able: number, settleS: number, seed = 1, params = DEFAULT_PARAMS) {
  const swarm = new Swarm(new Rig({ random: seeded(seed), params }), undefined, { probeAt, linkMs: LINK_MS });
  await swarm.addSource(SLOW_KBPS);
  const order = [...Array.from({ length: slow }, () => true), ...Array.from({ length: able }, () => false)];
  for (let t = 0, joined = 0; joined < order.length; t += 100) {
    while (joined < order.length && (joined * 1000) / 4 <= t) {
      if (order[joined]) await swarm.addViewer(true, SLOW_KBPS);
      else await swarm.addViewer(true);
      joined++;
    }
    await swarm.step(100);
  }
  for (let s = 0; s < settleS; s++) await swarm.second();
  const waits = [...swarm.joinWaits].sort((a, b) => a - b);
  return { swarm, shape: swarm.shape(), p95: waits.length > 0 ? waits[Math.floor(0.95 * waits.length)] : Infinity, placed: waits.length };
}

describe("coordinator: start-up with no relay anywhere (D76)", () => {
  it("six slow viewers first at a source of fan-out 3 do not shut everyone else out (gate run 45243574215)", { timeout: 120_000 }, async () => {
    const { shape, p95, placed } = await startUp(6, 40, 20);
    console.log(`      6 slow first, then 40: placed ${placed} of 46, waiting ${shape.waiting}, relays ${shape.relays}, depth ${shape.maxDepth}, welcome to parent p95 ${p95} ms`);
    assert.equal(shape.waiting, 0, `${shape.waiting} viewers never had a parent`);
    assert.ok(shape.relays > 0, "a relay was made");
    assert.ok(p95 <= 10_000, `welcome to parent p95 ${p95} ms`);
  });

  it("as many slow viewers first as the source can take over its fan-out (twice it), and then some: still no deadlock", { timeout: 120_000 }, async () => {
    for (const slow of [3, 9, 12]) {
      const { shape, p95, placed } = await startUp(slow, 30, 30);
      console.log(`      ${slow} slow first, then 30: placed ${placed} of ${slow + 30}, waiting ${shape.waiting}, relays ${shape.relays}, welcome to parent p95 ${p95} ms`);
      assert.equal(shape.waiting, 0, `${slow} slow first: ${shape.waiting} viewers never had a parent`);
    }
  });

  it("the proof's tree (fan-outs of two, no slot kept at the source): slow viewers first still leave nobody out", { timeout: 120_000 }, async () => {
    const params = { ...DEFAULT_PARAMS, sourceFanout: 2, maxFanout: 2, sourceAloneFanout: 2 };
    for (const slow of [2, 4]) {
      const { shape, p95, placed } = await startUp(slow, 10, 40, 1, params);
      console.log(`      fan-out 2, ${slow} slow first, then 10: placed ${placed} of ${slow + 10}, waiting ${shape.waiting}, relays ${shape.relays}, welcome to parent p95 ${p95} ms`);
      assert.equal(shape.waiting, 0, `${slow} slow first: ${shape.waiting} viewers never had a parent`);
    }
  });
});
