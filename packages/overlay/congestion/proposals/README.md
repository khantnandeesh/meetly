# Proposals for files E-congestion does not own

For the integration engineer (`overlay-integration`) and E-transport+topology. Nothing here is
built or imported by this module; each patch applies with `patch -p1` (or `git apply`) at the
repository root of `origin/overlay-integration` as of ee49101, and was checked there.

| Patch | File | What |
| --- | --- | --- |
| `1-simlink-rate-cap.patch` | `topology/sim.ts` | A rate cap on `SimNet`'s wire: `kbps` and `queueMs` (300 if not given). Packets leave one after another at the rate; what waits is the sender's `bufferedAmount`, as a data channel's is; a full queue loses the packet. `bufferedAmount` stays settable, so the tests that play a backed-up channel are unchanged. |
| `2-nack-backlog.patch` | `topology/node.ts` | A NACK is not answered while the child's backlog is over §11.2's strained line (50 ms of *B*). See below. |
| `3-slow-child-on-the-node.test.patch` | `harness/slowChildSim.test.ts` (new) | PLAN C3 in one process on the real `OverlayNode`, with this module's estimator and gate, over the capped wire: children capped at 900 kbps and 1.1 Mbps each get one `layers` to the middle layer within 2 s and every frame of layers 0 and 1, as does the child below them; the siblings and theirs every frame of every layer. |

With all three on ee49101 (and this module at its head) every overlay test passes, the new one
included, except one test that could not bind its port (4268 in use by another run on the
machine).

## Why patch 2

On the real node a child capped at 900 kbps went to the base layer, where this module's own fake
node keeps it on the middle one. The capped link's queue overflows while the top layer is still
being sent; the child asks for what was lost; the parent answers, up to 20% of the bitrate (§4.6),
into the same full queue. The backlog then stands over the congested line for the whole second
after the first drop, and rule 3 ([D31]) rightly reads that as the first drop not having helped,
and drops a second layer. The node's §7.6 then moves the child to another parent.

Holding the answer while the backlog is over the strained line, measured on that tree: one drop,
at +1,067 ms for 900 kbps and +1,200 ms for 1.1 Mbps, to the middle layer, and no move. Without it
the 900 kbps case drops again at +2,100 ms. It is a rule §4.6 does not have yet ("nothing is sent
again into a backlog"), so it wants the integrator's word as well as E-transport's.
