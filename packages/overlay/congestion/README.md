# congestion

**Owner: E-congestion.** Spec: SPEC §11. Milestones: PLAN §5, C1–C6.

What each link can carry, and what to do when that is less than the stream. Arithmetic on numbers
it is handed: it owns no timer, link or channel. Every rule in SPEC §11 is a unit test with a
fake clock before it is anything else.

| To build | In `types.ts` | Notes |
| --- | --- | --- |
| Per-link estimates | `LinkEstimator` | RTT from echoes, loss from `linkSeq`, queue delay from `sendMs`, jitter, `bufferedAmount`; and the body of the feedback packet for the other side |
| Layer drop | `LayerGate` | one per child and stream; one answer per frame; the nine rules of SPEC §11.3 |
| The source's bitrate | `SourceRateController` | follows the source's own uplink and the coordinator's `hint`, never one viewer |
| Spare uplink | `UplinkProbe` | decides who may relay (SPEC §8.1) |

Rules of this module:

- A data channel queues what it cannot send. The whole job is to decide what not to send before
  it is queued: late video is worse than less video.
- Audio and control packets are never refused.
- A frame is sent whole or not at all.
- This module is called by topology; it calls nothing.
