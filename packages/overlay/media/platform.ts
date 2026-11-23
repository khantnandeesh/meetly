/**
 * The browser objects this module uses that TypeScript's DOM library does not describe:
 * insertable streams for tracks (`MediaStreamTrackProcessor`, `MediaStreamTrackGenerator` /
 * `VideoTrackGenerator`) and the temporal-layer field of an encoder's output metadata. They are
 * reached through `globalThis`, so the module still loads under Node, where its pure parts are
 * tested.
 */

type Constructor<Args extends unknown[], Instance> = new (...args: Args) => Instance;

type Globals = {
  MediaStreamTrackProcessor?: Constructor<[{ track: MediaStreamTrack; maxBufferSize?: number }], { readable: ReadableStream<unknown> }>;
  MediaStreamTrackGenerator?: Constructor<[{ kind: "video" | "audio" }], MediaStreamTrack & { writable: WritableStream<VideoFrame> }>;
  VideoTrackGenerator?: Constructor<[], { track: MediaStreamTrack; writable: WritableStream<VideoFrame> }>;
};

const globals = globalThis as unknown as Globals;

/** What a `VideoEncoder` says about a chunk beyond what the DOM library knows. */
export type EncodedVideoMetadata = EncodedVideoChunkMetadata & { svc?: { temporalLayerId?: number } };

/** The frames of a track, as a stream. `maxBufferSize` 1: a reader that falls behind gets the newest, not a backlog. */
export function readTrack<T extends VideoFrame | AudioData>(track: MediaStreamTrack, maxBufferSize?: number): ReadableStream<T> {
  const Processor = globals.MediaStreamTrackProcessor;
  if (!Processor) throw new Error("this browser has no MediaStreamTrackProcessor");
  return new Processor(maxBufferSize === undefined ? { track } : { track, maxBufferSize }).readable as ReadableStream<T>;
}

/** A video track fed with frames by writing to `writable`. */
export function createVideoTrack(): { track: MediaStreamTrack; writable: WritableStream<VideoFrame> } {
  if (globals.MediaStreamTrackGenerator) {
    const generator = new globals.MediaStreamTrackGenerator({ kind: "video" });
    return { track: generator, writable: generator.writable };
  }
  if (globals.VideoTrackGenerator) {
    const generator = new globals.VideoTrackGenerator();
    return { track: generator.track, writable: generator.writable };
  }
  throw new Error("this browser cannot make a video track from frames");
}

export const hasWebCodecs = (): boolean => typeof VideoDecoder === "function" && typeof AudioDecoder === "function";
