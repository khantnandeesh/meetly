/**
 * A fixed tree of fake peers over simulated pipes, with a synthetic program at its root, and
 * what each viewer got out of it. The deterministic half of the module's acceptance tests.
 */
import { createSourceRateController } from "../sourceRate";
import { FakePeer, type FrameRecord } from "./peer";
import { AUDIO_STREAM, STAGE1_SHAPE, VIDEO_STREAM, createSyntheticProgram, type ProgramShape } from "./program";
import { SimPipe, World, seeded, type PipeProfile } from "./world";

export type TreePeer = {
  id: string;
  /** Null for the source. */
  parent: string | null;
  /** The pipe from the parent to this peer. */
  down?: PipeProfile;
  /** The pipe from this peer to its parent: feedback, and probes. */
  up?: PipeProfile;
};

export type TreeOptions = {
  peers: TreePeer[];
  seed?: number;
  shape?: ProgramShape;
  tickMs?: number;
  /** Run a `SourceRateController` at the source, fed its children's estimates once a second, with the encoder obeying it. */
  sourceRate?: { minKbps: number };
};

const CLEAN: PipeProfile = { delayMs: 5 };

export function createSimTree(options: TreeOptions) {
  const world = new World();
  const random = seeded(options.seed ?? 1);
  const shape = options.shape ?? STAGE1_SHAPE;
  const program = createSyntheticProgram(shape);
  const peers = new Map<string, FakePeer>();
  const pipes = new Map<string, { down: SimPipe; up: SimPipe }>();
  const depthOf = (peer: TreePeer): number => (peer.parent === null ? 0 : 1 + depthOf(options.peers.find((other) => other.id === peer.parent)!));

  options.peers.forEach((spec, index) => {
    peers.set(
      spec.id,
      new FakePeer({
        id: spec.id,
        depth: depthOf(spec),
        streamKbps: shape.videoKbps,
        temporalLayers: 3,
        frameIntervalMs: program.frameIntervalMs,
        audioFrameMs: shape.audioFrameMs,
        // Clocks that agree on nothing, and one that wraps `sendMs` within any run.
        clockOffsetMs: index * 7919 + 60_000,
      }),
    );
  });
  for (const spec of options.peers) {
    if (spec.parent === null) continue;
    const child = peers.get(spec.id)!;
    const parent = peers.get(spec.parent)!;
    const down = new SimPipe(world, spec.down ?? CLEAN, random);
    const up = new SimPipe(world, spec.up ?? { delayMs: (spec.down ?? CLEAN).delayMs }, random);
    down.onmessage = (packet, at) => child.fromParent(packet, at);
    up.onmessage = (packet, at) => parent.fromChild(spec.id, packet, at);
    child.setParent(up);
    parent.addChild(spec.id, down, 0);
    pipes.set(spec.id, { down, up });
  }

  const source = peers.get(options.peers.find((spec) => spec.parent === null)!.id)!;
  world.every(program.frameIntervalMs, () => source.publish(program.video(world.now * 1000), world.now));
  world.every(shape.audioFrameMs, () => source.publish(program.audio(world.now * 1000), world.now));
  world.every(options.tickMs ?? 5, () => {
    for (const peer of peers.values()) peer.tick(world.now);
  });

  const targets: { at: number; kbps: number }[] = [];
  const rate = options.sourceRate ? createSourceRateController({ maxKbps: shape.videoKbps, minKbps: options.sourceRate.minKbps }) : null;
  if (rate) {
    rate.on("target", (kbps) => {
      targets.push({ at: world.now, kbps });
      program.setVideoKbps(kbps);
    });
    // What `OverlayNode.childEstimates()` will hand the source, looked at as often as feedback comes.
    world.every(
      100,
      () =>
        rate.onChildren(
          [...source.children.values()].map((port) => port.estimator.estimate(world.now + source.clockOffsetMs)),
          world.now,
        ),
      1000,
    );
  }

  return {
    world,
    program,
    /** The source's rate controller, if it was asked for, and every target it set. */
    rate,
    targets,
    peers,
    pipes,
    peer: (id: string): FakePeer => peers.get(id)!,
    /** What the parent of `id` keeps for it: the estimator, the gate, the cap's history. */
    port: (id: string) => peers.get(options.peers.find((spec) => spec.id === id)!.parent!)!.children.get(id)!,
    run: (untilMs: number): void => world.runUntil(untilMs),
    /** Changes the pipe from `id`'s parent to `id`, from now on. */
    setDown: (id: string, profile: PipeProfile): void => pipes.get(id)!.down.setProfile(profile),
  };
}

export type ViewerStats = {
  /** Video frames captured in the window. */
  captured: number;
  /** Whole video frames received, by temporal layer. */
  video: number[];
  /** Of those, the ones a decoder could use: every frame they need arrived too. */
  decodable: number;
  /** Capture to last fragment, for every whole video frame, in milliseconds. */
  delayMs: { min: number; p50: number; p95: number; max: number };
  audio: number;
  audioCaptured: number;
  audioDelayMaxMs: number;
};

const quantile = (sorted: number[], q: number): number => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);

/** What `peer` received of the frames captured in `[fromMs, toMs)`. */
export function viewerStats(peer: { frames: Map<number, Map<number, FrameRecord>> }, fromMs: number, toMs: number, shape: ProgramShape = STAGE1_SHAPE): ViewerStats {
  const inWindow = (frame: FrameRecord): boolean => frame.captureMs >= fromMs && frame.captureMs < toMs;
  const video = [0, 0, 0];
  const delays: number[] = [];
  const usable = new Set<number>();
  let decodable = 0;
  const frames = [...peer.frames.get(VIDEO_STREAM)!.values()].sort((a, b) => a.frameId - b.frameId);
  for (const frame of frames) {
    if (frame.completeAt === null) continue;
    const ok = frame.key || usable.has(frame.frameId - frame.refDelta);
    if (ok) usable.add(frame.frameId);
    if (!inWindow(frame)) continue;
    video[frame.temporal]++;
    delays.push(frame.completeAt - frame.captureMs);
    if (ok) decodable++;
  }
  delays.sort((a, b) => a - b);
  let audio = 0;
  let audioDelayMaxMs = 0;
  for (const frame of peer.frames.get(AUDIO_STREAM)!.values()) {
    if (frame.completeAt === null || !inWindow(frame)) continue;
    audio++;
    audioDelayMaxMs = Math.max(audioDelayMaxMs, frame.completeAt - frame.captureMs);
  }
  const span = toMs - fromMs;
  return {
    captured: Math.round((span * shape.fps) / 1000),
    video,
    decodable,
    delayMs: { min: delays[0] ?? NaN, p50: quantile(delays, 0.5), p95: quantile(delays, 0.95), max: delays[delays.length - 1] ?? NaN },
    audio,
    audioCaptured: Math.round(span / shape.audioFrameMs),
    audioDelayMaxMs,
  };
}
