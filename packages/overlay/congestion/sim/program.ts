/**
 * A stand-in for the program feed until E-media's encoder exists: frames with the headers SPEC
 * §9.2 asks for (VP8 `L1T3`, a keyframe every 60 frames, Opus in 20 ms frames) and sizes that add
 * up to the bitrate, but with nothing inside them. The congestion module never reads a payload,
 * so this is all it needs; what real encoders do to frame sizes is not modelled here.
 */
import { MediaFlag, PacketType, type FrameHeader } from "../../protocol";

export type SyntheticFrame = { header: FrameHeader; data: Uint8Array };

export type ProgramShape = {
  videoKbps: number;
  fps: number;
  keyIntervalFrames: number;
  /**
   * The share of the bitrate at each temporal layer and below. libvpx's default for three layers
   * is 40% / 60% / 100%.
   */
  layerShare: [number, number, number];
  /** A keyframe's size, in base-layer delta frames. */
  keyFrameFactor: number;
  audioKbps: number;
  audioFrameMs: number;
};

export const STAGE1_SHAPE: ProgramShape = {
  videoKbps: 1200,
  fps: 30,
  keyIntervalFrames: 60,
  layerShare: [0.4, 0.6, 1],
  keyFrameFactor: 4,
  audioKbps: 32,
  audioFrameMs: 20,
};

export const VIDEO_STREAM = 0;
export const AUDIO_STREAM = 1;

/** `L1T3`: which temporal layer the n-th frame of a GOP is on, and how far back the frame it needs is. */
export function l1t3(indexInGop: number): { temporal: number; refDelta: number } {
  switch (indexInGop % 4) {
    case 0:
      return { temporal: 0, refDelta: indexInGop === 0 ? 0 : 4 };
    case 2:
      return { temporal: 1, refDelta: 2 };
    default:
      return { temporal: 2, refDelta: 1 };
  }
}

/** Makes the program's frames one after another. `captureUs` is the caller's: it knows the time. */
export function createSyntheticProgram(shape: ProgramShape = STAGE1_SHAPE) {
  const perGop = [0, 0, 0];
  for (let i = 0; i < shape.keyIntervalFrames; i++) perGop[l1t3(i).temporal]++;
  const [base, mid, all] = shape.layerShare;
  const sizesAt = (videoKbps: number) => {
    const gopBytes = (videoKbps * 1000 * (shape.keyIntervalFrames / shape.fps)) / 8;
    // The base layer's bytes are shared by one keyframe and the delta frames after it.
    const baseDelta = (gopBytes * base) / (perGop[0] - 1 + shape.keyFrameFactor);
    return { key: baseDelta * shape.keyFrameFactor, t0: baseDelta, t1: (gopBytes * (mid - base)) / perGop[1], t2: (gopBytes * (all - mid)) / perGop[2] };
  };
  let sizes = sizesAt(shape.videoKbps);
  const audioBytes = Math.round((shape.audioKbps * shape.audioFrameMs) / 8);
  let videoFrame = 0;
  let audioFrame = 0;

  const header = (streamId: number, frameId: number, captureUs: number, more: Partial<FrameHeader>): FrameHeader => ({
    type: PacketType.Media,
    flags: 0,
    streamId,
    stripe: 0,
    spatial: 0,
    temporal: 0,
    refDelta: 0,
    keyDelta: 0,
    frameId,
    captureUs: Math.round(captureUs),
    configId: 1,
    ...more,
  });

  return {
    shape,
    /** Bytes of a keyframe and of a delta frame on each layer, at the bitrate of the moment. */
    get sizes() {
      return sizes;
    },
    /** What an encoder does when its target changes: the frames that follow are that much smaller. */
    setVideoKbps(videoKbps: number): void {
      sizes = sizesAt(videoKbps);
    },
    frameIntervalMs: 1000 / shape.fps,
    video(captureUs: number): SyntheticFrame {
      const frameId = videoFrame++;
      const indexInGop = frameId % shape.keyIntervalFrames;
      const { temporal, refDelta } = l1t3(indexInGop);
      const key = indexInGop === 0;
      const bytes = Math.round(key ? sizes.key : temporal === 0 ? sizes.t0 : temporal === 1 ? sizes.t1 : sizes.t2);
      return {
        header: header(VIDEO_STREAM, frameId, captureUs, {
          flags: (key ? MediaFlag.Key : 0) | (temporal === 2 ? MediaFlag.Discardable : 0),
          temporal,
          refDelta,
          keyDelta: indexInGop,
        }),
        data: new Uint8Array(bytes),
      };
    },
    audio(captureUs: number): SyntheticFrame {
      return { header: header(AUDIO_STREAM, audioFrame++, captureUs, { flags: MediaFlag.Key }), data: new Uint8Array(audioBytes) };
    },
  };
}
