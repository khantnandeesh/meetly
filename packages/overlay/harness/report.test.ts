/**
 * PLAN H3: `buildReport` on hand-made `ShardResult`s gives the quantiles expected, merges shards
 * in any order to the same report, and marks a run invalid for each reason in SPEC §12.3. And
 * the arithmetic every shard must do the same: networks, join times, churn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LATENCY_BUCKET_EDGES_MS, decodeMetricsSample, emptyHistogram, latencyBucket, type MetricsEvent, type MetricsSample } from "@meetly/overlay";
import { buildReport, exactQuantiles, histogramQuantiles, renderReport, reportJson } from "@meetly/overlay/harness/report";
import { GATE_MIX, PROFILES, churnSteps, gateChurn, joinAtS, profileOf, scenario, shardOf } from "@meetly/overlay/harness/scenarios";
import { pickPeer } from "@meetly/overlay/harness/shard";
import type { ShardResult } from "@meetly/overlay/harness/types";

const hist = (values: number[]): number[] => {
  const counts = emptyHistogram();
  for (const value of values) counts[latencyBucket(value)]++;
  return counts;
};

function sample(peer: string, seq: number, depth: number, latencies: number[], events: MetricsEvent[] = []): MetricsSample {
  // Through the decoder, so a hand-made sample is one the wire would accept.
  return decodeMetricsSample(
    JSON.stringify({ peer, seq, at: 1000 + seq * 2000, intervalMs: 2000, role: "leaf", depth, playoutDelayMs: 60, video: { rendered: latencies.length, dropped: 1, lost: 0, glassToGlass: hist(latencies), frameGap: emptyHistogram(), maxTemporal: 2 }, events }),
  );
}
const join = (ms: number): MetricsEvent => ({ t: "join", start: 100, welcome: 110, linked: 120, firstPacket: 130, firstFrame: 100 + ms, turn: false });
const repair = (freezeMs: number, kind: "warm" | "cold" | "wait" = "warm", framesLost = 0): MetricsEvent => ({
  t: "repair",
  stream: 0,
  stripe: 0,
  dead: "x",
  next: "y",
  kind,
  lastHeard: 5000,
  detected: 5200,
  resubscribed: 5210,
  firstPacket: 5215,
  freezeMs,
  framesLost,
  usedCoordinator: kind === "cold",
});
const lagOf = (ms: number): number[] => hist(Array.from({ length: 1000 }, () => ms));

function shard(index: number, count: number, samples: MetricsSample[], over: Partial<ShardResult> = {}): ShardResult {
  return {
    runId: "run",
    shard: { index, count },
    startedAt: 0,
    endedAt: 60_000,
    peersStarted: 100,
    peersFailed: [],
    samples,
    host: { cores: 4, loadAvg1: [1, 2], maxEventLoopLagMs: 12, driverLag: lagOf(5), pageLag: lagOf(8) },
    peers: 200,
    durationS: 60,
    scenario: "gate",
    engine: "real",
    coordinator: index === 0 ? "real" : "external",
    stubbed: [],
    clock: { source: index === 0 ? 2 : null, viewers: [3, 4, 5] },
    links: { opened: 10, failed: 0, turn: 1, candidates: { "host-host": 9, "relay-host": 1 }, crossShard: 2, crossShardTurn: 1 },
    ...over,
  };
}

/** Two shards whose run is a valid gate run that passes: 120 repairs, good numbers. */
function goodRun(): ShardResult[] {
  const a: MetricsSample[] = [];
  const b: MetricsSample[] = [];
  for (let i = 0; i < 60; i++) {
    a.push(sample(`a${i}`, 0, 1, [100, 110, 120], [join(400), repair(200)]));
    b.push(sample(`b${i}`, 0, 2, [200, 210, 220], [join(900), repair(300, "cold")]));
  }
  return [shard(0, 2, a), shard(1, 2, b)];
}

