/**
 * The report: any number of shards' results put together into one set of numbers, judged against
 * the gate (SPEC §12.3). Everything here is a sum, so shards can be merged in any order, and a
 * quantile read from the summed 97-bucket histograms is exact to the bucket: it can overstate a
 * time by the bucket's width (10 ms below 500 ms) and never understates one.
 *
 * Owner: E-harness.
 */
import { LATENCY_BUCKETS, emptyHistogram, histogramQuantile, latencyBucket, mergeHistogram, type MetricsSample } from "../protocol";
import { GATE, type GateCheck, type ImpairmentCounters, type LinkCounts, type Quantiles, type ReportOptions, type ShardResult, type SwarmReport } from "./types";

/** The gate's limits on the run itself (SPEC §12.3). */
export const VALIDITY = { minRepairs: 100, lagP99Ms: 50, clockSumP95Ms: 20 } as const;

/**
 * D29: light viewers must agree with decoding ones to within the decode time. PLAN M5 puts that
 * at 15 ms between their p50s; a 10 ms bucket either way is within it.
 */
export const HONESTY = { lightVsDecodingP50Ms: 15 } as const;

/** Quantiles of a histogram on the 97 latency buckets, as bucket upper edges. */
export function histogramQuantiles(counts: readonly number[]): Quantiles {
  const n = counts.reduce((a, b) => a + b, 0);
  return { n, p50: histogramQuantile(counts, 0.5), p95: histogramQuantile(counts, 0.95), p99: histogramQuantile(counts, 0.99), max: histogramQuantile(counts, 1) };
}

