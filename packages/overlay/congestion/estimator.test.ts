/**
 * C1 (PLAN §5): the estimator against synthetic traces. Loss within a point of the truth across
 * a `linkSeq` wrap, RTT within 2 ms across a `sendMs` wrap, a queue seen within 300 ms and clock
 * drift not mistaken for one, and the states of SPEC §11.2 exactly as its table.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ECHO_NONE, ms16, type Feedback } from "../protocol";
import { createLinkEstimator, type DirectedLinkEstimator } from "./estimator";
import { seeded } from "./sim/world";

/** A whole feedback packet from the estimator's part of one, as the link would send it at `now`. */
const feedbackFrom = (estimator: DirectedLinkEstimator, now: number): Feedback => ({
  ...estimator.takeFeedback(now),
  flags: 0,
  linkSeq: 0,
  sendMs: ms16(now),
  playoutDelayMs: 0,
  bufferMs: 0,
  maxSpatial: 0,
  maxTemporal: 2,
});

/** Feedback made by hand, for when only what it says matters. */
const feedback = (now: number, fields: Partial<Feedback>): Feedback => ({
  flags: 0,
  linkSeq: 0,
  sendMs: ms16(now),
  echoMs: 0,
  echoHoldMs: ECHO_NONE,
  highestSeq: 0,
  received: 0,
  expected: 0,
  jitterTenthsMs: 0,
  queueDelayTenthsMs: 0,
  playoutDelayMs: 0,
  bufferMs: 0,
  maxSpatial: 0,
  maxTemporal: 2,
  ...fields,
});

/**
 * A sender and a receiver, the sender's packets numbered and timed as a link numbers and times
 * them, with `lose` deciding each packet's fate. Returns the sender's reading of the loss once a
 * second, and the receiver's own.
 */