describe("harness report", () => {
  it("reads quantiles from the summed histograms, as bucket upper edges", () => {
    // 1..100 ms, one each: p50 is the 50th value (50), p95 the 95th, p99 the 99th.
    const q = histogramQuantiles(hist(Array.from({ length: 100 }, (_, i) => i + 1)));
    assert.deepEqual(q, { n: 100, p50: 50, p95: 100, p99: 100, max: 100 });
    assert.deepEqual(histogramQuantiles(emptyHistogram()), { n: 0, p50: null, p95: null, p99: null, max: null });
    assert.equal(histogramQuantiles(hist([20_000])).max, Infinity);
    assert.deepEqual(exactQuantiles([4, 1, 3, 2]), { n: 4, p50: 2, p95: 4, p99: 4, max: 4 });
    assert.equal(LATENCY_BUCKET_EDGES_MS.length, 96);
  });

  it("gives the quantiles expected of hand-made shards", () => {
    const report = buildReport(goodRun());
    assert.equal(report.peers, 200);
    assert.equal(report.shards, 2);
    // 60 joins of 400 ms and 60 of 900: the median is 400, the tail 900.
    assert.deepEqual(report.joinMs, { n: 120, p50: 400, p95: 900, p99: 900, max: 900 });
    assert.deepEqual(report.repairMs, { n: 120, p50: 200, p95: 300, p99: 300, max: 300 });
    assert.deepEqual(report.repairs, { warm: 60, cold: 60, wait: 0, usedCoordinator: 60, framesLost: 0 });
    // 180 frames at 100–120 ms and 180 at 200–220.
    assert.deepEqual(report.glassToGlassMs, { n: 360, p50: 120, p95: 220, p99: 220, max: 220 });
    assert.deepEqual(Object.keys(report.glassToGlassByDepth), ["1", "2"]);
    assert.equal(report.glassToGlassByDepth[2].p50, 210);
    assert.deepEqual(report.frames, { rendered: 360, dropped: 120, lost: 0 });
    // The worst viewer (5 ms) plus the source (2 ms).
    assert.equal(report.clockUncertaintyMs.p95, 7);
    assert.equal(report.links.opened, 20);
    assert.equal(report.links.candidates["host-host"], 18);
    assert.deepEqual(report.gate.checks.map((c) => [c.value, c.pass]), [[300, true], [220, true], [900, true]]);
    assert.deepEqual([report.gate.valid, report.gate.pass, report.gate.verdict, report.gate.isGate], [true, true, "pass", true]);
  });

  it("fails a valid run that misses a limit, and says which", () => {
    const results = goodRun();
    results[1].samples.push(...Array.from({ length: 20 }, (_, i) => sample(`slow${i}`, 0, 3, [], [repair(650)])));
    const report = buildReport(results);
    assert.equal(report.repairMs.p95, 650);
    assert.deepEqual([report.gate.valid, report.gate.pass, report.gate.verdict], [true, false, "fail"]);
    assert.deepEqual(report.gate.checks.filter((c) => !c.pass).map((c) => c.name), ["repair time p95 (ms)"]);
  });

  it("merges shards in any order to the same report, and counts a sample once", () => {
    const [a, b] = goodRun();
    const c = shard(2, 3, [sample("c0", 0, 3, [300], [repair(100, "wait"), { t: "freeze", stream: 0, at: 10, ms: 400 }])], { peersFailed: [{ index: 5, why: "x" }], notes: ["n"] });
    for (const s of [a, b]) s.shard.count = 3;
    const orders = [[a, b, c], [c, b, a], [b, c, a], [c, a, b]];
    const reports = orders.map((order) => reportJson(buildReport(order)));
    for (const text of reports) assert.equal(text, reports[0]);
    const once = buildReport([a, b, c]);
    const twice = buildReport([a, b, { ...c, samples: [...c.samples, ...c.samples] }]);
    assert.equal(twice.glassToGlassMs.n, once.glassToGlassMs.n);
    assert.equal(once.freezes.count, 1);
    assert.equal(once.freezeMs.max, 400);
  });

  it("marks a run invalid for each reason of SPEC §12.3, and an invalid run is neither a pass nor a fail", () => {
    const failing = (results: ShardResult[]): string[] => {
      const report = buildReport(results);
      assert.equal(report.gate.valid, report.gate.validity.every((v) => v.pass));
      if (!report.gate.valid) assert.deepEqual([report.gate.pass, report.gate.verdict], [false, "invalid"]);
      return report.gate.validity.filter((v) => !v.pass).map((v) => v.name);
    };
    assert.deepEqual(failing(goodRun()), []);

    // Fewer than 100 repair events.
    const few = goodRun();
    few[1].samples = few[1].samples.slice(0, 30);
    assert.deepEqual(failing(few), ["repair events, at least"]);

    // A peer failed to start.
    const crashed = goodRun();
    crashed[0].peersFailed.push({ index: 7, why: "the page crashed" });
    assert.deepEqual(failing(crashed), ["peers that failed to start"]);

    // A machine was starved: event-loop lag over 50 ms at p99, on one shard only.
    const starved = goodRun();
    starved[1].host.pageLag = hist([...Array.from({ length: 97 }, () => 5), 80, 80, 80]);
    assert.deepEqual(failing(starved), ["event-loop lag p99 on the worst shard (ms)"]);
    const unmeasured = goodRun();
    unmeasured[0].host = { cores: 4, loadAvg1: [], maxEventLoopLagMs: 0 };
    assert.deepEqual(failing(unmeasured), ["event-loop lag p99 on the worst shard (ms)"]);

    // Clocks: the sum of uncertainties at p95 is not under 20 ms; or nobody measured them.
    const loose = goodRun();
    loose[1].clock = { source: null, viewers: [3, 4, 19] };
    assert.deepEqual(failing(loose), ["clock uncertainty, viewer plus source, p95 (ms)"]);
    const blind = goodRun();
    blind[0].clock = undefined;
    assert.deepEqual(failing(blind), ["clock uncertainty, viewer plus source, p95 (ms)"]);

    // Not 200 peers; a shard missing.
    const small = goodRun();
    for (const s of small) s.peers = 150;
    assert.deepEqual(failing(small), ["peers, at least"]);
    assert.deepEqual(failing([goodRun()[1]]), ["shards that reported, of the run's", "repair events, at least", "clock uncertainty, viewer plus source, p95 (ms)"]);
    assert.equal(buildReport([]).gate.verdict, "invalid");
  });

  it("judges a small scenario by what it asks, and never calls it the gate", () => {
    const results = goodRun().map((s) => ({ ...s, peers: 30, expect: { peers: 30, minRepairs: 12 } }));
    const report = buildReport(results);
    assert.deepEqual([report.gate.valid, report.gate.verdict, report.gate.isGate], [true, "pass", false]);
    assert.ok(report.gate.notes.some((note) => /not the gate run/.test(note)));
  });

  it("names every stub, in the report and at the top of its text", () => {
    const results = goodRun();
    results[0].stubbed = ["media.createPlayer"];
    results[1].engine = "standin";
    results[1].stubbed = ["index.createOverlayViewer", "media.createPlayer"];
    const report = buildReport(results);
    assert.deepEqual(report.stubbed, ["index.createOverlayViewer", "media.createPlayer"]);
    assert.deepEqual([report.engine, report.gate.isGate], ["mixed", false]);
    const text = renderReport(report);
    assert.match(text.split("\n").slice(0, 5).join("\n"), /Stand-in, not the engine/);
    assert.match(text, /STUBBED: index\.createOverlayViewer, media\.createPlayer/);
    assert.doesNotMatch(renderReport(buildReport(goodRun())), /Stand-in/);
  });
});

