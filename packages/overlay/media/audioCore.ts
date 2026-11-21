/**
 * Audio playout, the part that runs on the audio thread (SPEC §10.5).
 *
 * `audioWorkletModule` is one self-contained function: its source text is what the browser loads
 * as the AudioWorklet module (`audioWorkletSource`), and Node's unit tests call it directly to
 * get the same `Sequencer`. So it must not refer to anything outside itself, and is written
 * without class fields or anything else a bundler would rewrite into a helper call.
 *
 * The sequencer plays decoded 20 ms frames, each at its place on the capture timeline:
 *
 * - a frame that is not there when its turn comes is concealed: the last frame once more,
 *   fading, then silence. It never waits. A frame that turns up after its turn is dropped;
 * - the playout delay is changed one frame at a time, at most once a second: a frame is dropped
 *   (two frames cross-faded into the time of one) or repeated (a cross-fade inserted between
 *   two), at the quietest frame it can find within that second [D26];
 * - it reports where on the capture timeline it is playing, against the context's own frame
 *   count, which is what video is timed by.
 */

export type SequencerReport = {
  /** The context frame of the next sample to be rendered. */
  frame: number;
  /** The capture time of that sample, in microseconds. Null until started. */
  playUs: number | null;
  /** Decoded audio waiting for its turn, in milliseconds. */
  queuedMs: number;
  /** Totals since the sequencer was made, in samples. */
  played: number;
  concealed: number;
  /** Frames that arrived after their turn. */
  late: number;
  /** Delay changes made: frames dropped, frames repeated. */
  drops: number;
  repeats: number;
  /** A delay change asked for and not yet made: -1 drop, +1 repeat, 0 none. */
  pending: number;
};

export type SequencerMessage =
  | { t: "pcm"; us: number; pcm: Float32Array }
  /** Capture time `us` plays at context frame `atFrame`. Whatever was playing is abandoned. */
  | { t: "start"; us: number; atFrame: number }
  /** -1: play 20 ms less delayed (drop a frame). +1: 20 ms more (repeat one). */
  | { t: "adjust"; dir: -1 | 1 }
  | { t: "stop" }
  /** Send back what is played, for a test to listen to. */
  | { t: "tap"; on: boolean };

export interface SequencerLike {
  push(us: number, pcm: Float32Array): void;
  start(us: number, atFrame: number): void;
  adjust(dir: number): void;
  stop(): void;
  render(out: Float32Array, frame: number): void;
  report(): SequencerReport;
}

export const PLAYOUT_PROCESSOR = "meetly-overlay-playout";

