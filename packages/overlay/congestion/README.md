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
| The send path, faked (C3) | | `sim/` | `slowChild.test.ts`, `sim/world.test.ts` |
| The same on real data channels | | `browser/` | `browser/run.ts` (not part of `npm test`) |

Rules of this module:

- A data channel queues what it cannot send. The whole job is to decide what not to send before
  it is queued: late video is worse than less video.
- Audio and control packets are never refused.
- A frame is sent whole or not at all.
- This module is called by topology; it calls nothing.

## What the node must do with it

`sim/peer.ts` is a fake of topology's node that does exactly this and no more; it is the contract
in code, and the acceptance tests run on it.

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
  one PROBE packet to the parent, until `spareKbps` is a number. A peer that receives PROBE
  packets must answer with FEEDBACK while they keep coming (see below).

## Where the spec was silent, or could not be followed to the letter

Each is the smallest choice that worked. Those marked **(spec)** want a line in SPEC.md from the
architect; none changes the wire.

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

## What was measured

Simulated links (`sim/world.ts`, this module's model of a capped link) and a synthetic program
(`sim/program.ts`: `L1T3`, layer shares 40/60/100%, a keyframe 4× a base delta frame). One of
three children capped at 900 kbps under the 1,200 kbps stream, eight peers:

| | Simulated | Browser run (real data channels, loopback) |
| --- | --- | --- |
| First layer dropped, after the cap | 533 ms | 561 ms |
| Cap settled (at the base layer) | 1,033 ms | 1,061 ms |
| Siblings and their subtrees: frames lost | 0 | 0 |
| Siblings' latency p95, change | 0.00 ms | −0.4 to −0.9 ms |
| Slow child's audio lost | 0 | 0 |
| Slow child's video delay, p95 / max | 258 / 260 ms | 246 / 248 ms |
| Uplink probe against 1 / 3 / 10 Mbps | 1.00 / 2.99 / 9.98 | 2.68 against 3 |

The browser run: `NODE_PATH=$(npm root -g) node --experimental-transform-types --import
./test/register.mjs packages/overlay/congestion/browser/run.ts`. About 40 s, port 4240.

## Known, and not fixed here

- **On a 900 kbps link the cap ends at the base layer, not the middle one**, though the middle
  one fits on average (833 of 900 kbps). A keyframe is about 27 kB, more than 150 ms of *B*, so on
  that link every keyframe reads as a moment of congestion and the five seconds of *ok* that
  rule 5 asks for never come. The same keyframe keeps any link slower than about 4.6 Mbps from
  being *ok* for five seconds running, so such a link that has once dropped a layer does not get
  it back while the cap lasts. This is §11.2's thresholds meeting real keyframes, and is the
  first thing for C6 to settle against the shim and a real encoder.
- **A keyframe takes 237 ms to cross a 900 kbps link**, whatever the gate does. PLAN C3's "no
  video frame more than 200 ms late" cannot hold for keyframes on that link unless keyframes are
  smaller or paced.
- **A link slower than the base layer** (about 640 kbps with audio and headers) is announced as
  starved and gets little that decodes: the keyframe alone overflows a 300 ms queue.
- **The delay floor** is ten seconds, as §11.1 says, so a queue that has stood for ten seconds
  becomes the floor and reads as none. The backlog signal still sees it at the sender.
