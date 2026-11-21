/**
 * Named scenarios, and the arithmetic every shard does alone and must do the same: which network
 * each peer gets, when it joins, which shard runs it, and which shard carries out each churn
 * event. All of it comes from the run's seed, the peer's index and the clock on the wall, so
 * shards never talk to each other (SPEC §13.3).
 *
 * Owner: E-harness.
 */
import { mixSeed, seededRandom } from "./clock";
import type { ChurnEvent, ImpairmentProfile, SwarmConfig } from "./types";

/** Networks to test against. "clean" is the proof's condition; the gate is run on the mix below. */
export const PROFILES: Record<string, ImpairmentProfile> = {
  clean: { name: "clean", delayMs: 0, jitterMs: 0, lossPct: 0 },
  good: { name: "good", delayMs: 15, jitterMs: 5, lossPct: 0.1 },
  home: { name: "home", delayMs: 30, jitterMs: 15, lossPct: 1 },
  bad: { name: "bad", delayMs: 60, jitterMs: 40, lossPct: 3, burst: { enterPct: 1, leavePct: 30, lossPctInBurst: 50 } },
  slow: { name: "slow", delayMs: 40, jitterMs: 20, lossPct: 1, kbps: 900, queueMs: 300 },
  /** slow-child (PLAN C3): a clean link capped under the stream, and then given room again. */
  "cap-900": { name: "cap-900", delayMs: 0, jitterMs: 0, lossPct: 0, kbps: 900, queueMs: 300 },
  "cap-3000": { name: "cap-3000", delayMs: 0, jitterMs: 0, lossPct: 0, kbps: 3000, queueMs: 300 },
};

/** The gate's audience (D28): mostly ordinary connections, some bad, a few too slow for every layer. */
export const GATE_MIX: SwarmConfig["mix"] = [
  { profile: "good", share: 0.5 },
  { profile: "home", share: 0.3 },
  { profile: "bad", share: 0.15 },
  { profile: "slow", share: 0.05 },
];

/* ------------------------------ what each shard works out alone ------------------------------ */

/** The source is peer 0 and runs on shard 0; every other peer on the shard its index falls to. */
export const shardOf = (index: number, count: number): number => index % Math.max(1, count);

/**
 * The network of peer `index`. The source's is clean: it is the host. The viewers present at the
 * start are dealt the mix exactly (15% of 199 is 30, not "about 30"), in an order the seed
 * decides; a viewer who joins later draws from it.
 */
export function profileOf(config: Pick<SwarmConfig, "seed" | "peers" | "profiles" | "mix">, index: number): ImpairmentProfile | null {
  if (index === 0 || config.mix.length === 0) return null;
  const named = (name: string): ImpairmentProfile | null => {
    const profile = config.profiles.find((p) => p.name === name) ?? PROFILES[name];
    return profile && profile.name !== "clean" ? profile : null;
  };
  const total = config.mix.reduce((sum, part) => sum + part.share, 0);
  const pickAt = (u: number): ImpairmentProfile | null => {
    let edge = 0;
    for (const part of config.mix) {
      edge += part.share / total;
      if (u < edge) return named(part.profile);
    }
    return named(config.mix[config.mix.length - 1].profile);
  };
  const viewers = config.peers - 1;
  if (index > viewers) return pickAt(seededRandom(mixSeed(config.seed, "late", index))());
  // Rank this viewer among the first ones by a hash, and cut the ranks by the shares.
  const key = (i: number): number => mixSeed(config.seed, "net", i);
  const mine = key(index);
  let rank = 0;
  for (let i = 1; i <= viewers; i++) if (key(i) < mine || (key(i) === mine && i < index)) rank++;
  return pickAt((rank + 0.5) / viewers);
}

/** When peer `index` joins, in seconds from the run's start. The source first, then `joinPerS` a second. */
export const joinAtS = (config: Pick<SwarmConfig, "joinPerS">, index: number): number => (index === 0 ? 0 : 2 + (index - 1) / Math.max(0.1, config.joinPerS));

/** How long the swarm takes to fill. Churn scripts start after it. */
export const fillS = (config: Pick<SwarmConfig, "joinPerS" | "peers" | "fillS">): number => config.fillS ?? Math.ceil(joinAtS(config, config.peers - 1) + 8);

/** One step of a churn script, as one shard is to carry it out. */
export type ChurnStep = {
  atS: number;
  event: ChurnEvent;
  /** Which of the event's `count` this is. */
  nth: number;
  /** The shard that carries it out. */
  shard: number;
  /** For a join: the new peer's index in the run. */
  index?: number;
  /** Decides whom it falls on, among that shard's peers. */
  seed: number;
};

