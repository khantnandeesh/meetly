/** D43: keyframes are paced to each child, and rules 3 and 6 read what of one the link has yet to absorb. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MediaFlag, PacketType, decodeMediaHeader } from "@meetly/overlay";
import { createLayerGate, createLinkEstimator } from "@meetly/overlay/congestion/index";
import type { LinkEstimate } from "@meetly/overlay/types";
import { SimNet, type SimPeer } from "@meetly/overlay/topology/sim";
import { PACE_FRAMES } from "@meetly/overlay/topology/node";

const B = 1200;
const INTERVAL = 1000 / 30;
/** A stage's keyframe: 300 ms of B, the rest of a 2 s GOP sharing what is left, so the stream averages B. */
const KEY = (B * 300) / 8;
const REST = ((B * 2000) / 8 - KEY) / 59;
const stageBytes = (frameId: number) => Math.round(frameId % 60 === 0 ? KEY : REST);

const layerMessages = (net: SimNet, since: number) => net.messages.filter((m) => m.message.t === "layers" && m.at >= since);

/** Records when each video packet the source hands to `to`'s link leaves, with its frame. */
function tap(source: SimPeer, to: string, now: () => number): { at: number; frameId: number; key: boolean }[] {
  const log: { at: number; frameId: number; key: boolean }[] = [];
  const link = source.links.get(to)!;
  const send = link.sendPacket.bind(link);
  link.sendPacket = (packet, sendClass) => {
    const header = (packet[0] & 0x0f) === PacketType.Media ? decodeMediaHeader(packet) : null;
    if (header && header.streamId === 0) log.push({ at: now(), frameId: header.frameId, key: (header.flags & MediaFlag.Key) !== 0 });
    return send(packet, sendClass);
  };
  return log;
}

describe("D43: keyframe pacing", () => {
  it("a stage-like keyframe (300 ms of B) on a link at 1.1 × B: no layer drop, no stall, every frame", async () => {
    const net = new SimNet({ seed: 1, latencyMs: 10, keepFrames: true, createLinkEstimator, createLayerGate: createLayerGate as never });
    const source = net.join("src", "source", []);
    net.publish(source, { frameBytes: stageBytes, audio: false });
    await net.runAsync(200);
    const child = net.join("c", "leaf", ["src"]);
    await net.runAsync(1000);
    net.setWire("src", "c", { kbps: 1.1 * B, queueMs: 1000 }, false);
    const since = net.clock.now();
    const from = net.published + 60;
    const states = new Set<string>();
    for (let t = 0; t < 20_000; t += 100) {
      await net.runAsync(100);
      states.add(child.node.status().stripes[0].state);
    }
    const to = net.published - 30;

    assert.deepEqual(layerMessages(net, since), [], "no layer drop");
    const lost: number[] = [];
    for (let id = from; id < to; id++) if (!child.video.has(id)) lost.push(id);
    assert.deepEqual(lost, [], "every frame arrives");
    assert.deepEqual([...states], ["active"], "never STALLED or repairing");
    assert.equal(child.metrics.filter((m) => m.t === "repair").length, 0);
    // No stall: the keyframe holds back what follows it no longer than the link takes to carry
    // it (300 ms of B at 1.1 × B is 273 ms), so a playout delay of that much never runs dry.
    const late = child.frames
      .filter((f) => f.header.streamId === 0 && f.header.frameId >= from && f.header.frameId < to)
      .map((f) => f.completeAt - f.header.captureUs / 1000)
      .sort((a, b) => a - b);
    const extra = late[late.length - 1] - late[late.length >> 1];
    assert.ok(extra < 250, `the latest frame ${extra.toFixed(0)} ms behind the median`);
  });

  it("a keyframe leaves over its own frame interval and two more, and what follows waits behind it", async () => {
    const net = new SimNet({ seed: 2, latencyMs: 10, createLinkEstimator, createLayerGate: createLayerGate as never });
    const source = net.join("src", "source", []);
    net.publish(source, { frameBytes: stageBytes, audio: false });
    await net.runAsync(200);
    net.join("c", "leaf", ["src"]);
    await net.runAsync(500);
    const log = tap(source, "c", () => net.clock.now());
    await net.runAsync(4500);

    const keyIds = [...new Set(log.filter((p) => p.key).map((p) => p.frameId))];
    assert.ok(keyIds.length >= 2, "two keyframes seen");
    for (const id of keyIds) {
      const packets = log.filter((p) => p.frameId === id);
      if (packets.length < 30) continue; // its first packets went before the tap
      const spread = packets[packets.length - 1].at - packets[0].at;
      assert.ok(spread >= (PACE_FRAMES - 1) * INTERVAL, `keyframe ${id} spread over ${spread.toFixed(0)} ms, not burst`);
      assert.ok(spread <= PACE_FRAMES * INTERVAL + 10, `keyframe ${id} done in ${spread.toFixed(0)} ms (≤ 3 frame intervals and a tick)`);
      // Frames stay in order on the wire.
      const firstAfter = log.findIndex((p) => p.frameId > id);
      const lastOfKey = log.findLastIndex((p) => p.frameId === id);
      assert.ok(firstAfter > lastOfKey, `frame ${id + 1} waits for keyframe ${id}`);
    }
  });

  it("rule 6 reads a backlog up to the paced keyframe's remainder as the keyframe's, and no more", () => {
    const estimate = (bufferedBytes: number): LinkEstimate =>
      ({ state: "ok", bufferedBytes, lossPct: 0, queueDelayMs: 0, rttMs: 30, deliveredKbps: B, sentKbps: B }) as unknown as LinkEstimate;
    const header = (frameId: number) => ({ frameId, flags: 0, temporal: 0, spatial: 0, refDelta: 1, streamId: 0, stripe: 0, fragIndex: 0, fragCount: 4 }) as never;
    const gate = () => createLayerGate({ bitrateKbps: B, temporalLayers: 3, kind: "video" } as never);
    // 39 kB is over 200 ms of B (30 kB).
    assert.equal(gate().admit(header(1), 4000, estimate(39_000), 1000), false, "stale without a paced keyframe");
    assert.equal(gate().admit(header(1), 4000, estimate(39_000), 1000, 39_000), true, "the keyframe's own backlog is not stale");
    assert.equal(gate().admit(header(1), 4000, estimate(39_000), 1000, 20_000), false, "beyond the keyframe's remainder and 30 kB it is");
    assert.equal(gate().admit(header(1), 4000, estimate(29_000), 1000, 10_000), true, "under 30 kB it never was");
  });
});
