#!/usr/bin/env node
// Decides what .github/workflows/overlay-swarm.yml runs, and writes it to $GITHUB_OUTPUT as
// matrices. Big swarms are not run on every push: a push runs what its commit message asks for,
//
//   [swarm: experiment sizes sharded gate merge]
//
// a manual run what its `runs` input says, and the nightly run the gate.
//
//   experiment  PLAN H5's first task: two shards on two runners, one coordinator behind a public
//               tunnel, STUN only. Can they reach it, and can their peers link to each other?
//   sizes       PLAN H4: gate-small at 30, 40, 50 and 60 peers, each alone on one runner; the
//               largest valid one is reported.
//   scenarios   proof-tree, chain-kill and slow-child (PLAN T3, T4, C3), each alone on a runner.
//   sharded     PLAN H5: gate-small at 100 peers, 4 shards of 25 on 4 runners, one report.
//   gate        PLAN H6, SPEC §12.3: 200 peers, ten minutes of churn, on 20 runners: the
//               coordinator alone on one, the source alone on another, and the viewers over the
//               other 18, of which those behind a symmetric NAT (AWS-hosted, about a quarter) are
//               left out and the rest take their share. 20 is all a free account runs at once;
//               the workflow waits for this push's own CI to finish first.
//   merge       before any of these, merge the engineers' overlay-* branches into the checkout,
//               so the run uses whatever of the engine is real (H6). Stubs are named in the report.
//
// Owner: E-harness.
import { appendFileSync } from "node:fs";

const event = process.env.EVENT ?? "push";
const message = process.env.COMMIT_MESSAGE ?? "";
const input = process.env.RUNS_INPUT ?? "";

let words;
if (event === "workflow_dispatch") words = input.split(/[\s,]+/);
else if (event === "schedule") words = ["gate", "merge"];
// Every [swarm: ...] in the message counts, so one that only mentions the syntax is harmless.
else words = [...message.matchAll(/\[swarm:([^\]]*)\]/gi)].flatMap((m) => m[1].split(/[\s,]+/));
const want = new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean));

/** One sharded run: its shards are matrix entries that share a rendezvous. */
const RUNS = {
  // Shard 0 runs only the coordinator, the first open one only the source (../layout.ts).
  experiment: { scenario: "two-runner", shards: 4, peers: 16, churnS: 0 },
  sharded: { scenario: "gate-small", shards: 6, peers: 100, churnS: 120 },
  gate: { scenario: "gate", shards: 20, peers: 200, churnS: 600 },
};

const shards = [];
for (const [run, r] of Object.entries(RUNS)) {
  if (!want.has(run)) continue;
  for (let shard = 0; shard < r.shards; shard++) shards.push({ run, shard, ...r });
}
/** Runs of one runner each, with its own coordinator. `dir` is where its result goes. */
const single = [];
if (want.has("sizes")) for (const peers of [30, 40, 50, 60]) single.push({ dir: `sizes-${peers}`, scenario: "gate-small", peers });
if (want.has("scenarios"))
  for (const [scenario, peers] of [["proof-tree", 7], ["chain-kill", 5], ["slow-child", 8]]) single.push({ dir: `scenario-${scenario}`, scenario, peers });

const out = {
  shards: JSON.stringify({ include: shards.length ? shards : [{ run: "none", shard: 0 }] }),
  has_shards: String(shards.length > 0),
  single: JSON.stringify({ include: single.length ? single : [{ dir: "none", scenario: "none", peers: 0 }] }),
  has_single: String(single.length > 0),
  merge: String(want.has("merge") || want.has("integration")),
  merge_mode: want.has("integration") ? "integration" : "branches",
  any: String(shards.length > 0 || single.length > 0),
  runs: [...want].join(" "),
};
const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
console.log(lines.join("\n"));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
