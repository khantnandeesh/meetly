# media

**Owner: E-media.** Spec: SPEC §9, §10. Milestones: PLAN §5, M1–M6.

Everything between a camera and a packet at the source, and between a frame and a screen or a
loudspeaker at a viewer. It never sees a link or a peer: frames go in and out as `EncodedFrame`
and `ReceivedFrame` (`../types.ts`).

| To build | In `types.ts` | Notes |
| --- | --- | --- |
| The source | `ProgramSource` | WebCodecs VP8 `L1T3` and Opus from two tracks; fills `refDelta`, `keyDelta`, the layer and `captureUs` in every header; never lets the encoder queue |
| The jitter buffer | `JitterBuffer` | pure, and the most precisely specified thing in the package: SPEC §10 is its test list |
| Playout | `Player` | decoders, an AudioWorklet ring buffer, audio as the master clock, the picture as a `MediaStreamTrack` |
| Light mode | `PlayerOptions.decode = false` | for the harness: the real jitter buffer and clocks, no decoder |
| What this browser can decode | `probeDecoders` | for `Capabilities.decode` |

Rules of this module:

- The payload is opaque to everyone but the source's encoder and the viewer's decoder. Anything
  a relay or a jitter buffer needs to know about a frame is in its header. SFrame (stage 2) will
  make that a fact rather than a discipline.
- Missing video may stall, briefly; missing audio never waits.
- `MediaStreamTrackProcessor`, `VideoTrackGenerator` and `AudioWorkletProcessor` are not in
  TypeScript's DOM library: declare what you use in this directory.
