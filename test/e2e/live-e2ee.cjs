// Live (beta), end-to-end encryption, in real Chromium against a local Worker build:
//
//   npx opennextjs-cloudflare build
//   npx opennextjs-cloudflare preview --port 4311     (with OVERLAY_ADMISSION_SECRET,
//        OVERLAY_SERVER_SECRET and OVERLAY_LOCAL_ONE_NETWORK=1 in a local .dev.vars)
//   MEETLY_URL=http://localhost:4311 node test/e2e/live-e2ee.cjs
//
// A host goes live; viewers open its link. It checks that viewers with the key see the video
// advance, that a link without its key, with a broken key, or with another webinar's key says so
// instead of showing a black picture, that what crosses the data channels is ciphertext (taken
// off the wire at viewers and relays and tried in a real VP8 decoder, which refuses it; the same
// bytes decrypted with the key decode), that a frame changed on the way is dropped and counted,
// and that no request, WebSocket message or server log line ever holds the key.
//
// SERVER_LOG=<file>: the preview's output, searched for the key too. VIEWERS (default 6).
const { chromium } = require("playwright");
const fs = require("node:fs");

const BASE = process.env.MEETLY_URL || "http://localhost:4311";
const VIEWERS = Number(process.env.VIEWERS || 6);
const SHOTS = process.env.MEETLY_SHOTS || "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/**
 * Installed in every page before its scripts: a tap on every RTCDataChannel (what this browser
 * sends and receives, as the bytes are), keeping media packets (version 1, type 0). `tamper`
 * flips one payload byte in every 10th video packet this page receives, before the engine sees
 * it: a parent that alters frames. Only frames no other frame needs (DISCARDABLE) are altered, so
 * the picture plays on around the dropped ones; altering a frame others build on freezes the
 * picture until the next keyframe, as losing it would. A tampering page that relays passes its
 * altered copy on, as a hostile relay would: its children must drop those frames too.
 */
function tap({ tamper }) {
  const state = { forwardedTampered: 0, inPackets: 0, outPackets: 0, inSFrame: 0, inClear: 0, outSFrame: 0, outClear: 0, vp8StartCodes: 0, forwardedSame: 0, forwardedAltered: 0, tampered: 0, frames: new Map(), keyframes: [] };
  window.__tap = state;
  const seen = new Set();
  const altered = new Set();
  const id = (u8) => {
    // The end-to-end bytes (0–23) and the payload: what a relay must pass on unchanged.
    let h = 2166136261;
    for (let i = 0; i < u8.length; i++) if (i < 24 || i >= 30) h = Math.imul(h ^ u8[i], 16777619);
    return `${u8.length}:${h >>> 0}`;
  };
  const isMedia = (u8) => u8.length >= 30 && u8[0] === 0x10;
  const note = (u8, dir) => {
    const sframe = (u8[1] & 0x02) !== 0;
    const streamId = u8[2];
    const fragIndex = (u8[12] << 8) | u8[13];
    const fragCount = (u8[14] << 8) | u8[15];
    const frameId = ((u8[8] << 24) | (u8[9] << 16) | (u8[10] << 8) | u8[11]) >>> 0;
    if (dir === "in") {
      state.inPackets++;
      if (sframe) state.inSFrame++;
      else state.inClear++;
      seen.add(id(u8));
      // A VP8 keyframe's start code, where a clear payload would have it.
      if (streamId === 0 && fragIndex === 0 && u8[33] === 0x9d && u8[34] === 0x01 && u8[35] === 0x2a) state.vp8StartCodes++;
      // Whole video keyframes, put back together, as a relay holds them.
      if (streamId === 0 && (u8[1] & 0x01) && state.keyframes.length < 3) {
        const key = `${frameId}`;
        let frame = state.frames.get(key);
        if (!frame) state.frames.set(key, (frame = { parts: new Array(fragCount), have: 0, header: null }));
        if (!frame.parts[fragIndex]) {
          frame.parts[fragIndex] = Array.from(u8.subarray(30));
          frame.have++;
          if (fragIndex === 0) frame.header = Array.from(u8.subarray(0, 24));
        }
        if (frame.have === fragCount && frame.header) {
          state.keyframes.push({ header: frame.header, payload: frame.parts.flat() });
          state.frames.delete(key);
        }
      }
    } else {
      state.outPackets++;
      if (sframe) state.outSFrame++;
      else state.outClear++;
      const which = id(u8);
      if (altered.has(which)) state.forwardedTampered++;
      else if (seen.has(which)) state.forwardedSame++;
      else state.forwardedAltered++;
    }
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    try {
      if (typeof data !== "string") {
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (isMedia(u8)) note(u8, "out");
      }
    } catch {}
    return send.call(this, data);
  };
  const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "onmessage");
  let count = 0;
  Object.defineProperty(RTCDataChannel.prototype, "onmessage", {
    configurable: true,
    get() {
      return desc.get.call(this);
    },
    set(handler) {
      if (typeof handler !== "function") return desc.set.call(this, handler);
      desc.set.call(this, function (event) {
        if (event.data instanceof ArrayBuffer) {
          let u8 = new Uint8Array(event.data);
          if (isMedia(u8)) {
            note(u8, "in");
            if (tamper && u8[2] === 0 && (u8[1] & 0x04) && u8.length > 60 && ++count % 10 === 0) {
              u8 = u8.slice();
              u8[50] ^= 0xff;
              altered.add(id(u8));
              state.tampered++;
              return handler.call(this, new MessageEvent("message", { data: u8.buffer }));
            }
          }
        }
        return handler.call(this, event);
      });
    },
  });
}

