# topology

**Owner: E-transport+topology.** Spec: SPEC §7, §8, and §4.4–§4.6 for the packets it sends.
Milestones: PLAN §5, T2–T6.

Where this peer sits in the trees and how it stays there.

| To build | In `types.ts` | Notes |
| --- | --- | --- |
| The node | `OverlayNode` | one state machine per (stream, stripe): join, subscribe, active, waiting, repairing, cold repair, rejoin. Owns the heartbeat and feedback timers, the failure detector and the forwarding loop |
| The GOP cache | `GopCache` | what makes repair lossless: replay "after frame X", and answer NACKs |
| Choosing a parent | `ParentSelector`, `parentCost` | SPEC §8.3; never a peer whose path contains this one |
| Who may relay | `judgeRelay` | SPEC §8.1–§8.2. Pure. The coordinator imports it, so it is needed in week 1 |

Rules of this module:

- **Repair does not wait for the coordinator.** Between detecting a dead parent and media
  flowing again from the backup, nothing is sent to it. `report` and `need` come after.
- Forwarding does not wait for anything: not for the frame to be whole, not for this peer's own
  playout, not for a recovery in progress.
- Congestion decisions are not made here. Ask the `LayerGate` you were given, per frame per
  child, and do what it says.
- The numbers to beat are the proof's (SPEC §17): detection at 200 ms, about 207 ms of freeze,
  no frames lost.

## Files

| File | What |
| --- | --- |
| `node.ts` | `createOverlayNode`: everything above, on one 10 ms tick of the injected `Clock` |
| `gopCache.ts`, `scoring.ts` | the GOP cache; `judgeRelay`, `parentCost`, `createParentSelector` |
| `standins.ts` | an estimator and an open gate, written from `congestion/types.ts`, for tests and the bench |
| `sim.ts` | `SimNet`: real nodes on simulated links and a fake clock, with a coordinator that places from the nodes' status |
| `churn.ts` | one seeded run of PLAN T4's random churn on `SimNet` |
| `bench/` | small runs of real peers in headless Chromium (see below) |

Tests: `node.test.ts` (T3, T4's unit cases), `node.random.test.ts` (T4's random runs: 40 per
push; `OVERLAY_SIM_RUNS=1000 npm run test:overlay` for the full thousand), `node.t5.test.ts`
(NACK, rebalancing).

## The bench

Up to 7 peers in one headless Chromium, host candidates on loopback, as the proof ran. The
driver plays the coordinator and relays signalling; the source sends a synthetic feed shaped like
SPEC §9.2; viewers are light (a frame counts when it is whole and decodable). Playwright and
esbuild are found through `NODE_PATH`:

```
NODE_PATH=<dir with playwright>:<dir with esbuild> node --experimental-transform-types \
  --import ./test/register.mjs packages/overlay/topology/bench/run.ts tree-warm 5
```

Scenarios: `tree-warm`, `tree-cold`, `chain-kill`, `tree-leave`, `chain` (latency per hop).
Nothing listens on a port: the page is served by request interception on 127.0.0.1:4200.
