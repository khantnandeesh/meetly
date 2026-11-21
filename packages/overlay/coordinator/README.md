# coordinator

**Owner: E-coordinator.** Spec: SPEC §6, §8.1–§8.2, §4.1. Milestones: PLAN §5, K1–K6.

Who is in a session, what each may do, where each sits in the trees, and a relay for WebRTC
signalling. It never sees media, and a session keeps playing and repairing without it.

| File | What |
| --- | --- |
| `types.ts` | `CoordinatorCore` and its `Effect`s; `CoordinatorClient`; the Node entry point's options |
| `index.ts` | `createCoordinatorCore`, `createCoordinatorClient`, the routes and close codes |
| `core.ts` | `CoordinatorCore`: tickets, hello/welcome, grants, the clock, signalling, limits, HTTP, roles, the hint |
| `treeMap.ts` | the soft-state tree map, placement, holds, promotion and demotion, `move`s |
| `scoring.ts` | topology's `judgeRelay` and `parentCost`, the only code imported from another module |
| `client.ts` | `CoordinatorClient`: the browser's side; reconnects with `resume`, keeps the session clock |
| `routing.ts` | what both entry points share: the paths, and a queue of one |
| `node.ts` | `startNodeCoordinator`: the core behind `http` and `ws`, for tests and the harness |
| `durableObject.ts` | `OverlayRoom` and the Worker: the core behind hibernatable WebSockets, for production |
| `wrangler.jsonc` | the Worker `meetly-overlay`, its own, apart from the app's (D13). Never deployed from here |
| `contract.ts` | the contract suite, written against a URL; `contract.node.test.ts` and `contract.worker.test.ts` run it |
| `overlay.test.ts` | warm repair with the coordinator dead, under real transport and topology (skips until they are built here) |
| `client.browser.test.ts` | the client bundled and run in headless Chromium (skips without Playwright) |
| `orphans.test.ts`, `provisional.test.ts`, `churn.test.ts` | cold repair finds slots; D38; the depth under the gate's churn, in the simulator |
| `testkit.ts`, `wranglerDev.ts` | for tests: a core driven by hand, simulated peers; running `wrangler dev` |
| `load.ts`, `loadServer.ts` | K6: the load measurement |

The core does no I/O. It is told what happened and returns what to do. Both entry points are a
few dozen lines around it, and one contract test suite, written against a URL, passes against
both. If a behaviour can only be had by putting logic in an entry point, the core's interface is
missing something.

Rules of this module:

