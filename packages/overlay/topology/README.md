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
