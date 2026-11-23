/**
 * The report: any number of shards' results put together into one set of numbers, judged against
 * the gate (SPEC §12.3). Everything here is a sum, so shards can be merged in any order, and a
 * quantile read from the summed 97-bucket histograms is exact to the bucket: it can overstate a
 * time by the bucket's width (10 ms below 500 ms) and never understates one.
 *
 * Owner: E-harness.
 */
import { LATENCY_BUCKETS, LATENCY_BUCKET_EDGES_MS, emptyHistogram, histogramQuantile, latencyBucket, mergeHistogram, type MetricsSample } from "../protocol";
import { GATE, type GateCheck, type ImpairmentCounters, type LinkCounts, type Quantiles, type ReportOptions, type ShardResult, type SwarmReport } from "./types";

/** The gate's limits on the run itself (SPEC §12.3). */
export const VALIDITY = { minRepairs: 100, lagP99Ms: 20, clockSumP95Ms: 20 } as const;

/**
 * D42: a runner is starved when its timers run more than 20 ms late at p99 (each 20 ms timer
 * against the moment it was set for, read on 10 ms buckets by their upper edge, so "20" passes).
 * Load is reported for every runner and judges nothing; at `loadNoteAt` a note says so.
 */
export const HEALTH = { lagP99Ms: 20, loadNoteAt: 4 } as const;

/**
 * D29: light viewers must agree with decoding ones to within the decode time. PLAN M5 puts that
 * at 15 ms between their p50s; a 10 ms bucket either way is within it.
 */
export const HONESTY = { lightVsDecodingP50Ms: 15 } as const;
/** [D70] Siblings are paired within this slot of the session clock (a sample's length). */
export const PAIR_SLOT_MS = 2000;
/** [D70] Fewer decoding samples with light siblings than this and the check falls back to D58's pooled one. */
export const PAIRED_MIN_SAMPLES = 30;

