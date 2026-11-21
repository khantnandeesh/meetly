import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PARAMS,
  ECHO_NONE,
  FROM_LATEST_KEYFRAME,
  FeedbackFlag,
  HeartbeatFlag,
  HopFlag,
  LATENCY_BUCKETS,
  LATENCY_BUCKET_EDGES_MS,
  MAX_CAPTURE_US,
  MAX_MEDIA_PAYLOAD_BYTES,
  MAX_PACKET_BYTES,
  MEDIA_E2E_HEADER_BYTES,
  MEDIA_HEADER_BYTES,
  MediaFlag,
  NACK_WHOLE_FRAME,
  PROTOCOL_VERSION,
  PacketType,
  ProtocolError,
  decodeClientMessage,
  decodeFeedback,
  decodeHeartbeat,
  decodeMediaHeader,
  decodeMetricsSample,
  decodeNack,
  decodePeerMessage,
  decodeProbe,
  decodeServerMessage,
  emptyHistogram,
  encodeClientMessage,
  encodeFeedback,
  encodeHeartbeat,
  encodeMediaHeader,
  encodeMetricsSample,
  encodeNack,
  encodePeerMessage,
  encodeProbe,
  encodeServerMessage,
  exportGrantPublicKey,
  fromBase64Url,
  generateGrantKey,
  histogramQuantile,
  importGrantPublicKey,
  latencyBucket,
  mediaPayload,
  mergeHistogram,
  ms16,
  nackFragments,
  nackItemsFor,
  packetLinkFields,
  packetizeFrame,
  peekPacketType,
  readGrantUnverified,
  rttFromEcho,
  seq16Diff,
  signGrant,
  signTicket,
  toBase64Url,
  verifyGrant,
  verifyTicket,
  writeHopFields,
  type Capabilities,
  type ClientMessage,
  type Feedback,
  type Grant,
  type Heartbeat,
  type MediaHeader,
  type MetricsSample,
  type PeerMessage,
  type ServerMessage,
  type StreamConfig,
  type Ticket,
} from "./protocol";

const header = (over: Partial<MediaHeader> = {}): MediaHeader => ({
  type: PacketType.Media,
  flags: MediaFlag.Key | MediaFlag.SFrame,
  streamId: 3,
  stripe: 2,
  spatial: 1,
  temporal: 2,
  refDelta: 4,
  keyDelta: 513,
  frameId: 0xfedcba98,
  fragIndex: 258,
  fragCount: 770,
  captureUs: 0x0123_4567_89ab,
  configId: 7,
  hopFlags: HopFlag.Replay,
  hops: 5,
  linkSeq: 0xabcd,
  sendMs: 0x1234,
  ...over,
});

const video: StreamConfig = {
  id: 0,
  kind: "video",
  configId: 1,
  codec: "vp8",
  bitrateKbps: 1200,
  width: 1280,
  height: 720,
  fps: 30,
  scalability: "L1T3",
  keyIntervalFrames: 60,
  stripes: [{ index: 0, kind: "data", temporal: [0, 1, 2] }],
  sframe: false,
};

const caps: Capabilities = {
  browser: "chromium",
  desktop: true,
  onPower: null,
  nat: "cone",
  uplinkKbps: 8000,
  cores: 8,
  decode: ["vp8", "opus"],
  dataSaver: false,
  visible: true,
};

