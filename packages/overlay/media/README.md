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

## The delay, as built

A frame is played at `captureUs` + *path* + *D* + the sound's way out, not at `captureUs` + *D*
as SPEC §10.1 reads: *path* is the floor of (arrival − `captureUs`) over the last second for the
slower stream (followed at once when the last 200 ms say it grew), *D* is §10.2's, and the
sound's way out is the worklet's 15 ms lead plus the sound card's output latency (a light viewer
assumes 40 ms). Glass-to-glass is then §10.2's encode + hops + *D* + playout. See `player.ts`.

## Running it

- Unit tests (fake clock, fake decoders, the real sequencer): `npm run test:overlay`.
  `tuning.test.ts` prints how the player does under each of the gate's network profiles.
- Browser runs (headless Chromium, fake camera and microphone, ports 4220–4239):

  ```
  node --experimental-transform-types --import ./test/register.mjs packages/overlay/media/browser/run.ts <scenario> ['{"seconds":20}']
  ```

  Scenarios: `m1` (the source), `deps` (are the headers true: decode with frames removed, to the
  same pixels), `m3` (glass-to-glass, layer removal, a `<video>`), `clap` (flash and click at
  the same `captureUs`, through the player), `av` (the same, through the real source), `m5`
  (light against decoding viewers; a parent's death and the replay). `OVERLAY_MEDIA_JSON=1`
  prints everything measured.

  On a 4-core machine shared with other work, Chromium's VP8 encoder at 1280 wide (where it
  uses 4 threads) can fall to 5–15 fps; 1272 wide (2 threads) does not. Pass `"width":1272`, or
  a smaller program, to measure the rest.