/** The mean of a latency histogram, each bucket at its middle (the last, open one at its lower edge). */
export function histogramMean(counts: readonly number[]): number | null {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] ?? 0;
    if (c === 0) continue;
    const hi = LATENCY_BUCKET_EDGES_MS[i];
    const lo = i === 0 ? 0 : (LATENCY_BUCKET_EDGES_MS[i - 1] as number);
    n += c;
    sum += c * (hi === undefined ? lo : (lo + hi) / 2);
  }
  return n > 0 ? sum / n : null;
}

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
  const everyShard = [...results].sort((a, b) => a.shard.index - b.shard.index);
  // A shard the layout left out started no peer: it is listed, and otherwise not in the numbers.
  const excluded = everyShard.filter((shard) => shard.excluded).map((shard) => ({ shard: shard.shard.index, why: shard.excluded as string, nat: shard.host.nat?.mapped ?? [] }));
  const shards = everyShard.filter((shard) => !shard.excluded);
  const first = everyShard[0];
  const notes: string[] = [];
  const expect = { ...first?.expect, ...options };
  const wantPeers = expect.peers ?? GATE.peers;
  const wantRepairs = expect.minRepairs ?? VALIDITY.minRepairs;

  const join = emptyHistogram();
  const repair = emptyHistogram();
  const glass = emptyHistogram();
  const catchUpAge = emptyHistogram();
  const glassDecoding = emptyHistogram();
  const glassLight = emptyHistogram();
  // D58: per depth, so the light viewers can be weighed to the decoding viewers' depths.
  const lightByDepth = new Map<number, number[]>();
  const decodingByDepth = new Map<number, number>();
  const freeze = emptyHistogram();
  const lag = emptyHistogram();
  const byDepth = new Map<number, number[]>();
  const repairs = { warm: 0, cold: 0, wait: 0, usedCoordinator: 0, framesLost: 0 };
  const freezes = { count: 0, totalMs: 0 };
  // [D69] Parents that went quiet and came back; the source's own stalls.
  const silenceEvents: { at: number; ms: number; depth: number }[] = [];
  const sourceTickLate: number[] = [];
  const sourcePublishGap: number[] = [];
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
  let unfinished = 0;
  const streamKbps: number[] = [];
  const joinPhases = { welcome: [] as number[], linked: [] as number[], firstPacket: [] as number[], firstFrame: [] as number[] };
  const decoders = new Set<string>();
  let decodersKnown = false;
  for (const shard of shards) {
    if (shard.decoders) decodersKnown = true;
    for (const peer of shard.decoders ?? []) decoders.add(peer);
  }
  // [D70] Each peer's network profile, and every viewer's samples for the paired honesty check.
  const profileOf = new Map<string, string>();
  for (const shard of shards) for (const entry of shard.tree ?? []) if (entry.profile) profileOf.set(entry.peer, entry.profile);
  const siblings = new Map<string, { decoding: number[]; light: number[] }>();
  const clockByShard: SwarmReport["clockByShard"] = [];
  const sample = (s: MetricsSample): void => {
    const key = `${s.peer}/${s.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (s.up && s.depth === 1 && s.role !== "source") streamKbps.push(s.up.rxKbps);
    if (s.role === "source" && s.relay) {
      if (s.relay.tickLateMaxMs !== undefined) sourceTickLate.push(s.relay.tickLateMaxMs);
      if (s.relay.publishGapMaxMs !== undefined) sourcePublishGap.push(s.relay.publishGapMaxMs);
    }
    if (s.video && s.role !== "source") {
      frames.rendered += s.video.rendered;
      frames.dropped += s.video.dropped;
      frames.lost += s.video.lost;
      mergeHistogram(glass, s.video.glassToGlass);
      if (s.video.catchUp) mergeHistogram(catchUpAge, s.video.catchUp.age);
      if (decodersKnown) mergeHistogram(decoders.has(s.peer) ? glassDecoding : glassLight, s.video.glassToGlass);
      if (decodersKnown) {
        const count = s.video.glassToGlass.reduce((sum, n) => sum + n, 0);
        if (decoders.has(s.peer)) decodingByDepth.set(s.depth, (decodingByDepth.get(s.depth) ?? 0) + count);
        else {
          let h = lightByDepth.get(s.depth);
          if (!h) lightByDepth.set(s.depth, (h = emptyHistogram()));
          mergeHistogram(h, s.video.glassToGlass);
        }
      }
      const latency = decodersKnown && s.up ? histogramMean(s.video.glassToGlass) : null;
      if (latency !== null && s.up) {
        const key = `${s.up.parent}|${profileOf.get(s.peer) ?? "?"}|${Math.floor(s.at / PAIR_SLOT_MS)}`;
        let group = siblings.get(key);
        if (!group) siblings.set(key, (group = { decoding: [], light: [] }));
        (decoders.has(s.peer) ? group.decoding : group.light).push(latency);
      }
      let depth = byDepth.get(s.depth);
      if (!depth) byDepth.set(s.depth, (depth = emptyHistogram()));
      mergeHistogram(depth, s.video.glassToGlass);
    }
    for (const event of s.events) {
      if (event.t === "join") {
        join[latencyBucket(event.firstFrame - event.start)]++;
        joinPhases.welcome.push(event.welcome - event.start);
        joinPhases.linked.push(event.linked - event.welcome);
        joinPhases.firstPacket.push(event.firstPacket - event.linked);
        joinPhases.firstFrame.push(event.firstFrame - event.firstPacket);
      }
      else if (event.t === "repair") {
        repair[latencyBucket(event.freezeMs)]++;
        repairs[event.kind]++;
        if (event.usedCoordinator) repairs.usedCoordinator++;
        repairs.framesLost += event.framesLost;
      } else if (event.t === "silence") {
        silenceEvents.push({ at: event.at, ms: event.ms, depth: event.depth });
      } else if (event.t === "freeze") {
        freeze[latencyBucket(event.ms)]++;
        freezes.count++;
        freezes.totalMs += event.ms;
      }
    }
  };

  const indexes = new Set<number>(excluded.map((e) => e.shard));
  for (const shard of shards) {
    if (indexes.has(shard.shard.index)) notes.push(`shard ${shard.shard.index} appears twice: the second copy was still counted`);
    indexes.add(shard.shard.index);
    if (first && shard.runId !== first.runId) notes.push(`shard ${shard.shard.index} is of run "${shard.runId}", not "${first.runId}"`);
    for (const s of shard.samples) sample(s);
    // Still joining at the end: at least this long, so counted as this long.
    for (const waited of shard.unfinishedJoins ?? []) join[latencyBucket(waited)]++;
    unfinished += shard.unfinishedJoins?.length ?? 0;
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
    const settled = shard.host.loadAvg1Settled?.length ? shard.host.loadAvg1Settled : shard.host.loadAvg1;
    hosts.push({ shard: shard.shard.index, role: shard.role, cores: shard.host.cores, loadAvg1Max: Math.max(0, ...shard.host.loadAvg1), loadSettledMax: Math.max(0, ...settled), lagP99Ms: p99, peersStarted: shard.peersStarted, peersFailed: shard.peersFailed.length, joins, nat: !shard.host.nat || shard.host.nat.symmetric === null ? "unknown" : shard.host.nat.symmetric ? "symmetric" : "open" });
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
  const laidOut = shards.some((shard) => shard.peersOfRun !== undefined && shard.role !== undefined && shard.role !== "all") || excluded.length > 0;
  const ran = shards.reduce((n, shard) => n + (shard.peersOfRun ?? 0), 0);
  if (unfinished) notes.push(`${unfinished} viewer${unfinished === 1 ? " was" : "s were"} still joining when the run ended: each join counted as the time it had waited, a lower bound`);
  for (const e of excluded) notes.push(`shard ${e.shard}: excluded before it started a peer: ${e.why}`);
  // Without TURN, the run says nothing about viewers who would need it.
  const turnOffered = shards.length > 0 && shards.every((shard) => shard.ice === "turn");
  const coverage =
    shardCount > 1 && !turnOffered
      ? "Covers cone-NAT peers only: no TURN was offered, so viewers whose links need it (about 15–22% of real audiences) are untested."
      : null;
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
  // The clocks measured around SPEC §4.1's bound: each viewer's session clock and the source's,
  // both read against their machines' chrony-synced wall clocks, plus both wall clocks' own error
  // bounds. Used only when every shard could be read so; otherwise §4.1's bound judges the run.
  // With ranges over the run, a viewer counts at its worst moment against the source's.
  const sourceRange = shards.find((shard) => shard.clock?.sourceVsWallRangeMs)?.clock?.sourceVsWallRangeMs ?? (sourceVsWall === null ? null : ([sourceVsWall, sourceVsWall] as [number, number]));
  const measuredSums: number[] = [];
  let measurable = sourceRange !== null && sourceNtp !== null && shards.length > 0;
  for (const shard of shards) {
    const own = shard.host.ntp?.boundMs ?? null;
    const ranges = shard.clock?.viewersVsWallRangeMs ?? shard.clock?.viewersVsWallMs?.map((v) => [v, v] as [number, number]);
    if (own === null || !ranges || ranges.length < (shard.clock?.viewers.length ?? 0)) measurable = false;
    else if (measurable && sourceRange)
      for (const [lo, hi] of ranges) measuredSums.push(Math.max(Math.abs(hi - sourceRange[0]), Math.abs(lo - sourceRange[1])) + own + (sourceNtp as number));
  }
  const measuredClockMs = measurable ? exactQuantiles(measuredSums) : null;
  const clockCheck =
    measuredClockMs !== null
      ? below("clock disagreement, measured against chrony-synced wall clocks plus their bounds, p95 (ms)", measuredClockMs.p95, VALIDITY.clockSumP95Ms)
      : below("clock uncertainty, viewer plus source, p95 (ms)", clockMissing ? null : clockUncertaintyMs.p95, VALIDITY.clockSumP95Ms);
  if (measuredClockMs !== null && clockUncertaintyMs.p95 !== null)
    notes.push(
      `clocks judged as measured (p95 ${Math.round((measuredClockMs.p95 ?? 0) * 10) / 10} ms), not by SPEC §4.1's bound (p95 ${Math.round(clockUncertaintyMs.p95 * 10) / 10} ms): a harness rule for the architect to ratify`,
    );
  else for (const c of clockByShard.filter((c) => c.p95 !== null && c.p95 > VALIDITY.clockSumP95Ms)) notes.push(`shard ${c.shard}: clock uncertainty p95 ${Math.round((c.p95 as number) * 10) / 10} ms is over ${VALIDITY.clockSumP95Ms} ms: its viewers' latencies cannot be trusted`);
  if (measuredClockMs !== null) for (const c of clockByShard) if (c.measuredP95 !== null && c.measuredP95 !== undefined && c.measuredP95 + (c.ntpBoundMs ?? 0) > VALIDITY.clockSumP95Ms) notes.push(`shard ${c.shard}: its viewers' clocks were measured ${c.measuredP95} ms from the source's at p95: its latencies cannot be trusted`);

  // The health bar, runner by runner.
  // D42: timer lag judges a runner; its load is only reported.
  for (const h of hosts.filter((h) => h.lagP99Ms === null || h.lagP99Ms > HEALTH.lagP99Ms))
    notes.push(`shard ${h.shard}: starved: timer lag p99 ${h.lagP99Ms ?? "unmeasured"} ms against ${HEALTH.lagP99Ms} (D42)`);
  const loaded = hosts.filter((h) => (h.loadSettledMax ?? h.loadAvg1Max) >= HEALTH.loadNoteAt);
  if (loaded.length)
    notes.push(`load ${HEALTH.loadNoteAt} or more once filled, reported and not judged (D42): ${loaded.map((h) => `shard ${h.shard} at ${Math.round((h.loadSettledMax ?? h.loadAvg1Max) * 100) / 100}`).join(", ")}`);

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
    // Laid out (./layout.ts): the run's peers that really ran, on the shards that took part.
    laidOut ? atLeast("peers of the run that ran, at least", ran, wantPeers) : atLeast("peers, at least", results.length ? peers : null, wantPeers),
    atLeast("shards that reported, of the run's", results.length ? indexes.size : null, shardCount || 1),
    atLeast("repair events, at least", repairMs.n, wantRepairs),
    below("peers that failed to start", failed.length, 0),
    below("timer lag p99 on the worst runner (ms)", lagMissing ? null : worstLagP99, VALIDITY.lagP99Ms),
    clockCheck,
  ];
  const decodingQ = histogramQuantiles(glassDecoding);
  const lightQ = histogramQuantiles(glassLight);
  const honesty: GateCheck[] = [];
  if (decodingQ.n > 0 && lightQ.n > 0) {
    // D58: one in twenty viewers decodes, and those few do not sit at the light viewers' depths
    // (in run 45130383283, 21% of decoding samples at depth 2 against 12% of light ones). Latency
    // grows ~40 ms a hop, so the raw p50s differ by the depth mix alone. The light viewers are
    // weighed to the decoding viewers' depths before their p50s are compared.
    const weighed = emptyHistogram();
    for (const [depth, n] of decodingByDepth) {
      const h = lightByDepth.get(depth);
      const total = h ? h.reduce((sum, c) => sum + c, 0) : 0;
      if (!h || total === 0) continue;
      for (let i = 0; i < weighed.length; i++) weighed[i] += Math.round(((h[i] ?? 0) * n * 1000) / total);
    }
    const weighedQ = histogramQuantiles(weighed);
    const lightP50 = weighedQ.n > 0 ? (weighedQ.p50 as number) : (lightQ.p50 as number);
    const pooledGap = Math.abs((decodingQ.p50 as number) - lightP50);
    // [D70] Paired: each decoding viewer's sample against its light siblings' of the same 2 s (the
    // same parent, the same network profile), the p50 of those differences. Sixteen decoders
    // pooled (D58) sit wherever those sixteen peers' own links put them: sixteen light viewers
    // drawn at random and taken for decoders came out more than 15 ms from the rest in 21-40% of
    // draws (gate runs 45202616067, 45211601384); paired, in none (±8-10 ms at 95%).
    const diffs: number[] = [];
    for (const group of siblings.values()) {
      if (group.decoding.length === 0 || group.light.length === 0) continue;
      const light = group.light.reduce((sum, v) => sum + v, 0) / group.light.length;
      for (const decoding of group.decoding) diffs.push(light - decoding);
    }
    const paired = diffs.length >= PAIRED_MIN_SAMPLES ? exactQuantiles(diffs).p50 : null;
    if (paired !== null) {
      const gap = Math.round(Math.abs(paired) * 10) / 10;
      honesty.push(below("light viewers' latency against their decoding siblings' (same parent, network and 2 s; D70), p50 of the differences (ms apart)", gap, HONESTY.lightVsDecodingP50Ms));
      notes.push(`honesty (D70): light minus decoding ${Math.round(paired * 10) / 10} ms at p50 over ${diffs.length} paired samples; pooled at the decoders' depths (D58) the p50s were ${pooledGap} ms apart`);
      if (gap > HONESTY.lightVsDecodingP50Ms) notes.push(`light and decoding siblings disagree by ${gap} ms (D29 allows ${HONESTY.lightVsDecodingP50Ms}): the light viewers' numbers are suspect`);
    } else {
      honesty.push(below("light viewers' latency p50 (at the decoding viewers' depths, D58) against decoding viewers' (ms apart)", pooledGap, HONESTY.lightVsDecodingP50Ms));
      if (pooledGap > HONESTY.lightVsDecodingP50Ms) notes.push(`light and decoding viewers disagree by ${pooledGap} ms at p50 (D29 allows ${HONESTY.lightVsDecodingP50Ms}): the light viewers' numbers are suspect`);
    }
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
    catchUpAgeMs: histogramQuantiles(catchUpAge),
    honesty,
    clockByShard,
    measuredClockMs,
    excluded,
    coverage,
    streamKbps: exactQuantiles(streamKbps),
    joinPhasesMs: {
      welcome: exactQuantiles(joinPhases.welcome),
      linked: exactQuantiles(joinPhases.linked),
      firstPacket: exactQuantiles(joinPhases.firstPacket),
      firstFrame: exactQuantiles(joinPhases.firstFrame),
    },
    glassToGlassByDepth: Object.fromEntries([...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([depth, counts]) => [depth, histogramQuantiles(counts)])),
    repairs,
    freezes,
    silences: silenceSummary(silenceEvents, sourceTickLate, sourcePublishGap),
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
  if (report.coverage) lines.push(`> **${report.coverage}**`, "");
  if (report.excluded.length) lines.push(`Excluded before they started a peer: ${report.excluded.map((e) => `shard ${e.shard} (${e.why})`).join("; ")}.`, "");
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
  if (report.catchUpAgeMs?.n) lines.push(row("Catch-up frames' age (D46: shown while a replay plays forward; not in the latency above)", report.catchUpAgeMs, ""));
  if (report.streamKbps.n) lines.push("", `The stream as viewers at depth 1 received it: p50 ${Math.round(report.streamKbps.p50 ?? 0)} kbps, p95 ${Math.round(report.streamKbps.p95 ?? 0)} kbps, over ${report.streamKbps.n} samples (retransmissions and replays included).`);
  const jp = report.joinPhasesMs;
  if (jp.welcome.n) {
    lines.push("", "Where a join's time goes (exact, over every join):", "", "| Phase (ms) | p50 | p95 | max |", "| --- | ---: | ---: | ---: |");
    const phase = (name: string, q: Quantiles): string => `| ${name} | ${ms(q.p50)} | ${ms(q.p95)} | ${ms(q.max)} |`;
    lines.push(phase("connect() to welcome", jp.welcome), phase("welcome to a parent linked", jp.linked), phase("linked to its first packet", jp.firstPacket), phase("first packet to first frame", jp.firstFrame));
  }
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
  const quiet = report.silences;
  if (quiet && (quiet.count > 0 || quiet.sourceTickLateMaxMs !== null)) {
    lines.push(
      `Silences (D69: a parent quiet 150 ms or more, then back): ${quiet.count}, ms p50 ${quiet.ms.p50 ?? "–"} p95 ${quiet.ms.p95 ?? "–"}; of the source ${quiet.ofSource}, ` +
        `at ${quiet.sourceMoments} moments, ${quiet.sourceMomentsWide} of them at 3 or more children at once. The source's page: tick late at most ${quiet.sourceTickLateMaxMs ?? "–"} ms; ` +
        `longest gap between its published video frames p95 ${quiet.sourcePublishGapMs.p95 ?? "–"}, max ${quiet.sourcePublishGapMs.max ?? "–"} ms.`,
    );
  }
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
    "| Shard | Role | Cores | Load (1 min, max) | Event-loop lag p99 (ms) | Clock, viewer + source, p95 (ms) | Clocks apart, measured p95 (ms) | ± wall clocks (ms) | Peers started | Failed | First frames | NAT | Load once filled, max |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
  );
  for (const host of report.hosts) {
    const clock = report.clockByShard.find((c) => c.shard === host.shard);
    lines.push(
      `| ${host.shard} | ${host.role ?? "–"} | ${host.cores} | ${Math.round(host.loadAvg1Max * 100) / 100} | ${ms(host.lagP99Ms)} | ${ms(clock?.p95 ?? null)} | ${ms(clock?.measuredP95 ?? null)} | ${ms(clock?.ntpBoundMs ?? null)} | ${host.peersStarted ?? "–"} | ${host.peersFailed ?? "–"} | ${host.joins ?? "–"} | ${host.nat ?? "unknown"} | ${Math.round((host.loadSettledMax ?? host.loadAvg1Max) * 100) / 100} |`,
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

/**
 * [D69] Parents that went quiet and came back. Silences of the source at one moment (within 50 ms of
 * each other) are one stall of the source, seen by several children: a stall at three or more is
 * the source's own, not a link's.
 */
export function silenceSummary(events: { at: number; ms: number; depth: number }[], tickLate: number[], publishGap: number[]): NonNullable<SwarmReport["silences"]> {
  const ofSource = events.filter((e) => e.depth === 0).sort((a, b) => a.at - b.at);
  let moments = 0;
  let wide = 0;
  for (let i = 0; i < ofSource.length; ) {
    let j = i + 1;
    while (j < ofSource.length && ofSource[j]!.at - ofSource[i]!.at <= 50) j++;
    moments++;
    if (j - i >= 3) wide++;
    i = j;
  }
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  const ms = exactQuantiles(events.map((e) => e.ms));
  const gaps = exactQuantiles(publishGap);
  return {
    count: events.length,
    ms: { p50: round(ms.p50), p95: round(ms.p95) },
    ofSource: ofSource.length,
    sourceMoments: moments,
    sourceMomentsWide: wide,
    sourceTickLateMaxMs: tickLate.length ? Math.round(Math.max(...tickLate)) : null,
    sourcePublishGapMs: { p95: round(gaps.p95), max: round(gaps.max) },
  };
}
