/**
 * PLAN H3: `buildReport` on hand-made `ShardResult`s gives the quantiles expected, merges shards
 * in any order to the same report, and marks a run invalid for each reason in SPEC §12.3. And
 * the arithmetic every shard must do the same: networks, join times, churn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LATENCY_BUCKET_EDGES_MS, decodeMetricsSample, emptyHistogram, latencyBucket, type MetricsEvent, type MetricsSample } from "@meetly/overlay";
import { buildReport, exactQuantiles, histogramQuantiles, largestValid, renderReport, renderSizes, reportJson } from "@meetly/overlay/harness/report";
import { GATE_MIX, PROFILES, churnSteps, gateChurn, joinAtS, profileOf, scenario, shardOf } from "@meetly/overlay/harness/scenarios";
import { ntpBoundMs, pickPeer } from "@meetly/overlay/harness/shard";
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
    assert.deepEqual(failing(starved), ["timer lag p99 on the worst runner (ms)"]);
    const unmeasured = goodRun();
    unmeasured[0].host = { cores: 4, loadAvg1: [], maxEventLoopLagMs: 0 };
    assert.deepEqual(failing(unmeasured), ["timer lag p99 on the worst runner (ms)"]);

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

  it("splits latency into decoding and light viewers, and says when the light ones are not honest (D29)", () => {
    const results = goodRun();
    // a0..a59 at 100–120 ms decode; b0..b59 at 200–220 ms are light: 100 ms apart at p50.
    results[0].decoders = results[0].samples.map((s) => s.peer);
    results[1].decoders = [];
    const apart = buildReport(results);
    assert.deepEqual([apart.glassToGlassDecoding.p50, apart.glassToGlassLight.p50], [110, 210]);
    assert.deepEqual(apart.honesty.map((c) => [c.value, c.pass]), [[100, false]]);
    assert.ok(apart.gate.notes.some((note) => /light viewers' numbers are suspect/.test(note)));
    assert.equal(apart.gate.valid, true, "D29 is a note on the numbers, not one of SPEC §12.3's reasons");
    assert.match(renderReport(apart), /Can the instrument be believed\?/);

    // A few decoders among many light viewers, agreeing to a bucket.
    const close = goodRun();
    close[0].decoders = ["a0", "a1"];
    close[1].decoders = [];
    for (const s of close[1].samples) s.video!.glassToGlass = hist([100, 110, 130]);
    const agree = buildReport(close);
    assert.deepEqual(agree.honesty.map((c) => c.pass), [true]);

    // Not told who decoded: no split at all.
    assert.deepEqual([buildReport(goodRun()).glassToGlassDecoding.n, buildReport(goodRun()).honesty], [0, []]);
  });

  it("D70: judges light viewers against their decoding siblings (same parent, network and 2 s), not the pooled p50s", () => {
    // Forty parents, each with one decoding and two light children on the same network. Their
    // links differ, parent to parent, by up to 200 ms; at each parent the light children are 10 ms
    // later than the decoding one (a bucket: 10 ms). The decoders sit at the slow parents, so pooled at their
    // depths (D58) they look far apart; paired, 10.
    const withUp = (s: MetricsSample, parent: string): MetricsSample => decodeMetricsSample(JSON.stringify({ ...s, up: { parent, rttMs: 50, lossPct: 0, queueDelayMs: 0, rxKbps: 1200, nacksSent: 0, retransmitsReceived: 0, duplicates: 0, turn: false } }));
    const samples: MetricsSample[] = [];
    const decoders: string[] = [];
    const tree: NonNullable<ShardResult["tree"]> = [];
    for (let p = 0; p < 40; p++) {
      const base = p < 20 ? 300 : 100;
      for (let seq = 0; seq < 3; seq++) {
        if (p < 20) samples.push(withUp(sample(`d${p}`, seq, 2, [base, base, base]), `r${p}`));
        samples.push(withUp(sample(`l${p}a`, seq, 2, [base + 10, base + 10]), `r${p}`));
        samples.push(withUp(sample(`l${p}b`, seq, 2, [base + 10, base + 10]), `r${p}`));
      }
      if (p < 20) {
        decoders.push(`d${p}`);
        tree.push({ peer: `d${p}`, parent: `r${p}`, index: p * 3, profile: "home" });
      }
      tree.push({ peer: `l${p}a`, parent: `r${p}`, index: p * 3 + 1, profile: "home" }, { peer: `l${p}b`, parent: `r${p}`, index: p * 3 + 2, profile: "home" });
    }
    const run = goodRun();
    run[0].samples.push(...samples);
    run[0].decoders = decoders;
    run[0].tree = tree;
    run[1].decoders = [];
    const report = buildReport(run);
    assert.equal(report.honesty.length, 1);
    assert.match(report.honesty[0].name, /D70/);
    assert.equal(report.honesty[0].pass, true, `${report.honesty[0].value} ms apart`);
    assert.ok(Math.abs((report.honesty[0].value as number) - 10) <= 1, `${report.honesty[0].value} ms apart`);
    assert.ok(report.gate.notes.some((note) => /pooled at the decoders' depths \(D58\)/.test(note)));
  });

  it("gives clock uncertainty shard by shard, and names a shard whose cross-machine sum is over 20 ms", () => {
    const results = goodRun();
    results[1].clock = { source: null, viewers: [16, 17, 25] };
    const report = buildReport(results);
    assert.deepEqual(report.clockByShard, [
      { shard: 0, viewers: 3, p95: 7, max: 7, measuredP95: null, ntpBoundMs: null },
      { shard: 1, viewers: 3, p95: 27, max: 27, measuredP95: null, ntpBoundMs: null },
    ]);
    assert.equal(report.gate.valid, false);
    assert.ok(report.gate.notes.some((note) => /^shard 1: clock uncertainty p95 27 ms/.test(note)));
    assert.match(renderReport(report), /\| 1 \| – \| 4 \| 2 \| 10 \| 27 \|/);
  });

  it("measures how far apart viewers' clocks and the source's really were, against wall clocks", () => {
    const results = goodRun();
    results[0].clock = { source: 2, viewers: [3, 4, 5], sourceVsWallMs: -1000, viewersVsWallMs: [-1000.5, -999] };
    results[1].clock = { source: null, viewers: [20, 21, 22], viewersVsWallMs: [-1004, -996, -1003] };
    results[0].host.ntp = { boundMs: 0.5, text: "" };
    results[1].host.ntp = { boundMs: 1.5, text: "" };
    const report = buildReport(results);
    assert.deepEqual(
      report.clockByShard.map((c) => [c.shard, c.measuredP95, c.ntpBoundMs]),
      [[0, 1, 1], [1, 4, 2]],
    );
    assert.match(renderReport(report), /Clocks apart, measured p95/);
  });

  it("judges a runner by its timer lag and only reports its load (D42)", () => {
    const busy = goodRun();
    busy[1].host.loadAvg1Settled = [3.2, 8.8];
    let report = buildReport(busy);
    assert.equal(report.gate.valid, true, "a loaded runner whose timers kept time is not starved");
    assert.ok(report.gate.notes.some((note) => /reported and not judged \(D42\): shard 1 at 8\.8/.test(note)));
    const late = goodRun();
    late[0].host.pageLag = hist([...Array.from({ length: 98 }, () => 5), 25, 25]);
    report = buildReport(late);
    assert.deepEqual(report.gate.validity.filter((v) => !v.pass).map((v) => [v.name, v.value]), [["timer lag p99 on the worst runner (ms)", 30]]);
    assert.ok(report.gate.notes.some((note) => /^shard 0: starved: timer lag p99 30 ms against 20 \(D42\)/.test(note)));
    // 20 at p99 (a bucket of 10 to 20 ms) passes.
    const edge = goodRun();
    edge[0].host.pageLag = hist([...Array.from({ length: 98 }, () => 5), 15, 15]);
    assert.equal(buildReport(edge).gate.valid, true);
  });

  it("judges the clocks as measured against wall clocks when every shard can be read so", () => {
    const results = goodRun();
    // SPEC §4.1's bound says 27 ms on shard 1; the clocks were really 1–4 ms apart, wall clocks within 0.5 ms.
    results[0].clock = { source: 2, viewers: [3, 4, 5], sourceVsWallMs: -1000, viewersVsWallMs: [-1001, -999, -1000] };
    results[1].clock = { source: null, viewers: [24, 25, 25], viewersVsWallMs: [-1004, -996, -1003] };
    results[0].host.ntp = { boundMs: 0.25, text: "" };
    results[1].host.ntp = { boundMs: 0.25, text: "" };
    let report = buildReport(results);
    assert.equal(report.measuredClockMs?.p95, 4.5);
    assert.deepEqual(report.gate.validity.find((v) => v.name.startsWith("clock"))?.name, "clock disagreement, measured against chrony-synced wall clocks plus their bounds, p95 (ms)");
    assert.equal(report.gate.valid, true);
    assert.ok(report.gate.notes.some((note) => /not by SPEC §4\.1's bound \(p95 27 ms\)/.test(note)));
    // One shard without chrony: back to the bound, and invalid.
    results[1].host.ntp = undefined;
    report = buildReport(results);
    assert.equal(report.measuredClockMs, null);
    assert.equal(report.gate.valid, false);
  });

  it("counts each viewer's clock at its worst moment of the run against the source's", () => {
    const results = goodRun();
    results[0].clock = { source: 2, viewers: [3], sourceVsWallMs: -1000, viewersVsWallMs: [-1000], sourceVsWallRangeMs: [-1002, -999], viewersVsWallRangeMs: [[-1001, -1000]] };
    results[1].clock = { source: null, viewers: [20], viewersVsWallMs: [-1000], viewersVsWallRangeMs: [[-1000, -985]] };
    results[0].host.ntp = { boundMs: 0, text: "" };
    results[1].host.ntp = { boundMs: 0, text: "" };
    // Shard 1's viewer at its highest (-985) against the source at its lowest (-1002): 17 ms apart.
    assert.equal(buildReport(results).measuredClockMs?.max, 17);
  });

  it("says what the stream really was, as viewers at depth 1 received it", () => {
    const results = goodRun();
    const rx = (peer: string, kbps: number) => ({ ...sample(peer, 1, 1, [100]), up: { parent: "src", rttMs: 10, lossPct: 0, queueDelayMs: 0, rxKbps: kbps, nacksSent: 0, retransmitsReceived: 0, duplicates: 0, turn: false } });
    results[0].samples = [rx("x1", 1150), rx("x2", 1180), { ...rx("deep", 300), depth: 2 }];
    const report = buildReport(results);
    assert.deepEqual([report.streamKbps.n, report.streamKbps.p50, report.streamKbps.max], [2, 1150, 1180]);
    assert.match(renderReport(report), /depth 1 received it: p50 1150 kbps/);
  });

  it("counts a viewer still joining at the end at the time it had waited, and not as a failure", () => {
    const results = goodRun();
    results[1].unfinishedJoins = [12_000, 25_000];
    const report = buildReport(results);
    assert.equal(report.joinMs.n, 122);
    assert.equal(report.joinMs.max, Infinity, "25 s is past the last bucket edge");
    assert.equal(report.gate.validity.find((v) => v.name === "peers that failed to start")?.value, 0);
    assert.ok(report.gate.notes.some((note) => /^2 viewers were still joining when the run ended/.test(note)));
  });

  it("says where joins' time went", () => {
    const report = buildReport(goodRun());
    // join(): start 100, welcome 110, linked 120, firstPacket 130, firstFrame 100 + ms.
    assert.deepEqual([report.joinPhasesMs.welcome.p50, report.joinPhasesMs.linked.p50, report.joinPhasesMs.firstPacket.p50, report.joinPhasesMs.firstFrame.max], [10, 10, 10, 870]);
    assert.match(renderReport(report), /\| welcome to a parent linked \| 10 \| 10 \| 10 \|/);
  });

  it("reads chrony's own error bound", () => {
    const text = "Reference ID    : A9FEA97B (169.254.169.123)\nSystem time     : 0.000012345 seconds fast of NTP time\nRoot delay      : 0.000400000 seconds\nRoot dispersion : 0.000150000 seconds\n";
    assert.ok(Math.abs((ntpBoundMs(text) as number) - 0.362345) < 1e-9);
    assert.equal(ntpBoundMs("nothing"), null);
  });

  it("leaves excluded shards out of the numbers, and judges a laid-out run on the peers that ran", () => {
    const results = goodRun().map((s) => ({ ...s, ice: "stun" as const }));
    for (const s of results) s.shard.count = 4;
    results[0].role = "source";
    results[0].peersOfRun = 120;
    results[1].role = "viewers";
    results[1].peersOfRun = 85;
    const aws: ShardResult = { ...shard(2, 4, []), excluded: "symmetric NAT (an AWS-hosted runner): no link to another machine opens without TURN", role: "excluded", peersOfRun: 0, host: { cores: 0, loadAvg1: [], maxEventLoopLagMs: 0 } };
    const coordinator: ShardResult = { ...shard(3, 4, []), role: "coordinator", peersOfRun: 0, clock: undefined, ice: "stun" };
    let report = buildReport([...results, aws, coordinator]);
    assert.deepEqual(report.excluded.map((e) => e.shard), [2]);
    assert.deepEqual(report.hosts.map((h) => [h.shard, h.role]), [[0, "source"], [1, "viewers"], [3, "coordinator"]]);
    const check = (name: string) => report.gate.validity.find((v) => v.name.startsWith(name));
    assert.deepEqual([check("peers of the run that ran")?.value, check("peers of the run that ran")?.pass], [205, true]);
    assert.equal(check("shards that reported")?.value, 4, "an excluded shard reported");
    assert.match(renderReport(report), /Covers cone-NAT peers only/);
    assert.match(renderReport(report), /Excluded before they started a peer: shard 2 \(symmetric NAT/);
    // Too few peers left once the AWS shard is out.
    results[1].peersOfRun = 60;
    report = buildReport([...results, aws, coordinator]);
    assert.equal(report.gate.validity.find((v) => v.name.startsWith("peers of the run that ran"))?.pass, false);
  });

  it("finds the largest size that was a valid measurement (H4)", () => {
    const at = (peers: number, lagMs: number): ShardResult[] =>
      goodRun().map((s) => ({ ...s, peers, expect: { peers, minRepairs: 10 }, host: { ...s.host, pageLag: lagOf(lagMs) } }));
    const sizes = largestValid([buildReport(at(60, 90)), buildReport(at(30, 8)), buildReport(at(45, 20))]);
    assert.equal(sizes.peers, 45);
    assert.deepEqual(
      sizes.runs.map((r) => [r.peers, r.valid, r.lagP99Ms]),
      [[30, true, 10], [45, true, 20], [60, false, 90]],
    );
    assert.deepEqual(sizes.runs[2].why, ["timer lag p99 on the worst runner (ms)"]);
    assert.match(renderSizes(sizes), /Largest valid run: 45 peers/);
    assert.equal(largestValid([buildReport(at(60, 90))]).peers, null);
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
    assert.ok(joins.every((step) => step.shard === shardOf(step.index as number, { shard: { index: 0, count } })));
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
