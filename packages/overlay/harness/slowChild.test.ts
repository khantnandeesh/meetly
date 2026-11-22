/**
 * slow-child's own measures (PLAN C3) from a hand-made shard: when the capped child's layers went
 * and came back, and what its siblings saw.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeMetricsSample, emptyHistogram, latencyBucket, type MetricsEvent, type MetricsSample } from "@meetly/overlay";
import { pickPeer } from "@meetly/overlay/harness/shard";
import { renderSlowChild, slowChildReport } from "@meetly/overlay/harness/slowChild";
import { scenario } from "@meetly/overlay/harness/scenarios";
import type { ShardResult } from "@meetly/overlay/harness/types";

const hist = (values: number[]) => {
  const counts = emptyHistogram();
  for (const v of values) counts[latencyBucket(v)]++;
  return counts;
};
const sample = (peer: string, at: number, latencies: number[], lost = 0, events: MetricsEvent[] = [], concealedMs?: number): MetricsSample =>
  decodeMetricsSample(
    JSON.stringify({
      peer,
      seq: at,
      at,
      intervalMs: 2000,
      role: peer === "src" ? "source" : "leaf",
      depth: 1,
      playoutDelayMs: 60,
      video: { rendered: latencies.length, dropped: 0, lost, glassToGlass: hist(latencies), frameGap: emptyHistogram(), maxTemporal: 2 },
      ...(concealedMs === undefined ? {} : { audio: { playedMs: 2000, concealedMs, underruns: 0, glassToGlass: emptyHistogram(), avOffsetMs: 0 } }),
      events,
    }),
  );
const layer = (at: number, maxTemporal: number): MetricsEvent => ({ t: "layer", stream: 0, peer: "slow", at, maxTemporal, reason: maxTemporal < 2 ? "congestion" : "restore" });

function run(): ShardResult {
  const samples = [
    sample("src", 2000, []),
    sample("a", 8000, [100, 100]),
    sample("a", 12000, [100, 110], 0),
    sample("a1", 12000, [120]),
    sample("s1", 12000, [400], 30),
    sample("slow", 12000, [300], 20, [layer(10_700, 1), layer(11_230, 0)], 0),
    sample("slow", 34000, [100], 0, [layer(31_000, 1), layer(36_000, 2)], 0),
  ];
  return {
    runId: "r",
    shard: { index: 0, count: 1 },
    startedAt: 0,
    endedAt: 1,
    peersStarted: 5,
    peersFailed: [],
    samples,
    host: { cores: 4, loadAvg1: [], maxEventLoopLagMs: 0 },
    scenario: "slow-child",
    churnLog: [
      { atS: 20, action: "impair", targets: [], peer: "slow", sessionMs: 10_000 },
      { atS: 35, action: "impair", targets: [], peer: "slow", sessionMs: 25_000 },
    ],
    tree: [
      { peer: "src", parent: null, index: 0 },
      { peer: "a", parent: "src", index: 1 },
      { peer: "slow", parent: "src", index: 2 },
      { peer: "a1", parent: "a", index: 3 },
      { peer: "s1", parent: "slow", index: 4 },
    ],
  };
}

describe("harness slow-child", () => {
  it("times the layers against the cap and the lift, and leaves the slow child's subtree out of the siblings", () => {
    const report = slowChildReport(run());
    assert.deepEqual([report.slow, report.under, report.siblings], ["slow", ["s1"], ["a", "a1"]]);
    assert.deepEqual([report.firstDropMs, report.settledMs, report.settledLayer, report.layer1BackAfterLiftMs, report.layer2BackAfterLiftMs], [700, 1230, 0, 6000, 11000]);
    assert.equal(report.siblingsFramesLost, 0, "s1 lost frames, but it is under the slow child");
    assert.deepEqual(report.siblingsLatencyP95, { before: 100, during: 120 });
    assert.equal(report.slowChildAudioConcealedMs, 0);
    assert.match(renderSlowChild(report), /\| First layer dropped, after the cap \| 700 ms \| ~700 ms \|/);
  });

  it("says what it could not measure, rather than reporting zeros", () => {
    const result = run();
    result.samples = result.samples.map((s) => ({ ...s, events: [], audio: undefined }));
    const report = slowChildReport(result);
    assert.equal(report.firstDropMs, null);
    assert.equal(report.slowChildAudioConcealedMs, null);
    assert.equal(report.notes.length, 2);
  });

  it("is E-congestion's tree, capped and then lifted on the same peer", () => {
    const config = scenario("slow-child");
    assert.equal(config.peers, 8);
    // The tree is the fan-outs; the short probation (probationMs) only lets it fill under the real coordinator.
    assert.deepEqual({ sourceFanout: config.params?.sourceFanout, maxFanout: config.params?.maxFanout }, { sourceFanout: 3, maxFanout: 2 });
    assert.deepEqual(
      config.churn.map((e) => (e.action === "impair" ? [e.pick, e.profile] : null)),
      [["shallowest-relay", "cap-900"], ["impaired", "cap-3000"]],
    );
    // The source's link to the child is capped, not the child's own uplink; and the stream is padded to 1,200 kbps.
    assert.deepEqual(config.churn.map((e) => (e.action === "impair" ? e.link : null)), ["from-parent", "from-parent"]);
    assert.deepEqual([config.program?.source, config.program?.bitrateKbps, config.program?.pad], ["camera", 1200, true]);
    const peers = [
      { index: 1, children: 2, depth: 1, impaired: false },
      { index: 2, children: 1, depth: 1, impaired: true },
    ];
    assert.equal(pickPeer(peers, "impaired", 5)?.index, 2);
  });
});
