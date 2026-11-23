import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MediaFlag, PacketType, createSFrameDecryptor, createSFrameEncryptor, generateSFrameSigner, importSFrameKey } from "@meetly/overlay";
import { KEY_PARAM, PASS_PARAM, keyFragment, keyFromHash, newWebinarKey, withoutKey } from "../src/lib/live/e2ee";
import { viewerLink } from "../src/lib/live/webinar";

/** A serverless webinar's end-to-end key: made in the host's browser, carried only in the link's fragment. */

const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
/** A viewers' pass as the server makes them (src/lib/live/server.ts): 16 bytes, base64url. */
const PASS = Buffer.alloc(16, 9).toString("base64url");
/** Everything a host's link carries in its fragment. */
async function linkKeys() {
  const key = await newWebinarKey();
  const { publicKey } = await generateSFrameSigner();
  return { key, publicKey, pass: PASS };
}

test("each webinar gets its own random 256-bit key", async () => {
  const a = await newWebinarKey();
  const b = await newWebinarKey();
  assert.equal(a.byteLength, 32);
  assert.notDeepEqual(a, b);
  const { publicKey } = await generateSFrameSigner();
  assert.throws(() => keyFragment(new Uint8Array(16), publicKey, PASS), RangeError);
});

test("the key rides in the link's fragment, after the signed title, and comes back out whole", async () => {
  const keys = await linkKeys();
  const { key } = keys;
  const link = viewerLink("https://meet.example", "abc-defg-hij", { title: "Q&A #3", sig: "c2ln" }, keys);
  const url = new URL(link);
  assert.equal(url.pathname, "/live/abc-defg-hij");
  assert.equal(url.searchParams.get("title"), "Q&A #3");
  assert.ok(url.hash.startsWith(`#${KEY_PARAM}=${toBase64Url(key)}&`));
  assert.ok(url.hash.endsWith(`&${PASS_PARAM}=${PASS}`));
  // What leaves the browser (path and query) does not hold it.
  assert.ok(!`${url.pathname}${url.search}`.includes(toBase64Url(key)));
  assert.equal(withoutKey(link), "https://meet.example/live/abc-defg-hij?title=Q%26A%20%233&ts=c2ln");
  const read = keyFromHash(url.hash);
  assert.equal(read.t, "ok");
  assert.deepEqual(read.t === "ok" ? read.raw : null, key);
  assert.equal(read.t === "ok" ? read.pass : null, PASS);
  // Without a title, and without keys (an old caller), the link is as it was.
  assert.equal(viewerLink("https://meet.example", "abc-defg-hij", null), "https://meet.example/live/abc-defg-hij");
  assert.match(viewerLink("https://meet.example", "abc-defg-hij", null, keys), /^https:\/\/meet\.example\/live\/abc-defg-hij#k=[A-Za-z0-9_-]{43}&s=[A-Za-z0-9_-]{87}&a=[A-Za-z0-9_-]{22}$/);
});

test("a link without its key, or with a broken one, says which", async () => {
  const { key, publicKey, pass } = await linkKeys();
  const good = keyFragment(key, publicKey, pass);
  assert.deepEqual(keyFromHash(""), { t: "none" });
  assert.deepEqual(keyFromHash("#"), { t: "none" });
  assert.deepEqual(keyFromHash("#other=1"), { t: "none" });
  assert.equal(keyFromHash(`#${good}`).t, "ok");
  assert.equal(keyFromHash(good).t, "ok");
  assert.equal(keyFromHash(`#x=1&${good}`).t, "ok");
  const s = `s=${toBase64Url(publicKey)}`;
  const a = `a=${pass}`;
  for (const broken of [`#${good.slice(0, -1)}`, `#${good.slice(0, 20)}`, `#${good}A`, `#${good}.`, "#k=", `#k=${"!".repeat(43)}`, `#${good.slice(0, -1)}%`, `#k=${"!".repeat(43)}&${s}&${a}`, `#k=${toBase64Url(key).slice(0, -1)}&${s}&${a}`]) {
    assert.deepEqual(keyFromHash(broken), { t: "malformed" }, broken);
  }
});

test("the host's public signing key and the viewers' pass ride beside the key; without either, or broken, the link is broken", async () => {
  const keys = await linkKeys();
  const { key, publicKey } = keys;
  const link = new URL(viewerLink("https://meet.example", "abc-defg-hij", null, keys));
  assert.match(link.hash, /^#k=[A-Za-z0-9_-]{43}&s=[A-Za-z0-9_-]{87}&a=[A-Za-z0-9_-]{22}$/);
  const read = keyFromHash(link.hash);
  assert.equal(read.t, "ok");
  assert.deepEqual(read.t === "ok" ? read.publicKey : null, publicKey);
  const k = `k=${toBase64Url(key)}`;
  const s = `s=${toBase64Url(publicKey)}`;
  const a = `a=${PASS}`;
  // A link cut down to its key alone is not played unsigned: it is broken.
  for (const broken of [`#${k}`, `#${k}&${s}`, `#${k}&${a}`, `#${k}&s=&${a}`, `#${k}&${s}&a=`, `#${k}&${s.slice(0, -1)}&${a}`, `#${k}&${s}&${a.slice(0, -1)}`, `#${k}&${s}&${a}x`, link.hash.replace("&s=B", "&s=C")]) {
    if (broken === link.hash) continue;
    assert.deepEqual(keyFromHash(broken), { t: "malformed" }, broken);
  }
  // In any order, with other parameters beside them, it still reads.
  assert.equal(keyFromHash(`#x=1&${a}&${s}&${k}`).t, "ok");
  assert.throws(() => keyFragment(key, new Uint8Array(65), PASS), RangeError);
  assert.throws(() => keyFragment(key, publicKey, "short"), RangeError);
});

test("the key in a link opens the host's frames, and a cut-down link's does not", async () => {
  const keys = await linkKeys();
  const { key } = keys;
  const link = new URL(viewerLink("https://meet.example", "abc-defg-hij", null, keys));
  const host = createSFrameEncryptor(await importSFrameKey(key));
  const sealed = await host.encrypt({
    header: { type: PacketType.Media, flags: MediaFlag.Key, streamId: 0, stripe: 0, spatial: 0, temporal: 0, refDelta: 0, keyDelta: 0, frameId: 0, captureUs: 0, configId: 0 },
    data: new Uint8Array([1, 2, 3, 4]),
  });
  const read = keyFromHash(link.hash);
  assert.equal(read.t, "ok");
  if (read.t !== "ok") return;
  const opened = await createSFrameDecryptor(await importSFrameKey(read.raw)).decrypt(sealed);
  assert.deepEqual(opened.frame?.data, new Uint8Array([1, 2, 3, 4]));
  const other = await createSFrameDecryptor(await importSFrameKey(await newWebinarKey())).decrypt(sealed);
  assert.equal(other.outcome, "wrong-key");
});

// This checks Node's fetch (undici) as a stand-in for a browser: that a URL's fragment is not part
// of the request, even across a redirect. Whether the app itself ever sends the key anywhere is
// checked in real Chromium by test/e2e/live-e2ee.cjs.
test("the fragment never goes out with a request: not to the page, not on a redirect", async () => {
  const keys = await linkKeys();
  const secret = toBase64Url(keys.key);
  const seen: string[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    seen.push([request.method, request.url, ...request.rawHeaders].join("\n"));
    if (request.url?.startsWith("/r/")) {
      // A redirect to the viewer's page, as a trailing-slash or locale redirect would be.
      response.writeHead(307, { location: request.url.slice(2) });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const link = viewerLink(origin, "abc-defg-hij", { title: "Launch", sig: "c2ln" }, keys);
    assert.ok(link.includes(secret));
    assert.equal((await fetch(link)).status, 200);
    assert.equal((await fetch(link.replace("/live/", "/r/live/"))).status, 200);
    assert.ok(seen.length >= 3, "the page, the redirect and the page again");
    for (const request of seen) {
      assert.ok(!request.includes(secret), request);
      assert.ok(!request.includes(`${KEY_PARAM}=`), request);
    }
  } finally {
    server.close();
  }
});