describe("media header", () => {
  it("round-trips every field", () => {
    const buf = new Uint8Array(MEDIA_HEADER_BYTES + 5);
    encodeMediaHeader(header(), buf);
    assert.deepEqual(decodeMediaHeader(buf), header());
  });

  it("has the documented byte layout", () => {
    const buf = new Uint8Array(MEDIA_HEADER_BYTES);
    encodeMediaHeader(header(), buf);
    // prettier-ignore
    assert.deepEqual([...buf], [
      (PROTOCOL_VERSION << 4) | 0, 0x03, 3, 2, 0x12, 4, 0x02, 0x01,
      0xfe, 0xdc, 0xba, 0x98, 0x01, 0x02, 0x03, 0x02,
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 7, 0,
      0x01, 5, 0xab, 0xcd, 0x12, 0x34,
    ]);
    assert.equal(MEDIA_E2E_HEADER_BYTES, 24);
  });

  it("holds the extremes of each field", () => {
    const max = header({
      type: PacketType.Parity,
      flags: 0xff,
      streamId: 255,
      stripe: 255,
      spatial: 15,
      temporal: 15,
      refDelta: 255,
      keyDelta: 0xffff,
      frameId: 0xffffffff,
      fragIndex: 0xfffe,
      fragCount: 0xffff,
      captureUs: MAX_CAPTURE_US,
      configId: 255,
      hopFlags: 0xff,
      hops: 255,
      linkSeq: 0xffff,
      sendMs: 0xffff,
    });
    const min = header({ flags: 0, streamId: 0, stripe: 0, spatial: 0, temporal: 0, refDelta: 0, keyDelta: 0, frameId: 0, fragIndex: 0, fragCount: 1, captureUs: 0, configId: 0, hopFlags: 0, hops: 0, linkSeq: 0, sendMs: 0 });
    for (const h of [max, min]) {
      const buf = new Uint8Array(MEDIA_HEADER_BYTES);
      encodeMediaHeader(h, buf);
      assert.deepEqual(decodeMediaHeader(buf), h);
    }
  });

  it("refuses to encode a field out of range", () => {
    const buf = new Uint8Array(MEDIA_HEADER_BYTES);
    const wrong: Partial<MediaHeader>[] = [
      { frameId: -1 },
      { frameId: 2 ** 32 },
      { fragCount: 0 },
      { fragIndex: 770 },
      { captureUs: MAX_CAPTURE_US + 1 },
      { captureUs: 1.5 },
      { temporal: 16 },
      { spatial: 16 },
      { refDelta: 256 },
      { keyDelta: 65536 },
      { linkSeq: 65536 },
      { type: PacketType.Heartbeat as never },
    ];
    for (const over of wrong) assert.throws(() => encodeMediaHeader(header(over), buf), RangeError, JSON.stringify(over));
    assert.throws(() => encodeMediaHeader(header(), new Uint8Array(MEDIA_HEADER_BYTES - 1)), RangeError);
  });

  it("decodes garbage to null, never an exception", () => {
    const good = new Uint8Array(MEDIA_HEADER_BYTES);
    encodeMediaHeader(header(), good);
    assert.equal(decodeMediaHeader(good.subarray(0, MEDIA_HEADER_BYTES - 1)), null, "short");
    assert.equal(decodeMediaHeader(new Uint8Array(0)), null, "empty");
    assert.equal(decodeMediaHeader(new Uint8Array(MAX_PACKET_BYTES + 1).fill(0x10)), null, "too long");
    const otherVersion = good.slice();
    otherVersion[0] = ((PROTOCOL_VERSION + 1) << 4) | PacketType.Media;
    assert.equal(decodeMediaHeader(otherVersion), null, "version");
    const otherType = good.slice();
    otherType[0] = (PROTOCOL_VERSION << 4) | PacketType.Heartbeat;
    assert.equal(decodeMediaHeader(otherType), null, "type");
    const noFragments = good.slice();
    noFragments[14] = noFragments[15] = 0;
    assert.equal(decodeMediaHeader(noFragments), null, "fragCount 0");
    const pastEnd = good.slice();
    pastEnd.set([0xff, 0xff], 12);
    assert.equal(decodeMediaHeader(pastEnd), null, "fragIndex past fragCount");
  });

  it("reads a header through a view at an offset", () => {
    const backing = new Uint8Array(100);
    const at = backing.subarray(17, 17 + MEDIA_HEADER_BYTES + 3);
    encodeMediaHeader(header(), at);
    assert.deepEqual(decodeMediaHeader(at), header());
    assert.equal(backing[16], 0);
  });

  it("rewrites the hop section and nothing else", () => {
    const buf = new Uint8Array(MEDIA_HEADER_BYTES + 4).fill(0xee);
    encodeMediaHeader(header(), buf);
    const before = buf.slice();
    writeHopFields(buf, { hopFlags: HopFlag.Retransmit, hops: 6, linkSeq: 1, sendMs: 2 });
    assert.deepEqual(decodeMediaHeader(buf), header({ hopFlags: HopFlag.Retransmit, hops: 6, linkSeq: 1, sendMs: 2 }));
    assert.deepEqual(buf.subarray(0, MEDIA_E2E_HEADER_BYTES), before.subarray(0, MEDIA_E2E_HEADER_BYTES));
    assert.deepEqual(buf.subarray(MEDIA_HEADER_BYTES), before.subarray(MEDIA_HEADER_BYTES));
  });
});

