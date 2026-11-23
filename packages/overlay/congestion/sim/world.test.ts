/**
 * The simulated link is what the acceptance tests stand on, so it is tested too: it caps at the
 * rate it says, queues what it says, loses what it says, and runs the same way twice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STAGE1_SHAPE, createSyntheticProgram, l1t3 } from "./program";
import { RateCap, SimPipe, World, seeded } from "./world";

describe("the simulated world", () => {
  it("runs events in time order, and events of one instant in the order they were made", () => {
    const world = new World();
    const seen: string[] = [];
    world.at(20, () => seen.push("c"));
    world.at(10, () => seen.push("a"));
    world.at(10, () => seen.push("b"));
    world.after(5, () => world.after(5, () => seen.push("a2")));
    world.runUntil(15);
    assert.deepEqual(seen, ["a", "b", "a2"]);
    assert.equal(world.now, 15);
    world.runUntil(30);
    assert.deepEqual(seen, ["a", "b", "a2", "c"]);
  });

  it("caps a pipe at its rate to within 3%, with the queue it was given and no more", () => {
    const world = new World();
    const pipe = new SimPipe(world, { delayMs: 10, kbps: 900, queueMs: 300 }, seeded(1));
    let bytes = 0;
    let worst = 0;
    pipe.onmessage = (packet) => (bytes += packet.byteLength);
    // 1,500 kbps offered for 20 s.
    world.every(8, () => {
      pipe.send(new Uint8Array(1500));
      worst = Math.max(worst, pipe.bufferedAmount);
    });
    world.runUntil(20_000);
    const kbps = (bytes * 8) / 20_000;
    assert.ok(Math.abs(kbps - 900) <= 27, String(kbps));
    assert.ok(worst <= (900 * 300) / 8 + 1500, String(worst));
    assert.ok(pipe.lost > 0);
  });

  it("delays by what it says, loses what it says, and does so the same way for the same seed", () => {
    const run = (seed: number) => {
      const world = new World();
      const pipe = new SimPipe(world, { delayMs: 30, jitterMs: 20, lossPct: 5 }, seeded(seed));
      const delays: number[] = [];
      let sentAt = 0;
      pipe.onmessage = (packet, at) => delays.push(at - new DataView(packet.buffer).getFloat64(0));
      world.every(1, () => {
        const packet = new Uint8Array(100);
        new DataView(packet.buffer).setFloat64(0, (sentAt = world.now));
        pipe.send(packet);
      });
      world.runUntil(100_000);
      return { delays, lostPct: (pipe.lost / pipe.sent) * 100, sentAt };
    };
    const first = run(11);
    assert.ok(Math.abs(first.lostPct - 5) < 0.3, String(first.lostPct));
    assert.ok(Math.min(...first.delays) >= 30 && Math.max(...first.delays) <= 50);
    const mean = first.delays.reduce((sum, delay) => sum + delay, 0) / first.delays.length;
    assert.ok(Math.abs(mean - 40) < 0.2, String(mean));
    assert.deepEqual(run(11).delays.slice(0, 500), first.delays.slice(0, 500));
    assert.notDeepEqual(run(12).delays.slice(0, 500), first.delays.slice(0, 500));
  });

  it("loses in bursts as the harness's shim does: the overall share it is given, in runs", () => {
    const world = new World();
    const pipe = new SimPipe(world, { delayMs: 0, lossPct: 3, burst: { enterPct: 1, leavePct: 30, lossPctInBurst: 50 } }, seeded(5));
    const arrived: boolean[] = [];
    let seq = 0;
    pipe.onmessage = (packet) => (arrived[new DataView(packet.buffer).getUint32(0)] = true);
    world.every(1, () => {
      const packet = new Uint8Array(8);
      new DataView(packet.buffer).setUint32(0, seq++);
      pipe.send(packet);
    });
    world.runUntil(200_000);
    let lost = 0;
    let runs = 0;
    for (let i = 0; i < seq - 10; i++) {
      if (arrived[i]) continue;
      lost++;
      if (i === 0 || arrived[i - 1]) runs++;
    }
    assert.ok(Math.abs((lost / (seq - 10)) * 100 - 3) < 0.3, String((lost / seq) * 100));
    // Losses come in runs: fewer runs than losses, by a good margin.
    assert.ok(runs < 0.85 * lost, `${runs} runs for ${lost} losses`);
  });

  it("shows a rate cap's backlog as a channel shows bufferedAmount", () => {
    const cap = new RateCap<number>(800, 250);
    assert.equal(cap.push(1, 1000, 0), true); // leaves at 10 ms
    assert.equal(cap.push(2, 1000, 0), true); // 20 ms
    assert.equal(cap.backlog, 2000);
    assert.deepEqual(cap.take(10), [1]);
    assert.equal(cap.backlog, 1000);
    assert.equal(cap.nextAt(), 20);
    // 250 ms at 800 kbps is 25,000 bytes: the queue takes that and drops the rest.
    for (let i = 0; i < 30; i++) cap.push(i, 1000, 10);
    assert.equal(cap.backlog, 25_000);
    assert.equal(cap.dropped, 6);
  });
});

describe("the synthetic program", () => {
  it("adds up to the stream's bitrate, with libvpx's shares for three temporal layers", () => {
    const program = createSyntheticProgram();
    const bytes = [0, 0, 0];
    for (let i = 0; i < 600; i++) {
      const frame = program.video(i * 33_333);
      bytes[frame.header.temporal] += frame.data.byteLength;
    }
    const total = bytes[0] + bytes[1] + bytes[2];
    assert.ok(Math.abs((total * 8) / 20_000 - STAGE1_SHAPE.videoKbps) < 2);
    assert.ok(Math.abs(bytes[0] / total - 0.4) < 0.002);
    assert.ok(Math.abs(bytes[1] / total - 0.2) < 0.002);
  });

  it("follows L1T3 as SPEC §9.2 describes it", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(l1t3), [
      { temporal: 0, refDelta: 0 },
      { temporal: 2, refDelta: 1 },
      { temporal: 1, refDelta: 2 },
      { temporal: 2, refDelta: 1 },
      { temporal: 0, refDelta: 4 },
      { temporal: 2, refDelta: 1 },
      { temporal: 1, refDelta: 2 },
      { temporal: 2, refDelta: 1 },
    ]);
  });
});