export function audioWorkletModule(): { Sequencer: new (sampleRate: number, frameUs: number) => SequencerLike } {
  /** How many frames between two delay changes: one second's worth. */
  const ADJUST_EVERY_S = 1;

  class Sequencer {
    declare sampleRate: number;
    declare frameUs: number;
    declare frameLen: number;
    declare perSecond: number;
    declare queue: { us: number; pcm: Float32Array }[];
    declare started: boolean;
    /** The current slot: its capture time, the context frame it starts at, its samples, the next to play. */
    declare slotUs: number;
    declare slotFrame: number;
    declare cur: Float32Array | null;
    declare pos: number;
    declare silence: Float32Array;
    declare last: Float32Array | null;
    declare concealRun: number;
    declare pending: number;
    declare pendingSince: number;
    declare lastAdjust: number;
    declare slots: number;
    declare energies: number[];
    declare nextFrame: number;
    declare played: number;
    declare concealed: number;
    declare late: number;
    declare drops: number;
    declare repeats: number;

    constructor(sampleRate: number, frameUs: number) {
      this.sampleRate = sampleRate;
      this.frameUs = frameUs;
      this.frameLen = Math.round((sampleRate * frameUs) / 1e6);
      this.perSecond = Math.round(1e6 / frameUs);
      this.queue = [];
      this.started = false;
      this.slotUs = 0;
      this.slotFrame = 0;
      this.cur = null;
      this.pos = 0;
      this.silence = new Float32Array(this.frameLen);
      this.last = null;
      this.concealRun = 0;
      this.pending = 0;
      this.pendingSince = 0;
      this.lastAdjust = -1e9;
      this.slots = 0;
      this.energies = [];
      this.nextFrame = 0;
      this.played = 0;
      this.concealed = 0;
      this.late = 0;
      this.drops = 0;
      this.repeats = 0;
    }

    push(us: number, pcm: Float32Array): void {
      let frame = pcm;
      if (pcm.length !== this.frameLen) {
        frame = new Float32Array(this.frameLen);
        frame.set(pcm.subarray(0, this.frameLen));
      }
      // Decoded frames come in order; one that does not is put in its place.
      let at = this.queue.length;
      while (at > 0 && (this.queue[at - 1] as { us: number }).us > us) at--;
      // The same frame twice (§9.4 sends each twice) is played once.
      if (at > 0 && Math.abs((this.queue[at - 1] as { us: number }).us - us) < this.frameUs / 2) return;
      this.queue.splice(at, 0, { us, pcm: frame });
      if (this.queue.length > 4 * this.perSecond) this.queue.shift();
    }

    start(us: number, atFrame: number): void {
      // A start time already behind us: begin with the slot that is playing now.
      let startUs = us;
      let startFrame = Math.round(atFrame);
      if (startFrame < this.nextFrame) {
        const behind = Math.ceil((this.nextFrame - startFrame) / this.frameLen);
        startFrame += behind * this.frameLen;
        startUs += behind * this.frameUs;
      }
      this.started = true;
      this.slotUs = startUs - this.frameUs;
      this.slotFrame = startFrame - this.frameLen;
      this.cur = null;
      this.pos = this.frameLen;
      this.concealRun = 2;
      this.last = null;
      this.pending = 0;
    }

    adjust(dir: number): void {
      if (!this.started || this.pending !== 0) return;
      this.pending = dir < 0 ? -1 : 1;
      this.pendingSince = this.slots;
    }

    stop(): void {
      this.started = false;
      this.cur = null;
      this.queue = [];
      this.pending = 0;
    }

    energy(pcm: Float32Array): number {
      let sum = 0;
      for (let i = 0; i < pcm.length; i += 4) sum += (pcm[i] as number) * (pcm[i] as number);
      return (sum * 4) / pcm.length;
    }

    /**
     * Whether a pending delay change should be made here, where the sound it touches has this
     * energy: the louder of the two frames a cross-fade joins, so that neither end of it is loud.
     */
    quietEnough(energy: number): boolean {
      if (this.slots - this.lastAdjust < ADJUST_EVERY_S * this.perSecond) return false;
      // The second is up: this frame will have to do.
      if (this.slots - this.pendingSince >= this.perSecond) return true;
      let quietest = Infinity;
      for (let i = 0; i < this.energies.length; i++) quietest = Math.min(quietest, this.energies[i] as number);
      return energy <= quietest * 1.5 + 1e-7;
    }

    /** `from` fading into `to`, over one frame: it starts as `from` starts and ends as `to` ends. */
    crossfade(from: Float32Array, to: Float32Array): Float32Array {
      const n = this.frameLen;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        // Equal-gain raised cosine: no step at either end.
        const w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / n);
        out[i] = (from[i] as number) * (1 - w) + (to[i] as number) * w;
      }
      return out;
    }

    nextSlot(): void {
      this.slotUs += this.frameUs;
      this.slotFrame += this.frameLen;
      this.slots++;
      this.pos = 0;
      const tolerance = this.frameUs / 2;
      while (this.queue.length > 0 && (this.queue[0] as { us: number }).us < this.slotUs - tolerance) {
        this.queue.shift();
        this.late++;
      }
      const head = this.queue[0];
      if (!head || head.us > this.slotUs + tolerance) {
        // Not there: conceal. The last frame once more, backwards so that it continues from
        // where the sound stopped, fading out; after that, silence.
        this.concealRun++;
        this.concealed += this.frameLen;
        if (this.concealRun === 1 && this.last) {
          const n = this.frameLen;
          const out = new Float32Array(n);
          for (let i = 0; i < n; i++) out[i] = (this.last[n - 1 - i] as number) * (0.5 + 0.5 * Math.cos((Math.PI * i) / n));
          this.cur = out;
        } else {
          this.cur = this.silence;
        }
        return;
      }

      let frame = head.pcm;
      const next = this.queue[1];
      if (this.pending < 0 && next && Math.abs(next.us - (this.slotUs + this.frameUs)) <= tolerance && this.quietEnough(Math.max(this.energy(frame), this.energy(next.pcm)))) {
        // Drop: this frame and the next, cross-faded into the time of one.
        frame = this.crossfade(head.pcm, next.pcm);
        this.queue.splice(0, 2);
        this.slotUs += this.frameUs;
        this.last = next.pcm;
        this.drops++;
        this.pending = 0;
        this.lastAdjust = this.slots;
      } else if (this.pending > 0 && this.quietEnough(Math.max(this.energy(frame), this.last ? this.energy(this.last) : 0))) {
        // Repeat: a frame of cross-fade that leads back into this one, which then plays whole.
        frame = this.crossfade(head.pcm, this.last || this.silence);
        this.slotUs -= this.frameUs;
        this.repeats++;
        this.pending = 0;
        this.lastAdjust = this.slots;
      } else {
        this.queue.shift();
        this.last = head.pcm;
        this.energies.push(this.energy(head.pcm));
        if (this.energies.length > this.perSecond) this.energies.shift();
      }
      if (this.concealRun > 0) {
        // Coming back from a concealment, which ended at nothing: fade in over 5 ms rather than start with a step.
        const ramp = Math.min(this.frameLen, Math.round(this.sampleRate * 0.005));
        const faded = new Float32Array(frame);
        for (let i = 0; i < ramp; i++) faded[i] = (faded[i] as number) * (i / ramp);
        frame = faded;
      }
      this.concealRun = 0;
      this.played += this.frameLen;
      this.cur = frame;
    }

    /** Fills `out` with what plays from context frame `frame` on. */
    render(out: Float32Array, frame: number): void {
      const n = out.length;
      this.nextFrame = frame + n;
      if (!this.started) {
        out.fill(0);
        return;
      }
      for (let i = 0; i < n; i++) {
        const at = frame + i;
        if (at < this.slotFrame + this.frameLen && this.cur === null) {
          // Before the first slot.
          out[i] = 0;
          continue;
        }
        if (this.pos >= this.frameLen) this.nextSlot();
        out[i] = (this.cur as Float32Array)[this.pos++] as number;
      }
    }

    report(): SequencerReport {
      let queued = 0;
      for (let i = 0; i < this.queue.length; i++) if ((this.queue[i] as { us: number }).us >= this.slotUs) queued++;
      return {
        frame: this.nextFrame,
        playUs: this.started && this.cur !== null ? this.slotUs + (this.pos * 1e6) / this.sampleRate : null,
        queuedMs: (queued * this.frameUs) / 1000,
        played: this.played,
        concealed: this.concealed,
        late: this.late,
        drops: this.drops,
        repeats: this.repeats,
        pending: this.pending,
      };
    }
  }

  // In an AudioWorkletGlobalScope, register the processor that runs it.
  const scope = globalThis as unknown as {
    registerProcessor?: (name: string, processor: unknown) => void;
    AudioWorkletProcessor?: new () => { port: MessagePort };
    sampleRate?: number;
    currentFrame?: number;
  };
  if (typeof scope.registerProcessor === "function" && typeof scope.AudioWorkletProcessor === "function") {
    const Base = scope.AudioWorkletProcessor;
    class PlayoutProcessor extends Base {
      declare sequencer: Sequencer;
      declare quanta: number;
      declare tap: Float32Array | null;
      declare tapAt: number;
      declare tapFrame: number;
      declare changes: number;

      constructor(options?: { processorOptions?: { frameUs?: number } }) {
        super();
        const frameUs = (options && options.processorOptions && options.processorOptions.frameUs) || 20000;
        this.sequencer = new Sequencer(scope.sampleRate as number, frameUs);
        this.quanta = 0;
        this.tap = null;
        this.tapAt = 0;
        this.tapFrame = 0;
        this.changes = 0;
        this.port.onmessage = (event: MessageEvent) => {
          const message = event.data;
          if (message.t === "pcm") this.sequencer.push(message.us, message.pcm);
          else if (message.t === "start") this.sequencer.start(message.us, message.atFrame);
          else if (message.t === "adjust") this.sequencer.adjust(message.dir);
          else if (message.t === "stop") this.sequencer.stop();
          else if (message.t === "tap") this.tap = message.on ? new Float32Array(4800) : null;
        };
      }

      process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const output = outputs[0];
        if (!output || !output[0]) return true;
        const frame = scope.currentFrame as number;
        const first = output[0];
        this.sequencer.render(first, frame);
        for (let channel = 1; channel < output.length; channel++) (output[channel] as Float32Array).set(first);
        if (this.tap) {
          if (this.tapAt === 0) this.tapFrame = frame;
          this.tap.set(first, this.tapAt);
          this.tapAt += first.length;
          if (this.tapAt + first.length > this.tap.length) {
            this.port.postMessage({ t: "tap", frame: this.tapFrame, pcm: this.tap.slice(0, this.tapAt) });
            this.tapAt = 0;
          }
        }
        // A report every four blocks; and at once when the timeline has just moved by a frame, so
        // that the picture, timed by it, is not shown a frame early or late in between.
        const report = this.sequencer.report();
        const changes = report.drops + report.repeats;
        if (++this.quanta % 4 === 0 || changes !== this.changes) {
          this.changes = changes;
          this.port.postMessage({ t: "report", report });
        }
        return true;
      }
    }
    scope.registerProcessor("meetly-overlay-playout", PlayoutProcessor);
  }

  return { Sequencer };
}

/** The text of the AudioWorklet module: the function above, called. */
export const audioWorkletSource = (): string => `(${audioWorkletModule.toString()})();`;
