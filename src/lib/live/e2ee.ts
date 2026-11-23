/**
 * A serverless webinar's end-to-end encryption key, and where it lives: only in the share link's
 * fragment (`/live/<id>#k=<key>`). Browsers never send a fragment to a server (not in the request,
 * not in a Referer, not across a redirect), so Meetly's server, the overlay's coordinator and their
 * logs never see it. The host's browser makes the key when it goes live and keeps it for as long
 * as the page is open; a viewer's browser reads it from its own address bar.
 *
 * The media is encrypted with it frame by frame (packages/overlay/media/sframe.ts): relays, which
 * are viewers' browsers, pass on ciphertext, and only a browser holding the key can play it.
 *
 * Beside it, the host's public signing key (`s=`): the host signs every frame, so a viewer who
 * relays, and so holds the AES key too, still cannot pass off frames of its own as the host's.
 */

/** The fragment's parameters: `#k=<the AES key>&s=<the host's public signing key>`. */
export const KEY_PARAM = "k";
export const SIGNER_PARAM = "s";
/**
 * The viewers' pass (`a=`, src/lib/live/server.ts): not part of the encryption, but it rides with
 * the key so that the id alone does not get a viewer's ticket. The server sees it, never the key.
 */
export const PASS_PARAM = "a";
const KEY_BYTES = 32;
/** An uncompressed P-256 point: 0x04, x, y. */
const PUBLIC_KEY_BYTES = 65;
const PASS_BYTES = 16;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [b0, b1, b2] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64[b2 & 63];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (const char of text) {
    const value = B64.indexOf(char);
    if (value < 0) return null;
    acc = ((acc << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** A new webinar's key: a random AES-GCM 256 key from WebCrypto, as its 32 raw bytes. */
export async function newWebinarKey(): Promise<Uint8Array> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/**
 * The keys as the link's fragment carries them, without the "#": `k=<43 base64url characters>`,
 * then `&s=<87>` with the host's public signing key, then `&a=<22>` with the viewers' pass.
 */
export function keyFragment(raw: Uint8Array, publicKey: Uint8Array, pass: string): string {
  if (raw.byteLength !== KEY_BYTES) throw new RangeError("a webinar key is 32 bytes");
  if (publicKey.byteLength !== PUBLIC_KEY_BYTES || publicKey[0] !== 4) throw new RangeError("a public key is an uncompressed P-256 point");
  if (!exactly(pass, PASS_BYTES)) throw new RangeError("a viewers' pass is 16 bytes of base64url");
  return `${KEY_PARAM}=${toBase64Url(raw)}&${SIGNER_PARAM}=${toBase64Url(publicKey)}&${PASS_PARAM}=${pass}`;
}

/**
 * What a viewer's link says of the key, from `location.hash`:
 * - "none": the link has no key (it was shared without its end, or typed by hand);
 * - "malformed": it has one, but not a whole one (cut short when it was copied, or edited), or
 *   without the host's public signing key or the viewers' pass beside it. Every link the host
 *   shares has all three, so one without the signing key is not played unsigned: a link cut
 *   down to `k=` alone would otherwise let any relay holding the key pass off its own frames;
 * - "ok": a key, which may still be the wrong one; only the video can tell (`wrong-key`).
 */
export type LinkKey = { t: "none" } | { t: "malformed" } | { t: "ok"; raw: Uint8Array; publicKey: Uint8Array; pass: string };

/** Exactly `length` bytes of canonical base64url, or null. */
function exactly(value: string, length: number): Uint8Array | null {
  const bytes = fromBase64Url(value);
  return bytes && bytes.byteLength === length && toBase64Url(bytes) === value ? bytes : null;
}

export function keyFromHash(hash: string): LinkKey {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment) return { t: "none" };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(fragment);
  } catch {
    return { t: "malformed" };
  }
  const value = params.get(KEY_PARAM);
  if (value === null) return { t: "none" };
  const raw = exactly(value.trim(), KEY_BYTES);
  const publicKey = exactly((params.get(SIGNER_PARAM) ?? "").trim(), PUBLIC_KEY_BYTES);
  const pass = (params.get(PASS_PARAM) ?? "").trim();
  if (!raw || !publicKey || publicKey[0] !== 4 || !exactly(pass, PASS_BYTES)) return { t: "malformed" };
  return { t: "ok", raw, publicKey, pass };
}

/** The link without its fragment: what may be shown or sent anywhere that is not the share itself. */
export const withoutKey = (url: string) => url.replace(/#.*$/, "");

/** Whether localStorage["meetly:debug"] is "1": the app's opt-in handle for tests and debugging. */
export function debugHandles(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("meetly:debug") === "1";
  } catch {
    return false;
  }
}

/**
 * With localStorage["meetly:debug"] = "1" (the app's opt-in test handle), the encryption's
 * counters (frames, time spent, frames dropped and why) on `window.__meetlyE2ee`. Never the key.
 */
export function exposeE2eeStats(stats: () => object): void {
  try {
    if (!debugHandles()) return;
    (window as unknown as { __meetlyE2ee?: { stats: () => object } }).__meetlyE2ee = { stats };
  } catch {
    // Storage blocked: no handle.
  }
}