/**
 * A churn script as steps, each given to one shard in turn. A kill or a leave falls on one of
 * that shard's own peers, chosen from what its pages say of themselves, so no shard needs to
 * know another's peers and none needs the coordinator (which may be the thing that is dead).
 * The coordinator's own death is for whoever runs it: `shard` is -1.
 */
export function churnSteps(config: Pick<SwarmConfig, "seed" | "peers" | "churn" | "shard">): ChurnStep[] {
  const steps: ChurnStep[] = [];
  // Each kind of event goes round the shards on its own, so every shard gets its share of each.
  const turns: Record<string, number> = {};
  let nextIndex = config.peers;
  const events = [...config.churn].sort((a, b) => a.atS - b.atS);
  events.forEach((event, at) => {
    if (event.action === "kill-coordinator") {
      steps.push({ atS: event.atS, event, nth: 0, shard: -1, seed: mixSeed(config.seed, "churn", at) });
      return;
    }
    for (let nth = 0; nth < event.count; nth++) {
      const turn = (turns[event.action] = (turns[event.action] ?? -1) + 1);
      const step: ChurnStep = { atS: event.atS, event, nth, shard: turn % config.shard.count, seed: mixSeed(config.seed, "churn", at, nth) };
      if (event.action === "join") {
        step.index = nextIndex++;
        step.shard = shardOf(step.index, config.shard.count);
      }
      steps.push(step);
    }
  });
  return steps;
}

/**
 * The gate's churn (D28): from `fromS`, every 10 s one relay is killed without warning, one
 * viewer leaves gracefully and two join; and once, for 30 s, the coordinator is dead while the
 * kills go on.
 */
export function gateChurn(fromS: number, forS: number, everyS = 10, outageS = 30): ChurnEvent[] {
  const events: ChurnEvent[] = [];
  for (let at = fromS; at < fromS + forS; at += everyS) {
    events.push({ atS: at, action: "kill", pick: "relay", count: 1 });
    events.push({ atS: at + everyS * 0.3, action: "leave", pick: "any", count: 1 });
    events.push({ atS: at + everyS * 0.6, action: "join", count: 2 });
  }
  if (outageS > 0 && forS >= outageS * 2) events.push({ atS: fromS + Math.floor(forS / 3) + 5, action: "kill-coordinator", forS: outageS });
  return events.sort((a, b) => a.atS - b.atS);
}

/* ------------------------------ the scenarios ------------------------------ */

/** slow-child's timing, and E-congestion's measured numbers it is checked against (their C3 run). */
export const SLOW_CHILD = {
  liftAfterS: 15,
  baseline: { firstDropMs: 700, settledMs: 1230, siblingsFramesLost: 0, siblingsLatencyP95ShiftMs: 5, slowChildAudioConcealedMs: 0, layer1BackAfterLiftMs: 6000, layer2BackAfterLiftMs: 11000 },
} as const;

export type ScenarioOptions = {
  runId?: string;
  seed?: number;
  peers?: number;
  /** Seconds of churn, for the scenarios that have it. */
  churnS?: number;
  shard?: { index: number; count: number };
  coordinatorUrl?: string;
  admissionSecret?: string;
  ice?: SwarmConfig["ice"];
  port?: number;
};

const SYNTHETIC: NonNullable<SwarmConfig["program"]> = { source: "synthetic", bitrateKbps: 1200, fps: 30, keyIntervalFrames: 60 };
const CAMERA: NonNullable<SwarmConfig["program"]> = { source: "camera", bitrateKbps: 600, fps: 30, keyIntervalFrames: 60 };
/**
 * The gate's program: a real encode, so that a few viewers can decode it (D29), padded to the
 * session's 1,200 kbps, so that the "slow" viewers' 900 kbps really is under it (SPEC §12.3).
 */
const GATE_PROGRAM: NonNullable<SwarmConfig["program"]> = { source: "camera", bitrateKbps: 1200, fps: 30, keyIntervalFrames: 60, pad: true };

export const SCENARIOS = {
  /** The CI smoke test: the proof's tree and its one killed relay, with every viewer decoding. */
  smoke: "7 peers, clean, a real encode and decode; one relay killed",
  /** PLAN T3: the proof's tree (0 → 1, 2; 1 → 3, 4; 2 → 5, 6), relay 1 killed, warm backups. */
  "proof-tree": "7 peers, clean; one relay killed; warm repair",
  /** PLAN T4: a chain three deep; the depth-1 relay killed. */
  "chain-kill": "a chain three deep with two leaves; the depth-1 relay killed",
  /** PLAN C3: one viewer capped at 900 kbps under a 1,200 kbps stream. */
  "slow-child": "E-congestion's tree of 8: one of the source's three children capped at 900 kbps under 1,200, then given 3 Mbps",
  /** PLAN H3, H4: the gate's mix and churn, small. */
  "gate-small": "the gate's networks and churn at 30 peers (or --peers)",
  /** PLAN H6, SPEC §12.3. */
  gate: "200 peers, the gate's networks, ten minutes of churn, one 30 s coordinator outage",
  /** PLAN H5: can shards on different machines reach one coordinator and each other? */
  "two-runner": "a handful of peers on each of two machines, STUN only, no churn",
} as const;
export type ScenarioName = keyof typeof SCENARIOS;

