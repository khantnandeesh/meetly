/**
 * `LinkEstimator`: the signals of SPEC §11.1 and the state of §11.2, for one link.
 *
 * A link has two directions and the estimator watches both. What arrives is measured here, from
 * `linkSeq`, `sendMs` and arrival times, and told to the peer in feedback. What leaves is measured
 * by the peer and comes back in its feedback. `estimate()` answers for the direction that carries
 * the media; `directed()` answers for one direction by name.
 */
import { ECHO_NONE, rttFromEcho, seq16Diff, type Feedback, type Heartbeat } from "../protocol";
import type { LinkEstimate } from "../types";
import { DEFAULT_STREAM_KBPS, ESTIMATOR_TUNING, bytesOf, type EstimatorTuning } from "./tuning";
import type { FeedbackBody, LinkEstimator } from "./types";

export type LinkEstimatorOptions = {
  /** *B* of SPEC §11.2: the full bitrate of the video stream this link carries. */
  bitrateKbps?: number;
  tuning?: Partial<EstimatorTuning>;
};

/** What happened in one stretch of time, kept for as long as the window. */
type Slot = { at: number; a: number; b: number; c: number; ms: number };

/** Sums over the last `windowMs`. */
class Window {
  private slots: Slot[] = [];
  private head = 0;
  constructor(private readonly windowMs: number) {}

  add(at: number, a: number, b = 0, c = 0, ms = 0): void {
    this.slots.push({ at, a, b, c, ms });
  }

  /** Sums of what was added after `now - windowMs`. */
  sum(now: number): { a: number; b: number; c: number; ms: number; n: number } {
    const from = now - this.windowMs;
    while (this.head < this.slots.length && this.slots[this.head].at <= from) this.head++;
    if (this.head > 256 && this.head * 2 > this.slots.length) {
      this.slots = this.slots.slice(this.head);
      this.head = 0;
    }
    let a = 0;
    let b = 0;
    let c = 0;
    let ms = 0;
    for (let i = this.head; i < this.slots.length; i++) {
      a += this.slots[i].a;
      b += this.slots[i].b;
      c += this.slots[i].c;
      ms += this.slots[i].ms;
    }
    return { a, b, c, ms, n: this.slots.length - this.head };
  }
}

/** The smallest value seen in the last `spanMs`, kept as one minimum per bucket of time. */
class Floor {
  private readonly bucketMs: number;
  private buckets: { index: number; min: number }[] = [];
  constructor(private readonly spanMs: number) {
    this.bucketMs = Math.max(1, spanMs / 20);
  }

  add(value: number, now: number): void {
    const index = Math.floor(now / this.bucketMs);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.index === index) last.min = Math.min(last.min, value);
    else this.buckets.push({ index, min: value });
    const oldest = Math.floor((now - this.spanMs) / this.bucketMs);
    while (this.buckets.length > 0 && this.buckets[0].index < oldest) this.buckets.shift();
  }

  get(): number | null {
    let min: number | null = null;
    for (const bucket of this.buckets) if (min === null || bucket.min < min) min = bucket.min;
    return min;
  }

  clear(): void {
    this.buckets = [];
  }
}

/** Tracks "at or over a threshold, for how long". */
class Sustained {
  private since: number | null = null;
  update(over: boolean, now: number): void {
    if (!over) this.since = null;
    else if (this.since === null) this.since = now;
  }
  forMs(now: number): number {
    return this.since === null ? -1 : now - this.since;
  }
}

const u16 = (value: number): number => Math.max(0, Math.min(0xffff, Math.round(value)));
const lossOf = (received: number, expected: number): number => (expected <= 0 ? 0 : Math.max(0, Math.min(100, ((expected - received) * 100) / expected)));

/** A gap in arrivals longer than this and `sendMs` (16 bits of milliseconds) can no longer be unwrapped. */
const SEND_MS_UNWRAP_LIMIT = 20_000;