describe("packetizeFrame", () => {
  const frame = { type: PacketType.Media, flags: MediaFlag.Key, streamId: 0, stripe: 0, spatial: 0, temporal: 0, refDelta: 0, keyDelta: 0, frameId: 42, captureUs: 1_000_000, configId: 1 } as const;

  it("splits a frame into packets that put it back together", () => {
    const data = Uint8Array.from({ length: MAX_MEDIA_PAYLOAD_BYTES * 2 + 17 }, (_, i) => (i * 31) & 0xff);
    const packets = packetizeFrame(frame, data);
    assert.equal(packets.length, 3);
    const whole = new Uint8Array(data.length);
    let at = 0;
    packets.forEach((packet, i) => {
      assert.ok(packet.byteLength <= MAX_PACKET_BYTES);
      const h = decodeMediaHeader(packet);
      assert.ok(h);
      assert.equal(h.fragIndex, i);
      assert.equal(h.fragCount, 3);
      assert.equal(h.frameId, 42);
      assert.equal(h.flags, MediaFlag.Key);
      whole.set(mediaPayload(packet), at);
      at += mediaPayload(packet).byteLength;
    });
    assert.deepEqual(whole, data);
  });

  it("makes one full packet of a frame that exactly fits, and one empty packet of an empty frame", () => {
    assert.equal(packetizeFrame(frame, new Uint8Array(MAX_MEDIA_PAYLOAD_BYTES)).length, 1);
    assert.equal(packetizeFrame(frame, new Uint8Array(MAX_MEDIA_PAYLOAD_BYTES))[0].byteLength, MAX_PACKET_BYTES);
    const empty = packetizeFrame(frame, new Uint8Array(0));
    assert.equal(empty.length, 1);
    assert.equal(empty[0].byteLength, MEDIA_HEADER_BYTES);
    assert.equal(decodeMediaHeader(empty[0])?.fragCount, 1);
  });

  it("honours a smaller payload size and refuses a larger one", () => {
    assert.equal(packetizeFrame(frame, new Uint8Array(1000), 100).length, 10);
    assert.throws(() => packetizeFrame(frame, new Uint8Array(10), MAX_MEDIA_PAYLOAD_BYTES + 1), RangeError);
    assert.throws(() => packetizeFrame(frame, new Uint8Array(10), 0), RangeError);
  });
});