- The tree map is soft state, rebuilt from peers' `status`. Store only what cannot be rebuilt:
  the signing key (with the session clock's start), used ticket nonces, whether the session has
  ended.
- Never be on the repair path. A peer tells you about a repair after it has happened.
- `node.ts` and `durableObject.ts` are imported by path, never re-exported from `index.ts`: a
  browser bundle must not pull in Node's `http` or a Worker's globals.
- The Worker is its own (`meetly-overlay`), with its own `wrangler.jsonc` in this directory. The
  app's Worker and the `cloudflare-deploy` branch are not touched.
- Placement ranks with topology's `judgeRelay` and `parentCost`. That is the only code this
  module imports from another module; everything else is `types.ts`.

## Running it

```
npm run test:overlay                                  # everything, the Node contract included
OVERLAY_WRANGLER=/path/to/wrangler npm run test:overlay   # and the Worker's, under wrangler dev
```

Ports (E-coordinator's range is 4260–4279): 4260 Node contract, 4261–4262 Worker contract,
4264–4266 load, 4268 the overlay integration test, 4270 the browser client test. Wrangler is not a
dependency; CI installs a pinned one outside the project (`WRANGLER_VERSION` in ci.yml).

The harness signs tickets with `signTicket` (protocol.ts), starts `startNodeCoordinator` with
`storage` to survive its own `kill()`, and reads `GET …/rooms/:room/metrics` and `/tree` with
`Authorization: Bearer <serverSecret>`.

## Where it reads SPEC §6 in its own way

- **Dead ends go deep.** A joiner that can never relay (§8.1 says so of its caps alone) is
  placed deepest first, not shallowest, so slots near the source stay for peers the tree grows
  from; and the coordinator moves relays up and dead ends down (`assign` "move", an
  `interface:` commit). With a quarter of 200 peers able to relay: depth 4 (bound 5), against
  11–12 with §6.6's order alone.
- **Places are held** for 10 s at the first two parents offered, so a burst of joiners is not
  sent to one slot before its relay reports.
- **Demotion for children's loss** needs at least half of the children that report to be over
  5% for 10 s: one child with a bad line of its own is not the relay's doing. STARVED is not
  seen by the coordinator (no message carries it), so only loss counts.
- **Introductions** (§6.4) are soft state: a coordinator that lost its memory relays signalling
  again once it has named the two to each other again (any `assign`).
- **A PeerId** is 8 random characters and 8 that bind them to the ticket's identity under a key
  stored with the session, so a coordinator that lost its memory can still refuse a `resume`
  from someone holding another peer's grant.
- **A resumed peer's uptime** starts at its grant's `iat` when the coordinator has forgotten it
  (found integrating, 6e24f63): probation does not start over at a restart.

## Provisional relays (D38) and keeping the tree short under churn

- **D38.** A leaf that passes §8.1 but for probation, with the short probe's uplink, is made a
  relay with fan-out 2 when someone has nowhere to go (a joiner, an orphan, a child to move):
  its grant says `"fanout:2"` in its scope, and the coordinator never counts more than 2 slots
  for it. Placement offers it only when no full relay (or the source) has a free slot, and as a
  backup last. At the end of probation, eligible in full, it is sent a new grant without the
  limit. One that misbehaves first (anything but probation fails §8.1, or half its children lose
  over 5%) is demoted after 3 s. The fifth-of-the-audience rule promotes full relays only.
- **Demotion is make-before-break.** A relay to be made a leaf is offered to nobody, its
  children are sent `move`s to slots elsewhere, and it is told `role: leaf` once they have gone,
  or after 5 s.
- **Depth.** Every placement prefers a place where the peer and its subtree end within
  `neededDepth() + 1` (5 at 200 peers); a dead end is never moved down below that; relief of a
  parent over its fan-out moves only what does not push a subtree past it (a parent over its
  fan-out sheds a layer, D37, which costs less). Backups are chosen at the parent's own depth for
  peers with subtrees (a warm repair then moves nothing deeper) and as deep as the limit allows
  for leaves (keeping the places near the source for those that need them). Peers whose warm
  repair would push their subtree too deep are offered a better backup by `assign` "rebalance"
  with backups only, once a minute: topology's node takes it only if it says `free > 0`, so for
  a backup at a full relay it needs the node to look at standby places instead. Moves: 5% of
  the audience a second, a peer again after 10 s.
- **Measured** in the simulator under the gate's churn (`churn.test.ts`): see the table there.
  The quarter's case still spends 1–10% of the time at depth 6–8.

## K6: load (measured 2026-11-21, 4 shared cores, load average 5–6)

`node … load.ts [node|worker|core] peers joinSeconds holdSeconds`. 1,000 peers joining over
60 s, then 30 s of steady state (status every 5 s, metrics every 2 s, a clock probe every 30 s:
733 messages a second in); each joiner also sends 5 clock probes and 12 signals.

| | hello → welcome p50 / p95 / p99 | steady state CPU | CPU per message in |
| --- | --- | --- | --- |
| Node entry (`ws`) | 0.9 / 4.3 / 9.1 ms | 4.6% of a core | 63 µs |
| Worker under `wrangler dev` | 2.2 / 8.5 / 14.3 ms | 49% of a core (both workerd processes) | 672 µs |
| The core alone, no sockets | | | 19 µs (51,000 messages per CPU-second); a join ≈ 2.2 ms (Ed25519 grant) |

`wrangler dev`'s figure is local workerd's, not Cloudflare's: the same workerd spends 1.6 ms of
CPU on a `GET /health` that runs no code of ours, so most of the 672 µs is the dev runtime's own
per-event cost. The core runs on the same V8 in production, so a Durable Object's CPU time per
message is the core's 19 µs plus the platform's per-event overhead, which only a deployed
measurement can give. Stated with that caveat: at the local upper bound (≈ 900 µs a message
with dev overhead) one object serves about **750 peers at half a core**; by the core's own cost,
tens of thousands. The gate's 200 peers are well inside both.