/** A `LinkEstimator` whose `directed` is there for certain. */
export type DirectedLinkEstimator = LinkEstimator & { directed: NonNullable<LinkEstimator["directed"]> };

export function createLinkEstimator(options: LinkEstimatorOptions = {}): DirectedLinkEstimator {
  const tuning: EstimatorTuning = { ...ESTIMATOR_TUNING, ...options.tuning };
  const streamKbps = options.bitrateKbps ?? DEFAULT_STREAM_KBPS;

  /* ---- what arrives ---- */
  let rxAny = false;
  /** `linkSeq` without its wrap: the highest seen, and where the last feedback left off. */
  let rxHighest = 0;
  let rxHighestAtTake = 0;
  let rxIntervalCount = 0;
  let rxLastSendMs = 0;
  /** `sendMs` without its wrap. */
  let rxSendClock = 0;
  let rxLastArrival = 0;
  let rxJitter = 0;
  /** Arrival time less sending time: the one-way delay, plus whatever the two clocks differ by. */
  const rxFloor = new Floor(tuning.delayFloorMs);
  let rxIntervalMinTransit: number | null = null;
  let rxQueueDelay = 0;
  const rxQueueHigh = new Sustained();
  const rxLoss = new Window(tuning.windowMs);
  const rxBytes = new Window(tuning.windowMs);

  /* ---- what leaves ---- */
  const txBytes = new Window(tuning.windowMs);
  const txReports = new Window(tuning.windowMs);
  let txLastFeedbackAt: number | null = null;
  let txLastFeedbackSendMs = 0;
  let txLastHighestSeq = 0;
  let txQueueDelay = 0;
  let txJitter = 0;
  const txQueueHigh = new Sustained();

  let rttMs: number | null = null;
  let buffered = 0;
  /**
   * C6: the backlog counts against the link once it has stood over a line for `backlogWindowMs`.
   * A keyframe is several delta frames' worth, all handed to the channel at once; on a link with
   * room for the stream the backlog it leaves is gone a few frames later, and is not the link
   * falling behind. One that is still there at every sample for the window is.
   */
  const backlogStrained = new Sustained();
  const backlogCongested = new Sustained();

  const onEcho = (now: number, echoMs: number, echoHoldMs: number): void => {
    const sample = rttFromEcho(now, echoMs, echoHoldMs);
    if (sample === null) return;
    // Smoothed as TCP smooths it: one late packet does not move a parent's cost.
    rttMs = rttMs === null ? sample : rttMs + (sample - rttMs) / 8;
  };

  /** Queue delay of the stretch of arrivals since the last feedback: its quickest packet against the floor. */
  const rxQueueNow = (): number => {
    const floor = rxFloor.get();
    return rxIntervalMinTransit === null || floor === null ? rxQueueDelay : Math.max(0, rxIntervalMinTransit - floor);
  };

  /**
   * [D32]'s guard, per direction: since when the loss has been at the policer's line with no
   * queue (`high`); whether the guard has fired and the link is known to drop without queueing
   * (`known`); and since when the loss has been under the strained line (`quiet`), which clears it.
   */
  type Policer = { high: Sustained; known: boolean; quiet: Sustained };
  const txPoliced: Policer = { high: new Sustained(), known: false, quiet: new Sustained() };
  const rxPoliced: Policer = { high: new Sustained(), known: false, quiet: new Sustained() };

  const stateOf = (lossPct: number, queueDelayMs: number, queueHighForMs: number, now: number, policed: Policer): LinkEstimate["state"] => {
    // The state reads the backlog that stands. The estimate's `bufferedBytes`, which rule 6 and
    // the replay budget read, stays the channel's backlog as it is now.
    const standFor = tuning.backlogWindowMs;
    // C6: loss is the link's trouble only where it shows a queue. Loss on a path with no queue
    // (a lossy radio, the gate mix's "bad" bursts) is NACK's to repair (§4.6); dropping a layer
    // does not make a single packet fewer of it lost.
    const queued = queueDelayMs >= tuning.strainedQueueMs || buffered > bytesOf(streamKbps, tuning.strainedBufferMs);
    // [D32]'s guard: loss that stays high with no queue is a policer or a lossy last hop, and the
    // link needs fewer layers whatever the queue says. Bursts on a lossy link do not last this
    // long. Once it has fired, loss counts as §11.2's table has it, queue or none, until the loss
    // has been under the strained line for `policedClearMs`: otherwise the five seconds of ok
    // between two firings would give the layer back, and the policer take it again, for ever.
    policed.high.update(!queued && lossPct >= tuning.policedLossPct, now);
    policed.quiet.update(lossPct < tuning.strainedLossPct, now);
    if (tuning.lossNeedsQueue && policed.high.forMs(now) >= tuning.policedForMs) policed.known = true;
    else if (policed.known && policed.quiet.forMs(now) >= tuning.policedClearMs) policed.known = false;
    const loss = tuning.lossNeedsQueue && !queued && !policed.known ? 0 : lossPct;
    if (backlogCongested.forMs(now) >= standFor || loss >= tuning.congestedLossPct || queueHighForMs >= tuning.congestedQueueForMs) return "congested";
    if (backlogStrained.forMs(now) >= standFor || loss >= tuning.strainedLossPct || queueDelayMs >= tuning.strainedQueueMs) return "strained";
    return "ok";
  };

  const sendKbps = (now: number): number => (txBytes.sum(now).a * 8) / tuning.windowMs;

  const sent = (now: number): LinkEstimate => {
    const reports = txReports.sum(now);
    const packets = txBytes.sum(now);
    const lossPct = lossOf(reports.a, reports.b);
    // The peer counts packets, not bytes: what it received is priced at the size of what was sent.
    const meanBytes = packets.n > 0 ? packets.a / packets.n : 0;
    const deliveredKbps = reports.ms > 0 ? (reports.c * meanBytes * 8) / reports.ms : 0;
    return {
      rttMs,
      lossPct,
      queueDelayMs: txQueueDelay,
      jitterMs: txJitter,
      sendKbps: sendKbps(now),
      deliveredKbps,
      bufferedBytes: buffered,
      state: stateOf(lossPct, txQueueDelay, txQueueHigh.forMs(now), now, txPoliced),
    };
  };

  const received = (now: number): LinkEstimate => {
    const past = rxLoss.sum(now);
    const lossPct = lossOf(past.a + rxIntervalCount, past.b + (rxHighest - rxHighestAtTake));
    const queueDelayMs = rxQueueNow();
    return {
      rttMs,
      lossPct,
      queueDelayMs,
      jitterMs: rxJitter,
      sendKbps: sendKbps(now),
      deliveredKbps: (rxBytes.sum(now).a * 8) / tuning.windowMs,
      bufferedBytes: buffered,
      state: stateOf(lossPct, queueDelayMs, rxQueueHigh.forMs(now), now, rxPoliced),
    };
  };

  const feedbackFresh = (now: number): boolean => txLastFeedbackAt !== null && now - txLastFeedbackAt <= tuning.feedbackFreshMs;

  const estimator: DirectedLinkEstimator = {
    onReceived(linkSeq, sendMs, bytes, now) {
      if (rxAny && now - rxLastArrival > SEND_MS_UNWRAP_LIMIT) {
        // Too long a silence to tell how often `sendMs` wrapped: the delay is measured afresh.
        rxFloor.clear();
        rxSendClock = sendMs;
      } else if (rxAny) {
        const sendGap = seq16Diff(sendMs, rxLastSendMs);
        rxSendClock += sendGap;
        // RFC 3550 §6.4.1.
        rxJitter += (Math.abs(now - rxLastArrival - sendGap) - rxJitter) / 16;
      } else {
        rxSendClock = sendMs;
      }

      if (!rxAny) {
        rxHighest = linkSeq;
        rxHighestAtTake = linkSeq - 1;
      } else {
        const ahead = seq16Diff(linkSeq, rxHighest & 0xffff);
        if (ahead > 0) rxHighest += ahead;
      }
      rxAny = true;
      rxLastSendMs = sendMs;
      rxLastArrival = now;
      rxIntervalCount++;
      rxBytes.add(now, bytes);

      const transit = now - rxSendClock;
      rxFloor.add(transit, now);
      rxIntervalMinTransit = rxIntervalMinTransit === null ? transit : Math.min(rxIntervalMinTransit, transit);
    },

    onSent(bytes, now) {
      txBytes.add(now, bytes);
    },

    onFeedback(feedback: Feedback, now) {
      onEcho(now, feedback.echoMs, feedback.echoHoldMs);
      // How long this report covers, on the peer's clock. A report that went missing leaves a
      // hole: this one then covers only its own share of the time since the last one that came.
      // After a silence (a probe that starts minutes after the last one) it covers a time whose
      // length `sendMs` can no longer say: like the first report, it counts for loss only.
      let coversMs = 0;
      if (txLastFeedbackAt !== null && now - txLastFeedbackAt <= tuning.feedbackFreshMs) {
        coversMs = Math.max(0, seq16Diff(feedback.sendMs, txLastFeedbackSendMs));
        const advanced = seq16Diff(feedback.highestSeq, txLastHighestSeq);
        if (advanced > feedback.expected && feedback.expected > 0) coversMs *= feedback.expected / advanced;
      }
      // The first report covers a time nobody measured: it counts for loss, not for a rate.
      txReports.add(now, feedback.received, feedback.expected, coversMs > 0 ? feedback.received : 0, coversMs);
      txLastFeedbackAt = now;
      txLastFeedbackSendMs = feedback.sendMs;
      txLastHighestSeq = feedback.highestSeq;
      txQueueDelay = feedback.queueDelayTenthsMs / 10;
      txJitter = feedback.jitterTenthsMs / 10;
      txQueueHigh.update(txQueueDelay >= tuning.congestedQueueMs, now);
    },

    onHeartbeat(heartbeat: Heartbeat, now) {
      onEcho(now, heartbeat.echoMs, heartbeat.echoHoldMs);
    },

    onBuffered(bytes, now) {
      buffered = bytes;
      backlogStrained.update(bytes > bytesOf(streamKbps, tuning.strainedBufferMs), now);
      backlogCongested.update(bytes > bytesOf(streamKbps, tuning.congestedBufferMs), now);
    },

    takeFeedback(now): FeedbackBody {
      const expected = rxHighest - rxHighestAtTake;
      rxQueueDelay = rxQueueNow();
      rxQueueHigh.update(rxQueueDelay >= tuning.congestedQueueMs, now);
      rxLoss.add(now, rxIntervalCount, expected);
      const body: FeedbackBody = {
        highestSeq: rxHighest & 0xffff,
        received: u16(rxIntervalCount),
        expected: u16(expected),
        jitterTenthsMs: u16(rxJitter * 10),
        queueDelayTenthsMs: u16(rxQueueDelay * 10),
        ...estimator.echo(now),
      };
      rxHighestAtTake = rxHighest;
      rxIntervalCount = 0;
      rxIntervalMinTransit = null;
      return body;
    },

    echo(now) {
      const held = Math.round(now - rxLastArrival);
      // Past half the range the peer could not tell a long hold from a negative round trip.
      if (!rxAny || held < 0 || held > 0x7fff) return { echoMs: 0, echoHoldMs: ECHO_NONE };
      return { echoMs: rxLastSendMs, echoHoldMs: held };
    },

    estimate(now) {
      // The direction that carries the media is the one worth judging. A peer hears feedback
      // only about what it sends, so: fresh feedback, and sending at least as much as arrives.
      if (feedbackFresh(now) && sendKbps(now) >= (rxBytes.sum(now).a * 8) / tuning.windowMs) return sent(now);
      return received(now);
    },

    directed(direction, now) {
      return direction === "sent" ? sent(now) : received(now);
    },
  };
  return estimator;
}
