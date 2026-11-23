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
 *    keyframe is more than 500 ms of the bitrate (see KEY_ALLOWANCE_MS): 1280×720 → 960×540 → 640×360 → 480×270 → 320×180. It is
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
 * ... or when a keyframe is more than this many milliseconds of the bitrate. A keyframe is handed
 * to each child's channel whole, so it is a burst; the overlay's own budgets for one are 200–250
 * ms of *B* (SPEC §11.3 rule 6 holds video back above 200 ms of *B* buffered; §11.5 lets a replay
 * fill 250). But an ordinary program's keyframes are already past that: the camera on a textured
 * stage at 1272×720 and 1,200 kbps gave keyframes of 150–385 ms of *B*, and holding them to 250
 * (by asking the encoder for less, measured) brought its whole stream down to 758 kbps while the
 * keyframes stayed as they were. Keyframes are sized by the picture far more than by the
 * encoder's target; spreading them over time is pacing, which is the transport's to do. So the
 * source acts only on keyframes twice that: fine detail and noise at full size come to 2.2 s.
 */
export const KEY_ALLOWANCE_MS = 500;
/**
 * Keyframes of one picture vary by a tenth or two, so the picture is made smaller once they come
 * to this share of the allowance, not once one has passed it; and it is tried bigger only when
 * its keyframe one size up would likely be under this share too.
 */
export const KEY_MARGIN = 0.85;
/** A bigger size is tried only when its keyframe would likely be under this share of the allowance. */
export const KEY_TRY_MARGIN = 0.85;
/** Tried bigger again after this long at a size, doubling each time that fails within the wait, to a minute. */
export const SCALE_UP_AFTER_MS = 10_000;
export const SCALE_UP_MAX_MS = 60_000;
/** ... and only once the encoder is asked for this share of the bitrate again: it keeps to its target. */
export const SCALE_UP_FACTOR = 0.9;
/** A size is not changed again sooner than this. */
export const SCALE_HOLD_MS = 2500;
/**
 * For this long after the picture is made bigger, frames are let through only into this share of
 * the usual room: what frames of the new size cost is a guess until some have come out.
 */
export const TRY_MS = 2500;
export const TRY_GATE = 0.88;
/**
 * A cut in the picture (a flash, a new scene) makes a delta frame as big as a keyframe, and no
 * guess made before encoding it sees that coming. So room is kept for the biggest such surprise
 * (what a frame came to over what it was expected to be) of this long past.
 */
