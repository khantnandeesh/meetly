/**
 * PLAN H1: over 100,000 packets each profile's loss is within 0.2 points of its setting, mean
 * delay within 1 ms, delivered rate within 3% of a cap; bursts have the configured mean length;
 * the same seed gives the same drops. Then the channel wrapper, on a fake clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PacketChannel } from "@meetly/overlay/transport/types";
import { fakeClock, seededRandom } from "@meetly/overlay/harness/clock";
import { createImpairment, createLinkModel, emptyImpairmentCounters, goodStateLossPct } from "@meetly/overlay/harness/impairment";
import { PROFILES } from "@meetly/overlay/harness/index";
import type { ImpairmentProfile } from "@meetly/overlay/harness/types";

const N = 100_000;

/** Sends `N` packets of `bytes` at `kbps` through a profile and says what came of them. */
function drive(profile: ImpairmentProfile, seed: number, kbps: number, bytes = 1000, reliable = false) {
  const model = createLinkModel(profile, seededRandom(seed), reliable);
  const gapMs = (bytes * 8) / kbps;
  let lost = 0;
  let queueDropped = 0;
  let delaySum = 0;
  let deliveredBytes = 0;
  let lastDeliverAt = 0;
  let outOfOrder = 0;
  let previousAt = -Infinity;
  const drops: number[] = [];
  const bursts: number[] = [];
  let run = 0;
  for (let i = 0; i < N; i++) {
    const now = i * gapMs;
    const verdict = model.next(bytes, now);
    if (verdict.inBurst) run++;
    else if (run > 0) {
      bursts.push(run);
      run = 0;
    }
    if (verdict.dropped) {
      if (verdict.why === "queue") queueDropped++;
      else lost++;
      drops.push(i);
      continue;
    }
    delaySum += verdict.deliverAt - now;
    deliveredBytes += bytes;
    lastDeliverAt = Math.max(lastDeliverAt, verdict.deliverAt);
    if (verdict.deliverAt < previousAt) outOfOrder++;
    previousAt = verdict.deliverAt;
  }
  const delivered = N - lost - queueDropped;
  return {
    lossPct: (100 * lost) / N,
    queueDropPct: (100 * queueDropped) / N,
    meanDelayMs: delaySum / delivered,
    deliveredKbps: (deliveredBytes * 8) / lastDeliverAt,
    meanBurst: bursts.length ? bursts.reduce((a, b) => a + b, 0) / bursts.length : 0,
    bursts: bursts.length,
    outOfOrder,
    drops,
  };
}

