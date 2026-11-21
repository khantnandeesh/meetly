# congestion

**Owner: E-congestion.** Spec: SPEC §11. Milestones: PLAN §5, C1–C6.

What each link can carry, and what to do when that is less than the stream. Arithmetic on numbers
it is handed: it owns no timer, link or channel. Every rule in SPEC §11 is a unit test with a
fake clock before it is anything else.

| Built | In `types.ts` | File | Tests |
| --- | --- | --- | --- |
| Per-link estimates (C1) | `LinkEstimator` | `estimator.ts` | `estimator.test.ts` |
| Layer drop (C2) | `LayerGate` | `gate.ts` | `gate.test.ts`: every numbered rule of §11.3, and §11.5 |
| The source's bitrate (C4) | `SourceRateController` | `sourceRate.ts` | `sourceRate.test.ts` |
| Spare uplink (C5) | `UplinkProbe` | `probe.ts` | `probe.test.ts` |
| Every threshold of §11 | | `tuning.ts` | |
| The send path, faked (C3), through a fake of transport's `Link` | | `sim/` | `slowChild.test.ts`, `sim/world.test.ts`, `sim/link.test.ts` |
| The same on real data channels | | `browser/` | `browser/run.ts` (not part of `npm test`) |

Rules of this module:

- A data channel queues what it cannot send. The whole job is to decide what not to send before
  it is queued: late video is worse than less video.
- Audio and control packets are never refused.
- A frame is sent whole or not at all.
- This module is called by topology; it calls nothing.

## What the node must do with it

`sim/peer.ts` is a fake of topology's node that does exactly this and no more; it is the contract
in code, and the acceptance tests run on it. It sends and receives through transport's `Link`
interface (`transport/types.ts`); `sim/link.ts` is a fake of that link over a simulated pipe or a
real data channel, which stands in until E-transport+topology's is merged.

