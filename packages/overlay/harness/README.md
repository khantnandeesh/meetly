# harness

**Owner: E-harness.** Spec: SPEC §12, §13. Milestones: PLAN §5, H1–H6.

Many real peers in headless Chromium against one coordinator, with bad networks and people
leaving, and a report that says whether the gate is met: p95 repair under 500 ms, p95
glass-to-glass under 500 ms, p95 join under 3 s, at 200 peers (`GATE` in `types.ts`).

| To build | In `types.ts` | Notes |
| --- | --- | --- |
| Impairment | `ImpairmentProfile`, `createImpairment` | delay, jitter, loss (single and in bursts) and a rate cap, injected through the transport's `wrapChannel`. DevTools throttling does not reach data channels |
| A shard | `SwarmConfig`, `runShard`, `ShardResult` | this process's share of a swarm; everything derived from the seed and the peer's index, so shards need not talk |
| Churn | `ChurnEvent` | kills, leaves, joins, a change of network, a dead coordinator |
| The report | `buildReport`, `SwarmReport` | p50 / p95 / p99 from histograms that add up across shards; the gate's verdict; whether the run was valid at all |
| The page | `PageApi` | one peer per page, built with esbuild from `createOverlayViewer` / `createOverlaySource` |
| CI | `smoke.ts`, `ci/`, `.github/workflows/overlay-swarm.yml` | the smoke test on every push (7 peers, one killed relay); sharded swarms on demand |

Rules of this module:

- Playwright is not a dependency of the repository. Find it through `NODE_PATH`, as `test/e2e`
  does; CI installs it outside the project.