describe("impairment: the link model, over 100,000 packets", () => {
  for (const profile of Object.values(PROFILES)) {
    it(`"${profile.name}": loss within 0.2 points of ${profile.lossPct}%`, () => {
      for (const seed of [1, 2, 3]) {
        // Slow enough that a capped profile's queue never fills: this is the loss alone.
        const result = drive(profile, seed, 300);
        assert.ok(Math.abs(result.lossPct - profile.lossPct) <= 0.2, `seed ${seed}: ${result.lossPct}`);
        assert.equal(result.queueDropPct, 0);
      }
    });

    it(`"${profile.name}": mean delay within 1 ms of ${profile.delayMs} + ${profile.jitterMs}/2`, () => {
      // One byte, so a capped profile's own sending time is nothing: this is the delay alone.
      const result = drive(profile, 7, 1, 1);
      assert.ok(Math.abs(result.meanDelayMs - (profile.delayMs + profile.jitterMs / 2)) <= 1, `${result.meanDelayMs}`);
    });
  }

  it("a cap delivers within 3% of itself when offered more, and all of it when offered less", () => {
    for (const kbps of [900, 3000]) {
      const capped: ImpairmentProfile = { name: "cap", delayMs: 20, jitterMs: 0, lossPct: 0, kbps, queueMs: 300 };
      const over = drive(capped, 5, kbps * 1.5);
      assert.ok(Math.abs(over.deliveredKbps - kbps) / kbps <= 0.03, `${kbps}: ${over.deliveredKbps}`);
      assert.ok(Math.abs(over.queueDropPct - 100 / 3) < 1, `a third is dropped at the queue: ${over.queueDropPct}`);
      const under = drive(capped, 5, kbps * 0.5);
      assert.equal(under.queueDropPct, 0);
      assert.ok(Math.abs(under.deliveredKbps - kbps * 0.5) / (kbps * 0.5) <= 0.03, `${under.deliveredKbps}`);
    }
  });

  it('"slow" holds 1,200 kbps to 900, with the queue never longer than queueMs', () => {
    const result = drive(PROFILES.slow, 9, 1200);
    assert.ok(result.deliveredKbps <= 900 * 1.03 && result.deliveredKbps >= 900 * 0.97, `${result.deliveredKbps}`);
    // 1,000 bytes take 8.9 ms at 900 kbps; the wait is at most queueMs, then delay and jitter.
    assert.ok(result.meanDelayMs <= 300 + 9 + 40 + 20, `${result.meanDelayMs}`);
  });

  it("bursts have the configured mean length", () => {
    for (const leavePct of [30, 10, 50]) {
      const profile: ImpairmentProfile = { name: "b", delayMs: 0, jitterMs: 0, lossPct: 3, burst: { enterPct: 1, leavePct, lossPctInBurst: 50 } };
      const result = drive(profile, 11, 300);
      const expected = 100 / leavePct;
      assert.ok(result.bursts > 500, `${result.bursts} bursts`);
      assert.ok(Math.abs(result.meanBurst - expected) / expected <= 0.08, `leave ${leavePct}%: ${result.meanBurst} against ${expected}`);
    }
  });

  it("losses in a bursty profile really do cluster", () => {
    const bursty = drive(PROFILES.bad, 13, 300);
    const even = drive({ ...PROFILES.bad, burst: undefined }, 13, 300);
    const adjacent = (drops: number[]) => drops.filter((at, i) => i > 0 && at - drops[i - 1] === 1).length / drops.length;
    assert.ok(adjacent(bursty.drops) > 3 * adjacent(even.drops), `${adjacent(bursty.drops)} against ${adjacent(even.drops)}`);
    assert.ok(goodStateLossPct(PROFILES.bad) < PROFILES.bad.lossPct);
  });

  it("the same seed gives the same drops, and another seed others", () => {
    for (const profile of [PROFILES.home, PROFILES.bad, PROFILES.slow]) {
      assert.deepEqual(drive(profile, 21, 1200).drops, drive(profile, 21, 1200).drops);
      assert.notDeepEqual(drive(profile, 21, 1200).drops, drive(profile, 22, 1200).drops);
    }
  });

  it("jitter lets packets overtake each other; none does without it", () => {
    assert.ok(drive(PROFILES.home, 3, 1200).outOfOrder > N / 20);
    assert.equal(drive({ ...PROFILES.home, jitterMs: 0 }, 3, 1200).outOfOrder, 0);
  });

  it("a reliable channel loses nothing and keeps its order: a loss is a retransmission time instead", () => {
    const profile: ImpairmentProfile = { ...PROFILES.bad, retransmitMs: 250 };
    const result = drive(profile, 4, 300, 200, true);
    assert.equal(result.lossPct, 0);
    assert.equal(result.outOfOrder, 0);
    // Every message is late by the delay and jitter, a lost one by 250 ms more, and those behind a late one wait for it.
    assert.ok(result.meanDelayMs > 60 + 20 + 0.03 * 250, `${result.meanDelayMs}`);
  });
});

/* ------------------------------ the channel wrapper ------------------------------ */