/** Quantiles of a list of values, exactly (nearest rank). For what is too fine for 10 ms buckets. */
export function exactQuantiles(values: readonly number[]): Quantiles {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const at = (q: number): number | null => (sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null);
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

const emptyLinks = (): LinkCounts => ({ opened: 0, failed: 0, turn: 0, candidates: {}, crossShard: 0, crossShardTurn: 0, crossShardFailed: 0 });

export function addLinks(into: LinkCounts, from: LinkCounts | undefined): LinkCounts {
  if (!from) return into;
  into.opened += from.opened;
  into.failed += from.failed;
  into.turn += from.turn;
  into.crossShard += from.crossShard;
  into.crossShardTurn += from.crossShardTurn;
  into.crossShardFailed = (into.crossShardFailed ?? 0) + (from.crossShardFailed ?? 0);
  for (const [kind, count] of Object.entries(from.candidates)) into.candidates[kind] = (into.candidates[kind] ?? 0) + count;
  return into;
}

const below = (name: string, value: number | null, limit: number): GateCheck => ({ name, limit, value, pass: value !== null && value <= limit });
const atLeast = (name: string, value: number | null, limit: number): GateCheck => ({ name, limit, value, pass: value !== null && value >= limit });

/** Puts the shards of one run together and judges it against the gate. */
export function buildReport(results: ShardResult[], options: ReportOptions = {}): SwarmReport {
  const shards = [...results].sort((a, b) => a.shard.index - b.shard.index);
  const first = shards[0];
  const notes: string[] = [];
  const expect = { ...first?.expect, ...options };
  const wantPeers = expect.peers ?? GATE.peers;
  const wantRepairs = expect.minRepairs ?? VALIDITY.minRepairs;

  const join = emptyHistogram();
  const repair = emptyHistogram();
  const glass = emptyHistogram();
  const glassDecoding = emptyHistogram();
  const glassLight = emptyHistogram();
  const freeze = emptyHistogram();
  const lag = emptyHistogram();
  const byDepth = new Map<number, number[]>();
  const repairs = { warm: 0, cold: 0, wait: 0, usedCoordinator: 0, framesLost: 0 };
  const freezes = { count: 0, totalMs: 0 };
  const frames = { rendered: 0, dropped: 0, lost: 0 };
  const links = emptyLinks();
  const impairment: ImpairmentCounters = { sent: 0, delivered: 0, lost: 0, queueDropped: 0, lateMsSum: 0, lateMsMax: 0 };
  let impaired = false;
  const hosts: SwarmReport["hosts"] = [];
  const failed: SwarmReport["failed"] = [];
  const stubbed = new Set<string>();
  const engines = new Set<string>();
  const viewerClocks: number[] = [];
  let sourceClock: number | null = null;
  let clockMissing = false;
  let peersStarted = 0;
  let worstLagP99: number | null = null;
  let lagMissing = false;

  const seen = new Set<string>();
  const shardNotes = new Map<string, number[]>();
  const decoders = new Set<string>();
  let decodersKnown = false;
  for (const shard of shards) {
    if (shard.decoders) decodersKnown = true;
    for (const peer of shard.decoders ?? []) decoders.add(peer);
  }
  const clockByShard: SwarmReport["clockByShard"] = [];
  const sample = (s: MetricsSample): void => {
    const key = `${s.peer}/${s.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (s.video && s.role !== "source") {
      frames.rendered += s.video.rendered;
      frames.dropped += s.video.dropped;
      frames.lost += s.video.lost;
      mergeHistogram(glass, s.video.glassToGlass);
      if (decodersKnown) mergeHistogram(decoders.has(s.peer) ? glassDecoding : glassLight, s.video.glassToGlass);
      let depth = byDepth.get(s.depth);
      if (!depth) byDepth.set(s.depth, (depth = emptyHistogram()));
      mergeHistogram(depth, s.video.glassToGlass);
    }
    for (const event of s.events) {
      if (event.t === "join") join[latencyBucket(event.firstFrame - event.start)]++;
      else if (event.t === "repair") {
        repair[latencyBucket(event.freezeMs)]++;
        repairs[event.kind]++;
        if (event.usedCoordinator) repairs.usedCoordinator++;
        repairs.framesLost += event.framesLost;
      } else if (event.t === "freeze") {
        freeze[latencyBucket(event.ms)]++;
        freezes.count++;
        freezes.totalMs += event.ms;
      }
    }
  };

  const indexes = new Set<number>();
  for (const shard of shards) {
    if (indexes.has(shard.shard.index)) notes.push(`shard ${shard.shard.index} appears twice: the second copy was still counted`);
    indexes.add(shard.shard.index);
    if (first && shard.runId !== first.runId) notes.push(`shard ${shard.shard.index} is of run "${shard.runId}", not "${first.runId}"`);
    for (const s of shard.samples) sample(s);
    peersStarted += shard.peersStarted;
    for (const f of shard.peersFailed) failed.push({ shard: shard.shard.index, index: f.index, why: f.why });
    for (const name of shard.stubbed ?? []) stubbed.add(name);
    if (shard.engine) engines.add(shard.engine);
    addLinks(links, shard.links);
    if (shard.impairment) {
      impaired = true;
      impairment.sent += shard.impairment.sent;
      impairment.delivered += shard.impairment.delivered;
      impairment.lost += shard.impairment.lost;
      impairment.queueDropped += shard.impairment.queueDropped;
      impairment.lateMsSum += shard.impairment.lateMsSum;
      impairment.lateMsMax = Math.max(impairment.lateMsMax, shard.impairment.lateMsMax);
    }
    if (shard.clock) {
      if (shard.clock.source !== null) sourceClock = sourceClock === null ? shard.clock.source : Math.max(sourceClock, shard.clock.source);
      viewerClocks.push(...shard.clock.viewers);
    } else clockMissing = true;
    // The driver and the pages are judged apart: a thousand calm ticks of one must not hide the other's bad ones.
    let p99: number | null = null;
    for (const part of [shard.host.driverLag, shard.host.pageLag]) {
      if (!part || part.length !== LATENCY_BUCKETS) continue;
      mergeHistogram(lag, part);
      const own = histogramQuantile(part, 0.99);
      if (own !== null) p99 = p99 === null ? own : Math.max(p99, own);
    }
    if (p99 === null) lagMissing = true;
    else worstLagP99 = worstLagP99 === null ? p99 : Math.max(worstLagP99, p99);
    const joins = shard.samples.reduce((n, s) => n + s.events.filter((e) => e.t === "join").length, 0);
    hosts.push({ shard: shard.shard.index, cores: shard.host.cores, loadAvg1Max: Math.max(0, ...shard.host.loadAvg1), lagP99Ms: p99, peersStarted: shard.peersStarted, peersFailed: shard.peersFailed.length, joins });
    for (const note of new Set(shard.notes ?? [])) shardNotes.set(note, [...(shardNotes.get(note) ?? []), shard.shard.index]);
  }
  failed.sort((a, b) => a.shard - b.shard || a.index - b.index);
  // A note every shard made (what was merged, how links are counted) is said once.
  for (const [note, from] of shardNotes) {
    if (from.length === shards.length && shards.length > 1) notes.push(`every shard: ${note}`);
    else for (const index of from) notes.push(`shard ${index}: ${note}`);
  }
  notes.sort();

  const shardCount = first?.shard.count ?? 0;
  const peers = first?.peers ?? peersStarted;
  const clockSums = sourceClock === null ? [] : viewerClocks.map((viewer) => viewer + (sourceClock as number));
  const clockUncertaintyMs = exactQuantiles(clockSums);
  // The source's session clock against its wall clock: what every viewer's is compared with.
  const sourceVsWall = shards.find((shard) => typeof shard.clock?.sourceVsWallMs === "number")?.clock?.sourceVsWallMs ?? null;
  const sourceNtp = shards.find((shard) => shard.clock?.source !== null && shard.clock?.source !== undefined)?.host.ntp?.boundMs ?? null;
  for (const shard of shards) {
    const sums = sourceClock === null || !shard.clock ? [] : shard.clock.viewers.map((viewer) => viewer + (sourceClock as number));
    const q = exactQuantiles(sums);
    const apart = sourceVsWall === null ? [] : (shard.clock?.viewersVsWallMs ?? []).map((v) => Math.abs(v - sourceVsWall));
    const own = shard.host.ntp?.boundMs ?? null;
    clockByShard.push({
      shard: shard.shard.index,
      viewers: q.n,
      p95: q.p95,
      max: q.max,
      measuredP95: apart.length ? exactQuantiles(apart).p95 : null,
      ntpBoundMs: own === null || sourceNtp === null ? null : own + sourceNtp,
    });
  }
  const worstShardClock = clockByShard.filter((c) => c.p95 !== null && c.p95 > VALIDITY.clockSumP95Ms);
  for (const c of worstShardClock) notes.push(`shard ${c.shard}: clock uncertainty p95 ${Math.round((c.p95 as number) * 10) / 10} ms is over ${VALIDITY.clockSumP95Ms} ms: its viewers' latencies cannot be trusted`);

  const joinMs = histogramQuantiles(join);
  const repairMs = histogramQuantiles(repair);
  const glassToGlassMs = histogramQuantiles(glass);
  const checks: GateCheck[] = [
    // A scenario that expects no repair is not failed for having none to time.
    repairMs.n === 0 && wantRepairs === 0 ? { name: "repair time p95 (ms)", limit: GATE.repairP95Ms, value: null, pass: true } : below("repair time p95 (ms)", repairMs.p95, GATE.repairP95Ms),
    below("glass-to-glass latency p95 (ms)", glassToGlassMs.p95, GATE.glassToGlassP95Ms),
    below("join time p95 (ms)", joinMs.p95, GATE.joinP95Ms),
  ];
  const validity: GateCheck[] = [
    atLeast("peers, at least", results.length ? peers : null, wantPeers),
    atLeast("shards that reported, of the run's", results.length ? indexes.size : null, shardCount || 1),
    atLeast("repair events, at least", repairMs.n, wantRepairs),
    below("peers that failed to start", failed.length, 0),
    below("event-loop lag p99 on the worst shard (ms)", lagMissing ? null : worstLagP99, VALIDITY.lagP99Ms),
    below("clock uncertainty, viewer plus source, p95 (ms)", clockMissing ? null : clockUncertaintyMs.p95, VALIDITY.clockSumP95Ms),
  ];
  const decodingQ = histogramQuantiles(glassDecoding);
  const lightQ = histogramQuantiles(glassLight);
  const honesty: GateCheck[] = [];
  if (decodingQ.n > 0 && lightQ.n > 0) {
    const gap = Math.abs((decodingQ.p50 as number) - (lightQ.p50 as number));
    honesty.push(below("light viewers' latency p50 against decoding viewers' (ms apart)", gap, HONESTY.lightVsDecodingP50Ms));
    if (gap > HONESTY.lightVsDecodingP50Ms) notes.push(`light and decoding viewers disagree by ${gap} ms at p50 (D29 allows ${HONESTY.lightVsDecodingP50Ms}): the light viewers' numbers are suspect`);
  } else if (decodersKnown) notes.push(decodingQ.n === 0 ? "no viewer decoded for real: the light viewers are unchecked (D29)" : "every viewer decoded: no light viewer to check");
  if (lagMissing) notes.push("a shard did not report its event-loop lag: starvation cannot be ruled out");
  if (clockMissing || sourceClock === null) notes.push("clock uncertainty was not reported by every shard, or not by the source's: latency cannot be trusted");
  if (stubbed.size) notes.push(`STUBBED: ${[...stubbed].sort().join(", ")}. These numbers are the harness's stand-in, not the overlay engine.`);
  const valid = validity.every((check) => check.pass);
  const pass = valid && checks.every((check) => check.pass);
  const isGate = peers >= GATE.peers && wantPeers >= GATE.peers && wantRepairs >= VALIDITY.minRepairs && stubbed.size === 0 && !engines.has("standin");
  if (!isGate) notes.push("not the gate run: the gate is 200 peers with every module real (SPEC §12.3)");

  return {
    runId: first?.runId ?? "",
    peers,
    shards: shardCount,
    durationS: Math.max(0, ...shards.map((shard) => shard.durationS ?? (shard.endedAt - shard.startedAt) / 1000)),
    joinMs,
    repairMs,
    glassToGlassMs,
    glassToGlassDecoding: decodingQ,
    glassToGlassLight: lightQ,
    honesty,
    clockByShard,
    glassToGlassByDepth: Object.fromEntries([...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([depth, counts]) => [depth, histogramQuantiles(counts)])),
    repairs,
    freezes,
    gate: { pass, valid, checks, notes, validity, verdict: !valid ? "invalid" : pass ? "pass" : "fail", isGate },
    freezeMs: histogramQuantiles(freeze),
    frames,
    clockUncertaintyMs,
    eventLoopLagMs: histogramQuantiles(lag),
    hosts,
    engine: engines.size === 0 ? "unknown" : engines.size > 1 ? "mixed" : ([...engines][0] as "real" | "standin"),
    stubbed: [...stubbed].sort(),
    links,
    impairment: impaired ? { ...impairment, lateMsMean: impairment.delivered ? impairment.lateMsSum / impairment.delivered : 0 } : null,
    scenario: first?.scenario ?? null,
    failed,
  };
}

/* ------------------------------ as text ------------------------------ */

const ms = (value: number | null): string => (value === null ? "–" : value === Infinity ? "> 10,000" : `${Math.round(value * 10) / 10}`);
const row = (name: string, q: Quantiles, proof = ""): string => `| ${name} | ${q.n} | ${ms(q.p50)} | ${ms(q.p95)} | ${ms(q.p99)} | ${ms(q.max)} | ${proof} |`;
const tick = (pass: boolean): string => (pass ? "ok" : "**NO**");

/** The report as Markdown: for a job summary, an artifact, or a terminal. */
export function renderReport(report: SwarmReport): string {
  const lines: string[] = [];
  const gate = report.gate;
  lines.push(`# Overlay swarm report: ${report.scenario ?? "run"} (${report.runId})`, "");
  if (report.stubbed.length || report.engine !== "real") {
    lines.push(
      `> **Stand-in, not the engine.** Engine in the pages: \`${report.engine}\`. Stubbed: ${report.stubbed.length ? report.stubbed.map((name) => `\`${name}\``).join(", ") : "none"}.`,
      "> The numbers below measure the harness's stand-in peer and coordinator. They show that the harness works; they say nothing yet about the overlay.",
      "",
    );
  }
  const verdict = gate.verdict === "invalid" ? "INVALID (neither a pass nor a fail)" : gate.verdict === "pass" ? "PASS" : "FAIL";
  lines.push(`**Verdict: ${verdict}**${gate.isGate ? "" : " — not the gate run"}`, "");
  lines.push(`${report.peers} peers, ${report.shards} shard${report.shards === 1 ? "" : "s"}, ${Math.round(report.durationS)} s.`, "");
  lines.push("| Measure (ms) | n | p50 | p95 | p99 | max | Proof (7 peers, clean) |", "| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  lines.push(row("Join time", report.joinMs, "18–45"));
  lines.push(row("Repair time", report.repairMs, "206–209 warm, 225–227 cold"));
  lines.push(row("Glass-to-glass latency", report.glassToGlassMs, ""));
  lines.push(row("Freezes (over 200 ms)", report.freezeMs, ""));
  for (const [depth, q] of Object.entries(report.glassToGlassByDepth)) if (q.n > 0) lines.push(row(`Latency at depth ${depth === "255" ? "unknown" : depth}`, q, ""));
  if (report.glassToGlassDecoding.n) lines.push(row("Latency, decoding viewers (D29)", report.glassToGlassDecoding, ""));
  if (report.glassToGlassLight.n) lines.push(row("Latency, light viewers (D29)", report.glassToGlassLight, ""));
  lines.push("", "Histogram quantiles are bucket upper edges: up to 10 ms over below 500 ms, never under.", "");
  lines.push("| Gate check | Limit | Measured | |", "| --- | ---: | ---: | --- |");
  for (const check of gate.checks) lines.push(`| ${check.name} | ${check.limit} | ${ms(check.value)} | ${tick(check.pass)} |`);
  lines.push("", "| Is the run a measurement? | Limit | Measured | |", "| --- | ---: | ---: | --- |");
  for (const check of gate.validity) lines.push(`| ${check.name} | ${check.limit} | ${ms(check.value)} | ${tick(check.pass)} |`);
  if (report.honesty.length) {
    lines.push("", "| Can the instrument be believed? | Limit | Measured | |", "| --- | ---: | ---: | --- |");
    for (const check of report.honesty) lines.push(`| ${check.name} | ${check.limit} | ${ms(check.value)} | ${tick(check.pass)} |`);
  }
  lines.push("");
  const r = report.repairs;
  lines.push(`Repairs: ${r.warm} warm, ${r.cold} cold, ${r.wait} wait; ${r.usedCoordinator} used the coordinator; ${r.framesLost} frames lost across them.`);
  lines.push(`Frames: ${report.frames.rendered} rendered, ${report.frames.dropped} dropped, ${report.frames.lost} lost. Freezes: ${report.freezes.count}, ${Math.round(report.freezes.totalMs)} ms in all.`);
  const l = report.links;
  const turnShare = l.opened ? Math.round((1000 * l.turn) / l.opened) / 10 : 0;
  const cross = l.crossShard || l.crossShardFailed ? ` Between shards: ${l.crossShard} opened, of which ${l.crossShardTurn} through TURN; ${l.crossShardFailed ?? 0} never opened.` : "";
  lines.push(`Links: ${l.opened} opened, ${l.failed} failed, ${l.turn} through TURN (${turnShare}%).${cross} Candidates: ${JSON.stringify(l.candidates)}.`);
  if (report.impairment) {
    const i = report.impairment;
    const lossPct = i.sent ? Math.round((10000 * i.lost) / i.sent) / 100 : 0;
    lines.push(`Impairment shim: ${i.sent} packets, ${lossPct}% dropped as loss, ${i.queueDropped} dropped at a full queue; delivered ${ms(i.lateMsMean)} ms late on average, ${ms(i.lateMsMax)} ms at worst.`);
  }
  lines.push(`Clock uncertainty (viewer + source): p50 ${ms(report.clockUncertaintyMs.p50)}, p95 ${ms(report.clockUncertaintyMs.p95)}, max ${ms(report.clockUncertaintyMs.max)} ms over ${report.clockUncertaintyMs.n} viewers.`);
  lines.push(
    "",
    "| Shard | Cores | Load (1 min, max) | Event-loop lag p99 (ms) | Clock, viewer + source, p95 (ms) | Clocks apart, measured p95 (ms) | ± wall clocks (ms) | Peers started | Failed | First frames |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const host of report.hosts) {
    const clock = report.clockByShard.find((c) => c.shard === host.shard);
    lines.push(
      `| ${host.shard} | ${host.cores} | ${Math.round(host.loadAvg1Max * 100) / 100} | ${ms(host.lagP99Ms)} | ${ms(clock?.p95 ?? null)} | ${ms(clock?.measuredP95 ?? null)} | ${ms(clock?.ntpBoundMs ?? null)} | ${host.peersStarted ?? "–"} | ${host.peersFailed ?? "–"} | ${host.joins ?? "–"} |`,
    );
  }
  lines.push("", "\"Clock\" is SPEC §4.1's bound, half the best probe's round trip: the validity check. \"Clocks apart\" reads each viewer's session clock and the source's against their machines' wall clocks; it is the real disagreement give or take the last column.");
  if (report.failed.length) {
    lines.push("", "Peers that failed:");
    for (const f of report.failed.slice(0, 20)) lines.push(`- shard ${f.shard}, peer ${f.index}: ${f.why}`);
  }
  if (gate.notes.length) {
    lines.push("", "Notes:");
    for (const note of gate.notes) lines.push(`- ${note}`);
  }
  return lines.join("\n") + "\n";
}

/** JSON has no Infinity: a quantile in the open last bucket is written as this many milliseconds. */
export const OPEN_BUCKET_MS = 1e9;
export const reportJson = (report: SwarmReport): string => JSON.stringify(report, (_key, value: unknown) => (value === Infinity ? OPEN_BUCKET_MS : value), 1);

/* ------------------------------ H4: how many fit ------------------------------ */

export type SizeRun = { peers: number; verdict: SwarmReport["gate"]["verdict"]; valid: boolean; lagP99Ms: number | null; why: string[] };

/**
 * PLAN H4: of runs of one scenario at several sizes on one machine, the largest that was a valid
 * measurement. A run is judged by its own validity checks, so "valid" means the machine kept up
 * (event-loop lag), the clocks were good enough and no peer failed, not that the overlay passed.
 */
export function largestValid(reports: SwarmReport[]): { peers: number | null; runs: SizeRun[] } {
  const runs: SizeRun[] = reports
    .map((report) => {
      const lags = report.hosts.map((host) => host.lagP99Ms);
      return {
        peers: report.peers,
        verdict: report.gate.verdict,
        valid: report.gate.valid,
        lagP99Ms: lags.length && lags.every((lag) => lag !== null) ? Math.max(...(lags as number[])) : null,
        why: report.gate.validity.filter((check) => !check.pass).map((check) => check.name),
      };
    })
    .sort((a, b) => a.peers - b.peers);
  const valid = runs.filter((run) => run.valid);
  return { peers: valid.length ? valid[valid.length - 1].peers : null, runs };
}

export function renderSizes(result: ReturnType<typeof largestValid>): string {
  const lines = [
    "# How many peers fit on one machine (PLAN H4)",
    "",
    result.peers === null ? "**No size was a valid measurement.**" : `**Largest valid run: ${result.peers} peers.**`,
    "",
    "| Peers | Verdict | Event-loop lag p99, worst shard (ms) | Not valid because |",
    "| ---: | --- | ---: | --- |",
  ];
  for (const run of result.runs) lines.push(`| ${run.peers} | ${run.verdict} | ${ms(run.lagP99Ms)} | ${run.why.join("; ") || "–"} |`);
  return lines.join("\n") + "\n";
}