describe("heartbeat, feedback, nack, probe", () => {
  const hb: Heartbeat = {
    flags: HeartbeatFlag.Stalled | HeartbeatFlag.Full,
    linkSeq: 65535,
    sendMs: 1,
    echoMs: 2,
    echoHoldMs: ECHO_NONE,
    depth: 3,
    streams: [
      { streamId: 0, headFrameId: 0xffffffff, keyFrameId: 0xfffffff0 },
      { streamId: 1, headFrameId: 9, keyFrameId: 9 },
    ],
  };
  const fb: Feedback = {
    flags: FeedbackFlag.Starved,
    linkSeq: 10,
    sendMs: 11,
    echoMs: 12,
    echoHoldMs: 13,
    highestSeq: 14,
    received: 15,
    expected: 16,
    jitterTenthsMs: 17,
    queueDelayTenthsMs: 18,
    playoutDelayMs: 19,
    bufferMs: 20,
    maxSpatial: 1,
    maxTemporal: 2,
  };

  it("round-trips a heartbeat, with and without streams", () => {
    assert.deepEqual(decodeHeartbeat(encodeHeartbeat(hb)), hb);
    assert.equal(encodeHeartbeat(hb).byteLength, 12 + 2 * 9);
    assert.deepEqual(decodeHeartbeat(encodeHeartbeat({ ...hb, streams: [] })), { ...hb, streams: [] });
  });

  it("rejects a heartbeat whose length does not match its stream count", () => {
    const bytes = encodeHeartbeat(hb);
    assert.equal(decodeHeartbeat(bytes.subarray(0, bytes.length - 1)), null);
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    assert.equal(decodeHeartbeat(extra), null);
    assert.throws(() => encodeHeartbeat({ ...hb, streams: new Array(17).fill(hb.streams[0]) }), RangeError);
  });

  it("round-trips feedback", () => {
    const bytes = encodeFeedback(fb);
    assert.equal(bytes.byteLength, 26);
    assert.deepEqual(decodeFeedback(bytes), fb);
    assert.equal(decodeFeedback(bytes.subarray(0, 25)), null);
    assert.throws(() => encodeFeedback({ ...fb, received: 65536 }), RangeError);
  });

  it("round-trips a nack and expands its masks", () => {
    const nack = {
      linkSeq: 7,
      sendMs: 8,
      items: [
        { streamId: 0, frameId: 100, firstFrag: 3, mask: 0b101 },
        { streamId: 1, frameId: 5, firstFrag: NACK_WHOLE_FRAME, mask: 0 },
      ],
    };
    assert.deepEqual(decodeNack(encodeNack(nack)), nack);
    assert.deepEqual(nackFragments(nack.items[0]), [3, 4, 6]);
    assert.equal(nackFragments(nack.items[1]), null);
    assert.throws(() => encodeNack({ linkSeq: 0, sendMs: 0, items: [] }), RangeError);
    assert.equal(decodeNack(encodeNack(nack).subarray(0, 10)), null);
  });

  it("packs missing fragments into as few nack items as hold them", () => {
    const missing = [0, 1, 16, 17, 40];
    const items = nackItemsFor(2, 9, missing);
    assert.deepEqual(items, [
      { streamId: 2, frameId: 9, firstFrag: 0, mask: 0b1000000000000001 },
      { streamId: 2, frameId: 9, firstFrag: 17, mask: 0 },
      { streamId: 2, frameId: 9, firstFrag: 40, mask: 0 },
    ]);
    assert.deepEqual(
      items.flatMap((item) => nackFragments(item) ?? []),
      missing,
    );
    assert.deepEqual(nackItemsFor(0, 0, []), []);
  });

  it("round-trips a probe of the size asked for", () => {
    const bytes = encodeProbe({ linkSeq: 500, sendMs: 600, size: 1000 });
    assert.equal(bytes.byteLength, 1000);
    assert.deepEqual(decodeProbe(bytes), { linkSeq: 500, sendMs: 600, size: 1000 });
    assert.throws(() => encodeProbe({ linkSeq: 0, sendMs: 0, size: MAX_PACKET_BYTES + 1 }), RangeError);
  });

  it("tells packet types apart, and reads the link fields of each", () => {
    const media = new Uint8Array(MEDIA_HEADER_BYTES);
    encodeMediaHeader(header(), media);
    const packets: [number, Uint8Array, number, number][] = [
      [PacketType.Media, media, 0xabcd, 0x1234],
      [PacketType.Heartbeat, encodeHeartbeat(hb), 65535, 1],
      [PacketType.Feedback, encodeFeedback(fb), 10, 11],
      [PacketType.Nack, encodeNack({ linkSeq: 7, sendMs: 8, items: [{ streamId: 0, frameId: 1, firstFrag: 0, mask: 0 }] }), 7, 8],
      [PacketType.Probe, encodeProbe({ linkSeq: 500, sendMs: 600, size: 6 }), 500, 600],
    ];
    for (const [type, packet, linkSeq, sendMs] of packets) {
      assert.equal(peekPacketType(packet), type);
      assert.deepEqual(packetLinkFields(packet), { type, linkSeq, sendMs });
    }
    assert.equal(peekPacketType(new Uint8Array(0)), null);
    assert.equal(peekPacketType(Uint8Array.of((PROTOCOL_VERSION << 4) | 6)), null, "unknown type");
    assert.equal(peekPacketType(Uint8Array.of(0x02)), null, "version 0");
    assert.equal(packetLinkFields(Uint8Array.of((PROTOCOL_VERSION << 4) | PacketType.Probe, 0)), null);
    // Each decoder answers only for its own type.
    assert.equal(decodeHeartbeat(encodeFeedback(fb)), null);
    assert.equal(decodeFeedback(encodeHeartbeat(hb)), null);
    assert.equal(decodeNack(encodeProbe({ linkSeq: 0, sendMs: 0, size: 15 })), null);
    assert.equal(decodeProbe(media), null);
  });
});