/** Every request, WebSocket frame and URL a page uses, for the search for the key. */
function record(page, log) {
  page.on("request", (request) => {
    log.push(`${request.method()} ${request.url()}\n${JSON.stringify(request.headers())}\n${request.postData() ?? ""}`);
  });
  page.on("websocket", (ws) => {
    log.push(`WS ${ws.url()}`);
    ws.on("framesent", (frame) => log.push(`WS> ${typeof frame.payload === "string" ? frame.payload : frame.payload.toString("base64")}`));
    ws.on("framereceived", (frame) => log.push(`WS< ${typeof frame.payload === "string" ? frame.payload : frame.payload.toString("base64")}`));
  });
  page.on("console", (message) => log.push(`console ${message.text()}`));
}

async function person(browser, log, { tamper = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera", "microphone"] });
  await ctx.addInitScript(() => localStorage.setItem("meetly:debug", "1"));
  await ctx.addInitScript(tap, { tamper });
  const page = await ctx.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  record(page, log);
  return { ctx, page };
}

/** The picture advances: two samples of the <video> three seconds apart, with frames and pixels changed. */
async function advancing(page) {
  return page.evaluate(async () => {
    const video = document.querySelector('[data-testid="live-video"]');
    if (!video || !video.videoWidth) return { ok: false, why: "no picture" };
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const grab = () => {
      g.drawImage(video, 0, 0, 160, 90);
      return g.getImageData(0, 0, 160, 90).data;
    };
    const q0 = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const a = grab();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const b = grab();
    const q1 = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    let diff = 0;
    let lit = 0;
    for (let i = 0; i < a.length; i += 4) {
      diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      lit += b[i] + b[i + 1] + b[i + 2];
    }
    return { ok: q1 > q0 && diff > 0 && lit > 0, frames: q1 - q0, diff, meanLevel: Math.round(lit / (a.length / 4) / 3), width: video.videoWidth, height: video.videoHeight };
  });
}

/** A captured keyframe, tried in a VP8 decoder as it came off the wire, then decrypted with `keyB64` and tried again. */
async function tryKeyframe(page, keyB64, pubB64) {
  return page.evaluate(async ([keyB64, pubB64]) => {
    const frame = window.__tap.keyframes[0];
    if (!frame) return null;
    const payload = new Uint8Array(frame.payload);
    const decode = (data) =>
      new Promise((resolve) => {
        let done = false;
        const finish = (result) => {
          if (done) return;
          done = true;
          resolve(result);
          try {
            decoder.close();
          } catch {}
        };
        const decoder = new VideoDecoder({
          output: (f) => {
            const size = `${f.displayWidth}x${f.displayHeight}`;
            f.close();
            finish({ decoded: true, size });
          },
          error: (e) => finish({ decoded: false, error: String(e.message || e).slice(0, 120) }),
        });
        try {
          decoder.configure({ codec: "vp8" });
          decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data }));
          decoder.flush().then(
            () => finish({ decoded: false, error: "no output" }),
            (e) => finish({ decoded: false, error: String(e.message || e).slice(0, 120) }),
          );
        } catch (e) {
          finish({ decoded: false, error: String(e.message || e).slice(0, 120) });
        }
      });
    const asSent = await decode(payload);
    // Decrypt as the format says (independently of the app's code): IV = payload[5..17), AAD =
    // the clear header (fragment fields zeroed) and the 17-byte SFrame header.
    const unb64 = (text) => {
      const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
      return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    };
    const raw = unb64(keyB64);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const aad = new Uint8Array(24 + 17);
    aad.set(frame.header);
    aad.fill(0, 12, 16);
    aad.set(payload.subarray(0, 17), 24);
    let decrypted = null;
    try {
      decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.subarray(5, 17), additionalData: aad }, key, payload.subarray(17)));
    } catch (e) {
      return { bytes: payload.length, sframeByte: payload[0], asSent, decryptedWithKey: { decoded: false, error: `decrypt failed: ${e}` } };
    }
    // SIGNED: the last 64 bytes are the host's ECDSA P-256 signature over the AAD and the payload.
    let signatureHolds = null;
    if (payload[0] & 0x01) {
      const body = decrypted.subarray(0, decrypted.length - 64);
      const signed = new Uint8Array(aad.length + body.length);
      signed.set(aad);
      signed.set(body, aad.length);
      const pub = await crypto.subtle.importKey("raw", unb64(pubB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      signatureHolds = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, decrypted.subarray(decrypted.length - 64), signed);
      decrypted = body;
    }
    const startCode = decrypted[3] === 0x9d && decrypted[4] === 0x01 && decrypted[5] === 0x2a;
    return { bytes: payload.length, sframeByte: payload[0], asSent, plaintextStartCode: startCode, signatureHolds, decryptedWithKey: await decode(decrypted) };
  }, [keyB64, pubB64]);
}