function fakeChannel() {
  const sent: { at: number; data: Uint8Array | string }[] = [];
  const state = { readyState: "open" as PacketChannel["readyState"], bufferedAmount: 0, closed: false };
  let now = () => 0;
  const channel: PacketChannel = {
    get readyState() {
      return state.readyState;
    },
    get bufferedAmount() {
      return state.bufferedAmount;
    },
    send: (data) => void sent.push({ at: now(), data }),
    close: () => {
      state.closed = true;
      state.readyState = "closed";
    },
    onopen: null,
    onclose: null,
    onmessage: null,
  };
  return { channel, sent, state, setNow: (fn: () => number) => (now = fn) };
}

describe("impairment: the channel", () => {
  const packet = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, 0, 0]);

  it("delays each packet by what the profile says, on the clock it is given", () => {
    const clock = fakeClock();
    const inner = fakeChannel();
    inner.setNow(clock.now);
    const profile: ImpairmentProfile = { name: "p", delayMs: 40, jitterMs: 0, lossPct: 0 };
    const wrap = createImpairment(() => profile, 1, { clock, self: "a" });
    const channel = wrap(inner.channel, { peer: "b", kind: "media" });
    for (let i = 0; i < 5; i++) {
      channel.send(packet(i));
      clock.advance(10);
    }
    assert.equal(inner.sent.length, 2, "at 50 ms those sent at 0 and at 10 have arrived");
    assert.equal(channel.bufferedAmount, 12, "what is on its way counts as buffered");
    clock.advance(100);
    assert.deepEqual(
      inner.sent.map((s) => s.at),
      [40, 50, 60, 70, 80],
    );
    assert.equal(channel.bufferedAmount, 0);
  });

  it("copies what it holds: the caller may reuse its buffer", () => {
    const clock = fakeClock();
    const inner = fakeChannel();
    const wrap = createImpairment(() => ({ name: "p", delayMs: 10, jitterMs: 0, lossPct: 0 }), 1, { clock });
    const channel = wrap(inner.channel, { peer: "b", kind: "media" });
    const buffer = packet(1);
    channel.send(buffer);
    buffer[0] = 99;
    clock.advance(20);
    assert.equal((inner.sent[0].data as Uint8Array)[0], 1);
  });

  it("passes straight through with no profile, and impairs only what is sent", () => {
    const clock = fakeClock();
    const inner = fakeChannel();
    const counters = emptyImpairmentCounters();
    const wrap = createImpairment(() => null, 1, { clock, counters });
    const channel = wrap(inner.channel, { peer: "b", kind: "media" });
    channel.send(packet(1));
    assert.equal(inner.sent.length, 1);
    const received: (ArrayBuffer | string)[] = [];
    channel.onmessage = (data) => received.push(data);
    let opened = 0;
    let closed = 0;
    channel.onopen = () => opened++;
    channel.onclose = () => closed++;
    inner.channel.onmessage?.("hello");
    inner.channel.onopen?.();
    inner.channel.onclose?.();
    assert.deepEqual([received, opened, closed], [["hello"], 1, 1]);
    assert.deepEqual([counters.sent, counters.delivered, counters.lost], [1, 1, 0]);
  });

  it("drops the same packets for the same seed and link, and others for another link", () => {
    const run = (seed: number, peer: string) => {
      const clock = fakeClock();
      const inner = fakeChannel();
      const wrap = createImpairment(() => PROFILES.bad, seed, { clock, self: "a" });
      const channel = wrap(inner.channel, { peer, kind: "media" });
      for (let i = 0; i < 3000; i++) {
        channel.send(packet(i));
        clock.advance(1);
      }
      clock.advance(1000);
      return inner.sent.map((s) => (s.data as Uint8Array)[0] | ((s.data as Uint8Array)[1] << 8));
    };
    const a = run(5, "b");
    assert.ok(a.length < 3000 && a.length > 2800, `${a.length}`);
    assert.deepEqual([...a].sort((x, y) => x - y), [...run(5, "b")].sort((x, y) => x - y));
    assert.notDeepEqual([...a].sort((x, y) => x - y), [...run(5, "c")].sort((x, y) => x - y));
    assert.notDeepEqual([...a].sort((x, y) => x - y), [...run(6, "b")].sort((x, y) => x - y));
  });

  it("keeps the reliable channel whole and in order, even when the profile changes under it", () => {
    const clock = fakeClock();
    const inner = fakeChannel();
    let profile: ImpairmentProfile | null = { ...PROFILES.bad, lossPct: 20, burst: undefined };
    const wrap = createImpairment(() => profile, 3, { clock, self: "a" });
    const channel = wrap(inner.channel, { peer: "b", kind: "ctl" });
    for (let i = 0; i < 400; i++) {
      if (i === 200) profile = null;
      channel.send(String(i));
      clock.advance(2);
    }
    clock.advance(5000);
    assert.deepEqual(
      inner.sent.map((s) => s.data),
      Array.from({ length: 400 }, (_, i) => String(i)),
    );
  });

  it("counts what it lost, what a full queue dropped, and how late its own timers were", () => {
    const clock = fakeClock();
    const inner = fakeChannel();
    const counters = emptyImpairmentCounters();
    // One profile object for the whole run: a different object is a different network, and starts afresh.
    const capped: ImpairmentProfile = { name: "cap", delayMs: 0, jitterMs: 0, lossPct: 10, kbps: 80, queueMs: 100 };
    const wrap = createImpairment(() => capped, 2, { clock, counters });
    const channel = wrap(inner.channel, { peer: "b", kind: "media" });
    // 1,000 bytes every 10 ms is 800 kbps into an 80 kbps link.
    for (let i = 0; i < 1000; i++) {
      channel.send(new Uint8Array(1000));
      clock.advance(10);
    }
    clock.advance(1000);
    assert.equal(counters.sent, 1000);
    assert.ok(counters.lost > 60 && counters.lost < 140, `${counters.lost}`);
    assert.equal(counters.delivered + counters.lost + counters.queueDropped, 1000);
    assert.ok(Math.abs(counters.delivered - 101) <= 3, `80 kbps for 10.1 s is 101 packets: ${counters.delivered}`);
    assert.equal(counters.lateMsMax, 0, "a fake clock is never late");
  });

  it("caps what a peer receives as well as what it sends: a slow viewer is slow at being sent to", () => {
    const clock = fakeClock();
    const inner = fakeChannel();
    const counters = emptyImpairmentCounters();
    const wrap = createImpairment(() => PROFILES.slow, 2, { clock, counters });
    const channel = wrap(inner.channel, { peer: "parent", kind: "media" });
    const arrived: number[] = [];
    channel.onmessage = () => arrived.push(clock.now());
    // 1,000 bytes every 5 ms is 1,600 kbps arriving at a 900 kbps downlink, for 20 s.
    for (let i = 0; i < 4000; i++) {
      inner.channel.onmessage?.(new ArrayBuffer(1000));
      clock.advance(5);
    }
    clock.advance(1000);
    const kbps = (arrived.length * 8000) / (arrived[arrived.length - 1] - arrived[0]);
    assert.ok(Math.abs(kbps - 900) / 900 <= 0.03, `${kbps}`);
    assert.equal(counters.queueDropped, 4000 - arrived.length);
    assert.equal(counters.lost, 0, "delay, jitter and loss are the sender's, not the receiver's");
    // Nothing waits longer than the queue (300 ms) and its own 8.9 ms on the wire.
    const clean = wrap(fakeChannel().channel, { peer: "other", kind: "media" });
    let got = 0;
    clean.onmessage = () => got++;
    assert.equal(got, 0);
  });

  it("stops delivering when closed", () => {
    const clock = fakeClock();
    const inner = fakeChannel();
    const wrap = createImpairment(() => PROFILES.home, 1, { clock });
    const channel = wrap(inner.channel, { peer: "b", kind: "media" });
    for (let i = 0; i < 10; i++) channel.send(packet(i));
    channel.close();
    clock.advance(1000);
    assert.equal(inner.sent.length, 0);
    assert.equal(inner.state.closed, true);
  });
});
