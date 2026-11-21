/**
 * Holding the video stream to its bitrate, whatever the picture (SPEC §9.2, §11.4).
 *
 * Chromium's VP8 encoder overshoots its target on busy pictures, by far: measured at 1280×720 and
 * 1,200 kbps asked, a grainy drifting pattern came out at 1.6–2.2 Mbps, fine detail at 5.5–8.2
 * Mbps under L1T3 (1.5–2.3 under L1T1), and noise at 63 Mbps, 260 kB a frame, in every mode WebCodecs
 * offers. Past some point it is at its coarsest quantiser and cannot spend less, and WebCodecs
 * gives VP8 no per-frame quantiser. Every byte budget in the overlay (fan-out, congestion's *B*,
 * the source's own rate, D27) assumes the stream is what it says. So the source holds it there,
 * in three steps, each used only when the one before is not enough:
 *
 * 1. **The encoder's own target** is steered: when what came out over the last two seconds is
 *    over the stream's bitrate, the encoder is asked for proportionally less (down to a quarter),
 *    and given it back as it comes under.
 * 2. **Frames are not encoded** when they would not fit: no frame goes to the encoder unless the
 *    bytes of the last two seconds, those still in the encoder, and what this frame is expected to
 *    be (from the last ones of its kind) fit in two seconds of the bitrate, with a margin. Checked
 *    at every frame, that bounds every two-second window, not only some.
 * 3. **The picture is made smaller** when that still skips a quarter of the frames, or when a
 *    keyframe is more than 250 ms of the bitrate: 1280×720 → 960×540 → 640×360 → 480×270 → 320×180. It is
 *    tried bigger again later, waiting twice as long each time that fails (to a minute).
 *
 * Pure: told what was offered and what came out, it answers. The source does the encoding.
 */

/** The window every byte is counted over, and the most it may carry: two seconds of the bitrate, 15% over. */
export const RATE_WINDOW_MS = 2000;
export const RATE_WINDOW_ALLOWANCE = 1.15;
/** What the gate aims at inside that, for a frame that comes out bigger than expected. */
export const RATE_GATE_MARGIN = 1.12;
/** The encoder's target is moved this often, and never below this share of the stream's bitrate. */
export const STEER_EVERY_MS = 1000;
export const STEER_MIN = 0.25;
/** Sizes of the picture, as shares of the program's. */
export const SCALE_LEVELS = [1, 0.75, 0.5, 0.375, 0.25] as const;
/** Smaller when this share of the frames offered over the window was not encoded. */
export const SCALE_DOWN_SKIPPED = 0.25;
/**
 * ... or when a keyframe is more than this many milliseconds of the bitrate: a keyframe is handed
 * to each child's channel at once, and the overlay's budgets for a burst on a link are of this
 * order (SPEC §11.5: a replay may fill 250 ms of *B*; §11.2, [D30]: a backlog counts once it has
 * stood over 150 ms of *B* for 150 ms).
 */
export const KEY_ALLOWANCE_MS = 250;
/** Tried bigger again after this long at a size, doubling each time that fails within the wait, to a minute. */
export const SCALE_UP_AFTER_MS = 10_000;
export const SCALE_UP_MAX_MS = 60_000;
/** ... and only once the encoder is asked for this share of the bitrate again: it keeps to its target. */
export const SCALE_UP_FACTOR = 0.9;
/** A size is not changed again sooner than this. */
export const SCALE_HOLD_MS = 2500;
/** Room is kept for a keyframe due this soon, so that it is not late for want of it. */
export const KEY_RESERVE_MS = 600;

export type RateDecision = "encode" | "skip";

type Sent = { at: number; bytes: number };

export class VideoRateController {
  private targetKbps: number;
  private readonly sent: Sent[] = [];
  private sentBytes = 0;
  /** Frames offered over the window: when, and whether they were skipped. */
  private readonly offered: { at: number; skipped: boolean }[] = [];
  /** Bytes expected of frames in the encoder that have not come out yet. */
  private inFlight: number[] = [];
  /** Recent sizes, by kind: keyframes, and each temporal layer. */
  private keyBytes: number | null = null;
  private readonly layerBytes: (number | null)[];
  private factor = 1;
  private steeredAt = -Infinity;
  private level = 0;
  private levelAt = -Infinity;
  private upAfterMs = SCALE_UP_AFTER_MS;
  private raisedAt = -Infinity;
  private counters = { offered: 0, skipped: 0, scaleChanges: 0 };
  private keySeenAtLevel = false;
  /** A frame too big for the window was seen: smaller at the next tick, whatever the hold. */
  private shrinkNow = false;

