/**
 * Composing the program (SPEC §9.1, [D23]): several pictures laid out on one canvas, several
 * sounds mixed into one, and the two tracks `ProgramSource` takes. The app's integration will
 * decide what goes on the stage and how it is laid out; this is the smallest composer that does
 * the job, and what media's own browser runs use to make a program that is not just the fake
 * camera's test card.
 *
 * Browser only: a canvas, `captureStream`, and Web Audio.
 */
import type { Cancel, Clock } from "../runtime";
import type { ProgramInput } from "./types";

export type ProgramComposerOptions = {
  width: number;
  height: number;
  fps: number;
  clock: Clock;
  /** Behind the tiles. A CSS colour. */
  background?: string;
  /**
   * Called for every frame after the tiles are drawn, to draw over them: a caption, a logo, a
   * test pattern. `frame` counts composed frames from 0.
   */
  overlay?: (context: CanvasRenderingContext2D, frame: number) => void;
  /** Where the mixed sound also goes, besides the program track: a test's own sound, say. */
  audioContext?: AudioContext;
};

export interface ProgramComposer {
  /** The pictures on stage, in order. They are laid out in a grid, each fitted inside its cell. */
  setVideo(tracks: MediaStreamTrack[]): void;
  /** The sounds on stage. They are mixed at equal gain. */
  setAudio(tracks: MediaStreamTrack[]): void;
  /** A node to connect any other sound to, to have it in the program. */
  readonly audioInput: AudioNode;
  readonly audioContext: AudioContext;
  /** What to hand to `ProgramSource.start`. */
  input(): ProgramInput;
  close(): void;
}

type Tile = { track: MediaStreamTrack; element: HTMLVideoElement };

/** The grid for `count` tiles in a `width` × `height` picture: as close to square cells as it gets. */
export function gridFor(count: number, width: number, height: number): { columns: number; rows: number } {
  if (count <= 1) return { columns: 1, rows: 1 };
  let best = { columns: count, rows: 1 };
  let bestScore = -Infinity;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const cellRatio = width / columns / (height / rows);
    // Cells near 16:9, and as few empty ones as possible.
    const score = -Math.abs(Math.log(cellRatio / (16 / 9))) - 0.2 * (columns * rows - count);
    if (score > bestScore) {
      bestScore = score;
      best = { columns, rows };
    }
  }
  return best;
}

export function createProgramComposer(options: ProgramComposerOptions): ProgramComposer {
  const { width, height, fps, clock } = options;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) throw new Error("no 2D canvas to compose the program on");
  // 0: a frame is captured when asked for, so the program's frame rate is the composer's, exactly.
  const stream = canvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };

  const audioContext = options.audioContext ?? new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  const mix = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();
  mix.connect(destination);
  const audioTrack = destination.stream.getAudioTracks()[0] as MediaStreamTrack;

  let tiles: Tile[] = [];
  let sources: { track: MediaStreamTrack; node: MediaStreamAudioSourceNode }[] = [];
  let frame = 0;
  let closed = false;

  const draw = () => {
    if (closed) return;
    context.fillStyle = options.background ?? "#111";
    context.fillRect(0, 0, width, height);
    const { columns, rows } = gridFor(tiles.length, width, height);
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    tiles.forEach((tile, index) => {
      const { element } = tile;
      if (element.readyState < 2 || element.videoWidth === 0) return;
      const ratio = Math.min(cellWidth / element.videoWidth, cellHeight / element.videoHeight);
      const w = element.videoWidth * ratio;
      const h = element.videoHeight * ratio;
      const x = (index % columns) * cellWidth + (cellWidth - w) / 2;
      const y = Math.floor(index / columns) * cellHeight + (cellHeight - h) / 2;
      context.drawImage(element, x, y, w, h);
    });
    options.overlay?.(context, frame);
    frame++;
    videoTrack.requestFrame?.();
  };
  const cancel: Cancel = clock.setInterval(draw, 1000 / fps);

  return {
    audioInput: mix,
    audioContext,
    setVideo(tracks) {
      const kept = tiles.filter((tile) => tracks.includes(tile.track));
      for (const tile of tiles) if (!kept.includes(tile)) tile.element.srcObject = null;
      tiles = tracks.map((track) => {
        const existing = kept.find((tile) => tile.track === track);
        if (existing) return existing;
        const element = document.createElement("video");
        element.muted = true;
        element.playsInline = true;
        element.srcObject = new MediaStream([track]);
        void element.play().catch(() => undefined);
        return { track, element };
      });
    },
    setAudio(tracks) {
      for (const source of sources) if (!tracks.includes(source.track)) source.node.disconnect();
      sources = tracks.map((track) => {
        const existing = sources.find((source) => source.track === track);
        if (existing) return existing;
        const node = audioContext.createMediaStreamSource(new MediaStream([track]));
        node.connect(mix);
        return { track, node };
      });
    },
    input: () => ({ video: videoTrack, audio: audioTrack }),
    close() {
      if (closed) return;
      closed = true;
      cancel();
      for (const tile of tiles) tile.element.srcObject = null;
      for (const source of sources) source.node.disconnect();
      tiles = [];
      sources = [];
      videoTrack.stop();
      audioTrack.stop();
      if (!options.audioContext) void audioContext.close().catch(() => undefined);
    },
  };
}
