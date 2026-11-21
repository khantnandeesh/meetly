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
//   sharded     PLAN H5: gate-small at 100 peers, 4 shards of 25 on 4 runners, one report.
//   gate        PLAN H6, SPEC §12.3: 200 peers, 8 shards of 25, ten minutes of churn.
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
else words = (/\[swarm:([^\]]*)\]/i.exec(message)?.[1] ?? "").split(/[\s,]+/);
const want = new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean));

/** One sharded run: its shards are matrix entries that share a rendezvous. */
const RUNS = {
  experiment: { scenario: "two-runner", shards: 2, peers: 16, churnS: 0 },
  sharded: { scenario: "gate-small", shards: 4, peers: 100, churnS: 120 },
  gate: { scenario: "gate", shards: 8, peers: 200, churnS: 600 },
};

const shards = [];
for (const [run, r] of Object.entries(RUNS)) {
  if (!want.has(run)) continue;
  for (let shard = 0; shard < r.shards; shard++) shards.push({ run, shard, ...r });
}
const sizes = want.has("sizes") ? [30, 40, 50, 60] : [];

const out = {
  shards: JSON.stringify({ include: shards.length ? shards : [{ run: "none", shard: 0 }] }),
  has_shards: String(shards.length > 0),
  sizes: JSON.stringify(sizes.length ? sizes : [0]),
  has_sizes: String(sizes.length > 0),
  merge: String(want.has("merge")),
  any: String(shards.length > 0 || sizes.length > 0),
  runs: [...want].join(" "),
};
const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
console.log(lines.join("\n"));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