export const SURPRISE_MEMORY_MS = 6_000;
/** Room is kept for a keyframe due this soon, so that it is not late for want of it. */
export const KEY_RESERVE_MS = 600;
/** [D68] Room a key interval's plan leaves unspent, in delta frames: what frames bigger than expected take. */
export const PLAN_SLACK_FRAMES = 3;

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
  private firstOfferAt = -Infinity;
  /** Frames that came out bigger than expected, by how much, lately. */
  private surprises: { at: number; bytes: number }[] = [];
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
  /** Until then the picture is at a size just tried bigger. */
  private tryingUntil = -Infinity;
  /** Keyframes out so far, and how many of them had been acted on: each is acted on once. */
  private keysSeen = 0;
  private keyActedOn = 0;
  /** A frame too big for the window was seen: smaller at the next tick, whatever the hold. */
  private shrinkNow = false;
  /** [D68] The last keyframe's bytes, the delta frames' since, and the skips owed (see `offer`). */
  private lastKeyBytes: number | null = null;
  private gopDeltaBytes = 0;
  private skipCredit = 0;

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
   * [D68] What a delta frame comes to on average over the temporal pattern: layer 0 is every
   * 2^(n−1)th frame, and each layer above doubles the share of the one below.
   */
  private meanDeltaBytes(): number {
    const layers = this.layerBytes.length;
    let sum = 0;
    for (let t = 0; t < layers; t++) sum += this.expectedBytes(false, t) * (t === 0 ? 1 : 2 ** (t - 1));
    return sum / 2 ** (layers - 1);
  }

  /**
   * A frame from the camera: encode it, or not. `key`: it would be a keyframe; `temporal`: the
   * layer it would be; `untilKeyMs`: how soon the next keyframe is due.
   */
  offer(now: number, key: boolean, temporal: number, untilKeyMs = Infinity): RateDecision {
    this.forget(now);
    if (this.firstOfferAt === -Infinity) this.firstOfferAt = now;
    this.counters.offered++;
    const expected = this.expectedBytes(key, temporal);
    const pending = this.inFlight.reduce((sum, bytes) => sum + bytes, 0);
    const reserved = !key && untilKeyMs <= KEY_RESERVE_MS ? this.expectedBytes(true, 0) : 0;
    const gate = (this.windowCapBytes() / (RATE_WINDOW_ALLOWANCE / RATE_GATE_MARGIN)) * (now < this.tryingUntil ? TRY_GATE : 1);
    // A frame bigger than the whole window at this size: the picture must get smaller, now.
    if (expected > gate && this.level < SCALE_LEVELS.length - 1) {
      this.offered.push({ at: now, skipped: true });
      this.counters.skipped++;
      this.shrinkNow = true;
      return "skip";
    }
    while (this.surprises.length > 0 && (this.surprises[0] as { at: number }).at < now - SURPRISE_MEMORY_MS) this.surprises.shift();
    // What the gate's own margin under the window's limit absorbs needs no more room.
    const absorbed = this.windowCapBytes() - gate / (now < this.tryingUntil ? TRY_GATE : 1);
    const surprise = Math.max(0, this.surprises.reduce((most, s) => Math.max(most, s.bytes), 0) - absorbed);
    const margin = Math.min(surprise, gate / 2);
    let fits = this.sentBytes + pending + margin + expected <= gate;
    if (fits && reserved > 0) {
      // [D68] The keyframe's room is needed in the window it lands in, which by then no longer
      // holds what goes out of it before: above all the last keyframe, sent a key interval (the
      // window's length) before it. Reserved against the window now, the last keyframe was counted
      // twice.
      const landsAt = now + Math.max(0, untilKeyMs);
      let stillIn = 0;
      for (const sent of this.sent) if (sent.at > landsAt - RATE_WINDOW_MS) stillIn += sent.bytes;
      fits = stillIn + pending + reserved + margin + expected <= gate;
    }
    // An empty window always takes a frame, however big: otherwise a frame bigger than the
    // window would stop the stream for good.
    let decision: RateDecision = fits || this.sentBytes + pending === 0 ? "encode" : "skip";
    if (decision === "encode" && !key && this.lastKeyBytes !== null && Number.isFinite(untilKeyMs) && untilKeyMs > 0) {
      // [D68] Skips spread over the key interval, not left to its end. The tightest window is the
      // one that holds a keyframe and every frame after it up to the next: when the frames still
      // to come before the next keyframe will not all fit in what is left of it, a share of them
      // is skipped from now on, evenly (one at a time, a frame interval's gap), instead of every
      // one of the last few hundred milliseconds when the window is found full. Left to the end,
      // the skips were a gap of 130–200 ms before every keyframe, a freeze at every viewer every
      // 2 s (gate run 45211601384: 60,000 freezes, 16% of the time, at every depth at once).
      // Planned to leave PLAN_SLACK_FRAMES of room: frames come out bigger than expected, and
      // what the plan does not leave, the window takes back from the interval's last frames.
      const left = Math.max(1, Math.round((untilKeyMs * this.fps) / 1000));
      const mean = this.meanDeltaBytes();
      const want = left * mean;
      const room = gate - margin - PLAN_SLACK_FRAMES * mean - Math.max(this.lastKeyBytes, this.expectedBytes(true, 0)) - this.gopDeltaBytes - pending;
      const keep = want <= 0 ? 1 : Math.max(0, Math.min(1, room / want));
      this.skipCredit += 1 - keep;
      if (this.skipCredit >= 1) {
        this.skipCredit -= 1;
        decision = "skip";
      }
    }
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
    const expected = this.inFlight.shift();
    // Delta frames only (keyframes have their own estimate), and not while the picture is being
    // learnt: the first frames of an input are all surprises.
    if (!key && expected !== undefined && expected > 0 && bytes > expected && now - this.firstOfferAt >= RATE_WINDOW_MS) this.surprises.push({ at: now, bytes: bytes - expected });
    this.sent.push({ at: now, bytes });
    this.sentBytes += bytes;
    // The latest of each kind, a little pessimistic: pictures change fast.
    const remember = (old: number | null) => (old === null ? bytes : Math.max(bytes, 0.5 * old + 0.5 * bytes));
    if (key) {
      // [D68] A new key interval.
      this.lastKeyBytes = bytes;
      this.gopDeltaBytes = 0;
      this.skipCredit = 0;
    } else this.gopDeltaBytes += bytes;
    if (key) {
      this.keysSeen++;
      // Only what a keyframe of this size really came to.
      this.keyBytes = this.keySeenAtLevel ? remember(this.keyBytes) : bytes;
      this.keySeenAtLevel = true;
    }
    else {
      const layer = Math.min(temporal, this.layerBytes.length - 1);
      // Up at once with a bigger frame (the picture got harder, or bigger: frames let through on a
      // low guess are what takes a window over), down halfway with each smaller one.
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
      else if (ratio < 0.95 && this.factor < 1) this.factor = Math.min(1, this.factor * Math.min(1.15, 1 / ratio));
    }
    const keyTooBig = this.keySeenAtLevel && this.keyBytes !== null && this.keyBytes > KEY_MARGIN * this.keyAllowanceBytes();
    const smallest = this.level >= SCALE_LEVELS.length - 1;
    const newKey = this.keysSeen !== this.keyActedOn;
    if ((this.shrinkNow || (keyTooBig && newKey)) && !smallest) {
      // A frame too big for the window, or a keyframe past the allowance (asking the encoder for
      // less does not make keyframes smaller): smaller at once, not at the end of a hold, so that
      // the next keyframe, two seconds on, is not past it too.
      this.keyActedOn = this.keysSeen;
      this.shrinkNow = false;
      this.shrink(now, keyTooBig);
    } else if (now - this.levelAt >= SCALE_HOLD_MS) {
      const offered = this.offered.length;
      const skipped = this.offered.filter((o) => o.skipped).length;
      const tooManySkipped = offered >= 10 && skipped / offered >= SCALE_DOWN_SKIPPED;
      // Smaller for want of room only once asking the encoder for less has done all it can (step 1 before 3).
      const askedLeast = this.factor <= STEER_MIN * 1.05;
      if (tooManySkipped && askedLeast && !smallest) {
        this.shrink(now, false);
      } else if (this.level > 0 && skipped === 0 && this.biggerKeyFits() && this.factor >= SCALE_UP_FACTOR && now - this.levelAt >= this.upAfterMs) {
        // Only a picture the encoder keeps to what it is asked is tried bigger: one at its coarsest
        // (asked for less, it spent no less) would only bring back the frames that do not fit,
        // and a keyframe past the allowance with them.
        this.raisedAt = now;
        this.setLevel(this.level - 1, now);
      }
    }
    return { factor: this.factor, level: this.level };
  }

  /**
   * Whether a keyframe one size up might still be inside the allowance. A picture at the encoder's
   * coarsest costs its area, one it holds to its target costs about the same at any size, and
   * nothing here tells the two apart: taken halfway (the square root of the area's ratio). A try
   * that guesses wrong costs one keyframe past the allowance, and the wait before the next doubles.
   */
  private biggerKeyFits(): boolean {
    if (this.keyBytes === null) return true;
    const ratio = ((SCALE_LEVELS[this.level - 1] as number) / (SCALE_LEVELS[this.level] as number)) ** 2;
    return this.keyBytes * Math.sqrt(ratio) <= KEY_TRY_MARGIN * this.keyAllowanceBytes();
  }

  /**
   * One size smaller; or, for a keyframe past the allowance, straight to the size where it would
   * not be, taking it to cost its area (a keyframe that big is the encoder at its coarsest), so
   * that the way down is not a keyframe past the allowance at every size.
   */
  private shrink(now: number, forKey: boolean): void {
    // Bigger did not hold: wait longer before trying it again.
    if (now - this.raisedAt < this.upAfterMs) this.upAfterMs = Math.min(SCALE_UP_MAX_MS, this.upAfterMs * 2);
    let level = this.level + 1;
    if (forKey && this.keyBytes !== null) {
      const share = SCALE_LEVELS[this.level] as number;
      while (level < SCALE_LEVELS.length - 1 && this.keyBytes * ((SCALE_LEVELS[level] as number) / share) ** 2 > KEY_MARGIN * this.keyAllowanceBytes()) level++;
    }
    this.setLevel(level, now);
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
    this.tryingUntil = level < this.level ? now + TRY_MS : -Infinity;
    this.level = level;
    this.levelAt = now;
    this.counters.scaleChanges++;
  }

  stats(): { offered: number; skipped: number; scaleChanges: number; level: number; factor: number } {
    return { ...this.counters, level: this.level, factor: this.factor };
  }
}
