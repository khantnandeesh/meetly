import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_MEDIA_PAYLOAD_BYTES,
  MediaFlag,
  PacketType,
  SFRAME_HEADER_BYTES,
  SFRAME_OVERHEAD_BYTES,
  SFRAME_SIGNATURE_BYTES,
  clearHeaderBytes,
  generateSFrameSigner,
  importSFrameVerifier,
  createSFrameDecryptor,
  createSFrameEncryptor,
  decodeMediaHeader,
  importSFrameKey,
  mediaPayload,
  packetizeFrame,
  sframeTransform,
  signStreamConfig,
  verifyStreamConfig,
  FrameIntegrityError,
  decodePeerMessage,
  encodePeerMessage,
  type StreamConfig,
  type EncodedFrame,
  type FrameHeader,
  type ReceivedFrame,
} from "@meetly/overlay";

/** SFrame-style end-to-end encryption of frame payloads (media/sframe.ts, SPEC §15.2). */

const rawKey = (fill: number) => new Uint8Array(32).fill(fill);

function header(over: Partial<FrameHeader> = {}): FrameHeader {
  return { type: PacketType.Media, flags: MediaFlag.Key, streamId: 0, stripe: 0, spatial: 0, temporal: 0, refDelta: 0, keyDelta: 0, frameId: 7, captureUs: 1_234_567, configId: 1, ...over };
}

/** A payload that looks like a VP8 keyframe: its start code at bytes 3–5. */
function vp8Like(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  if (size >= 6) data.set([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]);
  return data;
}

const frame = (over: Partial<FrameHeader> = {}, data = vp8Like(5000)): EncodedFrame => ({ header: header(over), data });
const received = (f: EncodedFrame): ReceivedFrame => ({ ...f, firstPacketAt: 0, completeAt: 1, from: "p-relay", recovered: false });

test("a frame round-trips: the payload is ciphertext on the wire, the header stays readable", async () => {
  const key = await importSFrameKey(rawKey(1));
  const encryptor = createSFrameEncryptor(key);
  const decryptor = createSFrameDecryptor(key);
  for (const original of [frame(), frame({ streamId: 1, flags: MediaFlag.Key, frameId: 3 }, vp8Like(80)), frame({ flags: MediaFlag.Discardable, temporal: 2, refDelta: 1, keyDelta: 5 }, vp8Like(0))]) {
    const sealed = await encryptor.encrypt(original);
    assert.equal(sealed.data.byteLength, original.data.byteLength + SFRAME_OVERHEAD_BYTES);
    assert.equal(sealed.header.flags, original.header.flags | MediaFlag.SFrame);
    // What a relay reads is unchanged.
    const { flags: _f, ...rest } = sealed.header;
    const { flags: _g, ...before } = original.header;
    assert.deepEqual(rest, before);
    // The plaintext is nowhere in what is sent: not the VP8 start code, not a run of it.
    if (original.data.byteLength > 16) {
      const wire = Buffer.from(sealed.data);
      assert.equal(wire.indexOf(Buffer.from([0x9d, 0x01, 0x2a])), -1);
      assert.equal(wire.indexOf(Buffer.from(original.data.subarray(16, 48))), -1);
    }
    const opened = await decryptor.decrypt(received(sealed));
    assert.equal(opened.outcome, "ok");
    assert.deepEqual(opened.frame!.data, original.data);
    assert.equal(opened.frame!.from, "p-relay");
  }
  assert.equal(decryptor.stats().ok, 3);
});

test("it survives packetizing and reassembly, and a relay rewriting the hop fields", async () => {
  const key = await importSFrameKey(rawKey(2));
  const sealed = await createSFrameEncryptor(key).encrypt(frame({}, vp8Like(4 * MAX_MEDIA_PAYLOAD_BYTES + 17)));
  const packets = packetizeFrame(sealed.header, sealed.data);
  assert.equal(packets.length, 5);
  const parts: Uint8Array[] = [];
  for (const packet of packets) {
    packet[24] = 0x01; // hopFlags: a replay
    packet[25] = 3; // hops
    const h = decodeMediaHeader(packet)!;
    assert.equal(h.flags & MediaFlag.SFrame, MediaFlag.SFrame);
    parts.push(mediaPayload(packet));
  }
  const { fragIndex: _i, fragCount: _c, hopFlags: _h, hops: _o, linkSeq: _l, sendMs: _s, ...again } = decodeMediaHeader(packets[0])!;
  const data = new Uint8Array(Buffer.concat(parts));
  const opened = await createSFrameDecryptor(key).decrypt(received({ header: again, data }));
  assert.equal(opened.outcome, "ok");
  assert.equal(opened.frame!.data.byteLength, 4 * MAX_MEDIA_PAYLOAD_BYTES + 17);
});