/** WebCrypto AES-256-GCM in this Chromium, per frame, at the sizes a 720p VP8 stream and Opus make. */
async function bench(page) {
  return page.evaluate(async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const aad = new Uint8Array(41);
    const out = {};
    for (const [label, size, n] of [
      ["audio 80 B", 80, 2000],
      ["720p delta 5 KB", 5000, 2000],
      ["720p keyframe 40 KB", 40000, 500],
      ["720p busy keyframe 150 KB", 150000, 200],
    ]) {
      const data = crypto.getRandomValues(new Uint8Array(Math.min(size, 65536)));
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i += 65536) payload.set(data.subarray(0, Math.min(65536, size - i)), i);
      const enc = [];
      const dec = [];
      const began = performance.now();
      for (let i = 0; i < n; i++) {
        const iv = new Uint8Array(12);
        new DataView(iv.buffer).setUint32(8, i);
        let t = performance.now();
        const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, payload);
        enc.push(performance.now() - t);
        t = performance.now();
        await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, sealed);
        dec.push(performance.now() - t);
      }
      const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
      const r = (x) => Math.round(x * 1000) / 1000;
      // The whole per-frame pipeline, with and without the host's signature, interleaved so that
      // whatever else the machine is doing weighs on both alike.
      const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const ecdsa = { name: "ECDSA", hash: "SHA-256" };
      let plainMs = 0;
      let signedMs = 0;
      for (let i = 0; i < Math.min(n, 500); i++) {
        const iv = new Uint8Array(12);
        new DataView(iv.buffer).setUint32(8, i);
        let t = performance.now();
        await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, payload));
        plainMs += performance.now() - t;
        t = performance.now();
        const sig = await crypto.subtle.sign(ecdsa, signing.privateKey, payload);
        const both = new Uint8Array(size + 64);
        both.set(payload);
        both.set(new Uint8Array(sig), size);
        const opened = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, both)));
        await crypto.subtle.verify(ecdsa, signing.publicKey, opened.subarray(size), opened.subarray(0, size));
        signedMs += performance.now() - t;
      }
      const m = Math.min(n, 500);
      out[label] = { encryptAndDecryptMeanMs: r(plainMs / m), withSignAndVerifyMeanMs: r(signedMs / m), roundTripMeanMs: r((performance.now() - began) / n), encryptMsP50: r(q(enc, 0.5)), encryptMsP99: r(q(enc, 0.99)), decryptMsP50: r(q(dec, 0.5)), decryptMsP99: r(q(dec, 0.99)) };
    }
    return out;
  });
}

const e2eeStats = (page) => page.evaluate(() => window.__meetlyE2ee?.stats() ?? null);
const tapStats = (page) => page.evaluate(() => { const { keyframes, ...rest } = window.__tap; delete rest.frames; return { ...rest, keyframesCaptured: keyframes.length }; });

