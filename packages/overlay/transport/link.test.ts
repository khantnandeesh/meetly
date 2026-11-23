/** PLAN T1: links, against a fake peer connection. SPEC §3.2, §5. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PacketType, encodeHeartbeat, encodePeerMessage, packetLinkFields, packetizeFrame, type PeerId, type PeerMessage, type SignalData } from "@meetly/overlay";
import { CHANNELS, createLinkManager, prepareOffer } from "@meetly/overlay/transport/index";
import { FakeClock } from "@meetly/overlay/transport/fakes";
import { FakeNet, type FakeDataChannel, type FakePeerConnection } from "@meetly/overlay/transport/fakeRtc";
import { CONNECT_TIMEOUT_MS, HELLO_TIMEOUT_MS } from "@meetly/overlay/transport/link";
import { classifyNat } from "@meetly/overlay/transport/nat";
import type { Link, LinkCloseReason, PacketChannel, TransportOptions } from "@meetly/overlay/transport/types";

/** Signalling between managers in one process, as the coordinator would relay it. */
function world() {
  const clock = new FakeClock();
  const net = new FakeNet(clock);
  const inboxes = new Map<PeerId, ((from: PeerId, data: SignalData) => void)[]>();
  const signals: { from: PeerId; to: PeerId; data: SignalData }[] = [];
  const pcs = new Map<PeerId, FakePeerConnection[]>();

  const peer = (self: PeerId, over: Partial<TransportOptions> = {}) => {
    const incoming: Link[] = [];
    const manager = createLinkManager({
      self,
      grant: () => `grant-of-${self}`,
      verifyPeer: async (who, grant) => grant === `grant-of-${who}`,
      signaler: {
        send: (to, data) => {
          signals.push({ from: self, to, data });
          clock.setTimeout(() => inboxes.get(to)?.forEach((listener) => listener(self, data)), 1);
        },
        onSignal: (listener) => {
          const list = inboxes.get(self) ?? [];
          inboxes.set(self, [...list, listener]);
          return () => {};
        },
      },
      ice: [],
      clock,
      peerConnection: () => {
        const pc = net.factory();
        pcs.set(self, [...(pcs.get(self) ?? []), pc as unknown as FakePeerConnection]);
        return pc;
      },
      ...over,
    });
    manager.on("incoming", (link) => incoming.push(link));
    return { manager, incoming };
  };

  /** Moves time on a millisecond at a time, letting promises settle in between. */
  const run = async (ms: number) => {
    for (let i = 0; i < ms; i++) {
      clock.advance(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const channel = (self: PeerId, kind: "ctl" | "media", index = 0): FakeDataChannel => pcs.get(self)![index].channels.get(CHANNELS[kind].id)!;

  /** Signalling out of nowhere. */
  const inject = (from: PeerId, to: PeerId, data: SignalData) => inboxes.get(to)?.forEach((listener) => listener(from, data));

  return { clock, net, peer, run, signals, pcs, channel, inject };
}

function watch(link: Link) {
  const seen = { states: [] as string[], messages: [] as PeerMessage[], packets: [] as Uint8Array[], reason: undefined as LinkCloseReason | undefined };
  link.on("state", (state, reason) => {
    seen.states.push(state);
    if (state === "closed") seen.reason = reason;
  });
  link.on("message", (message) => seen.messages.push(message));
  link.on("packet", (packet) => seen.packets.push(packet.slice()));
  return seen;
}

const heartbeat = () => encodeHeartbeat({ flags: 0, linkSeq: 0, sendMs: 0, echoMs: 0, echoHoldMs: 0xffff, depth: 1, streams: [] });
const media = (frameId: number, bytes = 100) =>
  packetizeFrame({ type: PacketType.Media, flags: 0, streamId: 0, stripe: 0, spatial: 0, temporal: 0, refDelta: 1, keyDelta: 1, frameId, captureUs: 0, configId: 0 }, new Uint8Array(bytes))[0];
const PATH: PeerMessage = { t: "path", path: ["a", "src"] };

async function pair(w: ReturnType<typeof world>, overA: Partial<TransportOptions> = {}, overB: Partial<TransportOptions> = {}) {
  const a = w.peer("a", overA);
  const b = w.peer("b", overB);
  const ab = a.manager.connect("b");
  await w.run(40);
  const ba = b.manager.get("a")!;
  return { a, b, ab, ba };
}

describe("links: making one (SPEC §5.1)", () => {
  it("two managers that both connect at once end with one open link", async () => {
    const w = world();
    const a = w.peer("a");
    const b = w.peer("b");
    const ab = a.manager.connect("b");
    const ba = b.manager.connect("a");
    const seenA = watch(ab);
    const seenB = watch(ba);
    await w.run(60);
    assert.equal(ab.state, "open");
    assert.equal(ba.state, "open");
    assert.deepEqual(seenA.states, ["open"]);
    assert.deepEqual(seenB.states, ["open"]);
    assert.equal(a.manager.links().length, 1);
    assert.equal(b.manager.links().length, 1);
    assert.equal(a.manager.connect("b"), ab);
    assert.equal(w.pcs.get("a")!.length, 1);
    assert.equal(w.pcs.get("b")!.length, 1);
    // Both offered; "b" sorts later, so it gave way and answered "a"'s offer.
    assert.equal(w.net.offers, 2);
    assert.deepEqual(
      w.signals.filter((s) => s.data.sdp?.type === "answer").map((s) => s.from),
      ["b"],
    );
    // And it carries both channels, both ways.
    ab.sendMessage(PATH);
    ba.sendMessage({ t: "unsub", stream: 0, stripes: [0] });
    assert.equal(ab.sendPacket(heartbeat(), "control"), true);
    assert.equal(ba.sendPacket(media(7), "video"), true);
    await w.run(3);
    assert.deepEqual(seenB.messages, [PATH]);
    assert.deepEqual(seenA.messages, [{ t: "unsub", stream: 0, stripes: [0] }]);
    assert.equal(seenB.packets.length, 1);
    assert.equal(seenA.packets.length, 1);
  });

  it("one side connects: the other is told of an incoming link, and both open once hello is checked", async () => {
    const w = world();
    const { a, b, ab, ba } = await pair(w);
    assert.equal(ab.state, "open");
    assert.deepEqual(b.incoming, [ba]);
    assert.equal(ba.peer, "a");
    assert.equal(ba.state, "open");
    assert.deepEqual(a.incoming, []);
    assert.equal(w.net.offers, 1);
    assert.equal(ab.turn, false);
    // The first thing on ctl, each way, is hello with the grant.
    assert.equal(w.channel("a", "ctl").sent[0], encodePeerMessage({ t: "hello", v: 1, peer: "a", grant: "grant-of-a" }));
    assert.equal(w.channel("b", "ctl").sent[0], encodePeerMessage({ t: "hello", v: 1, peer: "b", grant: "grant-of-b" }));
  });

  it("hands every channel to wrapChannel once, and uses what it returns", async () => {
    const w = world();
    const wrapped: string[] = [];
    let dropped = 0;
    const { ab, ba } = await pair(w, {
      wrapChannel: (inner, info) => {
        wrapped.push(`${info.peer}/${info.kind}`);
        if (info.kind !== "media") return inner;
        // An impairment shim that loses every second packet.
        const outer: PacketChannel = {
          get readyState() {
            return inner.readyState;
          },
          get bufferedAmount() {
            return inner.bufferedAmount;
          },
          send: (data) => (dropped++ % 2 === 0 ? inner.send(data) : undefined),
          close: () => inner.close(),
          onopen: null,
          onclose: null,
          onmessage: null,
        };
        inner.onopen = () => outer.onopen?.();
        inner.onclose = () => outer.onclose?.();
        inner.onmessage = (data) => outer.onmessage?.(data);
        return outer;
      },
    });
    assert.deepEqual(wrapped, ["b/ctl", "b/media"]);
    const seen = watch(ba);
    for (let i = 0; i < 6; i++) ab.sendPacket(media(i), "video");
    await w.run(3);
    assert.equal(seen.packets.length, 3);
  });

  it("says when the route goes through TURN", async () => {
    const w = world();
    const a = w.peer("a");
    w.peer("b");
    const ab = a.manager.connect("b");
    w.pcs.get("a")![0].relayed = true;
    await w.run(40);
    assert.equal(ab.state, "open");
    assert.equal(ab.turn, true);
  });

  it("gives up with \"timeout\" on a peer that never answers", async () => {
    const w = world();
    const a = w.peer("a");
    const link = a.manager.connect("nobody");
    const seen = watch(link);
    await w.run(CONNECT_TIMEOUT_MS + 5);
    assert.equal(link.state, "closed");
    assert.equal(seen.reason, "timeout");
    assert.deepEqual(a.manager.links(), []);
    assert.notEqual(a.manager.connect("nobody"), link);
  });

  it("a stray candidate or answer does not start a link; only an offer does", async () => {
    const w = world();
    const b = w.peer("b");
    w.inject("c", "b", { candidate: { candidate: "candidate:x" } });
    w.inject("c", "b", { sdp: { type: "answer", sdp: "fake 99" } });
    await w.run(5);
    assert.equal(b.incoming.length, 0);
    assert.equal(b.manager.links().length, 0);
    w.inject("c", "b", { sdp: { type: "offer", sdp: "fake 99" } });
    await w.run(5);
    assert.equal(b.incoming.length, 1);
    assert.equal(b.incoming[0].peer, "c");
  });
});

describe("links: an offer made before the peer is known (SPEC §5.1 [D83])", () => {
  it("opens with only the answer coming back: the offer reached the other side through the coordinator", async () => {
    const w = world();
    const made: FakePeerConnection[] = [];
    const prepared = (await prepareOffer(() => {
      const pc = w.net.factory();
      made.push(pc as unknown as FakePeerConnection);
      return pc;
    }))!;
    assert.ok(prepared);
    assert.equal(made.length, 1);
    // Nothing applied yet: no offer counted, nothing gathered.
    assert.equal(w.net.offers, 0);
    assert.equal(made[0].signalingState, "stable");
    const stun = [{ urls: ["stun:stun.example:3478"] }];
    const a = w.peer("a", { prepared: { peer: "b", offer: prepared }, ice: stun });
    const b = w.peer("b");
    const ab = a.manager.get("b")!;
    assert.ok(ab, "the link is made with the manager, before any signal");
    const seen = watch(ab);
    // The ICE servers from welcome, set before the offer is applied.
    assert.deepEqual(made[0].config?.iceServers, [{ urls: stun[0].urls, username: undefined, credential: undefined }]);
    // What the coordinator does with hello.offer.
    w.clock.setTimeout(() => w.inject("a", "b", { sdp: { type: "offer", sdp: prepared.sdp } }), 1);
    await w.run(40);
    const ba = b.manager.get("a")!;
    assert.equal(ab.state, "open");
    assert.equal(ba.state, "open");
    assert.deepEqual(seen.states, ["open"]);
    assert.deepEqual(b.incoming, [ba]);
    assert.equal(a.manager.connect("b"), ab);
    assert.equal(w.pcs.get("a"), undefined, "no second connection made");
    assert.deepEqual(
      w.signals.filter((s) => s.data.sdp).map((s) => `${s.from}:${s.data.sdp!.type}`),
      ["b:answer"],
      "the offer is not sent again",
    );
    assert.equal(w.net.offers, 1);
    assert.equal(prepared.used, true);
    ab.sendMessage(PATH);
    await w.run(3);
    assert.equal(w.channel("b", "ctl").sent[0], encodePeerMessage({ t: "hello", v: 1, peer: "b", grant: "grant-of-b" }));
  });

  it("an offer not used is closed, and a used one is not taken twice", async () => {
    const w = world();
    const made: FakePeerConnection[] = [];
    const factory = () => {
      const pc = w.net.factory();
      made.push(pc as unknown as FakePeerConnection);
      return pc;
    };
    const unused = (await prepareOffer(factory))!;
    unused.close();
    assert.equal(made[0].signalingState, "closed");
    assert.equal(unused.used, true);
    // A manager given one already closed makes nothing of it.
    const a = w.peer("a", { prepared: { peer: "b", offer: unused } });
    assert.equal(a.manager.get("b"), undefined);
    // No WebRTC at all: null, and the join goes as before.
    assert.equal(
      await prepareOffer(() => {
        throw new Error("no RTCPeerConnection");
      }),
      null,
    );
  });
});

describe("links: hello (SPEC §5.2)", () => {
  it("a grant that does not verify closes with \"auth-failed\"", async () => {
    const w = world();
    const a = w.peer("a", { verifyPeer: async () => false });
    const b = w.peer("b");
    const ab = a.manager.connect("b");
    const seenA = watch(ab);
    await w.run(40);
    const seenB = b.incoming.map(watch);
    assert.equal(ab.state, "closed");
    assert.equal(seenA.reason, "auth-failed");
    assert.deepEqual(seenA.states, ["closed"]);
    await w.run(5);
    // The other side sees its channels close; it was never open on "a".
    assert.equal(b.incoming[0].state, "closed");
    assert.ok(seenB[0].reason === "channel-closed" || seenB[0].reason === undefined);
    assert.deepEqual(b.manager.links(), []);
  });

  it("a verifier that throws closes with \"auth-failed\"", async () => {
    const w = world();
    const a = w.peer("a", {
      verifyPeer: async () => {
        throw new Error("no key");
      },
    });
    w.peer("b");
    const ab = a.manager.connect("b");
    const seen = watch(ab);
    await w.run(40);
    assert.equal(seen.reason, "auth-failed");
  });

  it("a hello naming another peer closes with \"auth-failed\"", async () => {
    const w = world();
    const a = w.peer("a");
    // "b" presents itself as "z".
    w.peer("b", {
      wrapChannel: (inner, info) => {
        if (info.kind !== "ctl") return inner;
        const send = inner.send.bind(inner);
        inner.send = (data) => send(typeof data === "string" ? data.replace('"peer":"b"', '"peer":"z"') : data);
        return inner;
      },
    });
    const ab = a.manager.connect("b");
    const seen = watch(ab);
    await w.run(40);
    assert.equal(seen.reason, "auth-failed");
  });

  it("no hello within 5 s closes with \"auth-failed\", and nothing sent meanwhile is passed on", async () => {
    const w = world();
    const a = w.peer("a");
    // "b" never says hello, but talks.
    w.peer("b", {
      wrapChannel: (inner, info) => {
        if (info.kind !== "ctl") return inner;
        const send = inner.send.bind(inner);
        inner.send = (data) => (typeof data === "string" && data.includes('"hello"') ? undefined : send(data));
        return inner;
      },
    });
    const ab = a.manager.connect("b");
    const seen = watch(ab);
    await w.run(40);
    assert.equal(ab.state, "connecting");
    // "b" pushes a message and a packet straight into its channels.
    w.channel("b", "ctl").send(encodePeerMessage(PATH));
    w.channel("b", "media").send(heartbeat());
    await w.run(5);
    assert.deepEqual(seen.messages, []);
    assert.deepEqual(seen.packets, []);
    assert.equal(ab.sendPacket(heartbeat(), "control"), false);
    await w.run(HELLO_TIMEOUT_MS);
    assert.equal(ab.state, "closed");
    assert.equal(seen.reason, "auth-failed");
  });

  it("keeps what is sent before the link is open, and what arrives while hello is being checked, in order", async () => {
    const w = world();
    let release: (ok: boolean) => void = () => {};
    const a = w.peer("a", { verifyPeer: () => new Promise<boolean>((resolve) => (release = resolve)) });
    const b = w.peer("b");
    const ab = a.manager.connect("b");
    ab.sendMessage({ t: "keyreq", stream: 0 });
    const seenA = watch(ab);
    await w.run(40);
    const ba = b.incoming[0];
    const seenB = watch(ba);
    // "b" has checked "a" and is open; "a" is still checking "b".
    assert.equal(ba.state, "open");
    assert.equal(ab.state, "connecting");
    ba.sendMessage(PATH);
    ba.sendMessage({ t: "keyreq", stream: 1 });
    await w.run(5);
    assert.deepEqual(seenA.messages, []);
    assert.deepEqual(seenB.messages, []);
    release(true);
    await w.run(5);
    assert.equal(ab.state, "open");
    assert.deepEqual(seenA.messages, [PATH, { t: "keyreq", stream: 1 }]);
    assert.deepEqual(seenB.messages, [{ t: "keyreq", stream: 0 }]);
  });
});

describe("links: messages and packets (SPEC §5.3, §4)", () => {
  it("drops what does not parse, removes unknown fields, and closes after three bad messages in a row", async () => {
    const w = world();
    const { ab, ba } = await pair(w);
    const seen = watch(ab);
    const raw = w.channel("b", "ctl");
    raw.send("not json");
    raw.send(JSON.stringify({ t: "no-such-message" }));
    raw.send(JSON.stringify({ t: "path", path: ["x"], extra: "dropped" }));
    raw.send("{");
    raw.send("{");
    await w.run(3);
    assert.deepEqual(seen.messages, [{ t: "path", path: ["x"] }]);
    assert.equal(ab.state, "open");
    raw.send("{");
    await w.run(3);
    assert.equal(ab.state, "closed");
    assert.equal(seen.reason, "local");
    await w.run(3);
    assert.equal(ba.state, "closed");
  });

  it("passes on a bye and then closes with \"remote-bye\"", async () => {
    const w = world();
    const { ab, ba } = await pair(w);
    const seen = watch(ab);
    ba.sendMessage({ t: "bye", reason: "leave", alt: [{ peer: "c", depth: 1, free: 2 }] });
    await w.run(3);
    assert.deepEqual(seen.messages, [{ t: "bye", reason: "leave", alt: [{ peer: "c", depth: 1, free: 2 }] }]);
    assert.equal(ab.state, "closed");
    assert.equal(seen.reason, "remote-bye");
  });

  it("closing one end closes the other with \"channel-closed\", and a new link can be made", async () => {
    const w = world();
    const { a, b, ab, ba } = await pair(w);
    const seen = watch(ba);
    ab.close();
    assert.equal(ab.state, "closed");
    assert.equal(a.manager.get("b"), undefined);
    await w.run(3);
    assert.equal(ba.state, "closed");
    assert.equal(seen.reason, "channel-closed");
    assert.equal(b.manager.get("a"), undefined);
    const again = b.manager.connect("a");
    await w.run(40);
    assert.equal(again.state, "open");
    assert.equal(a.manager.get("b")!.state, "open");
  });

  it("stamps linkSeq and sendMs on every packet, of every type, counting from 0", async () => {
    const w = world();
    const { ab, ba } = await pair(w);
    const seen = watch(ba);
    w.clock.advance(70_000 - (w.clock.now() % 65_536));
    const now = w.clock.now();
    const packets = [heartbeat(), media(1), media(2), heartbeat()];
    for (const packet of packets) assert.equal(ab.sendPacket(packet, "video"), true);
    await w.run(3);
    assert.deepEqual(
      seen.packets.map((p) => packetLinkFields(p)),
      [
        { type: PacketType.Heartbeat, linkSeq: 0, sendMs: Math.floor(now) & 0xffff },
        { type: PacketType.Media, linkSeq: 1, sendMs: Math.floor(now) & 0xffff },
        { type: PacketType.Media, linkSeq: 2, sendMs: Math.floor(now) & 0xffff },
        { type: PacketType.Heartbeat, linkSeq: 3, sendMs: Math.floor(now) & 0xffff },
      ],
    );
    // In place: the caller's buffer carries the stamp too, and nothing else changed.
    assert.deepEqual(packetLinkFields(packets[2]), { type: PacketType.Media, linkSeq: 2, sendMs: Math.floor(now) & 0xffff });
    assert.deepEqual(ab.counters(), { packetsSent: 4, packetsReceived: 0, bytesSent: packets.reduce((n, p) => n + p.byteLength, 0), bytesReceived: 0, packetsShed: 0 });
    assert.equal(ba.counters().packetsReceived, 4);
  });

  it("drops a packet of another version without closing, and closes past 100 malformed packets a second", async () => {
    const w = world();
    const { ab } = await pair(w);
    const seen = watch(ab);
    const raw = w.channel("b", "media");
    raw.send(new Uint8Array([0x20, 0, 0, 0, 0, 0, 0, 0]));
    raw.send(new Uint8Array([0x1f, 0, 0, 0, 0, 0, 0, 0]));
    raw.send(new Uint8Array(0));
    await w.run(3);
    assert.deepEqual(seen.packets, []);
    assert.equal(ab.state, "open");
    for (let i = 0; i < 100; i++) raw.send(new Uint8Array([0xff]));
    await w.run(3);
    assert.equal(ab.state, "closed");
  });
});

describe("links: the send queue", () => {
  it("control and audio are sent ahead of queued video, and live video ahead of replay", async () => {
    const w = world();
    const { ab, ba } = await pair(w);
    const seen = watch(ba);
    const channel = w.channel("a", "media");
    channel.bufferedAmount = 200_000; // backed up
    const before = channel.sent.length;
    assert.equal(ab.sendPacket(media(100), "replay"), true);
    assert.equal(ab.sendPacket(media(1), "video"), true);
    assert.equal(ab.sendPacket(media(2), "video"), true);
    assert.equal(ab.sendPacket(media(50), "audio"), true);
    assert.equal(ab.sendPacket(heartbeat(), "control"), true);
    assert.equal(ab.sendPacket(media(3), "video"), true);
    await w.run(20);
    assert.equal(channel.sent.length, before, "nothing leaves while the channel is backed up");
    assert.equal(ab.bufferedAmount, 200_000 + 5 * 130 + heartbeat().byteLength);
    channel.bufferedAmount = 0;
    await w.run(10);
    const order = seen.packets.map((p) => (packetLinkFields(p)!.type === PacketType.Heartbeat ? "hb" : new DataView(p.buffer).getUint32(8)));
    assert.deepEqual(order, ["hb", 50, 1, 2, 3, 100]);
    // The link sequence follows the order of leaving.
    assert.deepEqual(
      seen.packets.map((p) => packetLinkFields(p)!.linkSeq),
      [0, 1, 2, 3, 4, 5],
    );
    assert.equal(ab.bufferedAmount, 0);
    // With the queue empty, packets go straight through again.
    ab.sendPacket(media(4), "video");
    assert.equal(channel.sent.length, before + 7);
  });

  it("keeps a copy of what it queues: the caller may reuse its buffer", async () => {
    const w = world();
    const { ab, ba } = await pair(w);
    const seen = watch(ba);
    const channel = w.channel("a", "media");
    channel.bufferedAmount = 200_000;
    const buffer = media(9);
    ab.sendPacket(buffer, "video");
    buffer.fill(0);
    channel.bufferedAmount = 0;
    await w.run(10);
    assert.equal(new DataView(seen.packets[0].buffer).getUint32(8), 9);
  });

  it("sheds video beyond the queue's limit, and says so; control still gets through", async () => {
    const w = world();
    const { ab, ba } = await pair(w, { maxQueueBytes: 1000, highWaterBytes: 500 });
    const seen = watch(ba);
    const channel = w.channel("a", "media");
    channel.bufferedAmount = 501;
    const results = Array.from({ length: 10 }, (_, i) => ab.sendPacket(media(i), "video"));
    assert.deepEqual(results, [true, true, true, true, true, true, true, false, false, false]);
    assert.equal(ab.sendPacket(heartbeat(), "control"), true);
    assert.equal(ab.counters().packetsShed, 3);
    channel.bufferedAmount = 0;
    await w.run(10);
    assert.equal(seen.packets.length, 8);
    assert.equal(packetLinkFields(seen.packets[0])!.type, PacketType.Heartbeat);
  });

  it("refuses packets on a link that is not open, and drops messages on one that is closed", async () => {
    const w = world();
    const a = w.peer("a");
    w.peer("b");
    const ab = a.manager.connect("b");
    assert.equal(ab.sendPacket(heartbeat(), "control"), false);
    await w.run(40);
    assert.equal(ab.sendPacket(heartbeat(), "control"), true);
    ab.close();
    assert.equal(ab.sendPacket(heartbeat(), "control"), false);
    ab.sendMessage(PATH);
    a.manager.closeAll();
    assert.deepEqual(a.manager.links(), []);
  });
});

describe("NAT type from gathered candidates (SPEC §8.1)", () => {
  const host = { type: "host", address: "192.168.1.5", port: 5000 };
  const srflx = (port: number, base = 5000) => ({ type: "srflx", address: "203.0.113.9", port, relatedAddress: "192.168.1.5", relatedPort: base });

  it("a public host address is \"open\"", () => {
    assert.equal(classifyNat([{ type: "host", address: "203.0.113.9", port: 5000 }], 2), "open");
  });
  it("the same mapped port from both servers is \"cone\"", () => {
    assert.equal(classifyNat([host, srflx(40000)], 2), "cone");
  });
  it("different mapped ports are \"symmetric\"", () => {
    assert.equal(classifyNat([host, srflx(40000), srflx(40001)], 2), "symmetric");
    // Two local sockets, each with one mapping, is still a cone.
    assert.equal(classifyNat([host, srflx(40000, 5000), srflx(40001, 5001)], 2), "cone");
  });
  it("only a relay candidate is \"relay\"; nothing to compare is \"unknown\"", () => {
    assert.equal(classifyNat([{ type: "host", address: "abc.local", port: 1 }, { type: "relay", address: "198.51.100.1", port: 3478 }], 2), "relay");
    assert.equal(classifyNat([host], 2), "unknown");
    assert.equal(classifyNat([host, srflx(40000)], 1), "unknown");
    assert.equal(classifyNat([{ ...host, protocol: "tcp" }, { ...srflx(1), protocol: "tcp" }], 2), "unknown");
  });
});
