import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MediaFlag, PacketType, createSFrameDecryptor, createSFrameEncryptor, generateSFrameSigner, importSFrameKey } from "@meetly/overlay";
import { KEY_PARAM, keyFragment, keyFromHash, newWebinarKey, withoutKey } from "../src/lib/live/e2ee";
import { viewerLink } from "../src/lib/live/webinar";

/** A serverless webinar's end-to-end key: made in the host's browser, carried only in the link's fragment. */

const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

test("each webinar gets its own random 256-bit key", async () => {
  const a = await newWebinarKey();
  const b = await newWebinarKey();
  assert.equal(a.byteLength, 32);
  assert.notDeepEqual(a, b);
  assert.throws(() => keyFragment(new Uint8Array(16)), RangeError);
});

test("the key rides in the link's fragment, after the signed title, and comes back out whole", async () => {
  const key = await newWebinarKey();
  const link = viewerLink("https://meet.example", "abc-defg-hij", { title: "Q&A #3", sig: "c2ln" }, key);
  const url = new URL(link);
  assert.equal(url.pathname, "/live/abc-defg-hij");
  assert.equal(url.searchParams.get("title"), "Q&A #3");
  assert.equal(url.hash, `#${KEY_PARAM}=${toBase64Url(key)}`);
  // What leaves the browser (path and query) does not hold it.
  assert.ok(!`${url.pathname}${url.search}`.includes(toBase64Url(key)));
  assert.equal(withoutKey(link), "https://meet.example/live/abc-defg-hij?title=Q%26A%20%233&ts=c2ln");
  const read = keyFromHash(url.hash);
  assert.equal(read.t, "ok");
  assert.deepEqual(read.t === "ok" ? read.raw : null, key);
  // Without a title, and without a key (an old caller), the link is as it was.
  assert.equal(viewerLink("https://meet.example", "abc-defg-hij", null), "https://meet.example/live/abc-defg-hij");
  assert.match(viewerLink("https://meet.example", "abc-defg-hij", null, key), /^https:\/\/meet\.example\/live\/abc-defg-hij#k=[A-Za-z0-9_-]{43}$/);
});

test("a link without its key, or with a broken one, says which", async () => {
  const good = keyFragment(await newWebinarKey());
  assert.deepEqual(keyFromHash(""), { t: "none" });
  assert.deepEqual(keyFromHash("#"), { t: "none" });
  assert.deepEqual(keyFromHash("#other=1"), { t: "none" });
  assert.equal(keyFromHash(`#${good}`).t, "ok");
  assert.equal(keyFromHash(good).t, "ok");
  assert.equal(keyFromHash(`#x=1&${good}`).t, "ok");
  for (const broken of [`#${good.slice(0, -1)}`, `#${good.slice(0, 20)}`, `#${good}A`, `#${good}.`, "#k=", `#k=${"!".repeat(43)}`, `#${good.slice(0, -1)}%`]) {
    assert.deepEqual(keyFromHash(broken), { t: "malformed" }, broken);
  }
});

test("the host's public signing key rides beside the key, and a broken one breaks the link", async () => {
  const key = await newWebinarKey();
  const { publicKey } = await generateSFrameSigner();
  const link = new URL(viewerLink("https://meet.example", "abc-defg-hij", null, key, publicKey));
  assert.match(link.hash, /^#k=[A-Za-z0-9_-]{43}&s=[A-Za-z0-9_-]{87}$/);
  const read = keyFromHash(link.hash);
  assert.equal(read.t, "ok");
  assert.deepEqual(read.t === "ok" ? read.publicKey : null, publicKey);
  assert.equal(keyFromHash(`#${keyFragment(key)}`).t === "ok" && (keyFromHash(`#${keyFragment(key)}`) as { publicKey: unknown }).publicKey, null);
  for (const broken of [link.hash.slice(0, -1), link.hash.slice(0, -30), `${link.hash}x`, link.hash.replace("&s=B", "&s=C"), `#${keyFragment(key)}&s=`]) {
    if (broken === link.hash) continue;
    assert.deepEqual(keyFromHash(broken), { t: "malformed" }, broken);
  }
  assert.throws(() => keyFragment(key, new Uint8Array(65)), RangeError);
});

test("the key in a link opens the host's frames, and a cut-down link's does not", async () => {
  const key = await newWebinarKey();
  const link = new URL(viewerLink("https://meet.example", "abc-defg-hij", null, key));
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

test("the fragment never goes out with a request: not to the page, not on a redirect", async () => {
  const key = await newWebinarKey();
  const secret = toBase64Url(key);
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
    const link = viewerLink(origin, "abc-defg-hij", { title: "Launch", sig: "c2ln" }, key);
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