- **One estimator per link**, `createLinkEstimator({ bitrateKbps })`, where `bitrateKbps` is the
  video stream's full bitrate (*B* of §11.2; 1,200 if not given). Tell it of every packet handed to
  the unreliable channel (`onSent`) and every packet that arrives on it (`onReceived`, with the
  packet's `linkSeq` and `sendMs`), and pass on feedback and heartbeats.
- **One gate per child and stream**, `createLayerGate({ ..., kind })`. Before the first packet of
  each frame, for each child: `estimator.onBuffered(link.bufferedAmount, now)`, then
  `gate.admit(header, frameBytes, estimator.estimate(now), now)`. The answer holds for every
  packet of that frame. A relay does not know a frame's size at its first packet; it passes
  `fragCount × 1,120`, which is close enough (the size is not used by any rule yet).
- **`change`** → `layers` to the child and a `layer` metric. **`starved`** → `layers` with reason
  "congestion", and the child sets STARVED.
- **A NACK for a frame the gate refused is not answered** (`gate.wasSent(frameId)`), or the gate's
  decision is undone by the retransmission.
- **A child sends FEEDBACK every `feedbackMs`** from `takeFeedback(now)`; heartbeats carry
  `echo(now)`.
- **Replay**: ask `gate.replayBudget(estimate, now)` only while there is replay waiting.
- **The source**: `rate.onChildren(node.childEstimates(), now)` as often as feedback arrives
  (100 ms) or once a second; `rate.onHint` from the coordinator; `target` → the encoder.
- **The probe**: `probe.next(probeView(estimator, now), now)` on a 10 ms tick, each size sent as
  one PROBE packet to the parent, until `spareKbps` is a number. The fake sends them in class
  "replay", the lowest, so a probe never delays anything real. A peer that receives PROBE packets
  must answer with FEEDBACK while they keep coming (see below).
- **`onBuffered` before every frame, for every child**, not only when the link looks bad: the
  state reads how long the backlog has stood (item 14 below), so it needs the samples.

## Where the spec was silent, or could not be followed to the letter

Each is the smallest choice that worked. Those marked **(spec)** are now in SPEC.md, decided by
the integrator on 2026-11-21 (§11.2, §11.3, §11.5, §11.6, §8.1); none changes the wire.

1. **Which direction `estimate()` describes.** A link has two, and `LinkEstimate` has room for
   one. It is the direction that carries the media: a peer that hears fresh feedback and sends at
   least as much as it receives is judged on what it sends, otherwise on what it receives. So a
   parent's estimate of a child is what the child reports, and a child's estimate of its parent
   (the `uplink` event, the player's *D*) is what the child measures. `directed("sent" |
   "received", now)` (optional, added to `LinkEstimator`) asks for one by name.
2. **§11.2, "for 500 ms"** is read as applying to `queueDelayMs` only. Backlog is the sender's own
   measurement and loss is already taken over a second.
3. **`queueDelayMs` is each feedback interval's quickest packet against the ten-second floor**,
   not the mean: jitter then does not read as a queue ("bad" has 40 ms of it, the strained line is
   40 ms). A growing queue is therefore seen one feedback interval late.
4. **`deliveredKbps`.** Feedback counts packets, not bytes. The delivered rate is the packets the
   peer counted, priced at the mean size of what was sent in the same second, over the time the
   reports cover on the peer's own clock (`sendMs` of the feedback). Exact when packets are one
   size (a probe); within a few percent for media.
5. **(spec) Audio and the gate.** `LayerGateOptions` did not say what a stream is. Added `kind?:
   "video" | "audio"`. Without it the gate takes stream 1 for audio, which is stage 1 (§2).
6. **(spec) §11.5 against §11.3.** A replay may fill the channel to 250 ms of *B*; rule 6 refuses
   live video over 200 ms; §11.2 calls 150 ms congested. Read together, every join would end with
   the joiner's first live frames refused and a layer dropped. The gate therefore treats the
   backlog as the replay's own for `replayGraceMs` (500) after it last gave a budget: a link that
   is "congested" by backlog alone, with no loss and no queue on the path, is held as *strained*,
   and rule 6's line is the replay's 250 ms. Loss or path delay still count at once.
7. **A frame whose reference was not sent is not sent.** Rule 6 or 7 holding back a base-layer
   frame leaves the rest of the GOP undecodable; sending it would be bitrate for nothing. Frames
   the gate never saw (a replay before it) are assumed sent.
8. **Rule 7, resuming.** Starved ends at the first keyframe that finds the link not congested and
   under rule 6's line; `starved` is announced again if it happens again.
9. **Rule 8** caps at one below the top layer (§7.5: "shed the top temporal layer"), not one below
   wherever the child already is.
10. **Rule 9 and the events.** A cap lowered because the child asked is not announced (the child
    knows; `LayerGateEvents` has no reason for it). Any rise is `restore`.
11. **[D27] with two children.** "At least half congested" is one link when there are two. One
    link is one viewer, so with two or more children it takes two congested links; with one child
    that link is all the uplink there is.
12. **(spec) §11.6 needs feedback going down.** FEEDBACK is child → parent, but a prober must hear
    how its probe fared. A peer that receives PROBE packets sends FEEDBACK back on that link while
    they keep coming, starting its count afresh (`takeFeedback` once, discarded).
13. **(spec) §8.1 and §11.6 do not fit together.** A probe "at 2 × the session's bitrate" can show
    at most 2.4 Mbps of spare uplink; eligibility needs 2 × 1.15 × *B* = 2.76 Mbps, and a fan-out
    of 4 needs 7.9. Nobody could ever be found eligible. The probe therefore takes its target from
    the caller and reports no more than the target; the composition root should ask for
    `maxFanout × 1.15 × B / 0.7` (7,900 kbps for stage 1). It stays harmless on a slow link
    because it never queues more than the link takes between two calls: it finds the link's pace
    rather than flooding it.
14. **(spec, C6) The backlog must stand for 150 ms before it makes a link strained or congested**
    (`backlogWindowMs`). Read sample by sample, §11.2 takes every keyframe for trouble: a 27 kB
    keyframe is more than 150 ms of *B*, all handed to the channel at once, and on a link with
    room for the stream it is gone a few frames later. The cost of the literal reading was that
    a link under about 4.6 Mbps that once lost a layer never got it back (rule 5's five seconds of
    *ok* never came), which would also have pushed the coordinator's audience-wide `hint`
    (§11.4) down for everyone. With the window, a 2 or 3 Mbps link gets the middle layer back
    about 5 s after a squeeze ends and the top 5 s later (`slowChild.test.ts`, "a squeeze, then
    room", which also shows the literal reading staying at the base layer). The price is 150 ms
    of reaction to a real deficit: a 900 kbps child loses its top layer at 700 ms rather than
    533. Rule 6 and the replay budget still read the backlog as it is now, so nothing stale is
    queued meanwhile. Setting the window to 0 gives the spec to the letter.
15. **(spec, C6) Rule 3's second drop waits to see what the first did.** As the integrator set
    it: after a drop, the next waits one observation window, the longer of `dropHoldMinMs`
    (1 s) and `dropHoldRttFactor` (2) × the link's reaction time (`rttMs` + `reactionMs`, 250:
    a feedback interval and the backlog's standing window); and it drops only if the backlog or
    the loss is still over the line. What "still over the line" had to mean, to meet the
    integrator's target (900 kbps and 1.1 Mbps children settle on the middle layer), measured
    in the simulation and in the browser:
    - the loss is at or over §11.2's congested line (10%), or the backlog has stood over the
      congested line (150 ms of *B*) at every frame for the whole window and its low point in
      the window is no lower than in the window before: the last drop did not help;
    - congestion by queue delay alone is not enough. A link that only just carries the middle
      layer reads ok for a second between keyframes and then, for each keyframe's queue,
      congested by delay for half a second, with the backlog under the line (the browser run
      showed this; the literal reading dropped it to the base layer 2 to 6 s in);
    - this holds from the first drop until the cap next rises (rule 5). The first drop, and a
      failed rise's drop back, are as the spec says: at the next frame.

    The first drop's reaction time is unchanged.
16. **(spec, pending: not yet decided by the integrator) Loss counts only where the link shows
    a queue** (`lossNeedsQueue`): `queueDelayMs` at or over 40, or `bufferedBytes` over 50 ms of
    *B*. Simulating the gate mix (`slowChild.test.ts`, "the gate mix's four networks") showed
    the "bad" profile (60 ms, 3% in bursts), which has room to spare, losing a layer to a burst
    that reads 10% for a second, and then a second, and never getting them back, because 3% loss
    keeps it *strained* half the time: below the top layer 76–92% of two minutes in two seeds of
    three. Dropping a layer does not make one packet fewer of random loss lost; NACK (§4.6) is
    what answers it. Congestion that overflows a queue shows the queue too, so it still counts.
    What this misses: a policer that drops without queueing. `lossNeedsQueue: false` is §11.2 to
    the letter. The estimate's `lossPct` is reported as measured either way. A link that needs two drops (600 kbps) gets the
    second one window after the first: at 1.9 s, inside PLAN C3's 2 s. Watching the window lasts
    up to 1.3 s on a 400 ms round trip.

## What was measured

Simulated links (`sim/world.ts`, this module's model of a capped link) and a synthetic program
(`sim/program.ts`: `L1T3`, layer shares 40/60/100%, a keyframe 4× a base delta frame). One of
three children capped at 900 kbps under the 1,200 kbps stream, eight peers. The browser run is
the same tree on real data channels on loopback, with a rate cap in front of one channel; its
three passing runs after rule 3's change had the machine's load average between 2.0 and 4.4
(4 cores, shared; earlier runs went up to 7).

| | Simulated | Browser runs |
| --- | --- | --- |
| First layer dropped, after the cap | 700 ms | 727, 728 ms |
| Cap settled | the middle layer, one drop | the middle layer, one drop |
| What the slow child gets once settled | layers 0 and 1, all decodable: 15 fps | 124 + 123 of 495 frames: 15 fps |
| The slow child told (`layers`) | each change, one hop later | each change |
| Siblings and their subtrees: frames lost | 0 | 0 |
| Siblings' latency p95, change | 0.00 ms | −1.2 to +1.0 ms |
| Slow child's audio lost | 0 | 0 |
| Slow child's video delay, p50 / p95 / max | 101 / 237 / 261 ms | 70 / 229 / 254 ms |
| With room again (3 Mbps): top layer back | +5 s after the last keyframe it struggled with | +5.3, +5.4 s |
| At 1.1 Mbps: one drop, to the middle layer | at 1,200 ms | at 1,324, 1,208 ms |
| At 600 kbps: the base layer | second drop 1,034 ms after the first | not run |
| Uplink probe against 1 / 3 / 10 Mbps | 1.00 / 2.99 / 9.98 | 2.72, 2.69 against 3 |
| Source's uplink filled (3 × 667 kbps): encoder lowered, restored after | 1.0 s, 19 s | not run |
| The gate mix's profiles, one child each, 2 min, 3 seeds | good, home, bad: every layer throughout; slow: the middle layer from 200 ms; the source never moves | not run |

Before C6 the first drop came at 533 / 561 ms, a 900 kbps child ended at the base layer (7.5 fps),
and no child got its layers back on a 3 Mbps link.

The browser run: `NODE_PATH=$(npm root -g) node --experimental-transform-types --import
./test/register.mjs packages/overlay/congestion/browser/run.ts`. About 60 s, port 4240.

## Known, and not fixed here

- **A keyframe takes 237 ms to cross a 900 kbps link**, whatever the gate does. PLAN C3's "no
  video frame more than 200 ms late" cannot hold for keyframes on that link unless keyframes are
  smaller or paced.
- **Below the top layer, a deficit seen only as path delay waits for loss.** Rule 3's second drop
  reads the backlog and the loss, not queue delay. A bottleneck past the sender that queues
  without overflowing shows only as delay, and is shed only once it loses packets.
- **A link slower than the base layer** (about 640 kbps with audio and headers) is announced as
  starved and gets little that decodes: the keyframe alone overflows a 300 ms queue.
- **The delay floor** is ten seconds, as §11.1 says, so a queue that has stood for ten seconds
  becomes the floor and reads as none. The backlog signal still sees it at the sender.
- **The harness shim's `bufferedAmount` counts bytes that are only on their way** (the delay
  line), where `RTCDataChannel`'s does not. With the 150 ms window it does not matter at the
  gate mix's delays (15 to 60 ms), but on "bad" (60 ms) a keyframe in flight reads about 28 kB,
  just under rule 6's 30 kB: a larger real keyframe would be refused as stale in the harness and
  not in a browser. For E-harness.
- **Not measured yet**: anything against the harness's impairment shim (H1) or transport's real
  link and send queue (T1); C4's and C5's harness tests (a capped source uplink, the probe's cost
  to the prober's children's latency); the gate mix. The browser run's links are on loopback.