describe("sequence and time arithmetic", () => {
  it("compares 16-bit sequence numbers across the wrap", () => {
    assert.equal(seq16Diff(5, 3), 2);
    assert.equal(seq16Diff(3, 5), -2);
    assert.equal(seq16Diff(2, 65534), 4);
    assert.equal(seq16Diff(65534, 2), -4);
    assert.equal(seq16Diff(7, 7), 0);
    assert.equal(seq16Diff(0x8000, 0), -32768);
  });

  it("works out a round trip from an echo, across the wrap of the clock", () => {
    assert.equal(rttFromEcho(10_000, ms16(9_900), 60), 40);
    assert.equal(rttFromEcho(65_546, ms16(65_500), 6), 40);
    assert.equal(rttFromEcho(10_000, ms16(9_900), ECHO_NONE), null);
    assert.equal(ms16(65_536 + 7.9), 7);
  });
});

describe("peer messages", () => {
  const messages: PeerMessage[] = [
    { t: "hello", v: 1, peer: "p1", grant: "a.b" },
    { t: "sub", id: 1, stream: 0, stripes: [0], mode: "active", fromFrame: FROM_LATEST_KEYFRAME, maxSpatial: 0, maxTemporal: 2 },
    { t: "repair", id: 2, stream: 0, stripes: [0], fromFrame: 1234, dead: "p9" },
    { t: "sub-ack", id: 1, ok: true, config: video, headFrame: 10, keyFrame: 0, path: ["p2", "p1", "src"], maxTemporal: 2 },
    { t: "sub-ack", id: 1, ok: false, code: "full" },
    { t: "unsub", stream: 0, stripes: [0, 1] },
    { t: "layers", stream: 0, maxSpatial: 0, maxTemporal: 0, reason: "congestion" },
    { t: "path", path: ["a", "b"] },
    { t: "peers", peers: [{ peer: "x", depth: 2, free: 1, region: "FRA" }] },
    { t: "sig", to: "a", from: "b", ttl: 2, data: { sdp: { type: "offer", sdp: "v=0" } } },
    { t: "sig", to: "a", from: "b", ttl: 0, data: { candidate: null } },
    { t: "config", stream: video },
    { t: "keyreq", stream: 0 },
    { t: "bye", reason: "leave", alt: [{ peer: "x", depth: 1, free: 0 }] },
  ];

  it("round-trips every kind", () => {
    for (const message of messages) assert.deepEqual(decodePeerMessage(encodePeerMessage(message)), message);
    const kinds = new Set(messages.map((m) => m.t));
    assert.equal(kinds.size, 12);
  });

  it("drops fields it does not know and keeps the rest", () => {
    const decoded = decodePeerMessage(JSON.stringify({ t: "keyreq", stream: 1, extra: { anything: true } }));
    assert.deepEqual(decoded, { t: "keyreq", stream: 1 });
    const nested = decodePeerMessage(JSON.stringify({ t: "peers", peers: [{ peer: "x", depth: 0, free: 0, admin: true }] }));
    assert.deepEqual(nested, { t: "peers", peers: [{ peer: "x", depth: 0, free: 0 }] });
  });

  it("throws ProtocolError, naming the field, for anything else", () => {
    const wrong: [string, RegExp][] = [
      ["", /not JSON/],
      ["{", /not JSON/],
      ["null", /known message type/],
      ["[]", /known message type/],
      [JSON.stringify({ t: "nope" }), /known message type/],
      [JSON.stringify({ t: "__proto__" }), /known message type/],
      [JSON.stringify({ t: "constructor" }), /known message type/],
      [JSON.stringify({ t: "sub", id: 1 }), /stream/],
      [JSON.stringify({ t: "keyreq", stream: 256 }), /stream/],
      [JSON.stringify({ t: "keyreq", stream: 1.5 }), /stream/],
      [JSON.stringify({ t: "keyreq", stream: "1" }), /stream/],
      [JSON.stringify({ t: "hello", v: 1, peer: "", grant: "x" }), /peer/],
      [JSON.stringify({ t: "path", path: new Array(65).fill("a") }), /path/],
      [JSON.stringify({ t: "peers", peers: [{ peer: "x", depth: -1, free: 0 }] }), /peers\[0\]\.depth/],
      [JSON.stringify({ t: "sub", id: 1, stream: 0, stripes: [0], mode: "active", fromFrame: -3, maxSpatial: 0, maxTemporal: 0 }), /fromFrame/],
      [JSON.stringify({ t: "bye", reason: "because" }), /reason/],
      [" ".repeat(64 * 1024 + 1), /too long/],
    ];
    for (const [text, pattern] of wrong) {
      assert.throws(
        () => decodePeerMessage(text),
        (error: unknown) => error instanceof ProtocolError && pattern.test(error.message),
        text.slice(0, 60),
      );
    }
  });
});