/** A named scenario as a `SwarmConfig`. */
export function scenario(name: ScenarioName, options: ScenarioOptions = {}): SwarmConfig {
  const port = options.port ?? 4280;
  const base: SwarmConfig = {
    runId: options.runId ?? `${name}-${(options.seed ?? 1).toString(36)}`,
    seed: options.seed ?? 1,
    coordinatorUrl: options.coordinatorUrl ?? `http://127.0.0.1:${port}`,
    room: `swarm-${name}`,
    admissionSecret: options.admissionSecret ?? "harness-admission-secret",
    peers: options.peers ?? 7,
    shard: options.shard ?? { index: 0, count: 1 },
    durationS: 25,
    joinPerS: 2,
    profiles: Object.values(PROFILES),
    mix: [],
    churn: [],
    decodeEvery: 0,
    pagesPerBrowser: 8,
    ice: options.ice ?? "host",
    scenario: name,
    program: SYNTHETIC,
    coordinator: options.coordinatorUrl ? "external" : "auto",
  };
  // The proof's tree: a fan-out of two everywhere, so seven peers fill two levels.
  const proofTree = { sourceFanout: 2, maxFanout: 2 };
  switch (name) {
    case "smoke":
    case "proof-tree": {
      const config = { ...base, peers: 7, params: proofTree, decodeEvery: name === "smoke" ? 1 : 3, program: CAMERA };
      const at = fillS(config) + 3;
      return { ...config, churn: [{ atS: at, action: "kill", pick: "relay", count: 1 }], durationS: at + 6, expect: { peers: 7, minRepairs: 2 } };
    }
    case "chain-kill": {
      // A fan-out of one makes a chain; the last relay takes the leaves that are left.
      const config = { ...base, peers: 5, params: { sourceFanout: 1, maxFanout: 1 } };
      const at = fillS(config) + 3;
      return { ...config, churn: [{ atS: at, action: "kill", pick: "shallowest-relay", count: 1 }], durationS: at + 6, expect: { peers: 5, minRepairs: 1 } };
    }
    case "slow-child": {
      // E-congestion's tree (congestion/browser/run.ts): the source's three children, and four
      // grandchildren under them. One child of the source is capped at 900 kbps under the 1,200
      // kbps stream; 15 s later it has 3 Mbps, room for every layer again.
      const config = { ...base, peers: 8, params: { sourceFanout: 3, maxFanout: 2 }, program: SYNTHETIC };
      const at = fillS(config) + 5;
      return {
        ...config,
        churn: [
          { atS: at, action: "impair", pick: "shallowest-relay", count: 1, profile: "cap-900" },
          { atS: at + SLOW_CHILD.liftAfterS, action: "impair", pick: "impaired", count: 1, profile: "cap-3000" },
        ],
        durationS: at + SLOW_CHILD.liftAfterS + 15,
        expect: { peers: 8, minRepairs: 0 },
      };
    }
    case "two-runner": {
      const config = { ...base, peers: options.peers ?? 8, ice: options.ice ?? "stun", joinPerS: 1 };
      return { ...config, durationS: fillS(config) + 20, expect: { peers: config.peers, minRepairs: 0 } };
    }
    case "gate-small":
    case "gate": {
      const peers = options.peers ?? (name === "gate" ? 200 : 30);
      // Most viewers light, one in `decodeEvery` decoding as the check on them (D29, SPEC §13.2).
      const config = { ...base, peers, mix: GATE_MIX, joinPerS: name === "gate" ? 4 : 3, decodeEvery: name === "gate" ? 20 : 8, pagesPerBrowser: 10, program: GATE_PROGRAM };
      const from = fillS(config) + 5;
      const churnS = options.churnS ?? (name === "gate" ? 600 : 120);
      // Each kill orphans a relay's children: about three repairs a kill once the tree is full.
      const minRepairs = name === "gate" ? 100 : Math.max(5, Math.floor(churnS / 10));
      return { ...config, churn: gateChurn(from, churnS), durationS: from + churnS + 8, expect: { peers, minRepairs } };
    }
  }
}
