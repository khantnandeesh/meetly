# The Meetly overlay: build plan

Who builds what, in what order, and how five people work in one package without colliding.
[SPEC.md](./SPEC.md) says what is being built; this says how the work is split. Section numbers
(§) refer to SPEC.md.

Phase 0 (done, on the branch `overlay-engine`) left: the spec, `packages/overlay/protocol.ts`
complete with tests, a typed skeleton whose every factory throws `not implemented` and names its
owner, and CI.

## 1. The five

| Engineer | Owns (may edit freely) | Builds |
| --- | --- | --- |
| **E-transport+topology** | `packages/overlay/transport/`, `packages/overlay/topology/` | links, framing, the GOP cache, heartbeats, the repair state machine, forwarding, scoring |
| **E-media** | `packages/overlay/media/` | capture and encode, the jitter buffer, decode, audio playout, A/V sync |
| **E-congestion** | `packages/overlay/congestion/` | link estimates, layer drop, the source's bitrate, the uplink probe |
| **E-coordinator** | `packages/overlay/coordinator/` | the core, both entry points, the browser's client |
| **E-harness** | `packages/overlay/harness/`, `.github/workflows/overlay-swarm.yml` (new) | the swarm runner, impairment, churn, metrics, the report |

The architect (whoever leads; Phase 0's author) owns the shared files of §3 and
`packages/overlay/index.ts`, which puts the modules together into `createOverlayViewer` and
`createOverlaySource`.

Each module directory has `types.ts` (its contract with the others), `index.ts` (its factories,
now stubs) and a `README.md`. An owner adds whatever other files they like inside their
directory. Tests sit beside the code as `*.test.ts`; `npm test` and `npm run test:overlay` pick
them up.

## 2. Working rules

1. **Stay in your directory.** A change outside it is a change to someone else's work or to a
   shared file, and goes by §3.
2. **Build against interfaces, with fakes.** Every factory takes its dependencies as arguments
   (`OverlayNodeOptions.createLayerGate`, `TransportOptions.peerConnection`, a `Clock`). In week
   1 nobody's real module exists; write a fake of what you need in your own test files, from the
   other module's `types.ts`. Do not import another module's implementation, only its
   `types.ts` (and `index.ts` from the composition root and the harness).
3. **No timers, no clocks.** Take `Clock` and `SessionClock` (`runtime.ts`). A state machine
   that cannot be stepped by a fake clock in a unit test is not done.
4. **Branches.** Work on `overlay/<your-name>` cut from `overlay-engine`; rebase on it daily;
   merge to it only with `npx tsc --noEmit`, `npm run overlay:check`, `npm run lint` and
   `npm test` passing. Never push to `main` or `cloudflare-deploy`.
5. **A stub you replace** loses its line in `packages/overlay/skeleton.test.ts`, in the same
   commit as the tests that replace it. That file is the list of what is still not built.
6. **Ports 4100–4199** for anything a test starts. Stop what you start.
7. **The app is not touched.** Nothing under `src/` imports the package until the integration
   step (§7); ESLint fails the build if it does.

## 3. Shared files, and changing an interface

These belong to no engineer. Nobody edits them inside a feature commit.

| File | What it is |
| --- | --- |
| `docs/overlay/SPEC.md` | the design |
| `packages/overlay/protocol.ts` (+ its test) | the wire |
| `packages/overlay/runtime.ts`, `types.ts`, `index.ts` | clocks; cross-module types; the composition root |
| `packages/overlay/*/types.ts` | each module's contract: owned by its engineer, but frozen as below |
| `package.json`, `package-lock.json`, `tsconfig.json`, `packages/overlay/tsconfig.json`, `eslint.config.mjs`, `test/register.mjs` | tooling |
| `.github/workflows/ci.yml` | CI |

**Changing one** (a wire field, a method on another module's interface, a dependency):

1. Say what and why to the architect and to whoever else uses it, in one short note.
2. The change lands on `overlay-engine` as **its own commit**, titled `interface: …`, containing
   only the shared file, its test, the SPEC paragraph, and the smallest edits that keep
   everything compiling. No feature work rides with it.
3. Everyone rebases on it before their next merge.

A module's own `types.ts` follows the same rule once anyone else has built against it: its owner
may *add* to it freely (a new optional field, a new method nobody else implements), but changing
or removing what is there is an `interface:` commit.

Dependencies are already in place so that nobody needs `package.json`: `ws` and `@types/ws` (the
Node coordinator), `esbuild` (the harness's page bundle). Playwright is not a dependency of this
repository: tests find it through `NODE_PATH`, as `test/e2e` does. A new dependency is an
`interface:` commit, and needs a reason a browser API or thirty lines would not answer.

## 4. Who can collide with whom

For each pair: the file where their work meets, and the rule that keeps it from being a merge
conflict.

| Pair | Where they meet | Rule |
| --- | --- | --- |
| transport+topology ↔ congestion | `congestion/types.ts` (`LinkEstimator`, `LayerGate`), called from topology's forwarding loop | Topology calls; congestion never edits a topology file. Topology receives the factories as options and tests with fakes. A gate rule that needs a new input is an `interface:` commit on `congestion/types.ts`. |
| transport+topology ↔ media | `types.ts` (`ReceivedFrame`, `LayerCap`); `media/types.ts` (`Player.push`, `oldestWanted`, `wantedLayers`) | They never call each other. `index.ts` (the architect's) connects `OverlayNode`'s `frame` event to `Player.push`. Either side proposes; the architect edits `types.ts`. |
| transport+topology ↔ coordinator | `topology/types.ts` (`CoordinatorPort`); `topology/index.ts` (`judgeRelay`, `parentCost`), which placement imports | `CoordinatorPort` is topology's; the coordinator's client implements it. The two scoring functions are topology's and are the **only** topology code the coordinator imports; they are pure and land in week 1 (T2) so placement is not blocked. |
| transport+topology ↔ harness | `transport/types.ts` (`PacketChannel`, `wrapChannel`) | The hook is transport's; the shim is the harness's. The harness never patches transport to observe it: what it needs to see comes out in `MetricsSample`. |
| media ↔ congestion | `Player.setLinkHints` and `wantedLayers`; `LinkEstimate` in `types.ts` | Neither imports the other. Numbers pass through `index.ts`. |
| media ↔ harness | `PlayerOptions.decode` (light viewers); the `rendered` event | Light mode is media's to build (M5) and must go through the real jitter buffer. The harness does not fake a player. |
| media ↔ coordinator | `StreamConfig` (in `protocol.ts`) | Shared file. |
| congestion ↔ coordinator | the `hint` message; the audience-wide rule of §11.4 | The coordinator computes the hint from `MetricsSample`s; congestion only consumes `onHint`. The thresholds live in the coordinator. |
| congestion ↔ harness | `ImpairmentProfile`'s meaning (what "3% loss" and "900 kbps" do to a link) | The harness owns the shim and its statistical tests (H1). Congestion tests its estimator against synthetic traces of its own, then against the shim; a disagreement is settled by the shim's tests, not by tuning. |
| coordinator ↔ harness | `coordinator/node.ts` (`startNodeCoordinator`, `kill`, the metrics route); ticket signing | The Node entry point is the coordinator's. The harness starts it and signs tickets with `signTicket` from `protocol.ts`. A hook the harness needs is asked for; the harness does not edit `coordinator/`. |
| everyone ↔ everyone | `protocol.ts`, `skeleton.test.ts`, `SPEC.md` | §3. `skeleton.test.ts` is the one shared file everyone edits: each removes only their own lines, one line per commit, which merges cleanly. |
| everyone ↔ harness | `harness/page/` (the page that runs a whole peer) | It uses only `createOverlayViewer` / `createOverlaySource` from `index.ts`, plus `wrapChannel`. If the page needs to reach inside a module, the public API is missing something: say so. |

## 5. Milestones

Weeks are a guide to order, not a promise. "Proof" numbers are from SPEC §17. Every acceptance
test is a test in the repository that fails before and passes after; "harness scenario" means a
named scenario E-harness provides and anyone can run with one command.

### E-transport+topology

| | Deliverable | Accepted when |
| --- | --- | --- |
| **T1** (wk 1) | `LinkManager` and `Link` on `RTCPeerConnection`: the two channels, `hello` with grant check, glare, send classes, counters | Unit: against a fake peer connection, two managers that both call `connect` at once end with one open link (§5.1); a bad or missing `hello` closes with "auth-failed"; "control" and "audio" are sent ahead of queued "video". Browser (two pages, host candidates): link open and authenticated in under 150 ms p95. |
| **T2** (wk 1) | `Reassembler`, `GopCache`, `judgeRelay`, `parentCost`, `createParentSelector`: all pure | Unit: 10,000 random frames delivered with reordering, 5% loss and duplicates: every complete frame comes out once and byte-identical; `missing()` names exactly the lost fragments, none before `reorderMs`. Cache: `replay(fromFrame)` returns what a decoder needs and no more, for each `fromFrame` case of §5.3; limits hold. Scoring: one test per row of the table in §8.1, and the formulas of §8.2–§8.3 to the digit. |
| **T3** (wk 2) | `OverlayNode` on a fixed tree: forwarding, heartbeats, failure detection, warm and cold repair, `sub`/`repair`/`sub-ack` | Unit (fake links, fake clock): a parent silent for 200 ms is detected between 200 and 210 ms; `repair` goes to the backup with the right `fromFrame`; nothing is sent to the coordinator before `sub-ack`. Harness scenario **proof-tree** (7 peers, clean, relay 1 killed): freeze p95 ≤ 250 ms (proof 206–209), 0 frames lost, `usedCoordinator` false; cold variant ≤ 300 ms (proof 225–227); forwarding p50 ≤ 1 ms per hop (proof 0.45). |
| **T4** (wk 3) | Join through the coordinator (§7.1), backups kept fresh (§7.3), STALLED (§7.4), paths and loop refusal (§7.2), leaving (§7.7) | Unit: in 1,000 seeded random runs of 50 simulated nodes with joins, kills and switches, no node is ever in its own path and every live node is `active` within 3 s of the last event. Harness scenario **chain-kill** (depth 3, the depth-1 relay killed): depth-2 children repair; depth-3 peers report `kind: "wait"`, do not change parent, and freeze ≤ 300 ms. Graceful leave: children's freeze ≤ 100 ms. |
| **T5** (wk 4) | NACK and retransmission (§4.6); rebalancing (§7.6); overload on repair (§7.5); `probeNat` | Harness: a link with 3% loss shows under 0.3% of frames lost at the leaf, with retransmissions under 20% of the bitrate. A peer placed under a parent 80 ms away with one 15 ms away available switches within 45 s, once, with no freeze. A backup at its fan-out accepts a `repair` and caps layers instead of refusing. |
| **T6** (wk 5) | Whatever the gate run finds | The gate (§12.3). |

### E-media

| | Deliverable | Accepted when |
| --- | --- | --- |
| **M1** (wk 1) | `ProgramSource`: VP8 `L1T3` and Opus from two tracks, headers filled, `captureUs` on the session clock | Browser (fake camera): over 60 s the video bitrate is within 15% of the target; a keyframe every 60 frames; every frame's `temporal`, `refDelta`, `keyDelta` and DISCARDABLE flag obey §9.2 (checked by a decoder that follows only the headers); capture to `frame` event p95 ≤ 40 ms; the encoder never holds more than 2 frames. |
| **M2** (wk 1–2) | `JitterBuffer`: pure | Unit, fake clock: one test per sentence of §10.1–§10.4. Among them: out-of-order input comes out in decode order; a missing layer-2 frame never stalls; a missing base frame stalls ≤ 150 ms then skips to the next keyframe; after a 1.5 s replay burst the buffer is within *D* of live after one `pop`; *D* follows the formula of §10.2 and falls no faster than 10 ms/s. |
| **M3** (wk 2–3) | `Player`, video: decode, render to a `MediaStreamTrack`, `rendered` / `firstFrame` / `freeze` events | Browser, source and player in one page with frames handed across directly: glass-to-glass p95 ≤ 130 ms at *D* = 60; 0 decode errors over 5 minutes with 10% of layer-2 and 5% of layer-1 frames removed at random; a `<video>` element shows the track. |
| **M4** (wk 3–4) | Audio: Opus decode, AudioWorklet ring buffer, A/V sync, concealment, autoplay handling | Browser: a clap test pattern (a flash and a click at the same `captureUs`) plays with the two within ±45 ms, measured from the worklet's clock and the `rendered` event; a lost audio frame is concealed and counted, never a gap of raw silence under 40 ms; with duplicates (§9.4) nothing is played twice. |
| **M5** (wk 3) | Light mode (`decode: false`); catch-up after repair | Light and decoding viewers of the same stream report latency within 15 ms of each other at p50. Harness scenario **proof-tree**: latency back to normal within 300 ms of the kill (proof 173–245). |
| **M6** (wk 4–5) | `wantedLayers` (window size, decode time), `probeDecoders`, tuning under the gate mix | A viewer whose decode time exceeds the frame interval asks for a lower layer within 2 s and recovers. The gate. |

### E-congestion

| | Deliverable | Accepted when |
| --- | --- | --- |
| **C1** (wk 1) | `LinkEstimator` | Unit, synthetic traces: loss reported within 1 point of the truth at 1%, 5% and 20% (across a `linkSeq` wrap); RTT within 2 ms across a `sendMs` wrap; `queueDelayMs` rises within 300 ms of a queue forming and is unmoved by 100 ppm of clock drift; state transitions exactly as the table in §11.2. |
| **C2** (wk 1–2) | `LayerGate` | Unit, fake clock: one test per numbered rule of §11.3, including the doubling back-off and that audio and control are never refused. |
| **C3** (wk 2–3) | Wired into the node with T3 | Harness scenario **slow-child** (one viewer capped at 900 kbps under a 1,200 kbps stream): its cap settles within 2 s; no video frame reaches it more than 200 ms late; its audio has 0 concealed ms; its siblings' latency p95 moves by under 10 ms. |
| **C4** (wk 3–4) | `SourceRateController`; with E-coordinator, the `hint` | Unit: the rules of §11.4. Harness: capping the source's own uplink at 2 Mbps with 3 children lowers the encoder within 3 s and restores it within 30 s of the cap lifting. |
| **C5** (wk 4) | `UplinkProbe` | Harness: against caps of 1, 3 and 10 Mbps the estimate is within 25%; the probe adds under 5 ms to the prober's children's latency p95. |
| **C6** (wk 5) | Tuning under the gate mix | The gate. |

### E-coordinator

| | Deliverable | Accepted when |
| --- | --- | --- |
| **K1** (wk 1) | `CoordinatorCore`: tickets, `hello` / `welcome`, grants, `time`, `signal` relay, limits | Unit, the core driven directly: a ticket is accepted once and never twice; a wrong secret, room or expiry closes with 4001; the cap closes with 4002 but never the source; `signal` between peers never introduced is refused; every `ClientMessage` type is answered or ignored as §6.3 says; garbage gets `error bad-message`. |
| **K2** (wk 1–2) | The tree map from `status`; placement; `need` | Unit: 200, then 1,000, simulated joins with a quarter able to relay: depth ≤ ⌈log₄(n)⌉ + 1; no relay is offered beyond its free slots; for ≥ 95% of peers the first backup's path avoids the first parent; a relay silent for 3 × `statusMs` is no longer offered; `restore` after losing memory rebuilds the map from `status` within one `statusMs`. Placement uses topology's `judgeRelay` and `parentCost` (T2). |
| **K3** (wk 2) | `startNodeCoordinator` (`ws`); `CoordinatorClient`: reconnect with `resume`, session clock, `Signaler`, `CoordinatorPort` | A **contract suite**, written against a URL, passes against the Node server. Client: clock error under 5 ms on loopback; after `kill()` and restart the client is `connected` again within 3 s with the same `PeerId`, having raised `offline` once. |
| **K4** (wk 3) | `OverlayRoom` and the Worker; `wrangler.jsonc` for `meetly-overlay`; hibernation | The same contract suite passes against `wrangler dev` on a port in 4100–4199. A session survives the object being evicted mid-run (forced in the test): sockets stay, the map returns. Nothing in the app's Worker or on `cloudflare-deploy` changes. |
| **K5** (wk 3–4) | Promotion and demotion (§6.6, §8.1); unasked rebalancing; the audience-wide `hint`; `/stats`, `/end`, `/kick` | Unit: a leaf that becomes eligible is promoted only when free slots are under a fifth of the audience; a relay whose children report 5% loss for 10 s is demoted. `/stats` answers what `webinarGate`'s `watching()` needs. |
| **K6** (wk 4–5) | Load | Node: 1,000 sockets join in 60 s with p95 `hello` → `welcome` under 200 ms. Worker: CPU time per message measured and written down; the number of peers one object can serve stated, with the measurement. |

### E-harness

| | Deliverable | Accepted when |
| --- | --- | --- |
| **H1** (wk 1) | `createImpairment`; the page bundle (esbuild) and a local server on 4100–4199 | Unit: over 100,000 packets each profile's loss is within 0.2 points of its setting, mean delay within 1 ms, delivered rate within 3% of a cap; bursts have the configured mean length; the same seed gives the same drops. |
| **H2** (wk 2) | `runShard` for one machine; scenario **proof-tree**; the CI smoke test | The placeholder in `harness/smoke.ts` is replaced: 7 peers, one relay killed, asserts every viewer rendered again within 1 s and lost 0 frames. The `overlay` job installs Playwright (as the `e2e` job does) and runs it in under 3 minutes. Until T3 and K3 exist it runs against the real page with whatever is built, and says what it skipped. |
| **H3** (wk 2–3) | Churn scripts; collecting samples; `buildReport` with p50 / p95 / p99 and the gate's verdict | Unit: `buildReport` on hand-made `ShardResult`s gives the quantiles expected, merges shards in any order to the same report, and marks a run invalid for each reason in §12.3. Scenarios **chain-kill**, **slow-child** and **gate-small** (the gate's mix and churn at 30 peers) run with one command each. |
| **H4** (wk 3–4) | 30–60 peers on this machine with light viewers; starvation detection | A 40-peer **gate-small** run is valid by §12.3 on 4 shared cores, or the harness reports the largest size that is. |
| **H5** (wk 4) | `overlay-swarm.yml`: a matrix of shards against one coordinator, artifacts, a report job | **First, a two-runner experiment**, written up: can shards reach one coordinator (which, how), and can peers on different runners link directly (what share needed TURN)? Then: 4 shards × 25 peers produce one valid report. |
| **H6** (wk 5) | The gate run | 200 peers, §12.3, a valid report. Pass or fail, with the numbers. |

## 6. Order and dependencies

```
week 1   T1 T2        M1 M2        C1 C2        K1 K2        H1
            \           \            \           |           /
week 2       T3 <------- (fakes) ---- C3 ------- K3 ------ H2      first real swarm: 7 peers
              |            M3                     |          |
week 3       T4           M3 M5       C3          K4 K5     H3 H4
              |            M4          |           |          |
week 4       T5           M4 M6       C4 C5       K5 K6     H5
               \            \           \          |         /
week 5        T6 ---------- M6 --------- C6 ------ K6 ----- H6     the gate
```

What blocks what:

- **T2's scoring functions block K2.** They are pure and small; do them first.
- **T3 needs a coordinator only for signalling.** Until K3, the harness's **proof-tree** scenario
  provides a stand-in that implements `Signaler` and `CoordinatorPort` over Playwright, as the
  proof's `tree.js` did.
- **H2 needs T1 and T3** to have anything to run; it is written against `createOverlayViewer`
  and fails with `NotImplementedError` until they exist, which is the signal.
- **`index.ts` (the architect)** composes the modules at the end of week 2, as soon as T3, M2,
  C2 and K3 exist, with media stubbed by the light player until M3.
- **C3, M5 and T4 meet in week 3** in the forwarding loop and the player. This is where the
  `interface:` rule earns its keep.
- **H5's experiment** can start in week 2; nothing depends on the overlay working for it.

Nothing else is sequential: within a week each engineer needs only the others' `types.ts`.

## 7. After stage 1

### Stage 2: several trees, parity, encryption, grants

| Work | Owner | Notes (SPEC §15.1–§15.2) |
| --- | --- | --- |
| *k* trees per stream; "interior in at most one tree" | E-coordinator | placement builds *k* trees; `Assignment` is already per stripe |
| Stripes repair independently | E-transport+topology | lift D14; the state machine is already per stripe |
| Base layer on two trees | E-media (config), E-transport+topology (dedup) | one line of `StreamConfig`; the proof's "no visible gap" result is the acceptance test |
| Parity stripe | E-transport+topology (decoder beside the reassembler), E-media (encoder at the source) | fix the code and the PARITY payload in an `interface:` change |
| SFrame | E-media | encrypt before packetizing, decrypt after reassembly; relays unchanged |
| Source signature | E-media + E-coordinator | closes SPEC §14 item 1; must land before a real audience |
| Key rotation, moderation scopes | E-coordinator | remove = rotate `kid`; mute and stage as grant scopes |
| `keyreq`, limited at the source | E-transport+topology, E-media | |
| Source handover | E-coordinator, E-media | a session survives its host's tab |
| Congestion control proper | E-congestion | a rate estimate per link rather than three states; pacing |

Gate for stage 2: stage 1's gate, plus no visible gap on a relay's death with a redundant base
layer, plus the same latency with SFrame on.

### Stage 3: more browsers, more people

| Work | Owner |
| --- | --- |
| Safari and Firefox as leaves: receive side only, Worker clock, track output | E-media, E-transport+topology |
| Phones as leaves: decode cost, background behaviour, data use | E-media |
| Gossip fallback: `peers` and `sig` over the overlay; cold repair without the coordinator | E-transport+topology |
| Coordinator per region under a session object | E-coordinator |
| Soak tests at 1,000 and 10,000: sharded runs of an hour; memory, drift, the coordinator's load | E-harness |

### Integration into Meetly

Not before stage 1's gate passes. Then, in this order, each its own change with the app's own
tests:

1. **Read the app's framework first.** `AGENTS.md`: this Next.js is not the one anyone
   remembers; read `node_modules/next/dist/docs/` before touching `src/`.
2. **Tickets.** A route handler that, after `webinarGate` and the pass cookie say yes, signs a
   ticket with `signTicket` (role "source" for the host, "viewer" for the audience). The gate's
   `watching()` reads the coordinator's `/stats`.
3. **An `overlay` viewer adapter behind `RtcCall`** (`src/lib/rtc/overlay.ts`). It is not a third
   provider: `RtcProviderName` stays as it is. It is what a webinar *viewer* gets instead of a
   provider connection: `mode: "webinar"`, `local.role: "viewer"`, one tile whose track is the
   program (`OverlayViewer.videoTrack()`), `audioBlocked` from the player, `quality()` from the
   overlay's own metrics. `ViewerCall.tsx` chooses it. This is the first import of the package
   from `src/`, so the ESLint rule that forbids it is narrowed to allow exactly that file.
4. **The program source in the host's call.** The host's browser composes the stage (a canvas
   and a Web Audio mix of the provider's tracks; in a Worker, so a hidden tab keeps sending)
   and hands the two tracks to `createOverlaySource`.
5. **Being brought on stage.** A viewer the host invites leaves the overlay and joins the
   provider's stage, as `switching` already models for a co-host; sent back, the reverse.
6. **Chat, polls, hands and the viewer count on the coordinator.** Today these ride the provider's
   data channel, which overlay viewers are not connected to. They become coordinator messages
   (new `ClientMessage` / `ServerMessage` types, an `interface:` change), fanned out over the
   WebSocket, with the server-signed chat and poll rules kept as they are. This is the largest
   piece and is designed on its own before it is built.
7. **Consent and controls** (SPEC §14, items 2 and 3): what viewers are told about relaying and
   addresses, the switch that makes them a leaf, the TURN-only option.
8. **Deploy** the `meetly-overlay` Worker; set `NEXT_PUBLIC_OVERLAY_URL` and the two secrets;
   behind a flag, off by default, like `MEETLY_WEBINARS_ENABLED`.

## 8. Checks before anything merges to `overlay-engine`

```
npx next typegen && npx tsc --noEmit        # the whole repository, the app's settings
npm run overlay:check                       # the package, its own stricter settings
npm run lint
npm test                                    # the app's tests and the package's
NEXT_PUBLIC_RTC_PROVIDER=livekit npm run build   # the app still builds, without the package in it
```

CI runs the same on every push (`.github/workflows/ci.yml`: `checks`, `overlay`, `build`,
`e2e`).