function lossTrace(lose: (index: number) => boolean, options: { packets: number; perSecond: number; firstSeq: number }) {
  const sender = createLinkEstimator();
  const receiver = createLinkEstimator();
  const gap = 1000 / options.perSecond;
  const readings: { sent: number; received: number; whole: number }[] = [];
  let lost = 0;
  let nextFeedback = 100;
  let nextReading = 2000;
  for (let i = 0; i < options.packets; i++) {
    const now = i * gap;
    while (nextFeedback <= now) {
      // 20 ms for the feedback to cross back.
      sender.onFeedback(feedbackFrom(receiver, nextFeedback), nextFeedback + 20);
      nextFeedback += 100;
    }
    if (now >= nextReading) {
      readings.push({ sent: sender.directed("sent", now).lossPct, received: receiver.directed("received", now).lossPct, whole: sender.estimate(now).lossPct });
      nextReading += 1000;
    }
    sender.onSent(1000, now);
    if (lose(i)) lost++;
    else receiver.onReceived((options.firstSeq + i) & 0xffff, ms16(now), 1000, now + 20);
  }
  return { readings, truePct: (lost / options.packets) * 100 };
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

describe("LinkEstimator: loss (C1)", () => {
  for (const [pct, every] of [
    [1, 100],
    [5, 20],
    [20, 5],
  ] as const) {
    it(`reads ${pct}% loss within a point at every second, across a linkSeq wrap`, () => {
      // 500 packets a second from linkSeq 64,000: the numbers wrap three seconds in.
      const trace = lossTrace((index) => index % every === every - 1, { packets: 10_000, perSecond: 500, firstSeq: 64_000 });
      assert.equal(trace.truePct, pct);
      assert.ok(trace.readings.length >= 15);
      for (const reading of trace.readings) {
        assert.ok(Math.abs(reading.sent - pct) <= 1, `sender read ${reading.sent}`);
        assert.ok(Math.abs(reading.received - pct) <= 1, `receiver read ${reading.received}`);
        assert.equal(reading.whole, reading.sent, "a link that sends and hears feedback is judged on what it sends");
      }
    });

    it(`reads ${pct}% random loss within a point over a long trace that wraps linkSeq`, () => {
      const random = seeded(pct);
      const trace = lossTrace(() => random() * 100 < pct, { packets: 100_000, perSecond: 500, firstSeq: 0 });
      assert.ok(Math.abs(mean(trace.readings.map((reading) => reading.sent)) - trace.truePct) <= 1);
      assert.ok(Math.abs(mean(trace.readings.map((reading) => reading.received)) - trace.truePct) <= 1);
    });
  }

  it("does not call packets that overtake each other lost", () => {
    const receiver = createLinkEstimator();
    // Pairs swapped all the way through, across the wrap.
    for (let i = 0; i < 2000; i++) {
      const seq = 65_000 + (i % 2 === 0 ? i + 1 : i - 1);
      receiver.onReceived(seq & 0xffff, ms16(i * 2), 500, i * 2 + 10);
      if (i % 50 === 49) receiver.takeFeedback(i * 2 + 10);
    }
    assert.equal(receiver.directed("received", 4010).lossPct, 0);
  });

  it("puts what arrived, and what should have, in the feedback, and starts each interval afresh", () => {
    const receiver = createLinkEstimator();
    for (const seq of [65_533, 65_534, 0, 1, 3]) receiver.onReceived(seq, ms16(seq), 100, 1000);
    const first = receiver.takeFeedback(1001);
    assert.deepEqual({ highestSeq: first.highestSeq, received: first.received, expected: first.expected }, { highestSeq: 3, received: 5, expected: 7 });
    const empty = receiver.takeFeedback(1101);
    assert.deepEqual({ highestSeq: empty.highestSeq, received: empty.received, expected: empty.expected }, { highestSeq: 3, received: 0, expected: 0 });
    receiver.onReceived(5, 0, 100, 1200);
    const next = receiver.takeFeedback(1201);
    assert.deepEqual({ highestSeq: next.highestSeq, received: next.received, expected: next.expected }, { highestSeq: 5, received: 1, expected: 2 });
  });
});

describe("LinkEstimator: round-trip time (C1)", () => {
  it("is within 2 ms of the truth on both sides, across sendMs wraps, with clocks that agree on nothing", () => {
    // A parent and a child. Their clocks start 23 minutes apart, and the child's wraps `sendMs`
    // four seconds in. 18.4 ms down and 26.3 ms up: 44.7 ms round the loop.
    const parent = createLinkEstimator();
    const child = createLinkEstimator();
    const parentClock = (t: number): number => t + 1_234_567.25;
    const childClock = (t: number): number => t + 61_500.5;
    const down = 18.4;
    const up = 26.3;
    const inFlight: { at: number; run: () => void }[] = [];
    let parentSeq = 0;
    let childSeq = 0;
    const checks: number[] = [];
    for (let t = 0; t <= 150_000; t++) {
      for (let i = 0; i < inFlight.length; ) {
        if (inFlight[i].at <= t) inFlight.splice(i, 1)[0].run();
        else i++;
      }
      if (t % 50 === 0) {
        // The parent's heartbeat, carrying an echo of the child's last packet.
        const echo = parent.echo(parentClock(t));
        const seq = parentSeq++ & 0xffff;
        const sendMs = ms16(parentClock(t));
        parent.onSent(12, parentClock(t));
        inFlight.push({
          at: t + down,
          run: () => {
            child.onReceived(seq, sendMs, 12, childClock(t + down));
            child.onHeartbeat({ flags: 0, linkSeq: seq, sendMs, ...echo, depth: 0, streams: [] }, childClock(t + down));
          },
        });
      }
      if (t % 100 === 7) {
        const sent = feedbackFrom(child, childClock(t));
        const seq = childSeq++ & 0xffff;
        child.onSent(26, childClock(t));
        inFlight.push({
          at: t + up,
          run: () => {
            parent.onReceived(seq, sent.sendMs, 26, parentClock(t + up));
            parent.onFeedback({ ...sent, linkSeq: seq }, parentClock(t + up));
          },
        });
      }
      if (t > 1000 && t % 997 === 0) {
        checks.push(t);
        for (const side of [parent.estimate(parentClock(t)), child.estimate(childClock(t))]) {
          assert.ok(side.rttMs !== null && Math.abs(side.rttMs - (down + up)) <= 2, `at ${t}: ${side.rttMs}`);
        }
      }
    }
    // Two and a quarter turns of a 16-bit millisecond clock were covered.
    assert.ok(checks.length > 140);
  });

  it("is null until there is an echo, and says so in what it sends", () => {
    const estimator = createLinkEstimator();
    assert.equal(estimator.estimate(0).rttMs, null);
    assert.deepEqual(estimator.echo(5), { echoMs: 0, echoHoldMs: ECHO_NONE });
    estimator.onFeedback(feedback(10, { echoHoldMs: ECHO_NONE }), 10);
    assert.equal(estimator.estimate(10).rttMs, null);
    estimator.onReceived(1, 4242, 100, 100);
    assert.deepEqual(estimator.echo(130), { echoMs: 4242, echoHoldMs: 30 });
    // A packet held for longer than an echo can say is not echoed at all.
    assert.equal(estimator.echo(100 + 40_000).echoHoldMs, ECHO_NONE);
  });
});

describe("LinkEstimator: queue delay (C1)", () => {
  /**
   * A sender whose clock runs `ppm` fast, a receiver, and a path whose delay `delayAt` gives.
   * A packet every 5 ms, feedback every 100 ms. Returns what each feedback said, and when.
   */
  function delayTrace(untilMs: number, ppm: number, delayAt: (t: number) => number) {
    const receiver = createLinkEstimator();
    const sender = createLinkEstimator();
    const reports: { at: number; queueDelayMs: number; state: string }[] = [];
    const arrivals: { at: number; seq: number; sendMs: number }[] = [];
    let seq = 0;
    for (let t = 0; t <= untilMs; t++) {
      if (t % 5 === 0) {
        const senderClock = t * (1 + ppm / 1e6) + 31_000;
        arrivals.push({ at: t + delayAt(t), seq: seq++ & 0xffff, sendMs: ms16(senderClock) });
        sender.onSent(1000, t);
      }
      while (arrivals.length > 0 && arrivals[0].at <= t) {
        const arrival = arrivals.shift()!;
        receiver.onReceived(arrival.seq, arrival.sendMs, 1000, arrival.at);
      }
      if (t % 100 === 99) {
        const sent = feedbackFrom(receiver, t);
        sender.onFeedback(sent, t);
        reports.push({ at: t, queueDelayMs: sent.queueDelayTenthsMs / 10, state: sender.estimate(t).state });
      }
    }
    return reports;
  }

  it("stays at nothing while two clocks drift apart at 100 ppm, either way", () => {
    for (const ppm of [100, -100]) {
      const reports = delayTrace(120_000, ppm, () => 20);
      // 100 ppm is 12 ms over these two minutes. The ten-second floor leaves 1 ms of it, and
      // `sendMs` is whole milliseconds.
      assert.ok(Math.max(...reports.map((report) => report.queueDelayMs)) <= 2, `${ppm} ppm: ${Math.max(...reports.map((report) => report.queueDelayMs))}`);
      assert.ok(reports.every((report) => report.state === "ok"));
    }
  });

  it("rises within 300 ms of a queue forming, drift or no drift", () => {
    // At 30 s the path starts to queue: each millisecond adds one of delay, up to 150.
    const formsAt = 30_000;
    const reports = delayTrace(34_000, 100, (t) => 20 + Math.max(0, Math.min(150, t - formsAt)));
    const before = reports.filter((report) => report.at < formsAt);
    assert.ok(before.every((report) => report.queueDelayMs <= 2));
    // The reading is each interval's quickest packet, so it trails a growing queue by an interval:
    // clearly up (strained, §11.2) inside 300 ms, and at the queue's full height soon after.
    const risen = reports.find((report) => report.at >= formsAt && report.queueDelayMs >= 40)!;
    assert.ok(risen.at - formsAt <= 300, `risen after ${risen.at - formsAt} ms`);
    assert.notEqual(risen.state, "ok");
    const seen = reports.find((report) => report.queueDelayMs >= 100)!;
    assert.ok(seen.at - formsAt <= 500, `at 100 ms after ${seen.at - formsAt} ms`);
    // Congested when it has lasted 500 ms at 100 or more.
    const congested = reports.find((report) => report.state === "congested")!;
    assert.equal(congested.at - seen.at, 500);
    assert.equal(reports[reports.length - 1].queueDelayMs, 150);
  });

  it("is not fooled by jitter: it is the quickest packet of each interval that is compared with the floor", () => {
    const random = seeded(7);
    const reports = delayTrace(20_000, 0, () => 60 + random() * 40);
    assert.ok(Math.max(...reports.slice(5).map((report) => report.queueDelayMs)) < 15);
  });

  it("measures interarrival jitter as RFC 3550 does", () => {
    const receiver = createLinkEstimator();
    let expected = 0;
    let lastTransit: number | null = null;
    const random = seeded(3);
    for (let i = 0; i < 400; i++) {
      const sentAt = i * 20;
      const arrival = sentAt + 30 + Math.round(random() * 20);
      receiver.onReceived(i, ms16(sentAt), 100, arrival);
      const transit = arrival - sentAt;
      if (lastTransit !== null) expected += (Math.abs(transit - lastTransit) - expected) / 16;
      lastTransit = transit;
    }
    const body = receiver.takeFeedback(8100);
    assert.ok(Math.abs(body.jitterTenthsMs / 10 - expected) < 0.06);
    assert.ok(Math.abs(receiver.directed("received", 8100).jitterMs - expected) < 1e-9);
  });
});

describe("LinkEstimator: the state of a link, exactly as SPEC §11.2's table", () => {
  // B is 1,200 kbps: 50 ms of it is 7,500 bytes, 150 ms is 22,500.
  const cases: [name: string, set: (estimator: DirectedLinkEstimator) => void, state: string][] = [
    ["nothing wrong", () => {}, "ok"],
    ["bufferedBytes at 50 ms of B", (e) => e.onBuffered(7500, 0), "ok"],
    ["bufferedBytes over 50 ms of B", (e) => e.onBuffered(7501, 0), "strained"],
    ["bufferedBytes at 150 ms of B", (e) => e.onBuffered(22_500, 0), "strained"],
    ["bufferedBytes over 150 ms of B", (e) => e.onBuffered(22_501, 0), "congested"],
    ["lossPct 2.9", (e) => e.onFeedback(feedback(0, { received: 971, expected: 1000 }), 0), "ok"],
    ["lossPct 3", (e) => e.onFeedback(feedback(0, { received: 97, expected: 100 }), 0), "strained"],
    ["lossPct 9.9", (e) => e.onFeedback(feedback(0, { received: 901, expected: 1000 }), 0), "strained"],
    ["lossPct 10", (e) => e.onFeedback(feedback(0, { received: 90, expected: 100 }), 0), "congested"],
    ["queueDelayMs 39.9", (e) => e.onFeedback(feedback(0, { queueDelayTenthsMs: 399 }), 0), "ok"],
    ["queueDelayMs 40", (e) => e.onFeedback(feedback(0, { queueDelayTenthsMs: 400 }), 0), "strained"],
    ["queueDelayMs 100, just now", (e) => e.onFeedback(feedback(0, { queueDelayTenthsMs: 1000 }), 0), "strained"],
  ];
  for (const [name, set, state] of cases) {
    it(`${name}: ${state}`, () => {
      const estimator = createLinkEstimator({ bitrateKbps: 1200 });
      set(estimator);
      // Looked at 150 ms on: a backlog counts once it has stood that long (C6, the next suite).
      assert.equal(estimator.directed("sent", 150).state, state);
    });
  }

  it("queueDelayMs at 100 or more is congested only once it has lasted 500 ms, and a dip starts the count again", () => {
    const estimator = createLinkEstimator();
    const at = (now: number, queueMs: number): string => {
      estimator.onFeedback(feedback(now, { queueDelayTenthsMs: queueMs * 10 }), now);
      return estimator.directed("sent", now).state;
    };
    assert.equal(at(0, 100), "strained");
    assert.equal(at(400, 120), "strained");
    assert.equal(estimator.directed("sent", 499).state, "strained");
    assert.equal(estimator.directed("sent", 500).state, "congested");
    assert.equal(at(600, 99), "strained");
    assert.equal(at(700, 100), "strained");
    assert.equal(estimator.directed("sent", 1199).state, "strained");
    assert.equal(at(1200, 100), "congested");
    assert.equal(at(1300, 10), "ok");
  });

  it("goes back to ok when the cause has gone: loss is over the last second only", () => {
    const estimator = createLinkEstimator();
    estimator.onFeedback(feedback(0, { received: 80, expected: 100 }), 0);
    assert.equal(estimator.directed("sent", 0).state, "congested");
    estimator.onFeedback(feedback(500, { received: 100, expected: 100 }), 500);
    assert.equal(estimator.directed("sent", 500).state, "congested"); // 180 of 200
    assert.equal(estimator.directed("sent", 1000).state, "ok"); // the bad report is a second old
    estimator.onBuffered(30_000, 1000);
    assert.equal(estimator.directed("sent", 1150).state, "congested");
    estimator.onBuffered(0, 1151);
    assert.equal(estimator.directed("sent", 1151).state, "ok");
  });

  it("takes B from the stream it is told of", () => {
    const estimator = createLinkEstimator({ bitrateKbps: 600 });
    estimator.onBuffered(3751, 0);
    assert.equal(estimator.estimate(150).state, "strained");
    estimator.onBuffered(11_251, 1000);
    assert.equal(estimator.estimate(1149).state, "strained");
    assert.equal(estimator.estimate(1150).state, "congested");
  });
});

describe("LinkEstimator: the backlog that stands (C6)", () => {
  // B is 1,200 kbps: the strained line is 7,500 bytes, the congested one 22,500; a backlog counts
  // once it has been over a line at every sample for 150 ms.
  it("does not read a keyframe's burst that the link drains for congestion", () => {
    const estimator = createLinkEstimator();
    // A frame every 33 ms. A 27 kB keyframe goes in at 100 and a 3 Mbps link drains it in 72 ms.
    const samples: [number, number][] = [
      [0, 1000],
      [33, 900],
      [66, 1100],
      [100, 27_000],
      [133, 15_000],
      [166, 3000],
      [200, 1000],
    ];
    for (const [at, bytes] of samples) {
      estimator.onBuffered(bytes, at);
      assert.equal(estimator.directed("sent", at).state, "ok", `at ${at}`);
      // What the channel holds now is still what rule 6 and the replay budget are shown.
      assert.equal(estimator.directed("sent", at).bufferedBytes, bytes);
    }
  });

  it("reads a backlog that is there at every sample for 150 ms for what it is", () => {
    const estimator = createLinkEstimator();
    // Strained first: over 7,500 bytes from 0, over 22,500 only from 99.
    const samples: [number, number, string][] = [
      [0, 8000, "ok"],
      [33, 12_000, "ok"],
      [66, 18_000, "ok"],
      [99, 23_000, "ok"],
      [132, 26_000, "ok"],
      [165, 29_000, "strained"],
      [198, 31_000, "strained"],
      [231, 33_000, "strained"],
      [264, 34_000, "congested"],
    ];
    for (const [at, bytes, state] of samples) {
      estimator.onBuffered(bytes, at);
      assert.equal(estimator.directed("sent", at).state, state, `at ${at}`);
    }
    // And lets go of it as soon as the channel has drained.
    estimator.onBuffered(500, 297);
    assert.equal(estimator.directed("sent", 297).state, "ok");
  });

  it("starts the count again when the backlog dips under the line, even once", () => {
    const estimator = createLinkEstimator();
    estimator.onBuffered(30_000, 0);
    estimator.onBuffered(20_000, 100);
    estimator.onBuffered(30_000, 133);
    assert.equal(estimator.directed("sent", 200).state, "strained");
    assert.equal(estimator.directed("sent", 283).state, "congested");
  });

  it("reads each sample as it comes with a window of 0: the spec to the letter", () => {
    const estimator = createLinkEstimator({ tuning: { backlogWindowMs: 0 } });
    estimator.onBuffered(1000, 0);
    estimator.onBuffered(27_000, 33);
    assert.equal(estimator.directed("sent", 33).state, "congested");
  });
});

describe("LinkEstimator: what the link carries, and which way it is judged", () => {
  it("reports what was sent and what the peer says arrived, over the last second", () => {
    const sender = createLinkEstimator();
    const receiver = createLinkEstimator();
    // 200 packets of 1,000 bytes a second leave: 1,600 kbps. Every other one arrives: 800.
    for (let t = 0; t < 4000; t++) {
      if (t % 5 === 0) {
        sender.onSent(1000, t);
        if (t % 10 === 0) receiver.onReceived((t / 5) & 0xffff, ms16(t), 1000, t);
      }
      if (t % 100 === 99) sender.onFeedback(feedbackFrom(receiver, t), t);
    }
    const estimate = sender.directed("sent", 4000);
    assert.ok(Math.abs(estimate.sendKbps - 1600) <= 16, String(estimate.sendKbps));
    assert.ok(Math.abs(estimate.deliveredKbps - 800) <= 16, String(estimate.deliveredKbps));
    assert.ok(Math.abs(receiver.directed("received", 4000).deliveredKbps - 800) <= 16);
    // A second later with nothing sent, both are nothing.
    assert.equal(sender.directed("sent", 5100).sendKbps, 0);
    assert.equal(sender.directed("sent", 5100).deliveredKbps, 0);
  });

  it("does not turn a lost feedback packet into a lower delivered rate", () => {
    const sender = createLinkEstimator();
    const receiver = createLinkEstimator();
    for (let t = 0; t < 4000; t++) {
      if (t % 5 === 0) {
        sender.onSent(1000, t);
        receiver.onReceived((t / 5) & 0xffff, ms16(t), 1000, t);
      }
      if (t % 100 === 99) {
        const sent = feedbackFrom(receiver, t);
        if (Math.floor(t / 100) % 3 !== 0) sender.onFeedback(sent, t); // every third is lost
      }
    }
    assert.ok(Math.abs(sender.directed("sent", 4000).deliveredKbps - 1600) <= 32, String(sender.directed("sent", 4000).deliveredKbps));
  });

  it("judges a child's link to its parent on what arrives, and a parent's link to a child on what the child reports", () => {
    const child = createLinkEstimator();
    // The child receives media with every tenth packet missing, and sends only feedback.
    for (let i = 0; i < 500; i++) {
      if (i % 10 !== 0) child.onReceived(i, ms16(i * 4), 1000, i * 4 + 10);
      if (i % 25 === 24) {
        child.takeFeedback(i * 4 + 10);
        child.onSent(26, i * 4 + 10);
      }
    }
    const up = child.estimate(2010);
    assert.ok(Math.abs(up.lossPct - 10) <= 1);
    assert.equal(up.state, "congested");
    assert.deepEqual(up, child.directed("received", 2010));

    // While it probes (SPEC §11.6) it sends more than it receives and hears feedback about it:
    // the link as a whole is then judged on the probe, and "received" still answers for the media.
    for (let i = 0; i < 300; i++) child.onSent(1150, 2010 + i * 3);
    child.onFeedback(feedback(2900, { received: 100, expected: 100 }), 2900);
    assert.deepEqual(child.estimate(2910), child.directed("sent", 2910));
    assert.equal(child.estimate(2910).lossPct, 0);
    assert.ok(child.directed("received", 2010).lossPct > 9);
  });

  it("stops believing feedback that has stopped coming", () => {
    const estimator = createLinkEstimator();
    estimator.onSent(1000, 0);
    estimator.onFeedback(feedback(0, { received: 50, expected: 100 }), 0);
    assert.equal(estimator.estimate(100).state, "congested");
    estimator.onSent(1000, 3500);
    assert.deepEqual(estimator.estimate(3501), estimator.directed("received", 3501));
  });
});
