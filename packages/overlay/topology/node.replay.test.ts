/**
 * A child's replay (join, repair) reaches it before the live video behind it, and a joiner's
 * replay is thinned to the base layer where the joiner would only decode it. Measured through
 * media's own jitter buffer: before, it gave the GOP up and waited for the next keyframe.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PacketType, decodeMediaHeader } from "@meetly/overlay";
import { createLayerGate, createLinkEstimator } from "@meetly/overlay/congestion/index";
import { createJitterBuffer } from "@meetly/overlay/media/jitterBuffer";
import { SimNet, VIDEO, type SimPeer } from "@meetly/overlay/topology/sim";
import { JOIN_THIN_MS } from "@meetly/overlay/topology/node";

const B = 1200;
const KEY = (B * 250) / 8;
const REST = ((B * 2000) / 8 - KEY) / 59;
const stageBytes = (frameId: number) => Math.round(frameId % 60 === 0 ? KEY : REST);

/** Feeds a peer's frames to a jitter buffer popped every 10 ms, as the player does. */
function watch(net: SimNet, peer: SimPeer) {
  const buffer = createJitterBuffer({ config: VIDEO, playoutMinMs: 150, playoutMaxMs: 1000, clock: net.clock });
  const seen = {
    skips: 0,
    shown: [] as number[],
    firstFrameAt: null as number | null,
    frames: [] as { frameId: number; temporal: number; captureUs: number; recovered: boolean }[],
  };
  buffer.on("skip", () => seen.skips++);
  peer.node.on("frame", (frame) => {
    seen.firstFrameAt ??= net.clock.now();
    seen.frames.push({ frameId: frame.header.frameId, temporal: frame.header.temporal, captureUs: frame.header.captureUs, recovered: frame.recovered });
    buffer.push(frame);
  });
  const stop = net.clock.setInterval(() => {
    for (const out of buffer.pop(net.sessionClock.now() * 1000)) if (!out.decodeOnly) seen.shown.push(net.clock.now());
  }, 10);
  return Object.assign(seen, { stop });
}

describe("node: replays before live, and a joiner's replay thinned", () => {
  it("a warm repair asks from the newest frame it holds whole, and its audio comes ahead of the video", async () => {
    const net = new SimNet({ seed: 1, latencyMs: 20, backups: false, keepFrames: true, params: { sourceFanout: 3 }, createLinkEstimator, createLayerGate: createLayerGate as never });
    const source = net.join("0", "source", []);
    net.publish(source, { frameBytes: stageBytes });
    await net.runAsync(300);
    net.join("1", "relay", ["0"]);
    await net.runAsync(300);
    const two = net.join("2", "relay", ["1"], ["0"]);
    await net.runAsync(300);
    for (const [a, b] of [["0", "2"], ["1", "2"]]) net.setWire(a, b, { kbps: 2500, queueMs: 1000 }, false);
    await net.runAsync(3170);
    const at = net.clock.now();
    const held = new Set(two.frames.filter((f) => f.header.streamId === 0).map((f) => f.header.frameId));
    // What the backup replays, in the order it goes.
    const replayed: { stream: number; frameId: number }[] = [];
    const link = source.links.get("2")!;
    const send = link.sendPacket.bind(link);
    link.sendPacket = (packet, sendClass) => {
      if (sendClass === "replay" && (packet[0] & 0x0f) === PacketType.Media) replayed.push({ stream: packet[2], frameId: decodeMediaHeader(packet)!.frameId });
      return send(packet, sendClass);
    };
    net.kill("1");
    await net.runAsync(1500);
    const video = replayed.filter((r) => r.stream === 0);
    assert.ok(video.length > 0);
    assert.ok(!held.has(video[0].frameId), `the replay starts at frame ${video[0].frameId}, which the peer already held whole`);
    // The audio the peer missed goes before the video it missed.
    assert.equal(replayed[0].stream, 1, "audio waited behind the video replay");
    const firstRecovered = (stream: number) => two.frames.find((f) => f.recovered && f.completeAt > at && f.header.streamId === stream)!.completeAt;
    assert.ok(firstRecovered(1) < firstRecovered(0));
  });

  for (const offset of [30, 50]) {
    it(`a joiner 3 Mbps down, ${offset} frames into the GOP, shows its first frame within 700 ms, keeping the GOP`, async () => {
      const net = new SimNet({ seed: 4, latencyMs: 15, createLinkEstimator, createLayerGate: createLayerGate as never });
      const source = net.join("src", "source", []);
      net.publish(source, { frameBytes: stageBytes, audio: false });
      await net.runAsync(3000);
      while (net.published % 60 !== offset) await net.runAsync(5);
      net.setWire("src", "c", { kbps: 3000, queueMs: 1000 }, false);
      const child = net.join("c", "leaf", ["src"]);
      const seen = watch(net, child);
      await net.runAsync(4000);
      seen.stop();
      assert.equal(seen.skips, 0, "the GOP is kept");
      const firstShown = seen.shown[0] - seen.firstFrameAt!;
      assert.ok(firstShown < 700, `first frame shown ${firstShown.toFixed(0)} ms after the first arrived`);
      // Frames arrive in order: nothing live overtakes the replay.
      const ids = seen.frames.map((f) => f.frameId);
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
      // The replay's older part is the keyframe and the base layer only.
      const replayed = seen.frames.filter((f) => f.recovered);
      const newest = Math.max(...replayed.map((f) => f.captureUs));
      const old = replayed.filter((f) => f.captureUs < newest - JOIN_THIN_MS * 1000);
      assert.ok(old.length > 0);
      assert.deepEqual(old.filter((f) => f.temporal > 0), []);
    });
  }

  it("a relay's repair over 2.5 Mbps links: its waiting children keep the GOP, and freeze under 800 ms", async () => {
    const net = new SimNet({ seed: 1, latencyMs: 20, backups: false, params: { sourceFanout: 3 }, createLinkEstimator, createLayerGate: createLayerGate as never });
    const source = net.join("0", "source", []);
    net.publish(source, { frameBytes: stageBytes, audio: false });
    await net.runAsync(300);
    net.join("1", "relay", ["0"]);
    await net.runAsync(300);
    const two = net.join("2", "relay", ["1"], ["0"]);
    await net.runAsync(300);
    const children = [net.join("3", "leaf", ["2"]), net.join("4", "leaf", ["2"])];
    for (const [a, b] of [["0", "2"], ["1", "2"], ["2", "3"], ["2", "4"]]) net.setWire(a, b, { kbps: 2500, queueMs: 1000 }, false);
    const seen = children.map((child) => watch(net, child));
    await net.runAsync(3170);
    const at = net.clock.now();
    net.kill("1");
    await net.runAsync(3000);
    assert.equal(two.metrics.filter((m) => m.t === "repair").length, 1);
    for (const s of seen) {
      s.stop();
      assert.equal(s.skips, 0, "the GOP is kept");
      let gap = 0;
      for (let i = 1; i < s.shown.length; i++) if (s.shown[i] >= at - 500) gap = Math.max(gap, s.shown[i] - s.shown[i - 1]);
      assert.ok(gap < 800, `froze ${gap.toFixed(0)} ms`);
    }
  });
});
