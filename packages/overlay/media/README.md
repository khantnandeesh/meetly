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

## The bitrate, held

Chromium's VP8 encoder overshoots its target on busy pictures (1,200 kbps asked at 1280×720: a
grainy drifting pattern 1.6–2.2 Mbps, fine detail 5.5–8.2 Mbps under L1T3, noise 63 Mbps in every
mode; WebCodecs has no VP8 quantiser to set). `rateControl.ts` holds the stream to its bitrate:
it asks the encoder for less (to a quarter), does not encode a frame that would not fit two
seconds of the bitrate +15% (checked at every frame, so every window is bounded), keeps room for
a keyframe due soon, and, when that still skips a quarter of the frames or a keyframe passes
250 ms of the bitrate, makes the picture smaller (to 320×180), trying it bigger again later. A
new size is a new configId; the player does not reset its decoder for it (a VP8 keyframe carries
its size). The first frame of a new input cannot be predicted, so the first window may be over.

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

  `.github/workflows/overlay-media.yml` runs them all on a GitHub runner (4 cores, otherwise
  idle) whenever media changes on `overlay-media`; the numbers are in the job summary.

  **1280 wide.** Chromium's VP8 encoder uses 4 threads from 1280 wide, 2 below. On a 4-core
  development machine shared with other work it fell to 5–15 fps at 1280, and not at 1272. On
  the runner it holds: 1,121 kbps of 1,200, capture to frame p95 7.1 ms, 4 frames skipped in 60 s.
  With a second 720p decoder in the same page it still makes its rate (1,056 kbps) but p95 is
  82 ms and 85 frames are skipped, where 1272 wide is 6.1 ms and none. So the default stays
  1280×720, as SPEC §9.2 says; a host machine that is also decoding the stage and composing it
  is the case to watch, and 1272×720 is the fallback (it travels in `StreamConfig`).