describe("harness scenarios: what every shard works out alone", () => {
  const config = scenario("gate", { seed: 7 });

  it("deals the first viewers the gate's mix exactly, the same on every shard", () => {
    const counts: Record<string, number> = {};
    for (let i = 1; i < config.peers; i++) counts[profileOf(config, i)?.name ?? "clean"] = (counts[profileOf(config, i)?.name ?? "clean"] ?? 0) + 1;
    // 199 viewers at 50 / 30 / 15 / 5.
    assert.deepEqual(counts, { good: 99, home: 60, bad: 30, slow: 10 });
    assert.equal(profileOf(config, 0), null, "the source's network is the host's own");
    assert.deepEqual(profileOf({ ...config, shard: { index: 3, count: 8 } } as typeof config, 42), profileOf(config, 42));
    assert.notDeepEqual(
      Array.from({ length: 50 }, (_, i) => profileOf(config, i + 1)?.name),
      Array.from({ length: 50 }, (_, i) => profileOf({ ...config, seed: 8 }, i + 1)?.name),
    );
    assert.ok(Object.keys(PROFILES).includes(profileOf(config, 500)?.name ?? "clean"), "a late joiner draws from the mix");
    assert.equal(GATE_MIX.reduce((sum, part) => sum + part.share, 0), 1);
  });

  it("is the gate of D28: a relay killed, a leave and two joins every 10 s for 10 minutes, and one 30 s outage", () => {
    const churn = gateChurn(100, 600);
    const of = (action: string) => churn.filter((event) => event.action === action);
    assert.equal(of("kill").length, 60);
    assert.equal(of("leave").length, 60);
    assert.equal(of("join").reduce((sum, event) => sum + ("count" in event ? event.count : 0), 0), 120);
    const kills = of("kill").map((event) => event.atS);
    assert.ok(kills.every((at, i) => i === 0 || at - kills[i - 1] === 10));
    const outage = of("kill-coordinator");
    assert.equal(outage.length, 1);
    const dead = outage[0] as { atS: number; forS: number };
    assert.equal(dead.forS, 30);
    assert.ok(kills.filter((at) => at >= dead.atS && at < dead.atS + 30).length >= 2, "relays go on dying while the coordinator is dead");
    assert.equal(config.peers, 200);
    assert.deepEqual(config.mix, GATE_MIX);
    assert.deepEqual(config.expect, { peers: 200, minRepairs: 100 });
  });

  it("gives every churn step to exactly one shard, and every new peer an index of its own", () => {
    const count = 8;
    const all = churnSteps({ ...config, shard: { index: 0, count } });
    const again = churnSteps({ ...config, shard: { index: 5, count } });
    assert.deepEqual(all, again, "every shard derives the same script");
    const joins = all.filter((step) => step.event.action === "join");
    assert.deepEqual(joins.map((step) => step.index), Array.from({ length: 120 }, (_, i) => 200 + i));
    assert.ok(joins.every((step) => step.shard === shardOf(step.index as number, count)));
    const kills = all.filter((step) => step.event.action === "kill");
    for (let s = 0; s < count; s++) assert.ok(kills.some((step) => step.shard === s), `shard ${s} kills somebody`);
    assert.deepEqual(all.filter((step) => step.shard === -1).map((step) => step.event.action), ["kill-coordinator"]);
  });

  it("spreads joins at joinPerS, the source first", () => {
    assert.equal(joinAtS(config, 0), 0);
    assert.equal(joinAtS(config, 1), 2);
    assert.equal(joinAtS(config, 41) - joinAtS(config, 1), 40 / config.joinPerS);
  });

  it("picks whom churn falls on from what the pages say, repeatably", () => {
    const peers = [
      { index: 1, children: 2, depth: 1 },
      { index: 2, children: 3, depth: 1 },
      { index: 3, children: 1, depth: 2 },
      { index: 4, children: 0, depth: 2 },
      { index: 5, children: 0, depth: 3 },
    ];
    assert.equal(pickPeer(peers, "busiest-relay", 1)?.index, 2);
    assert.equal(pickPeer(peers, "deepest-relay", 1)?.index, 3);
    assert.ok([1, 2].includes(pickPeer(peers, "shallowest-relay", 1)?.index ?? 0));
    assert.ok([4, 5].includes(pickPeer(peers, "leaf", 9)?.index ?? 0));
    assert.ok((pickPeer(peers, "relay", 3)?.children ?? 0) > 0);
    assert.equal(pickPeer(peers, "relay", 3), pickPeer([...peers].reverse(), "relay", 3));
    assert.equal(pickPeer(peers.slice(3), "relay", 3), null);
  });
});
