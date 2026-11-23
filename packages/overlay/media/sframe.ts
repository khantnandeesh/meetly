/**
 * End-to-end encryption of the program feed, SFrame-style (SPEC §15.2; after RFC 9605's layout,
 * with AES-256-GCM). The source encrypts each frame's payload before it is packetized; a viewer
 * decrypts it after reassembly, just before the jitter buffer. Relays forward ciphertext as it
 * came: everything they read is in the media header, which stays in the clear and is
 * authenticated as associated data, so a relay that changes a frame's header or payload makes it
 * undecryptable, and it is dropped.
 *
 * In the clear (the 24-byte end-to-end header, SPEC §4.2): version and type, flags (KEY, SFRAME,
 * DISCARDABLE, END), streamId, stripe, the spatial and temporal layer, refDelta, keyDelta,
 * frameId, captureUs, configId. That is all the topology (forwarding, layer drop, the GOP cache,
 * replay, NACK, repair) and the jitter buffer read. fragIndex and fragCount (bytes 12–15) vary by
 * packet, not by frame, and are zero in the associated data: a frame is encrypted whole.
 *
 * The payload becomes:
 *
 * ```
 *  off  size  field
 *    0     1  version (high 4 bits, 1) | flags (low 4 bits): bit 0 SIGNED
 *    1     4  kid       the key's id: SHA-256("meetly-sframe-kid" ‖ key), first 4 bytes
 *    5     8  salt      random, per encryptor (a page, a publish), new when the counter wraps
 *   13     4  counter   per encryptor, over every frame of every stream, layer and stripe
 *   17     …  AES-256-GCM ciphertext of the codec payload (and, SIGNED, its signature), then
 *              its 16-byte tag
 * ```
 *
 * The IV is salt ‖ counter (96 bits): unique per frame for as long as the encryptor lives, and
 * across encryptors (a host's reload, a second publish) by the random salt. The associated data
 * is the clear header (24 bytes, fragment fields zeroed) followed by these 17 bytes.
 *
 * Overhead: 33 bytes a frame (17 here and the tag), about 21 kbit/s at 30 video and 50 audio
 * frames a second.
 *
 * **Source signatures** (optional, SPEC §14 item 1). Everyone with the link holds the AES key, so
 * a relay that is also a viewer could make frames that decrypt. With a signer, the source signs
 * every frame with ECDSA P-256 (SHA-256) over the associated data and the codec payload, and puts
 * the 64-byte signature after the payload, inside the ciphertext; SIGNED says so (and, being in
 * the associated data, cannot be cleared without breaking the tag). A viewer given the source's
 * public key (it travels in the link beside the AES key) drops every frame whose signature does
 * not hold, or that has none: "forged". Every frame, not one per keyframe or GOP: a signature on
 * keyframes alone would leave the frames between them free to forge, and one per GOP could only
 * be checked a GOP late. It costs 64 bytes a frame (about 41 kbit/s more) and, in Chromium, about
 * 0.07 ms to sign and 0.13 ms to verify a frame.
 */
import { MediaFlag, MEDIA_E2E_HEADER_BYTES, MEDIA_HEADER_BYTES, encodeMediaHeader, type FrameHeader } from "../protocol";
import type { FrameTransform } from "../transform";
import type { EncodedFrame } from "../types";

export const SFRAME_VERSION = 1;
/** Bytes in front of the ciphertext. */
export const SFRAME_HEADER_BYTES = 17;
export const SFRAME_TAG_BYTES = 16;
/** What encryption adds to a frame's payload. */
export const SFRAME_OVERHEAD_BYTES = SFRAME_HEADER_BYTES + SFRAME_TAG_BYTES;
/** A key is 256 bits. */
export const SFRAME_KEY_BYTES = 32;
/** An ECDSA P-256 signature, r ‖ s. */
export const SFRAME_SIGNATURE_BYTES = 64;
const SIGNED = 0x01;
const KID_BYTES = 4;
const SALT_BYTES = 8;
const COUNTER_LIMIT = 0x1_0000_0000;

const utf8 = new TextEncoder();
const bytes = (u8: Uint8Array) => u8 as Uint8Array<ArrayBuffer>;

/** A webinar's key, ready to use: never extractable once imported. */
export type SFrameKey = { readonly aes: CryptoKey; readonly kid: Uint8Array };

/** The key from its 32 raw bytes (as the share link carries them). Throws on any other length. */
export async function importSFrameKey(raw: Uint8Array): Promise<SFrameKey> {
  if (raw.byteLength !== SFRAME_KEY_BYTES) throw new RangeError("sframe: a key is 32 bytes");
  const aes = await crypto.subtle.importKey("raw", bytes(raw), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const label = utf8.encode("meetly-sframe-kid");
  const input = new Uint8Array(label.byteLength + raw.byteLength);
  input.set(label);
  input.set(raw, label.byteLength);
  const kid = new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, KID_BYTES);
  return { aes, kid };
}