test("the wrong key, and no key, are told apart from tampering and nothing is played", async () => {
  const sealed = await createSFrameEncryptor(await importSFrameKey(rawKey(3))).encrypt(frame());
  const wrong = createSFrameDecryptor(await importSFrameKey(rawKey(4)));
  assert.deepEqual(await wrong.decrypt(sealed), { outcome: "wrong-key", frame: null });
  const none = createSFrameDecryptor(null);
  assert.deepEqual(await none.decrypt(sealed), { outcome: "missing-key", frame: null });
  assert.equal(wrong.stats()["wrong-key"], 1);
  assert.equal(none.stats()["missing-key"], 1);
});

test("a frame whose clear header was changed is dropped as tampered", async () => {
  const key = await importSFrameKey(rawKey(5));
  const sealed = await createSFrameEncryptor(key).encrypt(frame({ flags: MediaFlag.Discardable, temporal: 2, refDelta: 1, keyDelta: 3 }));
  const decryptor = createSFrameDecryptor(key);
  const changes: Partial<FrameHeader>[] = [
    { frameId: 8 },
    { captureUs: 1_234_568 },
    { flags: sealed.header.flags | MediaFlag.Key },
    { flags: sealed.header.flags & ~MediaFlag.Discardable },
    { flags: sealed.header.flags | MediaFlag.EndOfStream },
    { temporal: 0 },
    { spatial: 1 },
    { refDelta: 2 },
    { keyDelta: 0 },
    { streamId: 1 },
    { stripe: 1 },
    { configId: 2 },
  ];
  for (const change of changes) {
    const result = await decryptor.decrypt({ ...sealed, header: { ...sealed.header, ...change } });
    assert.deepEqual(result, { outcome: "tampered", frame: null }, JSON.stringify(change));
  }
  assert.equal(decryptor.stats().tampered, changes.length);
  assert.equal(decryptor.stats().ok, 0);
  // And untouched, it opens.
  assert.equal((await decryptor.decrypt(sealed)).outcome, "ok");
});

test("a frame whose payload was changed anywhere is dropped as tampered", async () => {
  const key = await importSFrameKey(rawKey(6));
  const sealed = await createSFrameEncryptor(key).encrypt(frame({}, vp8Like(300)));
  const decryptor = createSFrameDecryptor(key);
  // Every byte but the kid's (a changed kid reads as another key's frame: still dropped).
  for (let at = 0; at < sealed.data.byteLength; at++) {
    if (at >= 1 && at < 5) continue;
    const data = sealed.data.slice();
    data[at] ^= 0x01;
    const result = await decryptor.decrypt({ ...sealed, data });
    assert.equal(result.outcome, "tampered", `byte ${at}`);
    assert.equal(result.frame, null);
  }
  for (const data of [sealed.data.subarray(0, sealed.data.byteLength - 1), sealed.data.subarray(0, SFRAME_HEADER_BYTES + 15), new Uint8Array(0), Buffer.concat([sealed.data, Buffer.from([0])])]) {
    assert.equal((await decryptor.decrypt({ ...sealed, data: new Uint8Array(data) })).outcome, "tampered");
  }
  // One frame's payload under another frame's header.
  const other = await createSFrameEncryptor(key).encrypt(frame({ frameId: 8 }, vp8Like(300)));
  assert.equal((await decryptor.decrypt({ header: other.header, data: sealed.data })).outcome, "tampered");
});

