/**
 * What the slow-child scenario (PLAN C3) measures, beside the ordinary report: when the capped
 * child's layers went and came back, and whether its siblings and their subtrees noticed. The
 * numbers are set beside E-congestion's own browser run (congestion/browser/run.ts), which this
 * scenario replaces as C3's acceptance.
 *
 * Owner: E-harness.
 */
import { emptyHistogram, histogramQuantile, mergeHistogram, type MetricsSample, type PeerId } from "../protocol";
import { SLOW_CHILD } from "./scenarios";
import type { ShardResult } from "./types";

export type SlowChildReport = {
  slow: PeerId | null;
  /** The slow child's own subtree, which its cap reaches too (the cap is its access link). */
  under: PeerId[];
  siblings: PeerId[];
  /** Milliseconds after the cap: the first `layer` event lowering it, and the last before the lift. */
  firstDropMs: number | null;
  settledMs: number | null;
  /** Milliseconds after the lift: the middle layer back, and the top. */
  layer1BackAfterLiftMs: number | null;
  layer2BackAfterLiftMs: number | null;
  layerEvents: number;
  siblingsFramesLost: number;
  /** Siblings' and their subtrees' latency p95, before the cap and while it held. */
  siblingsLatencyP95: { before: number | null; during: number | null };
  slowChildAudioConcealedMs: number | null;
  notes: string[];
};

const p95 = (samples: MetricsSample[]): number | null => {
  const sum = emptyHistogram();
  for (const s of samples) if (s.video) mergeHistogram(sum, s.video.glassToGlass);
  return histogramQuantile(sum, 0.95);
};

export function slowChildReport(result: ShardResult): SlowChildReport {
  const notes: string[] = [];
  const impairs = (result.churnLog ?? []).filter((entry) => entry.action === "impair" && entry.peer);
  const cap = impairs[0];
  const lift = impairs[1];
  const slow = cap?.peer ?? null;
  const tree = result.tree ?? [];
  const parentOf = new Map(tree.map((node) => [node.peer, node.parent]));
  const under = tree.filter((node) => {
    for (let at = node.parent, hops = 0; at && hops < 32; at = parentOf.get(at) ?? null, hops++) if (at === slow) return true;
    return false;
  }).map((node) => node.peer);
  const source = result.samples.find((s) => s.role === "source")?.peer ?? null;
  const siblings = tree.map((node) => node.peer).filter((peer) => peer !== slow && peer !== source && !under.includes(peer));
  const report: SlowChildReport = {
    slow,
    under,
    siblings,
    firstDropMs: null,
    settledMs: null,
    layer1BackAfterLiftMs: null,
    layer2BackAfterLiftMs: null,
    layerEvents: 0,
    siblingsFramesLost: 0,
    siblingsLatencyP95: { before: null, during: null },
    slowChildAudioConcealedMs: null,
    notes,
  };
  if (!slow || cap.sessionMs === undefined) {
    notes.push("the cap fell on nobody, or its time on the session clock is not known");
    return report;
  }
  const capAt = cap.sessionMs;
  const liftAt = lift?.sessionMs ?? Infinity;

  const layers = result.samples
    .flatMap((s) => s.events)
    .filter((e) => e.t === "layer" && e.peer === slow)
    .sort((a, b) => (a as { at: number }).at - (b as { at: number }).at) as { at: number; maxTemporal: number }[];
  report.layerEvents = layers.length;
  const capped = layers.filter((e) => e.at >= capAt && e.at < liftAt);
  let level = 2;
  for (const e of capped) {
    if (e.maxTemporal < level && report.firstDropMs === null) report.firstDropMs = e.at - capAt;
    level = e.maxTemporal;
  }
  if (capped.length) report.settledMs = capped[capped.length - 1].at - capAt;
  for (const e of layers.filter((x) => x.at >= liftAt)) {
    if (e.maxTemporal >= 1 && report.layer1BackAfterLiftMs === null) report.layer1BackAfterLiftMs = e.at - liftAt;
    if (e.maxTemporal >= 2 && report.layer2BackAfterLiftMs === null) report.layer2BackAfterLiftMs = e.at - liftAt;
  }
  if (layers.length === 0) notes.push("no `layer` event for the slow child: the engine in the pages drops no layers, so C3's timings are not measured");

  const mine = (peers: PeerId[]) => result.samples.filter((s) => peers.includes(s.peer));
  const sib = mine(siblings);
  const during = sib.filter((s) => s.at > capAt && s.at - s.intervalMs < liftAt);
  report.siblingsFramesLost = during.reduce((n, s) => n + (s.video?.lost ?? 0), 0);
  report.siblingsLatencyP95 = { before: p95(sib.filter((s) => s.at <= capAt)), during: p95(during) };
  const slowDuring = mine([slow]).filter((s) => s.at > capAt);
  const audio = slowDuring.filter((s) => s.audio);
  report.slowChildAudioConcealedMs = audio.length ? audio.reduce((n, s) => n + (s.audio?.concealedMs ?? 0), 0) : null;
  if (!audio.length) notes.push("no audio in the slow child's samples: the engine in the pages sends none, so \"no audio lost\" is not measured");
  return report;
}

const ms = (value: number | null): string => (value === null ? "not measured" : `${Math.round(value)} ms`);

export function renderSlowChild(report: SlowChildReport): string {
  const b = SLOW_CHILD.baseline;
  const shift = report.siblingsLatencyP95.before === null || report.siblingsLatencyP95.during === null ? null : report.siblingsLatencyP95.during - report.siblingsLatencyP95.before;
  const lines = [
    "## slow-child (PLAN C3), against E-congestion's own run",
    "",
    `Capped: ${report.slow ?? "nobody"}; its subtree: ${report.under.join(", ") || "none"}; siblings and theirs: ${report.siblings.length}.`,
    "",
    "| Measure | Here | E-congestion |",
    "| --- | ---: | ---: |",
    `| First layer dropped, after the cap | ${ms(report.firstDropMs)} | ~${b.firstDropMs} ms |`,
    `| Cap settled | ${ms(report.settledMs)} | ~${b.settledMs} ms |`,
    `| Siblings' frames lost while capped | ${report.siblingsFramesLost} | ${b.siblingsFramesLost} |`,
    `| Siblings' latency p95, change (bucket edges) | ${shift === null ? "not measured" : `${shift} ms (${report.siblingsLatencyP95.before} → ${report.siblingsLatencyP95.during})`} | under ${b.siblingsLatencyP95ShiftMs} ms |`,
    `| Slow child's audio concealed | ${ms(report.slowChildAudioConcealedMs)} | ${b.slowChildAudioConcealedMs} ms |`,
    `| Middle layer back, after the lift to 3 Mbps | ${ms(report.layer1BackAfterLiftMs)} | ~${b.layer1BackAfterLiftMs / 1000} s |`,
    `| Top layer back | ${ms(report.layer2BackAfterLiftMs)} | ~${b.layer2BackAfterLiftMs / 1000} s |`,
  ];
  if (report.notes.length) lines.push("", ...report.notes.map((note) => `- ${note}`));
  return lines.join("\n") + "\n";
}