describe("coordinator messages", () => {
  const sample: MetricsSample = {
    peer: "p1",
    seq: 0,
    at: 12_345.5,
    intervalMs: 2000,
    role: "relay",
    depth: 2,
    video: { rendered: 60, dropped: 0, lost: 0, glassToGlass: emptyHistogram(), frameGap: emptyHistogram(), maxTemporal: 2 },
    audio: { playedMs: 2000, concealedMs: 0, underruns: 0, glassToGlass: emptyHistogram(), avOffsetMs: -4.5 },
    playoutDelayMs: 80,
    up: { parent: "p0", rttMs: null, lossPct: 0.5, queueDelayMs: 3, rxKbps: 1200, nacksSent: 1, retransmitsReceived: 1, duplicates: 0, turn: false },
    relay: { children: 2, standby: 1, txKbps: 2400, forwardP50Us: 450, forwardP95Us: 900, bufferedMaxBytes: 0, layerDrops: 0, retransmitsSent: 0 },
    events: [
      { t: "join", start: 0, welcome: 30, linked: 300, firstPacket: 310, firstFrame: 340, turn: false },
      { t: "repair", stream: 0, stripe: 0, dead: "p0", next: "p3", kind: "warm", lastHeard: 5000, detected: 5200, resubscribed: 5201, firstPacket: 5203, freezeMs: 209, framesLost: 0, usedCoordinator: false },
      { t: "switch", stream: 0, stripe: 0, from: "p3", to: "p4", at: 9000, freezeMs: 0 },
      { t: "layer", stream: 0, peer: "p7", at: 9100, maxTemporal: 1, reason: "congestion" },
      { t: "freeze", stream: 0, at: 9500, ms: 400 },
      { t: "error", at: 1, where: "decoder", message: "x" },
    ],
  };

  it("round-trips every client message", () => {
    const messages: ClientMessage[] = [
      { t: "hello", v: 1, caps },
      { t: "hello", v: 1, caps, resume: { peer: "p1", grant: "a.b" } },
      { t: "time", t0: 1_800_000_000_000.25 },
      { t: "signal", to: "p2", data: { candidate: { candidate: "candidate:1 1 udp 1 10.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null } } },
      { t: "need", id: 4, stream: 0, stripe: 0, want: "backup", exclude: ["p3"] },
      { t: "status", depth: 2, links: [{ stream: 0, stripe: 0, parent: "p0", backup: null }], children: 2, standby: 0, free: 2, caps, lossPct: 0, rttMs: 31.5 },
      { t: "report", event: "parent-dead", stream: 0, stripe: 0, peer: "p0", next: "p3" },
      { t: "metrics", sample },
      { t: "streams", streams: [video] },
      { t: "bye" },
    ];
    for (const message of messages) assert.deepEqual(decodeClientMessage(encodeClientMessage(message)), message);
  });

  it("round-trips every server message", () => {
    const assign = [{ stream: 0, stripe: 0, parents: [{ peer: "p0", depth: 0, free: 2 }], backups: [] }];
    const messages: ServerMessage[] = [
      {
        t: "welcome",
        v: 1,
        peer: "p1",
        room: "abc-defg-hij",
        role: "leaf",
        grant: "a.b",
        key: { kid: "k1", pub: "AAAA" },
        epochMs: 1_800_000_000_000,
        ice: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
        params: DEFAULT_PARAMS,
        streams: [video],
        assign,
      },
      { t: "time", t0: 5, t1: 6 },
      { t: "signal", from: "p2", data: { sdp: { type: "answer", sdp: "v=0" } } },
      { t: "assign", id: 4, reason: "need", assign },
      { t: "assign", reason: "rebalance", assign },
      { t: "role", role: "relay", grant: "a.b" },
      { t: "grant", grant: "a.b" },
      { t: "streams", streams: [] },
      { t: "hint", stream: 0, bitrateKbps: 800 },
      { t: "peer-gone", peer: "p0" },
      { t: "kick", reason: "removed by the host" },
      { t: "end", reason: "ended" },
      { t: "error", code: "full", message: "This webinar is full.", id: 4 },
    ];
    for (const message of messages) assert.deepEqual(decodeServerMessage(encodeServerMessage(message)), message);
  });

  it("refuses a peer message on the coordinator's socket, and the reverse", () => {
    assert.throws(() => decodeClientMessage(JSON.stringify({ t: "sub", id: 1 })), ProtocolError);
    assert.throws(() => decodeServerMessage(JSON.stringify({ t: "hello", v: 1, caps })), ProtocolError);
    assert.throws(() => decodePeerMessage(JSON.stringify({ t: "welcome" })), ProtocolError);
  });

  it("round-trips a metrics sample on its own, and refuses a histogram that is too long", () => {
    assert.deepEqual(decodeMetricsSample(encodeMetricsSample(sample)), sample);
    const long = { ...sample, video: { ...sample.video, glassToGlass: new Array(LATENCY_BUCKETS + 1).fill(0) } };
    assert.throws(() => decodeMetricsSample(JSON.stringify(long)), /glassToGlass/);
  });

  it("keeps the default timings the proof measured", () => {
    assert.equal(DEFAULT_PARAMS.heartbeatMs, 50);
    assert.equal(DEFAULT_PARAMS.deadMs, 200);
  });
});

describe("latency histogram", () => {
  it("has strictly rising edges and one open bucket past the last", () => {
    for (let i = 1; i < LATENCY_BUCKET_EDGES_MS.length; i++) assert.ok(LATENCY_BUCKET_EDGES_MS[i] > LATENCY_BUCKET_EDGES_MS[i - 1]);
    assert.equal(LATENCY_BUCKET_EDGES_MS[0], 10);
    assert.equal(LATENCY_BUCKET_EDGES_MS[49], 500);
    assert.equal(LATENCY_BUCKET_EDGES_MS[50], 550);
    assert.equal(LATENCY_BUCKET_EDGES_MS[79], 2000);
    assert.equal(LATENCY_BUCKET_EDGES_MS.at(-1), 10_000);
    assert.equal(emptyHistogram().length, LATENCY_BUCKETS);
  });

  it("puts a duration in the first bucket whose edge is at or above it", () => {
    assert.equal(latencyBucket(0), 0);
    assert.equal(latencyBucket(10), 0);
    assert.equal(latencyBucket(10.01), 1);
    assert.equal(latencyBucket(500), 49);
    assert.equal(latencyBucket(501), 50);
    assert.equal(latencyBucket(10_000), LATENCY_BUCKETS - 2);
    assert.equal(latencyBucket(99_999), LATENCY_BUCKETS - 1);
  });

  it("reads quantiles as an upper bound, and merges", () => {
    const h = emptyHistogram();
    assert.equal(histogramQuantile(h, 0.95), null);
    for (let i = 0; i < 95; i++) h[latencyBucket(205)]++;
    for (let i = 0; i < 5; i++) h[latencyBucket(480)]++;
    assert.equal(histogramQuantile(h, 0.5), 210);
    assert.equal(histogramQuantile(h, 0.95), 210);
    assert.equal(histogramQuantile(h, 0.96), 480);
    assert.equal(histogramQuantile(h, 1), 480);
    const other = emptyHistogram();
    other[LATENCY_BUCKETS - 1] = 100;
    assert.equal(histogramQuantile(mergeHistogram(h, other), 0.95), Infinity);
    assert.equal(
      h.reduce((a, b) => a + b),
      200,
    );
  });
});

describe("base64url", () => {
  it("round-trips every length and byte value", () => {
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length * 11) & 0xff);
      const text = toBase64Url(bytes);
      assert.match(text, /^[A-Za-z0-9_-]*$/);
      assert.equal(text, Buffer.from(bytes).toString("base64url"));
      assert.deepEqual(fromBase64Url(text), bytes);
    }
    assert.equal(fromBase64Url("a+b/"), null);
    assert.equal(fromBase64Url("abcde"), null);
  });
});

