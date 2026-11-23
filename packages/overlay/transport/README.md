# transport

**Owner: E-transport+topology.** Spec: SPEC §3.2, §4, §5. Milestones: PLAN §5, T1–T2, T5.

One `Link` per neighbour: an `RTCPeerConnection` with a reliable `ctl` channel for `PeerMessage`s
and an unreliable `media` channel for packets. It knows bytes, packets and frames. It does not
know trees, bitrates or codecs.

| To build | In `types.ts` | Notes |
| --- | --- | --- |
| Links | `LinkManager`, `Link` | either side may connect; perfect negotiation; `hello` and the grant check before anything else is believed |
| Sending | `Link.sendPacket`, `SendClass` | the link writes `linkSeq` and `sendMs`; control and audio go ahead of video, live ahead of replay |
| Framing | `Reassembler` (and `packetizeFrame` in `protocol.ts`) | frames from packets for local playout; names what is missing, for NACK |
| The harness's way in | `PacketChannel`, `TransportOptions.wrapChannel` | every channel passes through it once; this is how delay and loss are injected |
| NAT type | `probeNat` | for `Capabilities.nat` |

Rules of this module:

- Nothing here may throw on what arrives from the network. A packet that does not decode is
  counted and dropped.
- No DOM beyond the peer connection and its channels: the forwarding path has to be able to move
  to a Worker (SPEC D2).
- Timers come from the `Clock` in `TransportOptions`.