test("with a key, a frame sent in the clear is dropped; without one, it plays", async () => {
  const key = await importSFrameKey(rawKey(7));
  const plain = frame();
  assert.deepEqual(await createSFrameDecryptor(key).decrypt(plain), { outcome: "unencrypted", frame: null });
  // A relay that strips the SFRAME flag from a real frame gets the same.
  const sealed = await createSFrameEncryptor(key).encrypt(frame());
  assert.equal((await createSFrameDecryptor(key).decrypt({ ...sealed, header: { ...sealed.header, flags: sealed.header.flags & ~MediaFlag.SFrame } })).outcome, "unencrypted");
  const open = await createSFrameDecryptor(null).decrypt(plain);
  assert.equal(open.outcome, "clear");
  assert.equal(open.frame, plain);
});

test("every frame gets its own IV: across streams, layers, frames in flight, encryptors and a counter's wrap", async () => {
  const key = await importSFrameKey(rawKey(8));
  const ivs = new Set<string>();
  const ivOf = (f: EncodedFrame) => Buffer.from(f.data.subarray(5, SFRAME_HEADER_BYTES)).toString("hex");
  const encryptor = createSFrameEncryptor(key);
  // All in flight at once, as the engine runs them: video (three temporal layers, two stripes) and audio.
  const pending: Promise<EncodedFrame>[] = [];
  for (let i = 0; i < 3000; i++) {
    pending.push(encryptor.encrypt(frame({ streamId: 0, frameId: i, temporal: i % 3, stripe: i % 2, flags: i % 60 === 0 ? MediaFlag.Key : 0 }, vp8Like(64))));
    pending.push(encryptor.encrypt(frame({ streamId: 1, frameId: i }, vp8Like(40))));
  }
  for (const sealed of await Promise.all(pending)) ivs.add(ivOf(sealed));
  assert.equal(ivs.size, 6000);
  // A second encryptor under the same key (the host reloads, or publishes again): a new salt.
  const again = createSFrameEncryptor(key);
  for (let i = 0; i < 100; i++) ivs.add(ivOf(await again.encrypt(frame({ frameId: i }))));
  assert.equal(ivs.size, 6100);
  // Even if its random source repeated itself, the salt is per encryptor: the test's fixed salt
  // shows what is at stake, and that the counter, not the frame, decides the IV.
  const fixed = (out: Uint8Array) => out.fill(0xab);
  const a = createSFrameEncryptor(key, { random: fixed });
  const first = ivOf(await a.encrypt(frame({ frameId: 1 })));
  assert.notEqual(ivOf(await a.encrypt(frame({ frameId: 1 }))), first);
  // At the counter's end, a fresh salt, never a repeated IV.
  let n = 0;
  const wrapping = createSFrameEncryptor(key, { random: (out) => out.fill(++n), firstCounter: 0xffff_fffe });
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) seen.add(ivOf(await wrapping.encrypt(frame({ frameId: i }))));
  assert.equal(seen.size, 4);
  assert.equal(wrapping.stats().salts, 2);
  const decryptor = createSFrameDecryptor(key);
  assert.equal((await decryptor.decrypt(await wrapping.encrypt(frame()))).outcome, "ok");
});

test("a key is 32 bytes, and its id does not give it away", async () => {
  await assert.rejects(importSFrameKey(new Uint8Array(16)), RangeError);
  const raw = rawKey(9);
  const sealed = await createSFrameEncryptor(await importSFrameKey(raw)).encrypt(frame());
  assert.equal(Buffer.from(sealed.data).indexOf(Buffer.from(raw)), -1);
  assert.notDeepEqual(sealed.data.subarray(1, 5), raw.subarray(0, 4));
});