  constructor(
    targetKbps: number,
    layers: number,
    private readonly fps = 30,
  ) {
    this.targetKbps = targetKbps;
    this.layerBytes = Array.from({ length: Math.max(1, layers) }, () => null);
  }

  setTarget(kbps: number): void {
    this.targetKbps = kbps;
  }

  /** The most a keyframe should be, in bytes. */
  keyAllowanceBytes(): number {
    return (this.targetKbps * KEY_ALLOWANCE_MS) / 8;
  }

  /** The most the window may carry, in bytes. */
  windowCapBytes(): number {
    return (this.targetKbps * 1000 * (RATE_WINDOW_MS / 1000) * RATE_WINDOW_ALLOWANCE) / 8;
  }

  private forget(now: number): void {
    while (this.sent.length > 0 && (this.sent[0] as Sent).at <= now - RATE_WINDOW_MS) this.sentBytes -= (this.sent.shift() as Sent).bytes;
    while (this.offered.length > 0 && (this.offered[0] as { at: number }).at <= now - RATE_WINDOW_MS) this.offered.shift();
  }

  /** What a frame of this kind is expected to come to. Before any has, nothing stops it. */
  expectedBytes(key: boolean, temporal: number): number {
    const known = key ? this.keyBytes : (this.layerBytes[Math.min(temporal, this.layerBytes.length - 1)] ?? null);
    if (known !== null) return known;
    // A delta frame of a layer not seen yet: like the others seen.
    const any = this.layerBytes.find((bytes) => bytes !== null) ?? null;
    return key ? (any === null ? 0 : any * 4) : (any ?? 0);
  }

  /**
   * A frame from the camera: encode it, or not. `key`: it would be a keyframe; `temporal`: the
   * layer it would be; `untilKeyMs`: how soon the next keyframe is due.
   */
  offer(now: number, key: boolean, temporal: number, untilKeyMs = Infinity): RateDecision {
    this.forget(now);
    this.counters.offered++;
    const expected = this.expectedBytes(key, temporal);
    const pending = this.inFlight.reduce((sum, bytes) => sum + bytes, 0);
    const reserved = !key && untilKeyMs <= KEY_RESERVE_MS ? this.expectedBytes(true, 0) : 0;
    const gate = this.windowCapBytes() / (RATE_WINDOW_ALLOWANCE / RATE_GATE_MARGIN);
    // A frame bigger than the whole window at this size: the picture must get smaller, now.
    if (expected > gate && this.level < SCALE_LEVELS.length - 1) {
      this.offered.push({ at: now, skipped: true });
      this.counters.skipped++;
      this.shrinkNow = true;
      return "skip";
    }
    const fits = this.sentBytes + pending + reserved + expected <= gate;
    // An empty window always takes a frame, however big: otherwise a frame bigger than the
    // window would stop the stream for good.
    const decision: RateDecision = fits || this.sentBytes + pending === 0 ? "encode" : "skip";
    this.offered.push({ at: now, skipped: decision === "skip" });
    if (decision === "skip") this.counters.skipped++;
    else this.inFlight.push(expected);
    return decision;
  }

  /** A frame the encoder dropped by itself, or that failed: what was expected of it no longer is. */
  dropped(): void {
    this.inFlight.shift();
  }

  /** A frame came out of the encoder. */
  encoded(now: number, bytes: number, key: boolean, temporal: number): void {
    this.forget(now);
    this.inFlight.shift();
    this.sent.push({ at: now, bytes });
    this.sentBytes += bytes;
    // The latest of each kind, a little pessimistic: pictures change fast.
    const remember = (old: number | null) => (old === null ? bytes : Math.max(bytes, 0.5 * old + 0.5 * bytes));
    if (key) {
      // Only what a keyframe of this size really came to.
      this.keyBytes = this.keySeenAtLevel ? remember(this.keyBytes) : bytes;
      this.keySeenAtLevel = true;
    }
    else {
      const layer = Math.min(temporal, this.layerBytes.length - 1);
      this.layerBytes[layer] = remember(this.layerBytes[layer] ?? null);
    }
  }

