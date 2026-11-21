import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeMediaHeader, encodeHeartbeat, ms16, packetLinkFields, packetizeFrame, type PeerMessage } from "../../protocol";
import { PipeLink } from "./link";
import { STAGE1_SHAPE, createSyntheticProgram } from "./program";

const sink = () => {
  const sent: Uint8Array[] = [];
  return { sent, pipe: { bufferedAmount: 1234, send: (packet: Uint8Array) => void sent.push(packet.slice()) } };
};

describe("the fake of transport's Link", () => {
  it("sets linkSeq and sendMs, counting every packet of every type, and nothing else", () => {
    let now = 70_000.6;
    const { sent, pipe } = sink();
    const link = new PipeLink("child", pipe, () => now);
    const program = createSyntheticProgram(STAGE1_SHAPE);
    const [media] = packetizeFrame(program.video(0).header, program.video(0).data);
    const before = decodeMediaHeader(media)!;
    assert.equal(link.sendPacket(media, "video"), true);
    now += 5;
    assert.equal(link.sendPacket(encodeHeartbeat({ flags: 0, linkSeq: 0, sendMs: 0, echoMs: 0, echoHoldMs: 0xffff, depth: 0, streams: [] }), "control"), true);
    assert.deepEqual(
      sent.map((packet) => packetLinkFields(packet)!).map(({ linkSeq, sendMs }) => [linkSeq, sendMs]),
      [
        [0, ms16(70_000.6)],
        [1, ms16(70_005.6)],
      ],
    );
    const after = decodeMediaHeader(sent[0])!;
    assert.deepEqual({ ...after, linkSeq: 0, sendMs: 0 }, { ...before, linkSeq: 0, sendMs: 0 });
    assert.deepEqual(link.sentByClass, { control: 1, audio: 0, video: 1, replay: 0 });
    assert.equal(link.counters().packetsSent, 2);
    assert.equal(link.bufferedAmount, 1234);
  });

  it("raises what arrives as `packet` and `message`, and sends nothing once closed", () => {
    const { sent, pipe } = sink();
    const messages: PeerMessage[] = [];
    const link = new PipeLink("parent", pipe, () => 0, (message) => messages.push(message));
    const heard: number[] = [];
    link.on("packet", (_packet, at) => heard.push(at));
    const told: string[] = [];
    link.on("message", (message) => told.push(message.t));
    link.deliver(new Uint8Array([0x12, 0, 0, 0, 0, 0]), 42);
    link.deliverMessage({ t: "layers", stream: 0, maxSpatial: 0, maxTemporal: 1, reason: "congestion" });
    link.sendMessage({ t: "unsub", stream: 0, stripes: [0] });
    assert.deepEqual(heard, [42]);
    assert.deepEqual(told, ["layers"]);
    assert.deepEqual(link.messagesSent, messages);
    link.close();
    assert.equal(link.state, "closed");
    assert.equal(link.sendPacket(new Uint8Array(6).fill(0x12, 0, 1), "control"), false);
    assert.equal(sent.length, 0);
  });
});