test("signed frames: a viewer with the source's public key plays the source's frames and drops anyone else's", async () => {
  const key = await importSFrameKey(rawKey(11));
  const host = await generateSFrameSigner();
  assert.equal(host.publicKey.byteLength, 65);
  const verifier = await importSFrameVerifier(host.publicKey);
  const viewer = createSFrameDecryptor(key, { verifier });
  const original = frame({}, vp8Like(5000));
  const sealed = await createSFrameEncryptor(key, { signer: host.signer }).encrypt(original);
  assert.equal(sealed.data.byteLength, original.data.byteLength + SFRAME_OVERHEAD_BYTES + SFRAME_SIGNATURE_BYTES);
  assert.equal(sealed.data[0], 0x11);
  const opened = await viewer.decrypt(sealed);
  assert.equal(opened.outcome, "ok");
  assert.deepEqual(opened.frame!.data, original.data);
  // A viewer that is a relay holds the AES key, so it can make frames that decrypt: unsigned,
  // signed with its own key pair, or the source's signature moved onto other content.
  const unsigned = await createSFrameEncryptor(key).encrypt(original);
  const impostor = await createSFrameEncryptor(key, { signer: (await generateSFrameSigner()).signer }).encrypt(original);
  assert.equal((await viewer.decrypt(unsigned)).outcome, "forged");
  assert.equal((await viewer.decrypt(impostor)).outcome, "forged");
  const plain = (await createSFrameDecryptor(key).decrypt(sealed)).frame!;
  assert.deepEqual(plain.data, original.data, "a viewer without the public key still plays signed frames");
  // The source's own payload and signature, re-encrypted by a relay under another frame's header
  // with SIGNED set: it decrypts, and the signature does not hold for that header.
  const aes = await crypto.subtle.importKey("raw", rawKey(11), "AES-GCM", false, ["encrypt", "decrypt"]);
  const sframeHeader = sealed.data.slice(0, SFRAME_HEADER_BYTES);
  const signedPlain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(sframeHeader.slice(5)), additionalData: new Uint8Array(Buffer.concat([clearHeaderBytes(sealed.header), sframeHeader])) }, aes, sealed.data.slice(SFRAME_HEADER_BYTES) as Uint8Array<ArrayBuffer>));
  const movedHeader = { ...sealed.header, frameId: 99 };
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(sframeHeader.slice(5)), additionalData: new Uint8Array(Buffer.concat([clearHeaderBytes(movedHeader), sframeHeader])) }, aes, signedPlain as Uint8Array<ArrayBuffer>));
  const moved = { header: movedHeader, data: new Uint8Array(Buffer.concat([sframeHeader, ct])) };
  assert.equal((await createSFrameDecryptor(key).decrypt(moved)).outcome, "ok", "it does decrypt");
  assert.equal((await viewer.decrypt(moved)).outcome, "forged");
  assert.equal(viewer.stats().forged, 3);
  assert.equal(viewer.stats().ok, 1);
  await assert.rejects(importSFrameVerifier(new Uint8Array(65)));
});

test("the engine's hook: an encryptor marks streams as SFrame, a decryptor drops what does not open", async () => {
  const key = await importSFrameKey(rawKey(10));
  const outcomes: string[] = [];
  const source = sframeTransform({ encryptor: createSFrameEncryptor(key) });
  const viewer = sframeTransform({ decryptor: createSFrameDecryptor(key, { onOutcome: (outcome) => outcomes.push(outcome) }) });
  assert.equal(source.sframe, true);
  assert.equal(viewer.sframe, false);
  assert.equal(source.receive, undefined);
  const sealed = await source.send!(frame());
  assert.deepEqual((await viewer.receive!(received(sealed)))!.data, frame().data);
  // [D65] What a relay changed rejects, so that the engine can count it against that relay; dropped all the same.
  await assert.rejects(viewer.receive!(received({ ...sealed, data: sealed.data.subarray(1) })), FrameIntegrityError);
  assert.deepEqual(outcomes, ["ok", "tampered"]);
});