/** The frame's header as associated data: the 24 end-to-end bytes, its fragment fields zeroed. */
export function clearHeaderBytes(header: FrameHeader): Uint8Array {
  const out = new Uint8Array(MEDIA_HEADER_BYTES);
  encodeMediaHeader({ ...header, fragIndex: 0, fragCount: 1, hopFlags: 0, hops: 0, linkSeq: 0, sendMs: 0 }, out);
  out.fill(0, 12, 16);
  return out.subarray(0, MEDIA_E2E_HEADER_BYTES);
}

function associatedData(header: FrameHeader, sframeHeader: Uint8Array): Uint8Array<ArrayBuffer> {
  const aad = new Uint8Array(MEDIA_E2E_HEADER_BYTES + SFRAME_HEADER_BYTES);
  aad.set(clearHeaderBytes(header));
  aad.set(sframeHeader.subarray(0, SFRAME_HEADER_BYTES), MEDIA_E2E_HEADER_BYTES);
  return aad;
}

const ECDSA = { name: "ECDSA", hash: "SHA-256" } as const;
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
};

/** A source's signing key pair, made for one webinar; only the public half leaves the host's page (as 65 raw bytes). */
export async function generateSFrameSigner(): Promise<{ signer: CryptoKey; publicKey: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  // The private half is re-imported as not extractable: nothing in the page can read it out again.
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const signer = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { signer, publicKey };
}

/** The source's public key from its 65 raw bytes (as the share link carries them). Rejects anything that is not a P-256 point. */
export function importSFrameVerifier(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes(raw), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((value, i) => value === b[i]);
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

/* ------------------------------ the source ------------------------------ */

export type SFrameEncryptStats = {
  frames: number;
  /** Time spent in `encrypt`, start to resolve, summed (ms), and the longest. */
  totalMs: number;
  maxMs: number;
  /** Salts this encryptor has used: 1 unless its counter wrapped. */
  salts: number;
};

export interface SFrameEncryptor {
  /** The frame with its payload encrypted and the SFRAME flag set. Frames may be in flight together. */
  encrypt(frame: EncodedFrame): Promise<EncodedFrame>;
  stats(): SFrameEncryptStats;
}

export type SFrameEncryptorOptions = {
  /** Fills the salt. `crypto.getRandomValues` unless a test says otherwise. */
  random?: (out: Uint8Array<ArrayBuffer>) => void;
  /** Where the counter starts: for tests of its wrap. */
  firstCounter?: number;
  /** The source's ECDSA P-256 private key: every frame is signed (`generateSFrameSigner`). */
  signer?: CryptoKey;
};

export function createSFrameEncryptor(key: SFrameKey, options: SFrameEncryptorOptions = {}): SFrameEncryptor {
  const random = options.random ?? ((out: Uint8Array<ArrayBuffer>) => void crypto.getRandomValues(out));
  let salt = new Uint8Array(SALT_BYTES);
  random(salt);
  let counter = options.firstCounter ?? 0;
  const stats: SFrameEncryptStats = { frames: 0, totalMs: 0, maxMs: 0, salts: 1 };
  return {
    async encrypt(frame) {
      const started = now();
      // The IV is taken before anything awaits, so frames in flight together never share one.
      if (counter >= COUNTER_LIMIT) {
        salt = new Uint8Array(SALT_BYTES);
        random(salt);
        counter = 0;
        stats.salts++;
      }
      const sframeHeader = new Uint8Array(SFRAME_HEADER_BYTES);
      sframeHeader[0] = (SFRAME_VERSION << 4) | (options.signer ? SIGNED : 0);
      sframeHeader.set(key.kid, 1);
      sframeHeader.set(salt, 1 + KID_BYTES);
      new DataView(sframeHeader.buffer).setUint32(1 + KID_BYTES + SALT_BYTES, counter++);
      const header: FrameHeader = { ...frame.header, flags: frame.header.flags | MediaFlag.SFrame };
      const iv = sframeHeader.slice(1 + KID_BYTES, SFRAME_HEADER_BYTES);
      const aad = associatedData(header, sframeHeader);
      let plain: Uint8Array = frame.data;
      if (options.signer) plain = concat(frame.data, new Uint8Array(await crypto.subtle.sign(ECDSA, options.signer, concat(aad, frame.data))));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key.aes, bytes(plain)));
      const data = new Uint8Array(SFRAME_HEADER_BYTES + sealed.byteLength);
      data.set(sframeHeader);
      data.set(sealed, SFRAME_HEADER_BYTES);
      const took = now() - started;
      stats.frames++;
      stats.totalMs += took;
      stats.maxMs = Math.max(stats.maxMs, took);
      return { header, data };
    },
    stats: () => ({ ...stats }),
  };
}