describe("grants", () => {
  const now = 1_800_000_000_000;
  const payload: Grant = { v: 1, room: "abc-defg-hij", peer: "p1", role: "relay", scope: ["view", "relay"], iat: now / 1000, exp: now / 1000 + 600, kid: "k1" };

  it("verifies what the key signed, through an exported public key", async () => {
    const pair = await generateGrantKey();
    const token = await signGrant(payload, pair.privateKey);
    const pub = await importGrantPublicKey(await exportGrantPublicKey(pair.publicKey));
    assert.deepEqual(await verifyGrant(token, pub, { room: payload.room, now }), payload);
    assert.deepEqual(await verifyGrant(token, pub, { room: payload.room, now, peer: "p1" }), payload);
    assert.deepEqual(readGrantUnverified(token), payload);
  });

  it("refuses another key, room or peer, a changed payload, and a grant out of date", async () => {
    const pair = await generateGrantKey();
    const other = await generateGrantKey();
    const token = await signGrant(payload, pair.privateKey);
    const check = { room: payload.room, now };
    assert.equal(await verifyGrant(token, other.publicKey, check), null, "another key");
    assert.equal(await verifyGrant(token, pair.publicKey, { ...check, room: "other" }), null, "another room");
    assert.equal(await verifyGrant(token, pair.publicKey, { ...check, peer: "p2" }), null, "another peer");
    assert.equal(await verifyGrant(token, pair.publicKey, { ...check, now: now + 631_000 }), null, "expired");
    assert.ok(await verifyGrant(token, pair.publicKey, { ...check, now: now + 629_000 }), "inside the leeway");
    assert.equal(await verifyGrant(token, pair.publicKey, { ...check, now: now - 31_000 }), null, "not yet valid");
    const [, signature] = token.split(".");
    const forged = `${toBase64Url(new TextEncoder().encode(JSON.stringify({ ...payload, role: "source" })))}.${signature}`;
    assert.equal(await verifyGrant(forged, pair.publicKey, check), null, "changed payload");
    for (const junk of ["", "a", "a.b.c", "!!.!!", `${toBase64Url(new TextEncoder().encode("{}"))}.AAAA`]) {
      assert.equal(await verifyGrant(junk, pair.publicKey, check), null, junk);
      assert.equal(readGrantUnverified(junk), null, junk);
    }
  });

  it("refuses to sign a grant that is not one, or import a key that is not one", async () => {
    const pair = await generateGrantKey();
    await assert.rejects(signGrant({ ...payload, role: "admin" as never }, pair.privateKey), ProtocolError);
    await assert.rejects(importGrantPublicKey("AAAA"), ProtocolError);
  });
});

describe("tickets", () => {
  const now = 1_800_000_000_000;
  const payload: Ticket = { v: 1, room: "abc-defg-hij", identity: "u_123", name: "Maya", role: "viewer", exp: now / 1000 + 60, nonce: "0123456789abcdef" };

  it("verifies with the shared secret and nothing else", async () => {
    const token = await signTicket(payload, "s3cret");
    const check = { room: payload.room, now };
    assert.deepEqual(await verifyTicket(token, "s3cret", check), payload);
    assert.equal(await verifyTicket(token, "other", check), null);
    assert.equal(await verifyTicket(token, "", check), null);
    assert.equal(await verifyTicket(token, "s3cret", { ...check, room: "other" }), null);
    assert.equal(await verifyTicket(token, "s3cret", { ...check, now: now + 61_000 }), null);
    const [, mac] = token.split(".");
    const forged = `${toBase64Url(new TextEncoder().encode(JSON.stringify({ ...payload, role: "source" })))}.${mac}`;
    assert.equal(await verifyTicket(forged, "s3cret", check), null);
    await assert.rejects(signTicket(payload, ""), ProtocolError);
  });
});