test("[D65] tampered, forged and unencrypted frames reject as integrity failures; a missing or wrong key does not", async () => {
  const key = await importSFrameKey(rawKey(11));
  const other = await importSFrameKey(rawKey(12));
  const { signer, publicKey } = await generateSFrameSigner();
  const verifier = await importSFrameVerifier(publicKey);
  const signed = await createSFrameEncryptor(key, { signer }).encrypt(frame());
  const unsigned = await createSFrameEncryptor(key).encrypt(frame());
  const viewer = sframeTransform({ decryptor: createSFrameDecryptor(key, { verifier }) });
  const outcome = (error: unknown) => (error instanceof FrameIntegrityError ? error.outcome : "other");
  assert.ok(await viewer.receive!(received(signed)));
  assert.equal(await viewer.receive!(received({ ...signed, data: signed.data.subarray(2) })).catch(outcome), "tampered");
  assert.equal(await viewer.receive!(received(unsigned)).catch(outcome), "forged");
  assert.equal(await viewer.receive!(received(frame())).catch(outcome), "unencrypted");
  // Another webinar's key, or none: nothing a relay did. Dropped without blame.
  assert.equal(await sframeTransform({ decryptor: createSFrameDecryptor(other) }).receive!(received(signed)), null);
  assert.equal(await sframeTransform({ decryptor: createSFrameDecryptor(null) }).receive!(received(signed)), null);
});

const CONFIG: StreamConfig = {
  id: 0,
  kind: "video",
  configId: 3,
  codec: "vp8",
  bitrateKbps: 1200,
  width: 1280,
  height: 720,
  fps: 30,
  scalability: "L1T3",
  keyIntervalFrames: 60,
  stripes: [{ index: 0, kind: "data", temporal: [0, 1, 2] }],
  sframe: true,
  description: "AAECAw",
};

test("[D66] a stream configuration signed by the source is the source's, and nothing changed in it is", async () => {
  const key = await importSFrameKey(rawKey(13));
  const { signer, publicKey } = await generateSFrameSigner();
  const verifier = await importSFrameVerifier(publicKey);
  const signed = await signStreamConfig(CONFIG, { key, signer });
  assert.ok(signed.sig?.startsWith("s."));
  // It survives the wire: the protocol keeps `sig`, and the field order does not matter.
  const wired = decodePeerMessage(encodePeerMessage({ t: "config", stream: signed }));
  assert.equal(wired?.t, "config");
  const back = (wired as { stream: StreamConfig }).stream;
  assert.equal(await verifyStreamConfig(back, { key, verifier }), true);
  assert.equal(await verifyStreamConfig(Object.fromEntries(Object.entries(back).reverse()) as StreamConfig, { key, verifier }), true);
  for (const changed of [{ description: "AAECBA" }, { codec: "vp9" }, { configId: 4 }, { scalability: "L1T1" }, { sig: undefined }]) {
    assert.equal(await verifyStreamConfig({ ...signed, ...changed }, { key, verifier }), false, JSON.stringify(changed));
  }
  // A configuration tagged with the key alone (anyone with the link can) is not the source's.
  assert.equal(await verifyStreamConfig(await signStreamConfig(CONFIG, { key }), { key, verifier }), false);
  // Another signer's is not either.
  const stranger = await generateSFrameSigner();
  assert.equal(await verifyStreamConfig(await signStreamConfig(CONFIG, { signer: stranger.signer }), { key, verifier }), false);
});

test("[D66] with the key only, a configuration is checked by its tag; with nothing, anything goes", async () => {
  const key = await importSFrameKey(rawKey(14));
  const tagged = await signStreamConfig(CONFIG, { key });
  assert.ok(tagged.sig?.startsWith("g."));
  assert.equal(await verifyStreamConfig(tagged, { key }), true);
  assert.equal(await verifyStreamConfig({ ...tagged, description: "AAECBA" }, { key }), false);
  assert.equal(await verifyStreamConfig(tagged, { key: await importSFrameKey(rawKey(15)) }), false);
  assert.equal(await verifyStreamConfig(CONFIG, { key }), false, "unsigned");
  assert.equal(await verifyStreamConfig(CONFIG, {}), true, "no key, no check");
  // The hook: the source signs, the viewer checks.
  const { signer, publicKey } = await generateSFrameSigner();
  const source = sframeTransform({ encryptor: createSFrameEncryptor(key, { signer }), config: { key, signer } });
  const viewer = sframeTransform({ decryptor: createSFrameDecryptor(key), config: { key, verifier: await importSFrameVerifier(publicKey) } });
  const announced = await source.signConfig!(CONFIG);
  assert.equal(await viewer.verifyConfig!(announced), true);
  assert.equal(await viewer.verifyConfig!({ ...announced, width: 640 }), false);
});