/* ------------------------------ a viewer ------------------------------ */

/**
 * What became of a frame at a viewer:
 * - "ok": decrypted, and played;
 * - "clear": not encrypted, and this viewer has no key: played as it is (a source without E2EE);
 * - "unencrypted": not encrypted, but this viewer has a key: dropped (a relay may not downgrade);
 * - "missing-key": encrypted, and this viewer has no key: dropped;
 * - "wrong-key": encrypted under another key (its kid is not this key's): dropped;
 * - "tampered": malformed, or its tag does not hold (header or payload changed): dropped;
 * - "forged": it decrypts, but this viewer holds the source's public key and the frame's
 *   signature does not hold, or it has none (made by someone else who has the link): dropped.
 */
export type SFrameOutcome = "ok" | "clear" | "unencrypted" | "missing-key" | "wrong-key" | "tampered" | "forged";

export type SFrameDecryptStats = Record<SFrameOutcome, number> & {
  /** Time spent decrypting frames that were encrypted under this key (ms), summed, and the longest. */
  totalMs: number;
  maxMs: number;
};

export interface SFrameDecryptor {
  decrypt<F extends EncodedFrame>(frame: F): Promise<{ outcome: SFrameOutcome; frame: F | null }>;
  stats(): SFrameDecryptStats;
}

export type SFrameDecryptorOptions = {
  onOutcome?: (outcome: SFrameOutcome, frame: EncodedFrame) => void;
  /** The source's public key (`importSFrameVerifier`): every frame must carry its signature. */
  verifier?: CryptoKey;
};

export function createSFrameDecryptor(key: SFrameKey | null, options: SFrameDecryptorOptions = {}): SFrameDecryptor {
  const stats: SFrameDecryptStats = { ok: 0, clear: 0, unencrypted: 0, "missing-key": 0, "wrong-key": 0, tampered: 0, forged: 0, totalMs: 0, maxMs: 0 };
  const settle = <F extends EncodedFrame>(outcome: SFrameOutcome, original: F, frame: F | null) => {
    stats[outcome]++;
    try {
      options.onOutcome?.(outcome, original);
    } catch {
      // A listener's mistake is not the frame's.
    }
    return { outcome, frame };
  };
  return {
    async decrypt(frame) {
      const encrypted = (frame.header.flags & MediaFlag.SFrame) !== 0;
      if (!encrypted) return key ? settle("unencrypted", frame, null) : settle("clear", frame, frame);
      if (!key) return settle("missing-key", frame, null);
      const data = frame.data;
      if (data.byteLength < SFRAME_OVERHEAD_BYTES || data[0] >> 4 !== SFRAME_VERSION || (data[0] & 0x0f & ~SIGNED) !== 0) return settle("tampered", frame, null);
      const signed = (data[0] & SIGNED) !== 0;
      if (!sameBytes(data.subarray(1, 1 + KID_BYTES), key.kid)) return settle("wrong-key", frame, null);
      const started = now();
      const aad = associatedData(frame.header, data);
      let plain: Uint8Array;
      try {
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(data.slice(1 + KID_BYTES, SFRAME_HEADER_BYTES)), additionalData: aad, tagLength: 128 }, key.aes, bytes(data.subarray(SFRAME_HEADER_BYTES))));
      } catch {
        return settle("tampered", frame, null);
      }
      if (signed && plain.byteLength < SFRAME_SIGNATURE_BYTES) return settle("tampered", frame, null);
      const payload = signed ? plain.subarray(0, plain.byteLength - SFRAME_SIGNATURE_BYTES) : plain;
      if (options.verifier) {
        const genuine = signed && (await crypto.subtle.verify(ECDSA, options.verifier, bytes(plain.subarray(payload.byteLength)), concat(aad, payload)).catch(() => false));
        if (!genuine) return settle("forged", frame, null);
      }
      const took = now() - started;
      stats.totalMs += took;
      stats.maxMs = Math.max(stats.maxMs, took);
      return settle("ok", frame, { ...frame, data: payload });
    },
    stats: () => ({ ...stats }),
  };
}

/**
 * The engine's hook (`OverlayConnectOptions.frameTransform`) for an encryptor at the source, a
 * decryptor at a viewer, or both.
 */
export function sframeTransform(parts: { encryptor?: SFrameEncryptor; decryptor?: SFrameDecryptor }): FrameTransform {
  const { encryptor, decryptor } = parts;
  return {
    sframe: !!encryptor,
    ...(encryptor ? { send: (frame: EncodedFrame) => encryptor.encrypt(frame) } : {}),
    ...(decryptor ? { receive: async <F extends EncodedFrame>(frame: F) => (await decryptor.decrypt(frame)).frame } : {}),
  };
}
