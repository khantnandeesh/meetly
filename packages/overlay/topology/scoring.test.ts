/** SPEC §8: one test per row of §8.1's table, and the formulas of §8.2–§8.3 to the digit. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PARAMS, type Capabilities } from "@meetly/overlay";
import { createParentSelector, judgeRelay, parentCost } from "@meetly/overlay/topology/index";
import { relayFanout, relayScore } from "@meetly/overlay/topology/scoring";
import type { Candidate, Observed } from "@meetly/overlay/topology/types";

const KBPS = 1232; // 1,200 video + 32 audio
const good: Capabilities = { browser: "chromium", desktop: true, onPower: true, nat: "cone", uplinkKbps: null, cores: 8, decode: ["vp8", "opus"], dataSaver: false, visible: true };
const seen: Observed = { uptimeMs: 60_000, spareUplinkKbps: 10_000, lossPct: 0.5, churnPerMin: 0 };
const judge = (caps: Partial<Capabilities> = {}, observed: Partial<Observed> = {}) => judgeRelay({ ...good, ...caps }, { ...seen, ...observed }, KBPS, DEFAULT_PARAMS);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);

describe("judgeRelay: who may relay (SPEC §8.1)", () => {
  it("accepts a desktop Chromium on mains, reachable, visible, fast, settled and clean", () => {
    const verdict = judge();
    assert.equal(verdict.eligible, true);
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.fanout, 4);
  });

  it("browser: only Chromium", () => {
    for (const browser of ["firefox", "safari", "other"] as const) assert.deepEqual(judge({ browser }).reasons, ["browser"]);
  });

  it("device: only a desktop", () => {
    assert.deepEqual(judge({ desktop: false }).reasons, ["mobile"]);
  });

  it("power: on mains or unknown; on battery is a leaf, and unknown scores lower", () => {
    assert.deepEqual(judge({ onPower: false }).reasons, ["battery"]);
    const unknown = judge({ onPower: null });
    assert.equal(unknown.eligible, true);
    near(judge().score - unknown.score, 0.1);
  });

  it("NAT: open or cone; symmetric, relay and unknown are leaf-only", () => {
    assert.equal(judge({ nat: "open" }).eligible, true);
    assert.equal(judge({ nat: "cone" }).eligible, true);
    for (const nat of ["symmetric", "relay", "unknown"] as const) assert.deepEqual(judge({ nat }).reasons, ["nat"]);
  });

  it("data saver: off", () => {
    assert.deepEqual(judge({ dataSaver: true }).reasons, ["data-saver"]);
  });

  it("visible: the tab is in view", () => {
    assert.deepEqual(judge({ visible: false }).reasons, ["hidden"]);
  });

  it("uplink: measured spare uplink of at least 2 × 1.15 × the session's bitrate", () => {
    const least = 2 * 1.15 * KBPS;
    assert.equal(judge({}, { spareUplinkKbps: least }).eligible, true);
    assert.deepEqual(judge({}, { spareUplinkKbps: least - 1 }).reasons, ["uplink"]);
    // Not measured, and nothing claimed: not yet.
    assert.deepEqual(judge({}, { spareUplinkKbps: null }).reasons, ["uplink"]);
    // Not observed by the judge, but the peer reports its own probe's result.
    assert.equal(judge({ uplinkKbps: 10_000 }, { spareUplinkKbps: null }).eligible, true);
    // What was observed wins over what was said.
    assert.deepEqual(judge({ uplinkKbps: 10_000 }, { spareUplinkKbps: 100 }).reasons, ["uplink"]);
  });

  it("probation: 20 s in the session", () => {
    assert.deepEqual(judge({}, { uptimeMs: 19_999 }).reasons, ["probation"]);
    assert.equal(judge({}, { uptimeMs: 20_000 }).eligible, true);
  });

  it("loss: under 2% from its own parent", () => {
    assert.equal(judge({}, { lossPct: 1.99 }).eligible, true);
    assert.deepEqual(judge({}, { lossPct: 2 }).reasons, ["lossy"]);
  });

  it("gives every reason, in the order checked, and no fan-out to a peer that may not relay", () => {
    const verdict = judgeRelay(
      { ...good, browser: "safari", desktop: false, onPower: false, nat: "symmetric", dataSaver: true, visible: false },
      { uptimeMs: 0, spareUplinkKbps: 0, lossPct: 9, churnPerMin: 5 },
      KBPS,
      DEFAULT_PARAMS,
    );
    assert.deepEqual(verdict.reasons, ["browser", "mobile", "battery", "nat", "data-saver", "hidden", "uplink", "probation", "lossy"]);
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.fanout, 0);
  });

  it("fan-out: min(maxFanout, floor(0.7 × spare / (1.15 × session)))", () => {
    assert.equal(relayFanout(2 * 1.15 * 1000, 1000, 4), 1); // floor(1.4)
    assert.equal(relayFanout(3300, 1000, 4), 2); // floor(2.008…)
    assert.equal(relayFanout(3200, 1000, 4), 1); // floor(1.947…)
    assert.equal(relayFanout(100_000, 1000, 4), 4);
    assert.equal(relayFanout(0, 1000, 4), 0);
    assert.equal(judge({}, { spareUplinkKbps: 5000 }).fanout, Math.floor((0.7 * 5000) / (1.15 * KBPS)));
  });
});

describe("relay score (SPEC §8.2)", () => {
  it("is 1 for ten minutes on a fast, clean, mains-powered line that never changed parent", () => {
    near(relayScore(good, { uptimeMs: 600_000, spareUplinkKbps: 4 * 1.15 * KBPS, lossPct: 0, churnPerMin: 0 }, KBPS, DEFAULT_PARAMS), 1);
  });

  it("is 0 for a new peer with nothing spare, 2% loss, on battery, changing parent twice a minute", () => {
    near(relayScore({ ...good, onPower: false }, { uptimeMs: 0, spareUplinkKbps: 0, lossPct: 2, churnPerMin: 2 }, KBPS, DEFAULT_PARAMS), 0);
  });

  it("weighs uplink 0.35, uptime 0.25, loss 0.20, power 0.10, churn 0.10", () => {
    const observed: Observed = { uptimeMs: 150_000, spareUplinkKbps: 2 * 1.15 * 1000, lossPct: 0.5, churnPerMin: 1 };
    // uplink 2/4 = 0.5, uptime 0.25, loss 1 − 0.25 = 0.75, power unknown = 0, churn 1 − 0.5 = 0.5
    near(relayScore({ ...good, onPower: null }, observed, 1000, DEFAULT_PARAMS), 0.35 * 0.5 + 0.25 * 0.25 + 0.2 * 0.75 + 0 + 0.1 * 0.5);
    near(judgeRelay({ ...good, onPower: null }, observed, 1000, DEFAULT_PARAMS).score, 0.4375);
  });

  it("caps every term at 1", () => {
    near(relayScore(good, { uptimeMs: 9e9, spareUplinkKbps: 9e9, lossPct: 0, churnPerMin: 0 }, KBPS, DEFAULT_PARAMS), 1);
    near(relayScore(good, { uptimeMs: 600_000, spareUplinkKbps: 4 * 1.15 * KBPS, lossPct: 50, churnPerMin: 50 }, KBPS, DEFAULT_PARAMS), 0.7);
  });
});

const candidate = (over: Partial<Candidate> = {}): Candidate => ({ peer: "p", depth: 1, free: 1, rttMs: 20, lossPct: 0, path: ["p", "src"], turn: false, ...over });

describe("parent cost (SPEC §8.3)", () => {
  it("is the round trip, plus 30 a hop, plus 20 a point of loss, plus 100 through TURN", () => {
    assert.equal(parentCost(candidate()), 20 + 30);
    assert.equal(parentCost(candidate({ depth: 3 })), 20 + 90);
    assert.equal(parentCost(candidate({ depth: 0, lossPct: 1.5 })), 20 + 30);
    assert.equal(parentCost(candidate({ turn: true })), 20 + 30 + 100);
    assert.equal(parentCost(candidate({ rttMs: 42.5, depth: 2, lossPct: 0.5, turn: true })), 42.5 + 60 + 10 + 100);
  });

  it("charges 150 for a round trip not yet measured", () => {
    assert.equal(parentCost(candidate({ rttMs: null, depth: 0 })), 150);
  });

  it("is infinite without a free slot", () => {
    assert.equal(parentCost(candidate({ free: 0 })), Infinity);
  });

  it("prefers a slightly farther parent two hops down to a near one five hops down", () => {
    assert.ok(parentCost(candidate({ rttMs: 40, depth: 2 })) < parentCost(candidate({ rttMs: 10, depth: 5 })));
  });
});

describe("parent selector (SPEC §7.2, §7.6)", () => {
  it("ranks by cost, and never offers a peer whose path contains this one, itself, or a full one", () => {
    const selector = createParentSelector({ rebalanceMinMs: 30_000 });
    const ranked = selector.rank("me", [
      candidate({ peer: "far", rttMs: 90 }),
      candidate({ peer: "below-me", rttMs: 1, path: ["below-me", "me", "src"] }),
      candidate({ peer: "full", rttMs: 1, free: 0 }),
      candidate({ peer: "me", rttMs: 0 }),
      candidate({ peer: "near", rttMs: 10 }),
      candidate({ peer: "unknown-path", rttMs: 50, path: null }),
    ]);
    assert.deepEqual(
      ranked.map((c) => c.peer),
      ["near", "unknown-path", "far"],
    );
  });

  it("switches only for 20% and 20 ms, three comparisons running, and not within rebalanceMinMs", () => {
    const current = candidate({ peer: "now", rttMs: 80, free: 0 }); // 110; its own slot is not "no free slot"
    const better = candidate({ peer: "better", rttMs: 15 }); // 45

    let selector = createParentSelector({ rebalanceMinMs: 30_000 });
    assert.equal(selector.shouldSwitch(current, better, 60_000), false);
    assert.equal(selector.shouldSwitch(current, better, 70_000), false);
    assert.equal(selector.shouldSwitch(current, better, 80_000), true);
    // The count starts again after a switch.
    assert.equal(selector.shouldSwitch(current, better, 90_000), false);

    // Too soon after the last switch: it waits, and goes as soon as the interval has passed.
    selector = createParentSelector({ rebalanceMinMs: 30_000 });
    assert.equal(selector.shouldSwitch(current, better, 0), false);
    assert.equal(selector.shouldSwitch(current, better, 10_000), false);
    assert.equal(selector.shouldSwitch(current, better, 20_000), false);
    assert.equal(selector.shouldSwitch(current, better, 30_000), true);

    // A comparison that fails starts the count again.
    selector = createParentSelector({ rebalanceMinMs: 0 });
    const notBetter = candidate({ peer: "better", rttMs: 75 });
    assert.equal(selector.shouldSwitch(current, better, 1), false);
    assert.equal(selector.shouldSwitch(current, better, 1), false);
    assert.equal(selector.shouldSwitch(current, notBetter, 1), false);
    assert.equal(selector.shouldSwitch(current, better, 1), false);
    assert.equal(selector.shouldSwitch(current, better, 1), false);
    assert.equal(selector.shouldSwitch(current, better, 1), true);

    // So does a different best candidate.
    selector = createParentSelector({ rebalanceMinMs: 0 });
    assert.equal(selector.shouldSwitch(current, better, 1), false);
    assert.equal(selector.shouldSwitch(current, better, 1), false);
    assert.equal(selector.shouldSwitch(current, { ...better, peer: "other" }, 1), false);
    assert.equal(selector.shouldSwitch(current, { ...better, peer: "other" }, 1), false);
    assert.equal(selector.shouldSwitch(current, { ...better, peer: "other" }, 1), true);
  });

  it("needs both margins: 20% is not enough without 20 ms, nor 20 ms without 20%", () => {
    const selector = createParentSelector({ rebalanceMinMs: 0 });
    const thrice = (current: Candidate, best: Candidate) => [1, 2, 3].map(() => selector.shouldSwitch(current, best, 1)).at(-1);
    // 40 → 25: 37% better, but only 15 ms.
    assert.equal(thrice(candidate({ peer: "a", depth: 0, rttMs: 40 }), candidate({ peer: "b", depth: 0, rttMs: 25 })), false);
    // 300 → 270: 30 ms better, but only 10%.
    assert.equal(thrice(candidate({ peer: "a", depth: 0, rttMs: 300 }), candidate({ peer: "b", depth: 0, rttMs: 270 })), false);
    // 100 → 80: exactly 20% and 20 ms.
    assert.equal(thrice(candidate({ peer: "a", depth: 0, rttMs: 100 }), candidate({ peer: "b", depth: 0, rttMs: 80 })), true);
    assert.equal(thrice(candidate({ peer: "a", depth: 0, rttMs: 100 }), candidate({ peer: "a", depth: 0, rttMs: 1 })), false);
  });
});