  /** The stream's rate over the window, in kbps. */
  windowKbps(now: number): number {
    this.forget(now);
    return (this.sentBytes * 8) / RATE_WINDOW_MS;
  }

  /**
   * Call often. Returns the share of the stream's bitrate the encoder should be asked for now
   * (step 1), and the size of picture to encode (step 3) as an index into SCALE_LEVELS.
   */
  tick(now: number): { factor: number; level: number } {
    this.forget(now);
    if (now - this.steeredAt >= STEER_EVERY_MS && this.sent.length > 0) {
      this.steeredAt = now;
      // What the encoder would send if every frame went to it: its bytes a frame, at the stream's
      // frame rate. Not the window's rate, which step 2 holds down and so would hide how far over
      // the encoder is.
      const demandKbps = (this.sentBytes / this.sent.length) * this.fps * (8 / 1000);
      const ratio = demandKbps / this.targetKbps;
      if (ratio > 1.02) this.factor = Math.max(STEER_MIN, this.factor * Math.max(0.6, 1 / ratio));
      else if (ratio < 0.9 && this.factor < 1) this.factor = Math.min(1, this.factor * 1.15);
    }
    if (this.shrinkNow && this.level < SCALE_LEVELS.length - 1) {
      this.shrinkNow = false;
      this.setLevel(this.level + 1, now);
    } else if (now - this.levelAt >= SCALE_HOLD_MS) {
      const offered = this.offered.length;
      const skipped = this.offered.filter((o) => o.skipped).length;
      const tooManySkipped = offered >= 10 && skipped / offered >= SCALE_DOWN_SKIPPED;
      const keyTooBig = this.keySeenAtLevel && this.keyBytes !== null && this.keyBytes > this.keyAllowanceBytes();
      // Smaller only once asking the encoder for less has done all it can (step 1 before 3),
      // or when a keyframe alone is too much for the window, which asking does not change.
      const askedLeast = this.factor <= STEER_MIN * 1.05;
      if (((tooManySkipped && askedLeast) || keyTooBig) && this.level < SCALE_LEVELS.length - 1) {
        // Bigger did not hold: wait longer before trying it again.
        this.upAfterMs = now - this.raisedAt < this.upAfterMs ? Math.min(SCALE_UP_MAX_MS, this.upAfterMs * 2) : this.upAfterMs;
        this.setLevel(this.level + 1, now);
      } else if (this.level > 0 && skipped === 0 && !keyTooBig && this.factor >= SCALE_UP_FACTOR && now - this.levelAt >= this.upAfterMs) {
        // Only a picture the encoder keeps to what it is asked is tried bigger: one at its coarsest
        // (asked for less, it spent no less) would only bring back the frames that do not fit,
        // and a keyframe past the allowance with them.
        this.raisedAt = now;
        this.setLevel(this.level - 1, now);
      }
    }
    return { factor: this.factor, level: this.level };
  }

  private setLevel(level: number, now: number): void {
    // A picture at the encoder's coarsest costs about its area: until frames of the new size have
    // come out, that is what they are expected to be (it gates what is sent). Whether a keyframe is
    // too big is judged only by one of the new size (the change starts with one): a picture the
    // encoder can hold to its target does not cost its area.
    const ratio = ((SCALE_LEVELS[level] as number) / (SCALE_LEVELS[this.level] as number)) ** 2;
    if (this.keyBytes !== null) this.keyBytes *= ratio;
    for (let i = 0; i < this.layerBytes.length; i++) if (this.layerBytes[i] !== null) this.layerBytes[i] = (this.layerBytes[i] as number) * ratio;
    this.keySeenAtLevel = false;
    this.level = level;
    this.levelAt = now;
    this.counters.scaleChanges++;
  }

  stats(): { offered: number; skipped: number; scaleChanges: number; level: number; factor: number } {
    return { ...this.counters, level: this.level, factor: this.factor };
  }
}