(async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const log = [];
  const people = [];
  let failed = false;
  try {
    // The host.
    const host = await person(browser, log);
    people.push(host);
    await host.page.goto(`${BASE}/live`);
    await host.page.getByTestId("host-preview").waitFor({ timeout: 30_000 });
    await host.page.getByTestId("webinar-title-input").fill("E2EE check");
    await host.page.getByTestId("go-live").click();
    const share = host.page.getByTestId("share-link");
    await share.waitFor({ timeout: 30_000 });
    const link = await share.getAttribute("data-link");
    const keyB64 = /#k=([A-Za-z0-9_-]{43})(&|$)/.exec(link)?.[1];
    const pubB64 = /&s=([A-Za-z0-9_-]{87})(&|$)/.exec(link)?.[1];
    const passB64 = /&a=([A-Za-z0-9_-]{22})$/.exec(link)?.[1];
    ok("the share link carries a 256-bit key, the host's public signing key and the viewers' pass in its fragment", !!keyB64 && !!pubB64 && !!passB64, link?.replace(/#k=.*/, "#k=<43 chars>&s=<87 chars>&a=<22 chars>"));
    if (!keyB64 || !pubB64) throw new Error("no key in the link");
    const shown = await share.innerText();
    ok("the link as shown on the host's page leaves the key out", !shown.includes(keyB64));
    const keyBytes = Buffer.from(keyB64, "base64url");
    // The public key is not a secret, but it has no business on a server either.
    const needles = [keyB64, keyBytes.toString("hex"), keyBytes.toString("base64"), encodeURIComponent(keyB64), pubB64];

    // Viewers with the key; the second one's parent "alters" some of its video packets.
    const viewers = [];
    for (let i = 0; i < VIEWERS; i++) {
      const viewer = await person(browser, log, { tamper: i === 1 });
      people.push(viewer);
      viewers.push(viewer);
      await viewer.page.goto(link);
      await viewer.page.getByTestId("watch").click({ timeout: 30_000 });
      await sleep(400);
    }
    // A link without its key, with a broken one, and with another webinar's.
    const bare = await person(browser, log);
    people.push(bare);
    await bare.page.goto(link.replace(/#.*$/, ""));
    const missing = await bare.page.getByTestId("live-key-problem").getAttribute("data-problem", { timeout: 20_000 }).catch(() => null);
    const bareText = missing ? await bare.page.getByTestId("live-key-problem").innerText() : "";
    ok("a link without its key says so, with no Watch button", missing === "missing" && /missing its key/.test(bareText) && (await bare.page.getByTestId("watch").count()) === 0, bareText.split("\n")[0]);

    const cut = await person(browser, log);
    people.push(cut);
    await cut.page.goto(link.slice(0, -5));
    const cutProblem = await cut.page.getByTestId("live-key-problem").getAttribute("data-problem", { timeout: 20_000 }).catch(() => null);
    ok("a link whose key was cut short says it can't decrypt", cutProblem === "wrong", cutProblem ? (await cut.page.getByTestId("live-key-problem").innerText()).split("\n")[0] : "no state");

    // The id alone (it is in the path, on the host's screen, in logs) gets no viewer's place: the
    // ticket needs the link's pass, and a link with another pass says it can't be used.
    const id = /\/live\/([a-z-]+)/.exec(link)[1];
    const byIdAlone = await fetch(`${BASE}/api/live/${id}/ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "viewer" }) });
    ok("a viewer's ticket for the id alone, without the link's pass, is refused", byIdAlone.status === 403, String(byIdAlone.status));
    const forged = await person(browser, log);
    people.push(forged);
    await forged.page.goto(link.replace(/&a=[^&]*/, `&a=${"A".repeat(22)}`));
    await forged.page.getByTestId("watch").click({ timeout: 30_000 });
    const forgedProblem = await forged.page.getByTestId("live-key-problem").getAttribute("data-problem", { timeout: 20_000 }).catch(() => null);
    ok("a link with the key but another pass is turned away, and says so", forgedProblem === "wrong" && (await forged.page.getByTestId("live-video").count()) === 0, forgedProblem ?? "no state");

    const stranger = await person(browser, log);
    people.push(stranger);
    const otherKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff)).toString("base64url");
    await stranger.page.goto(link.replace(/#k=[^&]*/, `#k=${otherKey}`));
    await stranger.page.getByTestId("watch").click({ timeout: 30_000 });
    const wrongState = await stranger.page.getByTestId("live-key-problem").getAttribute("data-problem", { timeout: 45_000 }).catch(() => null);
    const strangerStats = await e2eeStats(stranger.page);
    const strangerTap = await tapStats(stranger.page);
    ok(
      "a link with another webinar's key says it can't decrypt, and plays nothing",
      wrongState === "wrong" && strangerStats && strangerStats.ok === 0 && (await stranger.page.getByTestId("live-video").count()) === 0,
      `state ${wrongState}; frames under another key ${strangerStats?.["wrong-key"]}, opened ${strangerStats?.ok}; media packets received ${strangerTap.inPackets}`,
    );

    // The right key, but another webinar's public signing key: every frame decrypts, none is
    // the signer's. What a viewer holding the key gets from a relay that makes its own frames.
    const misled = await person(browser, log);
    people.push(misled);
    const otherPub = await host.page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    });
    await misled.page.goto(link.replace(/&s=[^&]*/, `&s=${otherPub}`));
    await misled.page.getByTestId("watch").click({ timeout: 30_000 });

    // Everyone with the key sees the picture advance.
    for (const [i, viewer] of viewers.entries()) {
      const got = await viewer.page
        .locator('[data-testid="viewer-live"]')
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!got) ok(`viewer ${i + 1} gets the picture`, false, "no picture in 60 s");
    }
    await sleep(8000);
    for (const [i, viewer] of viewers.entries()) {
      const motion = await advancing(viewer.page).catch((e) => ({ ok: false, why: String(e) }));
      const stats = await e2eeStats(viewer.page);
      ok(
        `viewer ${i + 1} with the key sees the video advance`,
        motion.ok && stats && stats.ok > 0,
        `${motion.width}x${motion.height}, ${motion.frames} frames in 3 s, pixel change ${motion.diff}, decrypted ${stats?.ok}, tampered ${stats?.tampered}, decrypt mean ${stats && stats.ok ? (stats.totalMs / stats.ok).toFixed(3) : "-"} ms, max ${stats?.maxMs?.toFixed(2)} ms`,
      );
    }

    {
      const state = await misled.page.getByTestId("live-key-problem").getAttribute("data-problem", { timeout: 45_000 }).catch(() => null);
      const stats = await e2eeStats(misled.page);
      const pictured = await misled.page.locator('[data-testid="viewer-live"]').count();
      ok(
        "frames not signed by the link's signing key are dropped, even though they decrypt, and the page says it can't play them",
        state === "wrong" && stats && stats.forged > 0 && stats.ok === 0 && pictured === 0,
        `state ${state}; rejected as not the host's ${stats?.forged}, played ${stats?.ok}`,
      );
    }

    // The tampered-with viewer dropped and counted what was changed, and played on.
    {
      const stats = await e2eeStats(viewers[1].page);
      const t = await tapStats(viewers[1].page);
      const dropped = await viewers[1].page.getByTestId("live-video").locator("xpath=..").getAttribute("data-e2ee-dropped");
      const motion = await advancing(viewers[1].page).catch(() => ({ ok: false }));
      ok("frames changed on the way are dropped and counted, not played", stats && stats.tampered > 0 && stats.tampered <= t.tampered && Number(dropped) > 0 && motion.ok, `packets altered ${t.tampered}, frames dropped as tampered ${stats?.tampered} (page counter ${dropped}), opened ${stats?.ok}, picture still advancing ${motion.ok}`);
    }

    // What crosses the data channels is ciphertext.
    let inPackets = 0;
    let inClear = 0;
    let startCodes = 0;
    let relays = 0;
    let forwardedSame = 0;
    let forwardedAltered = 0;
    let outClear = 0;
    let forwardedTampered = 0;
    let droppedDownstream = 0;
    for (const [i, viewer] of viewers.entries()) {
      const t = await tapStats(viewer.page);
      inPackets += t.inPackets;
      inClear += t.inClear;
      startCodes += t.vp8StartCodes;
      if (t.outPackets > 0) relays++;
      forwardedSame += t.forwardedSame;
      forwardedAltered += t.forwardedAltered;
      outClear += t.outClear;
      forwardedTampered += t.forwardedTampered;
      if (i !== 1) droppedDownstream += (await e2eeStats(viewer.page))?.tampered ?? 0;
    }
    const hostTap = await tapStats(host.page);
    ok("every media packet on the wire carries the SFRAME flag, from the host and at every viewer", inPackets > 1000 && inClear === 0 && hostTap.outPackets > 0 && hostTap.outClear === 0, `${inPackets} received by viewers, ${inClear} in the clear; host sent ${hostTap.outPackets}, ${hostTap.outClear} in the clear; VP8 start codes seen ${startCodes}`);
    ok(
      "relays pass the ciphertext on untouched",
      relays > 0 ? forwardedAltered === 0 && forwardedSame > 0 && outClear === 0 : true,
      relays > 0 ? `${relays} viewer(s) relayed: ${forwardedSame} packets forwarded byte for byte, ${forwardedAltered} changed (besides the test's own alterations)` : "no viewer relayed in this run (the host fed everyone)",
    );
    if (forwardedTampered > 0) {
      ok("a relay's altered frames are dropped by its children too", droppedDownstream > 0, `the tampering viewer relayed ${forwardedTampered} altered packets; other viewers dropped ${droppedDownstream} frames as tampered`);
    } else {
      // Not a pass: said, so a run where it was not exercised does not read as one where it held.
      console.log("SKIP  a relay's altered frames are dropped by its children too  — the tampering viewer relayed nothing in this run");
    }
    const captured = viewers.find((v) => v !== viewers[1]);
    const proof = await tryKeyframe(captured.page, keyB64, pubB64);
    ok(
      "a keyframe as a relay holds it does not decode; decrypted with the link's key it does, and carries the host's valid signature",
      proof && proof.sframeByte === 0x11 && !proof.asSent.decoded && proof.plaintextStartCode && proof.decryptedWithKey.decoded && proof.signatureHolds === true,
      proof
        ? `${proof.bytes} bytes; as sent: ${proof.asSent.decoded ? "DECODED" : `refused (${proof.asSent.error})`}; with the key: ${proof.decryptedWithKey.decoded ? `decoded ${proof.decryptedWithKey.size}` : proof.decryptedWithKey.error}; signature ${proof.signatureHolds}`
        : "no keyframe captured",
    );

    // The cost, as it ran, and WebCrypto's alone.
    const hostStats = await e2eeStats(host.page);
    ok("the host encrypted every frame it sent", hostStats && hostStats.frames > 100, hostStats ? `${hostStats.frames} frames, mean ${(hostStats.totalMs / hostStats.frames).toFixed(3)} ms, max ${hostStats.maxMs.toFixed(2)} ms per frame (in situ, including queueing behind the encoder's thread)` : "");
    console.log("WebCrypto AES-256-GCM per frame in this Chromium:", JSON.stringify(await bench(host.page), null, 1));

    // The key never left a browser.
    await sleep(500);
    const serverLog = process.env.SERVER_LOG && fs.existsSync(process.env.SERVER_LOG) ? fs.readFileSync(process.env.SERVER_LOG, "utf8") : null;
    const leaks = log.filter((line) => needles.some((needle) => line.includes(needle)) && !line.startsWith("console "));
    const requests = log.filter((line) => /^(GET|POST|PUT|HEAD|OPTIONS) /.test(line)).length;
    const wsFrames = log.filter((line) => line.startsWith("WS>") || line.startsWith("WS<")).length;
    const sockets = log.filter((line) => line.startsWith("WS ")).length;
    ok("no request, header, body or WebSocket message holds the key", leaks.length === 0 && requests > 20 && wsFrames > 20, `${requests} requests, ${sockets} WebSockets to /api/live, ${wsFrames} WebSocket messages searched${leaks.length ? `; LEAK: ${leaks[0].slice(0, 200)}` : ""}`);
    if (serverLog !== null) ok("the server's own log never holds the key", !needles.some((needle) => serverLog.includes(needle)), `${serverLog.split("\n").length} lines searched`);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await viewers[0].page.screenshot({ path: `${SHOTS}/viewer.png` });
      await bare.page.screenshot({ path: `${SHOTS}/missing-key.png` });
      await stranger.page.screenshot({ path: `${SHOTS}/wrong-key.png` });
      await misled.page.screenshot({ path: `${SHOTS}/forged.png` });
      await host.page.screenshot({ path: `${SHOTS}/host.png` });
    }
  } catch (error) {
    failed = true;
    console.log("ERROR", error);
  } finally {
    for (const p of people) await p.ctx.close().catch(() => {});
    await browser.close();
  }
  const bad = results.filter((r) => !r.pass);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length || failed ? 1 : 0);
})();