- Ports 4280–4299 (the harness's share of the machine; PLAN's 4100–4199 is the whole package's).
  Stop everything you start, also when a run fails.
- A run that starved its machine is invalid, not slow. Measure event-loop lag and load on every
  shard and say so in the report.
- Use the package's public API in the page. If you need to reach inside a module, the API is
  missing something: ask for it.
- This machine has 4 shared cores: expect 30–60 peers with light viewers. 200 needs shards on
  several machines, and that needs two things nobody has measured yet (SPEC §13.3). Measure them
  first (H5).

## Running it

```
node packages/overlay/harness/swarm.mjs scenarios                 # what there is, and what is still a stub
node packages/overlay/harness/swarm.mjs modules                   # real or stub, factory by factory (H6)
node packages/overlay/harness/swarm.mjs run proof-tree            # one machine, its own coordinator
node packages/overlay/harness/swarm.mjs run gate-small --peers 8 --churn-s 60 --out out/gs8
node packages/overlay/harness/swarm.mjs report out/gs8            # any number of shard-N.json, one report
node packages/overlay/harness/swarm.mjs sizes out/30 out/45 out/60   # H4: the largest valid size
```

Locally, keep to 8 peers. Everything bigger runs in `.github/workflows/overlay-swarm.yml`, which
a push starts only when its commit message says `[swarm: …]` with any of `experiment`, `sizes`,
`sharded`, `gate`, `merge` (`ci/plan.mjs`). `merge` first merges the engineers' `overlay-*`
branches into the checkout (`ci/merge.sh`), so the run uses whatever of the engine is real; the
report names what was merged and every factory that is still a stub.

Across runners: shard 0 runs the coordinator and puts it behind a Cloudflare quick tunnel
(`ci/tunnel.sh`); it uploads the tunnel's URL, a start time two and a half minutes ahead and a
fresh admission secret as an artifact, and the other shards wait for it (`ci/rendezvous.sh`).
Shard 0's own peers, the source among them, reach the coordinator on 127.0.0.1; everyone else
through the tunnel. Peers use STUN only.

## What the report checks

- The gate (SPEC §12.3): repair, latency and join p95, with p50, p95 and p99 of each and of
  freezes, read from 97-bucket histograms summed over every shard.
- Whether the run is a measurement at all: peers, shards, repairs, no failed peer, event-loop
  lag p99 under 50 ms on every shard, and clock uncertainty (viewer plus source) p95 under 20 ms.
  Uncertainty is half the best probe's round trip plus what the offset still has to slew. It is
  also given shard by shard: off shard 0 every sum is between two machines.
- D29: the decoding viewers' latency against the light ones'. More than 15 ms apart at p50 is a
  note against the light viewers' numbers.

## H5: can shards on separate runners share one coordinator and reach each other?

Measured in `overlay-swarm.yml` run
[44944170529](https://github.com/khantnandeesh/meetly/actions/runs/44944170529) (`experiment`):
two GitHub-hosted runners, 8 peers each, the harness's stand-in peer and coordinator, STUN only
(Google's and Cloudflare's), no churn, no impairment.

- **One coordinator: yes, through a Cloudflare quick tunnel.** The Node coordinator ran on shard
  0's runner on 127.0.0.1, with `cloudflared tunnel --url` in front of it. All 8 peers on the
  other runner were admitted and rendered. Join p95 was 1,050 ms, against 120 ms on one machine:
  ICE between machines and signalling through the tunnel. No account is needed. A quick tunnel
  is documented to carry at most 200 requests in flight, and a 200-peer gate with 175 remote
  WebSockets sits just under that. The deployed Worker (K4) would replace the tunnel; it does
  not exist yet.
- **Peers on different runners link directly, but only between Azure-hosted runners.** In this
  run, 13 links between the runners, every one `srflx-srflx` (hole-punched through both NATs), 0
  through TURN, 0 failed; the same held over 2,585 link ends in an 8-runner run. Then a gate run
  ([44947800151](https://github.com/khantnandeesh/meetly/actions/runs/44947800151)) got three
  runners hosted on AWS (us-west-2) beside five on Azure. **Not one link of the AWS runners'
  opened** (934 link ends failed, 480 of them counted at the AWS end, and all 120 of those
  runners' peers "never found a parent"), while the
  Azure runners linked among themselves as before. Every earlier run had been Azure only. An AWS
  NAT gateway maps each destination to a different port (a symmetric NAT), which hole punching
  cannot get through. So on GitHub's mixed fleet **a share of runners needs TURN for every link:
  3 of 8 in that run**, and there is no TURN server to give them: the repository has no TURN key.
  Each shard now runs `ci/natcheck.mjs` (two STUN servers, one socket) before it starts, and the
  report says which shards are behind a symmetric NAT. Until there is a TURN key (Cloudflare's,
  through the coordinator's `welcome.ice`, SPEC §6.7), a run that draws an AWS runner is not a
  test of the overlay.
- **But the session clock across the tunnel is too loose for the gate.** A viewer on the other
  runner reaches the coordinator in a round trip of about 50 ms, so its uncertainty (half of
  that) was 24–30 ms. With the source's added, the p95 of the sum was 30.8 ms, against the 20 ms
  that SPEC §12.3 allows. Shard 0's viewers, beside the coordinator, were at 1 ms. **Every sharded
  run through a tunnel is therefore invalid by §12.3**, however well the overlay does. The report
  now also reads every session clock against its machine's wall clock, so that the real
  disagreement between a remote viewer's clock and the source's can be set beside the bound,
  with chrony's own error bound for the wall clocks. Whether the 20 ms rule should use that
  measurement instead is the architect's decision, not the harness's.

## H4: how many peers fit on one runner

Same run, `sizes`: gate-small (the gate's mix and churn, 120 s of it, with one 30 s coordinator
outage) alone on a 4-vCPU runner, light viewers with one in 8 decoding. Stand-in engine.

| Peers | Load (1 min, max) | Event-loop lag p99 | Valid? |
| ---: | ---: | ---: | --- |
| 30 | 4.8 | 30 ms | yes |
| 40 | 9.5 | 50 ms | yes, at the limit |
| 50 | 19.5 | 70 ms | no: starved |
| 60 | 41 | 470 ms | no: starved, and clocks at 37.8 ms |

**40 is the largest valid size** (PLAN H4), with no margin; a shard of 25 has plenty. The 30- and
40-peer runs were valid and failed the gate on join time. At 30–60 peers, the six viewers who
arrive during the outage are more than 5% of all joins, and they wait for it. At 200 they are
under 2%.

## Sharded runs so far (H5, H6)

None of these is a measurement of the overlay: the composition root (`createOverlayViewer`,
`createOverlaySource`) is still a stub, so every page ran the harness's stand-in peer, whatever
else was merged. They show that the sharded harness works, and what it will say.

| Run | Shards × peers | Coordinator | Verdict | Why |
| --- | --- | --- | --- | --- |
| [44945057879](https://github.com/khantnandeesh/meetly/actions/runs/44945057879) `sharded` | 4 × 25 | the package's (315d92a) | invalid | clock bound 24.3 ms at p95; join p95 over 10 s |
| [44946383526](https://github.com/khantnandeesh/meetly/actions/runs/44946383526) `gate` | 8 × 25 | stand-in (overlay-coordinator did not merge) | invalid | clock bound 43.8 ms; one late joiner never rendered |
| [44947800151](https://github.com/khantnandeesh/meetly/actions/runs/44947800151) `gate` | 8 × 25 | the package's (f7aba98) | invalid | 3 AWS runners could link to nobody (137 peers failed); clock bound 61.7 ms; join p95 over 10 s; repair p95 1,600 ms |

- **Links between runners need no TURN.** In the 8-shard gate run 2,585 link ends crossed
  between runners, all `srflx-srflx`; 2 never opened; 0 went through TURN.
- **The clocks agree far better than the bound says.** In the stand-in gate run, shards 1–7 had bounds of
  23.6–47 ms (p95, viewer plus source), but read against their wall clocks (chrony: within
  0.1–0.4 ms) their viewers' session clocks were 1.2–7.3 ms from the source's at p95. By SPEC
  §12.3 as written, every run through the tunnel stays invalid.
- **On the package's coordinator, joins wait for probation.** The coordinator places nobody under
  a peer in its first 20 s (D18), so while the swarm fills, every viewer past the source's three
  slots waits for a promotion: join p50 over 10 s in the 4 × 25 run. In an 8-peer run on one
  machine, the first three joins took about 100 ms and the next four 16–22 s.
- At 200 peers the stand-in itself falls over (repair p95 over 10 s, 560 `wait` repairs): it has
  no congestion control and no rebalancing. That is the stand-in, not the overlay.
