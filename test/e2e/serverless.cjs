// Serverless webinars (Live, beta) in real browsers, against the Worker (`npm run preview`, which
// runs custom-worker.ts and the overlay's coordinator in workerd): not part of run.cjs, whose
// suites run on `next start` with LiveKit, where Live answers 503.
//
//   npx opennextjs-cloudflare build && npx opennextjs-cloudflare preview --port 4310
//   MEETLY_URL=http://127.0.0.1:4310 node test/e2e/serverless.cjs [section…]
//
// with OVERLAY_ADMISSION_SECRET and OVERLAY_SERVER_SECRET (16+ characters each, any value) in a
// local .dev.vars, and OVERLAY_LOCAL_ONE_NETWORK=1 on a machine with no route out for STUN.
// Sections: happy scale viewer host home a11y (all by default). LIVE_VIEWERS sets the audience of
// `scale` (default 12). Every viewer's picture is checked to move: frames counted by the <video>
// and its pixels changing, not just a <video> being there.
const H = require("./lib.cjs");

const { BASE, ok, sleep, until } = H;
const WIDE = { width: 1280, height: 900 };
const PHONE = { width: 375, height: 812 };
const LIVE_LINK = /\/live\/([a-z]{3}-[a-z]{4}-[a-z]{3})(\?|#|$)/;
/**
 * The link's end-to-end key (`#k=…`, src/lib/live/e2ee.ts) is made by the host's page when it goes
 * live. A viewer who has the link before that (the early viewer below) is given this one, and the
 * host's page is made to use it (`useKey`): the browser's AES-GCM key generation returns it.
 */
const EARLY_KEY = Buffer.alloc(32, 7).toString("base64url");
/** The same for the host's signing key pair (`&s=…`): made here, and given to the host's page. */
const EARLY_SIGNER = require("node:crypto").generateKeyPairSync("ec", { namedCurve: "P-256" });
const EARLY_PRIVATE = EARLY_SIGNER.privateKey.export({ format: "jwk" });
const EARLY_PUBLIC = EARLY_SIGNER.publicKey.export({ format: "jwk" });
const EARLY_PUB = Buffer.concat([Buffer.from([4]), Buffer.from(EARLY_PUBLIC.x, "base64url"), Buffer.from(EARLY_PUBLIC.y, "base64url")]).toString("base64url");
/** The early link's fragment, given the webinar's viewers' pass (from POST /api/live). */
const earlyFragment = (pass) => `#k=${EARLY_KEY}&s=${EARLY_PUB}&a=${pass}`;
const useKey = `(() => {
  const raw = Uint8Array.from(atob(${JSON.stringify(Buffer.alloc(32, 7).toString("base64"))}), (c) => c.charCodeAt(0));
  const priv = ${JSON.stringify(EARLY_PRIVATE)};
  const pub = ${JSON.stringify(EARLY_PUBLIC)};
  const generate = crypto.subtle.generateKey.bind(crypto.subtle);
  crypto.subtle.generateKey = async (algorithm, extractable, usages) => {
    if (algorithm && algorithm.name === "AES-GCM") return crypto.subtle.importKey("raw", raw, "AES-GCM", true, usages);
    if (algorithm && algorithm.name === "ECDSA") {
      const curve = { name: "ECDSA", namedCurve: "P-256" };
      return { privateKey: await crypto.subtle.importKey("jwk", priv, curve, true, ["sign"]), publicKey: await crypto.subtle.importKey("jwk", pub, curve, true, ["verify"]) };
    }
    return generate(algorithm, extractable, usages);
  };
})();`;

/** Console errors and page errors, per page, so each section can say none were raised. */
const consoleErrors = new Map();

/**
 * `debug` (on by default): localStorage["meetly:debug"], with which the host's page puts the full
 * share link on its button (`data-link`) for these tests to read; without it only the copy has it.
 */
async function person(browser, { viewport = WIDE, permissions = ["camera", "microphone"], init, debug = true } = {}) {
  const ctx = await browser.newContext({ viewport, permissions });
  if (debug)
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("meetly:debug", "1");
      } catch {
        // about:blank has no storage.
      }
    });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  consoleErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return { ctx, page, errors };
}

const tree = async (id) => (await fetch(`${BASE}/api/live/${id}/tree`, { cache: "no-store" })).json();
const maxDepth = (t) => Math.max(0, ...t.nodes.map((node) => node.depth ?? 0));
const placed = (t) => t.nodes.filter((node) => !node.source && node.parent !== null).length;

/** Whether the viewer's picture moves: frames rendered and pixels changing over `ms`. */
function pictureMoves(page, ms = 1500) {
  return page.evaluate(async (wait) => {
    const video = document.querySelector('[data-testid="live-video"]');
    if (!video || !video.videoWidth || !video.srcObject) return { moves: false, why: "no picture" };
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 36;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const hash = () => {
      g.drawImage(video, 0, 0, 64, 36);
      const data = g.getImageData(0, 0, 64, 36).data;
      let h = 0;
      for (let i = 0; i < data.length; i += 4) h = (Math.imul(h, 31) + data[i] + data[i + 1] * 3 + data[i + 2] * 7) >>> 0;
      return h;
    };
    const f0 = video.getVideoPlaybackQuality().totalVideoFrames;
    const h0 = hash();
    await new Promise((resolve) => setTimeout(resolve, wait));
    const frames = video.getVideoPlaybackQuality().totalVideoFrames - f0;
    const changed = hash() !== h0;
    return { moves: frames > 0 && changed, frames, changed, size: `${video.videoWidth}x${video.videoHeight}` };
  }, ms);
}

/** Waits until the viewer's picture moves; returns how long that took, or null. */
async function untilMoving(page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const probe = await pictureMoves(page, 700).catch(() => ({ moves: false }));
    if (probe.moves) return Date.now() - start;
    await sleep(150);
  }
  return null;
}

/** The host: /live, with the camera on, a title, and "Go live". Returns the link and the stream id. */
async function goLive(host, title = "") {
  const { page } = host;
  if (!/\/live$/.test(page.url())) await page.goto(`${BASE}/live`);
  await page.locator('[data-testid="go-live"]:not([disabled])').waitFor({ timeout: 30000 });
  if (title) await page.fill('[data-testid="webinar-title-input"]', title);
  await page.click('[data-testid="go-live"]');
  await page.locator('[data-testid="share-link"]').waitFor({ timeout: 30000 });
  const link = await page.locator('[data-testid="share-link"]').getAttribute("data-link");
  return { link, id: LIVE_LINK.exec(link)[1], path: link.replace(/^https?:\/\/[^/]+/, "") };
}

/** A viewer: the link, the notice, "Watch". */
async function watch(viewer, path) {
  const { page } = viewer;
  await page.goto(`${BASE}${path}`);
  await page.locator('[data-testid="live-notice"]').waitFor({ timeout: 30000 });
  await page.locator('[data-testid="watch"]:not([disabled])').waitFor({ timeout: 30000 });
  await page.click('[data-testid="watch"]');
}

async function endWebinar(host) {
  await host.page.click('[data-testid="end-live"]');
  await host.page.getByRole("dialog", { name: "End this webinar?" }).waitFor();
  await host.page.click('[data-testid="end-live-confirm"]');
  await host.page.locator('[data-testid="host-ended"]').waitFor({ timeout: 15000 });
}

const watchingOf = async (page, testId) => {
  const text = await page
    .locator(`[data-testid="${testId}"]`)
    .innerText()
    .catch(() => "");
  const match = /(\d+) watching/.exec(text);
  return match ? Number(match[1]) : null;
};

function noErrors(label, people, expected = null) {
  const errors = people.flatMap((p) => consoleErrors.get(p.page) || []).filter((error) => !(expected && expected.test(error)));
  ok(`${label}: no console errors`, errors.length === 0, errors.slice(0, 4).join(" | "));
}

/* ------------------------------------------------------------------ 1. the happy path */

async function happy(browser) {
  const host = await person(browser, { permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"] });
  const { page } = host;
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "More ways to start a meeting" }).click();
  await page.getByRole("menuitem", { name: "New webinar…" }).click();
  await page.getByRole("dialog", { name: "Start a webinar" }).waitFor();
  await page.locator('[data-webinar-type="serverless"]').click();
  await page.waitForURL(/\/live$/);
  ok("home → New webinar… → Serverless opens /live", true);
  const previewMoves = await until(
    () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="host-preview"]');
      return !!v && v.videoWidth > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 3;
    }),
    20000,
  );
  ok("host preview shows the camera", previewMoves);
  const { link, id, path } = await goLive(host, "QA happy path");
  ok("share link carries the signed title, and the end-to-end key in its fragment", /\?title=QA%20happy%20path&ts=[\w-]{20,}#k=[\w-]{43}&s=[\w-]{87}&a=[\w-]{22}$/.test(link), link);
  ok("host page is titled after the webinar", (await page.locator('[data-testid="webinar-title"]').innerText()) === "QA happy path");
  await page.click('[data-testid="share-link"]');
  await page.getByText("Copied").waitFor({ timeout: 5000 });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  ok("Copy link puts the link on the clipboard", copied === link, copied);

  const viewers = [];
  for (let i = 0; i < 3; i++) viewers.push(await person(browser, { viewport: i === 2 ? PHONE : WIDE }));
  for (const viewer of viewers) {
    await viewer.page.goto(copied.replace(/^https?:\/\/[^/]+/, BASE));
    await viewer.page.locator('[data-testid="live-notice"]').waitFor();
    await viewer.page.getByText("Live now").waitFor({ timeout: 10000 });
  }
  ok("viewers see “Before you watch” and “Live now”", (await viewers[0].page.getByRole("heading", { name: "Before you watch" }).count()) === 1);
  ok("viewer sees the title from the link", (await viewers[0].page.locator('[data-testid="webinar-title"]').innerText()) === "QA happy path");
  for (const viewer of viewers) await viewer.page.click('[data-testid="watch"]');
  const times = await Promise.all(viewers.map((viewer) => untilMoving(viewer.page, 30000)));
  ok("every viewer's picture moves", times.every((t) => t !== null), `time to moving picture (ms): ${times.join(", ")}`);
  const rates = (await Promise.all(viewers.map((viewer) => pictureMoves(viewer.page, 3000)))).map((m) => Math.round(m.frames / 3));
  // The fake camera gives 20 fps; on a loaded 4-core machine viewers measured 5–14. Below 4 is a slideshow.
  ok("every viewer's picture runs at 4 fps or more", rates.every((fps) => fps >= 4), `fps: ${rates.join(", ")}`);
  const counted = await until(async () => (await watchingOf(page, "host-viewers")) === 3, 15000);
  ok("host counts 3 watching", counted, `host chip: ${await watchingOf(page, "host-viewers")}`);
  // Each page asks for the tree every 2 s.
  let viewerCounts = [];
  await until(async () => (viewerCounts = await Promise.all(viewers.map((viewer) => watchingOf(viewer.page, "viewer-live")))).every((n) => n === 3), 6000, 500);
  ok("viewers count 3 watching", viewerCounts.every((n) => n === 3), viewerCounts.join(","));
  const t = await tree(id);
  ok("tree: 3 viewers, all placed", t.viewers === 3 && placed(t) === 3, JSON.stringify(t.nodes.map((n) => [n.label, n.depth, n.children])));

  await endWebinar(host);
  const summary = await page.locator('[data-testid="host-ended"]').innerText();
  ok("host ended summary says how long and how many", /Live for .+, at most 3 viewers at once/.test(summary), summary.replace(/\s+/g, " "));
  const ended = await Promise.all(viewers.map((viewer) => viewer.page.locator('[data-testid="live-over"]').waitFor({ timeout: 15000 }).then(() => true, () => false)));
  ok("every viewer sees “This webinar has ended”", ended.every(Boolean), ended.join(","));
  ok("ended text", (await viewers[0].page.locator('[data-testid="live-over"]').innerText()) === "This webinar has ended");
  const camStopped = await page.evaluate(() => !document.querySelector('[data-testid="host-preview"]'));
  ok("host camera preview gone after ending", camStopped);
  const after = await tree(id);
  ok("tree says ended", after.ended === true, JSON.stringify(after));
  // Reopening the link after the end.
  const late = await person(browser);
  await late.page.goto(`${BASE}${path}`);
  ok("opening the link after the end says it ended", await late.page.locator('[data-testid="live-over"]').waitFor({ timeout: 15000 }).then(() => true, () => false));
  noErrors("happy path", [host, ...viewers, late]);
  for (const p of [host, ...viewers, late]) await p.ctx.close();
}

/* ------------------------------------------------------------------ 2–3. scale, relays, failure */

/** Which viewer page is which node: each viewer's own "Who's connected" rings its node ("You"). */
async function ownNode(viewer) {
  const { page } = viewer;
  const toggle = page.getByRole("button", { name: /Who’s connected/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const own = page.locator('[data-testid="tree-node"][data-own="true"]');
  if (!(await own.waitFor({ timeout: 8000 }).then(() => true, () => false))) return null;
  return { label: await own.getAttribute("data-label"), children: Number(await own.getAttribute("data-children")), depth: await own.getAttribute("data-depth") };
}

async function scale(browser) {
  const N = Number(process.env.LIVE_VIEWERS || 12);
  const host = await person(browser);
  const { id, path } = await goLive(host, "QA scale");
  const viewers = [];
  for (let i = 0; i < N; i++) {
    const viewer = await person(browser, { viewport: { width: 960, height: 700 } });
    viewers.push(viewer);
    await watch(viewer, path);
    await sleep(400);
  }
  const times = await Promise.all(viewers.map((viewer) => untilMoving(viewer.page, 60000)));
  ok(`scale: all ${N} viewers' pictures move`, times.every((t) => t !== null), `ms: ${times.join(",")}`);
  // Let the tree settle: everyone placed, and depth ≥ 2 if the coordinator makes relays.
  let t = null;
  const settled = await until(async () => {
    t = await tree(id);
    return t.viewers === N && placed(t) === N && maxDepth(t) >= 2;
  }, 90000, 1000);
  ok(`scale: tree has ${N} viewers placed, depth ≥ 2`, settled, t && `viewers ${t.viewers}, placed ${placed(t)}, max depth ${maxDepth(t)}; relays ${t.nodes.filter((n) => !n.source && n.children > 0).map((n) => `${n.label}→${n.children}`).join(" ")}`);
  const hostCount = await until(async () => (await watchingOf(host.page, "host-viewers")) === N, 15000);
  ok(`scale: host chip says ${N} watching`, hostCount, String(await watchingOf(host.page, "host-viewers")));
  await sleep(2500);
  const counts = await Promise.all(viewers.map((viewer) => watchingOf(viewer.page, "viewer-live")));
  ok(`scale: every viewer says ${N} watching`, counts.every((n) => n === N), counts.join(","));
  const moving = await Promise.all(viewers.map((viewer) => pictureMoves(viewer.page)));
  ok("scale: every picture still moves once settled", moving.every((m) => m.moves), moving.map((m) => `${m.frames}f`).join(","));

  /* relay failure: close a viewer that passes the video on */
  const owns = [];
  for (const viewer of viewers) owns.push(await ownNode(viewer));
  t = await tree(id);
  const byLabel = new Map(t.nodes.map((node) => [node.label, node]));
  const relayIndex = owns.findIndex((own) => own && (byLabel.get(own.label)?.children ?? 0) > 0);
  ok("scale: a viewer relays to others", relayIndex >= 0, owns.map((o) => o && `${o.label}:${o.children}`).join(" "));
  if (relayIndex >= 0) {
    const relay = viewers[relayIndex];
    const relayNode = byLabel.get(owns[relayIndex].label);
    const childLabels = t.nodes.filter((node) => node.parent === relayNode.key).map((node) => node.label);
    const children = viewers.filter((_, i) => owns[i] && childLabels.includes(owns[i].label));
    // The labels are renumbered once a viewer leaves; the pages are what is followed from here.
    const closedAt = Date.now();
    await relay.ctx.close();
    viewers.splice(relayIndex, 1);
    // How long each child's picture is frozen: sampled every 250 ms until it moves again.
    const recover = await Promise.all(
      children.map(async (child) => {
        await sleep(300);
        const back = await untilMoving(child.page, 30000);
        return back === null ? null : Date.now() - closedAt;
      }),
    );
    ok(`relay failure: its ${children.length} children recover the picture`, children.length > 0 && recover.every((r) => r !== null), `recovered after (ms): ${recover.join(",")}`);
    const hostAfter = await until(async () => (await watchingOf(host.page, "host-viewers")) === N - 1, 30000, 500);
    ok(`relay failure: host count drops to ${N - 1}`, hostAfter, `after ${Date.now() - closedAt} ms; chip ${await watchingOf(host.page, "host-viewers")}`);
    const treeAfter = await until(async () => {
      const now = await tree(id);
      return now.viewers === N - 1 && placed(now) === N - 1;
    }, 30000, 500);
    ok(`relay failure: tree has ${N - 1}, all placed`, treeAfter, JSON.stringify(await tree(id)).slice(0, 300));
    await sleep(3000);
    // "Watching" counts placed viewers, and the tree keeps moving for a few seconds after a relay
    // goes (re-parenting, promotions): each page polls every 2 s, so they agree within a few polls.
    let countsAfter = [];
    await until(async () => (countsAfter = await Promise.all(viewers.map((viewer) => watchingOf(viewer.page, "viewer-live")))).every((n) => n === N - 1), 10000, 500);
    ok(`relay failure: viewers say ${N - 1} watching`, countsAfter.every((n) => n === N - 1), countsAfter.join(","));
    const movingAfter = await Promise.all(viewers.map((viewer) => pictureMoves(viewer.page)));
    ok("relay failure: every remaining picture moves", movingAfter.every((m) => m.moves), movingAfter.map((m) => `${m.frames}f`).join(","));
  }

  /* the host's browser drops out without ending (a crash, its network): what viewers see */
  const crashedAt = Date.now();
  await host.ctx.close();
  const away = await until(async () => (await Promise.all(viewers.map((viewer) => viewer.page.locator('[data-testid="live-host-away"]').count()))).every((n) => n === 1), 15000, 500);
  ok("host's browser gone without ending: every viewer is told the host's connection dropped", away, `after ${Date.now() - crashedAt} ms`);
  ok("…and no viewer still reads “Live”", (await Promise.all(viewers.map((viewer) => viewer.page.locator('[data-testid="viewer-live"]').count()))).every((n) => n === 0));
  await H.shot({ page: viewers[0].page }, "serverless-host-away");
  noErrors("scale", viewers);
  for (const viewer of viewers) await viewer.ctx.close();
}

/* ------------------------------------------------------------------ 3b. the host leaves the page */

async function hostLeaves(browser) {
  // Closing the tab, reloading or following the logo away ends it, each after asking (the browser's
  // own prompt, or the End dialog for the logo).
  for (const how of ["close", "reload", "link"]) {
    const host = await person(browser);
    const { id, path } = await goLive(host, `QA host ${how}`);
    const viewer = await person(browser);
    await watch(viewer, path);
    ok(`host ${how}: viewer's picture moves`, (await untilMoving(viewer.page)) !== null);
    let asked = false;
    host.page.on("dialog", (dialog) => {
      asked = dialog.type() === "beforeunload";
      void dialog.accept();
    });
    if (how === "link") {
      // The logo asks first, with the End dialog; Cancel stays live.
      await host.page.locator("header a[href='/']").click();
      const dialog = host.page.getByRole("dialog", { name: "End this webinar?" });
      ok("host link: the logo asks first, with the End dialog", await dialog.waitFor({ timeout: 5000 }).then(() => true, () => false));
      ok("…its button reads “End and leave”", (await host.page.locator('[data-testid="end-live-confirm"]').innerText()).trim() === "End and leave");
      await host.page.getByRole("button", { name: "Cancel" }).click();
      await sleep(500);
      ok("…Cancel: still live, still on the page, the viewer still watching", (await dialog.count()) === 0 && /\/live$/.test(host.page.url()) && (await host.page.locator('[data-testid="host-viewers"]').count()) === 1 && (await untilMoving(viewer.page, 10000)) !== null);
      // A plain End afterwards is not "End and leave".
      await host.page.click('[data-testid="end-live"]');
      await dialog.waitFor();
      ok("…End itself still reads “End for everyone”", (await host.page.locator('[data-testid="end-live-confirm"]').innerText()).trim() === "End for everyone");
      await host.page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
    }
    const at = Date.now();
    if (how === "close") await host.page.close({ runBeforeUnload: true });
    else if (how === "reload") await host.page.reload();
    else {
      await host.page.locator("header a[href='/']").click();
      await host.page.click('[data-testid="end-live-confirm"]');
      ok("host link: End and leave goes home", await host.page.waitForURL(`${BASE}/`, { timeout: 15000 }).then(() => true, () => false), host.page.url());
    }
    const ended = await viewer.page.locator('[data-testid="live-over"]').waitFor({ timeout: 15000 }).then(() => true, () => false);
    ok(`host ${how}: viewer sees “This webinar has ended”`, ended, `after ${Date.now() - at} ms; tree ${JSON.stringify(await tree(id)).slice(0, 80)}`);
    if (how !== "link") ok(`host ${how}: the browser asked first`, asked);
    if (how === "reload") ok("host reload: back on the start page, for a new webinar", await host.page.locator('[data-testid="go-live"]').waitFor({ timeout: 20000 }).then(() => true, () => false));
    await host.ctx.close();
    await viewer.ctx.close();
  }
}

/* ------------------------------------------------------------------ 4. viewer edge cases */

const api = async (path, body) => (await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

async function viewer(browser) {
  /* the link before anyone is live: the wait, then the picture on its own */
  const created = await api("/api/live", { title: "QA early" });
  const early = await person(browser);
  await early.page.goto(`${BASE}/live/${created.id}?title=${encodeURIComponent(created.title.title)}&ts=${created.title.sig}${earlyFragment(created.viewerPass)}`);
  ok("before the host is live: “Not started yet”", await early.page.getByText("Not started yet").waitFor({ timeout: 15000 }).then(() => true, () => false));
  await early.page.click('[data-testid="watch"]');
  ok("…Watch: “Waiting for the host to go live”", await early.page.getByText("Waiting for the host to go live").waitFor({ timeout: 20000 }).then(() => true, () => false));
  const host = await person(browser, { init: useKey });
  // This host's "Go live" gets the stream the early viewer is waiting on, and its key.
  await host.page.route("**/api/live", (route) => (route.request().method() === "POST" ? route.fulfill({ json: created }) : route.continue()));
  const { path } = await goLive(host);
  const auto = await untilMoving(early.page, 30000);
  ok("…the host goes live: the waiting viewer's picture starts by itself", auto !== null, `${auto} ms after the link was shown`);

  /* reload mid-stream */
  await early.page.reload();
  await early.page.locator('[data-testid="watch"]:not([disabled])').waitFor({ timeout: 20000 });
  await early.page.click('[data-testid="watch"]');
  ok("reload mid-stream: Watch again, the picture comes back", (await untilMoving(early.page, 30000)) !== null);
  ok("…and it counts once", await until(async () => (await tree(created.id)).viewers === 1, 15000, 500), String((await tree(created.id)).viewers));

  /* the player's buttons */
  if ((await early.page.locator('[data-testid="viewer-sound"]').count()) === 0) await early.page.getByRole("button", { name: "Turn on sound" }).click();
  await early.page.getByRole("button", { name: "Mute" }).click();
  ok("Mute → “Turn on sound”", (await early.page.getByRole("button", { name: "Turn on sound" }).count()) === 1);
  await early.page.getByRole("button", { name: "Turn on sound" }).click();
  ok("…and back to “Mute”", (await early.page.getByRole("button", { name: "Mute" }).count()) === 1);
  await early.page.getByRole("button", { name: "Full screen" }).click();
  ok("Full screen takes the stage", await until(() => early.page.evaluate(() => !!document.fullscreenElement && document.fullscreenElement.contains(document.querySelector('[data-testid="live-video"]'))), 3000));
  ok("…and offers “Exit full screen”", await until(async () => (await early.page.getByRole("button", { name: "Exit full screen" }).count()) === 1, 3000));
  await early.page.getByRole("button", { name: "Exit full screen" }).click();
  ok("…which exits", await until(() => early.page.evaluate(() => !document.fullscreenElement), 3000));

  /* can't connect: no candidate but relay ones, and no TURN, as behind a strict NAT */
  const strict = await person(browser, {
    viewport: PHONE,
    init: () => {
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(config = {}) {
          super({ ...config, iceTransportPolicy: "relay" });
        }
      };
    },
  });
  await watch(strict, path);
  const t0 = Date.now();
  const stuck = await strict.page.locator('[data-testid="live-stuck"]').waitFor({ timeout: 45000 }).then(() => true, () => false);
  ok("can't connect: told why, after ~20 s", stuck, `${Math.round((Date.now() - t0) / 1000)} s`);
  ok("…and gives up its place (tree back to 1 viewer)", await until(async () => (await tree(created.id)).viewers === 1, 15000, 500));
  await H.shot({ page: strict.page }, "serverless-cant-connect");
  await strict.page.click('[data-testid="live-retry"]');
  ok("…Try again connects again", await strict.page.locator('[data-testid="live-video"]').waitFor({ timeout: 5000 }).then(() => true, () => false));

  /* the title in the link */
  const tampered = await person(browser);
  await tampered.page.goto(`${BASE}${path.replace("QA%20early", "Urgent%20security%20notice")}`);
  ok("an edited title in the link is not shown", (await tampered.page.locator('[data-testid="webinar-title"]').innerText()) === "Webinar");
  await tampered.page.goto(`${BASE}/live/${created.id}?title=QA%20early&title=Other&ts=${created.title.sig}`);
  ok("a repeated title parameter shows the signed one only", (await tampered.page.locator('[data-testid="webinar-title"]').innerText()) === "QA early");
  const other = await api("/api/live", { title: "QA early" });
  await tampered.page.goto(`${BASE}/live/${created.id}?title=QA%20early&ts=${other.title.sig}`);
  ok("another webinar's signature does not carry over", (await tampered.page.locator('[data-testid="webinar-title"]').innerText()) === "Webinar");
  const markup = await api("/api/live", { title: '<img src=x onerror="window.__xss=1">  two   spaces ' });
  await tampered.page.goto(`${BASE}/live/${markup.id}?title=${encodeURIComponent(markup.title.title)}&ts=${markup.title.sig}`);
  ok("a signed title with markup is shown as text", (await tampered.page.locator('[data-testid="webinar-title"]').innerText()) === '<img src=x onerror="window.__xss=1"> two spaces' && !(await tampered.page.evaluate(() => window.__xss)));
  ok("a long title is cut to 80 characters before it is signed", (await api("/api/live", { title: "x".repeat(500) })).title.title.length === 80);

  /* ids and keys */
  // The page streams (the viewer is in Suspense), so the status is already sent: Next.js marks
  // a not-found that late with `noindex` and renders the app's not-found page.
  await tampered.page.goto(`${BASE}/live/not-a-code`);
  ok("an invalid id shows the not-found page", (await tampered.page.locator('meta[name="robots"][content*="noindex"]').count()) > 0 && (await tampered.page.locator('[data-testid="live-notice"]').count()) === 0);
  ok("…and so is its tree", (await fetch(`${BASE}/api/live/NOT-AN-ID/tree`)).status === 404);
  await tampered.page.goto(`${BASE}/live/zzz-zzzz-zzz${earlyFragment("A".repeat(22))}`);
  ok("a well-formed id nobody made reads as not started", await tampered.page.getByText("Not started yet").waitFor({ timeout: 15000 }).then(() => true, () => false));
  // The id alone, without the link's pass, gets no viewer's place; nor does another webinar's pass.
  const viewerTicket = (pass) => fetch(`${BASE}/api/live/${created.id}/ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "viewer", pass }) });
  ok("a viewer's ticket without the link's pass is refused", (await viewerTicket(undefined)).status === 403);
  ok("…or with another webinar's pass", (await viewerTicket(other.viewerPass)).status === 403);
  ok("…and given with it", (await viewerTicket(created.viewerPass)).status === 200);
  const turnedAway = await person(browser);
  await turnedAway.page.goto(`${BASE}/live/${created.id}${earlyFragment(other.viewerPass)}`);
  await turnedAway.page.locator('[data-testid="watch"]:not([disabled])').waitFor({ timeout: 20000 });
  await turnedAway.page.click('[data-testid="watch"]');
  ok("a link with another webinar's pass is turned away with “Can't decrypt”", (await turnedAway.page.locator('[data-testid="live-key-problem"]').getAttribute("data-problem", { timeout: 20000 }).catch(() => null)) === "wrong");
  noErrors("viewer turned away", [turnedAway], /status of 403/);
  await turnedAway.ctx.close();
  // A link cut down to its key alone is broken, not played unsigned (a new document, not a hash change).
  await tampered.page.goto("about:blank");
  await tampered.page.goto(`${BASE}/live/${created.id}#k=${EARLY_KEY}`);
  ok("a link with only the key says it can't decrypt, with no Watch", (await tampered.page.locator('[data-testid="live-key-problem"]').getAttribute("data-problem", { timeout: 20000 }).catch(() => null)) === "wrong" && (await tampered.page.locator('[data-testid="watch"]').count()) === 0);
  const huge = await fetch(`${BASE}/api/live/${created.id}/ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "viewer", pass: created.viewerPass, filler: "x".repeat(10000) }) });
  ok("a request body over 4 KB is refused", huge.status === 413, String(huge.status));
  const end = await fetch(`${BASE}/api/live/${created.id}/end`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostKey: "nope" }) });
  ok("ending without the host key is refused", end.status === 403, String(end.status));
  const ticket = await fetch(`${BASE}/api/live/${created.id}/ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "source", hostKey: other.hostKey }) });
  ok("a source ticket with another webinar's host key is refused", ticket.status === 403, String(ticket.status));

  noErrors("viewer", [early, host, tampered]);
  for (const p of [early, host, strict, tampered]) await p.ctx.close();
}

/* ------------------------------------------------------------------ 5. host edge cases */

/** Makes getUserMedia fail as `window.__missing` says: "denied", "camera" (none), or "microphone" (none). */
function missingDevices() {
  const media = navigator.mediaDevices;
  const ask = media.getUserMedia.bind(media);
  media.getUserMedia = (constraints = {}) => {
    const kind = window.__missing;
    if (kind === "denied") return Promise.reject(new DOMException("denied", "NotAllowedError"));
    if (kind === "camera" && constraints.video) return Promise.reject(new DOMException("none", "NotFoundError"));
    if (kind === "microphone" && constraints.audio) return Promise.reject(new DOMException("none", "NotFoundError"));
    return ask(constraints);
  };
}

async function hostWithout(browser, kind) {
  const host = await person(browser);
  await host.ctx.addInitScript((k) => (window.__missing = k), kind);
  await host.ctx.addInitScript(missingDevices);
  await host.page.goto(`${BASE}/live`);
  return host;
}

async function hostCases(browser) {
  for (const [kind, text] of [
    ["denied", "Camera and microphone are blocked"],
    ["camera", "No camera was found"],
  ]) {
    const host = await hostWithout(browser, kind);
    const said = await host.page.getByRole("alert").filter({ hasText: text }).waitFor({ timeout: 15000 }).then(() => true, () => false);
    ok(`host, ${kind}: “${text}…” with Try again`, said && (await host.page.getByRole("button", { name: "Try again" }).count()) === 1);
    ok(`host, ${kind}: Go live stays off`, await host.page.locator('[data-testid="go-live"]').isDisabled());
    await H.shot({ page: host.page }, `serverless-host-${kind}`);
    if (kind === "denied") {
      await host.page.evaluate(() => (window.__missing = null));
      await host.page.getByRole("button", { name: "Try again" }).click();
      ok("host, denied then allowed, Try again: the preview comes", await host.page.locator('[data-testid="go-live"]:not([disabled])').waitFor({ timeout: 15000 }).then(() => true, () => false));
    }
    noErrors(`host ${kind}`, [host]);
    await host.ctx.close();
  }

  /* the full link is in the copy only: not in the page, where anything reading the DOM would find its key */
  {
    const host = await person(browser, { debug: false, permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"] });
    await host.page.goto(`${BASE}/live`);
    await host.page.locator('[data-testid="go-live"]:not([disabled])').waitFor({ timeout: 30000 });
    await host.page.click('[data-testid="go-live"]');
    const share = host.page.locator('[data-testid="share-link"]');
    await share.waitFor({ timeout: 30000 });
    const html = await host.page.content();
    await share.click();
    await host.page.getByText("Copied").waitFor({ timeout: 5000 });
    const copied = await host.page.evaluate(() => navigator.clipboard.readText());
    const key = /#k=([\w-]{43})&s=[\w-]{87}&a=[\w-]{22}$/.exec(copied)?.[1];
    ok("host: Copy link gives the full link, key and all", !!key, copied.replace(/#.*/, "#…"));
    ok("…which is nowhere in the page", (await share.getAttribute("data-link")) === null && !!key && !html.includes(key));
    await endWebinar(host);
    noErrors("host link copy", [host]);
    await host.ctx.close();
  }

  /* no microphone: live on the camera alone */
  {
    const host = await hostWithout(browser, "microphone");
    ok("host, no microphone: says viewers will see but not hear", await host.page.locator('[data-testid="no-microphone"]').waitFor({ timeout: 15000 }).then(() => true, () => false));
    const mic = host.page.locator('[data-testid="host-mic"]');
    ok("…the mic switch reads “No microphone”, inert", (await mic.getAttribute("aria-label")) === "No microphone" && (await mic.getAttribute("aria-disabled")) === "true");
    const { path } = await goLive(host);
    const v = await person(browser);
    await watch(v, path);
    ok("…and viewers get the picture", (await untilMoving(v.page)) !== null);
    noErrors("host no microphone", [host, v]);
    await host.ctx.close();
    await v.ctx.close();
  }

  /* switches while live; End asks, once */
  {
    const host = await person(browser);
    const { id, path } = await goLive(host, "QA switches");
    const v = await person(browser);
    await watch(v, path);
    await untilMoving(v.page);
    await host.page.click('[data-testid="host-mic"]');
    ok("live: mute → “Unmute microphone”, and Muted on the preview", (await host.page.locator('[data-testid="host-mic"]').getAttribute("aria-label")) === "Unmute microphone" && (await host.page.getByText("Muted", { exact: true }).count()) === 1);
    await host.page.click('[data-testid="host-mic"]');
    await host.page.click('[data-testid="host-camera"]');
    ok("live: camera off says viewers see a black picture", (await host.page.getByText("Camera off. Viewers see a black picture.").count()) === 1);
    await sleep(2000);
    const brightest = await v.page.evaluate(() => {
      const video = document.querySelector('[data-testid="live-video"]');
      const c = document.createElement("canvas");
      c.width = 32;
      c.height = 18;
      const g = c.getContext("2d");
      g.drawImage(video, 0, 0, 32, 18);
      const d = g.getImageData(0, 0, 32, 18).data;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
      return max;
    });
    ok("…the viewer's picture goes black", brightest < 30, `brightest pixel ${brightest}`);
    await host.page.click('[data-testid="host-camera"]');
    ok("…camera on: the viewer's picture moves again", (await untilMoving(v.page, 10000)) !== null);

    let ends = 0;
    host.page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith(`/api/live/${id}/end`)) ends++;
    });
    await host.page.click('[data-testid="end-live"]');
    const dialog = host.page.getByRole("dialog", { name: "End this webinar?" });
    await dialog.waitFor();
    ok("End asks first, naming the viewer", /It stops for the one viewer/.test(await dialog.innerText()));
    ok("…with the focus on Cancel", (await host.page.evaluate(() => document.activeElement?.textContent?.trim())) === "Cancel");
    await host.page.keyboard.press("Enter");
    await sleep(300);
    ok("…Enter there cancels: still live", (await dialog.count()) === 0 && (await host.page.locator('[data-testid="host-viewers"]').count()) === 1);
    await host.page.click('[data-testid="end-live"]');
    await host.page.locator('[data-testid="end-live-confirm"]').dblclick();
    await host.page.locator('[data-testid="host-ended"]').waitFor({ timeout: 15000 });
    await sleep(500);
    ok("a double-click on End for everyone ends it once", ends === 1, `${ends} end requests`);
    ok("ended summary: at most 1 viewer", /at most 1 viewer at once/.test(await host.page.locator('[data-testid="host-ended"]').innerText()));
    ok("…the camera is let go", await host.page.evaluate(() => !document.querySelector("video")));
    ok("…the viewer is told", await v.page.locator('[data-testid="live-over"]').waitFor({ timeout: 15000 }).then(() => true, () => false));
    await host.page.getByRole("button", { name: "Start another" }).click();
    ok("Start another: the preview again, ready to go live", await host.page.locator('[data-testid="go-live"]:not([disabled])').waitFor({ timeout: 15000 }).then(() => true, () => false));
    noErrors("host switches", [host, v]);
    await host.ctx.close();
    await v.ctx.close();
  }
}

/* ------------------------------------------------------------------ 6. home */

async function home(browser) {
  for (const enabled of [true, false]) {
    const p = await person(browser);
    let createAsked = false;
    await p.page.route("**/api/meeting", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      if (body.action === "webinars") return route.fulfill({ json: { enabled } });
      // Where a standard webinar would be made (a RealtimeKit session): stopped, answered as a failure.
      if (body.action === "create" && body.mode === "webinar") {
        createAsked = true;
        return route.fulfill({ status: 503, json: { error: "QA: not creating a RealtimeKit session." } });
      }
      return route.continue();
    });
    await p.page.goto(`${BASE}/`);
    const label = `home (standard ${enabled ? "on" : "off"})`;
    const trigger = p.page.getByRole("button", { name: "More ways to start a meeting" });
    await trigger.focus();
    await p.page.keyboard.press("Enter");
    await p.page.getByRole("menuitem", { name: "New webinar…" }).waitFor();
    const onNewWebinar = () => p.page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem" && document.activeElement.textContent.trim() === "New webinar…");
    // The menu moves the focus into itself a frame after it opens.
    await until(() => p.page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem"), 3000, 50);
    for (let i = 0; i < 5 && !(await onNewWebinar()); i++) {
      await p.page.keyboard.press("ArrowDown");
      await sleep(100);
    }
    ok(`${label}: the arrow keys reach New webinar…`, await onNewWebinar());
    await sleep(150);
    await p.page.keyboard.press("Enter");
    const dialog = p.page.getByRole("dialog", { name: "Start a webinar" });
    await dialog.waitFor();
    await sleep(300);
    const focused = await p.page.evaluate(() => document.activeElement?.getAttribute("data-webinar-type"));
    ok(`${label}: the chooser opens on the first kind that can be chosen`, focused === (enabled ? "standard" : "serverless"), String(focused));
    const stops = [];
    for (let i = 0; i < 6; i++) {
      await p.page.keyboard.press("Tab");
      stops.push(await p.page.evaluate(() => (document.querySelector("[data-webinar-type-dialog]")?.contains(document.activeElement) ? document.activeElement.getAttribute("data-webinar-type") || document.activeElement.getAttribute("aria-label") : "OUTSIDE")));
    }
    ok(`${label}: Tab stays in the chooser`, !stops.includes("OUTSIDE"), stops.join(" → "));
    await p.page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await sleep(200);
    const back = await p.page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName);
    ok(`${label}: Escape closes it, the focus back on the menu's arrow`, back === "More ways to start a meeting", String(back));
    await trigger.click();
    await p.page.getByRole("menuitem", { name: "New webinar…" }).click();
    await dialog.waitFor();
    const standard = dialog.locator('[data-webinar-type="standard"]');
    if (enabled) {
      await standard.click();
      const said = await p.page.getByText("QA: not creating a RealtimeKit session.").first().waitFor({ timeout: 10000 }).then(() => true, () => false);
      ok("Standard webinar asks the server to make it (stopped before RealtimeKit), and says the failure", createAsked && said);
      ok("…and can be chosen again", await until(async () => (await standard.getAttribute("aria-disabled")) === null, 3000));
    } else {
      ok("Standard off: shown disabled, with the reason", (await standard.getAttribute("aria-disabled")) === "true" && /Off on this server/.test(await standard.innerText()));
      await standard.click({ force: true });
      await sleep(500);
      ok("…and pressing it does nothing", !createAsked && (await dialog.count()) === 1);
    }
    // The 503 is the stand-in answer above, which the browser logs.
    noErrors(label, [p], /status of 503/);
    await p.ctx.close();
  }

  /* Leaving with the chooser open leaves no dialog behind. Cache Components keep the home page,
     hidden, in the document; a dialog left there (open, or caught mid exit animation) is taken by
     the Toaster for one with the person's attention, and every notice in the call is held back. */
  for (const how of ["standard", "serverless", "back"]) {
    const p = await person(browser);
    await p.page.route("**/api/meeting", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      if (body.action === "webinars") return route.fulfill({ json: { enabled: true } });
      // A made-up code: the call page that opens is not what is tested, only what home leaves behind.
      if (body.action === "create") return route.fulfill({ json: { code: "qaq-chooser-gon" } });
      return route.continue();
    });
    if (how === "back") {
      await p.page.goto(`${BASE}/live/abc-defg-hij`);
      await p.page.locator("header a[href='/']:visible").click();
      await p.page.waitForURL(`${BASE}/`);
    } else await p.page.goto(`${BASE}/`);
    await p.page.getByRole("button", { name: "More ways to start a meeting" }).click();
    await p.page.getByRole("menuitem", { name: "New webinar…" }).click();
    await p.page.getByRole("dialog", { name: "Start a webinar" }).waitFor();
    if (how === "back") await p.page.goBack();
    else await p.page.locator(`[data-webinar-type="${how}"]`).click();
    await p.page.waitForURL((url) => url.pathname !== "/");
    await sleep(2000);
    const left = await p.page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => `${d.textContent.slice(0, 20)} (${d.dataset.state})`));
    ok(`leaving home by ${how} with the chooser open leaves no dialog in the document`, left.length === 0, left.join("; "));
    await p.ctx.close();
  }

  /* 375 px: every page fits, nothing scrolls sideways */
  const phone = await person(browser, { viewport: PHONE });
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await phone.page.goto(`${BASE}/`);
  ok("375: home fits", (await overflow(phone.page)) <= 0);
  await phone.page.getByRole("button", { name: "More ways to start a meeting" }).click();
  await phone.page.getByRole("menuitem", { name: "New webinar…" }).click();
  const chooser = phone.page.getByRole("dialog", { name: "Start a webinar" });
  await chooser.waitFor();
  await sleep(400);
  const box = await chooser.boundingBox();
  ok("375: the chooser fits", box.x >= 0 && box.x + box.width <= 375 && (await overflow(phone.page)) <= 0, JSON.stringify(box));
  await phone.page.locator('[data-webinar-type="serverless"]').click();
  await phone.page.waitForURL(/\/live$/);
  await phone.page.locator('[data-testid="go-live"]:not([disabled])').waitFor({ timeout: 20000 });
  ok("375: /live fits", (await overflow(phone.page)) <= 0);
  const { path } = await goLive(phone, "A rather long webinar title that has to wrap on a phone screen");
  await sleep(2500);
  ok("375: /live, live, fits", (await overflow(phone.page)) <= 0);
  const v = await person(browser, { viewport: PHONE });
  await v.page.goto(`${BASE}${path}`);
  await v.page.locator('[data-testid="watch"]:not([disabled])').waitFor();
  ok("375: the viewer's notice fits", (await overflow(v.page)) <= 0);
  await v.page.click('[data-testid="watch"]');
  await untilMoving(v.page);
  await v.page.getByRole("button", { name: /Who’s connected/ }).click();
  await sleep(800);
  ok("375: the viewer watching, tree open, fits", (await overflow(v.page)) <= 0);
  noErrors("375", [phone, v]);
  await phone.ctx.close();
  await v.ctx.close();
}

/* ------------------------------------------------------------------ 7. accessibility */

/** Buttons and links on the page with no name a screen reader could read. */
const unnamed = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button, a[href], [role=button]")]
      .filter((el) => el.offsetParent !== null)
      .filter((el) => !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.textContent.trim() || el.getAttribute("title")))
      .map((el) => el.outerHTML.slice(0, 120)),
  );

/** What live regions (role=status/alert, aria-live) would announce over `ms`: their text changes. */
const liveChatter = (page, ms) =>
  page.evaluate(async (wait) => {
    const changes = [];
    const regions = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])')];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const region = regions.find((r) => r.contains(record.target));
        if (region) changes.push(region.textContent.trim().slice(0, 40));
      }
    });
    for (const region of regions) observer.observe(region, { subtree: true, characterData: true, childList: true });
    await new Promise((resolve) => setTimeout(resolve, wait));
    observer.disconnect();
    return { regions: regions.map((r) => r.textContent.trim().slice(0, 40)), changes };
  }, ms);

async function a11y(browser) {
  const host = await person(browser);
  await host.page.goto(`${BASE}/live`);
  await host.page.locator('[data-testid="go-live"]:not([disabled])').waitFor({ timeout: 20000 });
  ok("a11y: /live before going live, every button named", (await unnamed(host.page)).length === 0, (await unnamed(host.page)).join(" "));
  const { path } = await goLive(host, "QA a11y");
  const viewers = [];
  for (let i = 0; i < 3; i++) {
    const v = await person(browser);
    await watch(v, path);
    viewers.push(v);
  }
  for (const v of viewers) await untilMoving(v.page);
  await sleep(3000);
  ok("a11y: host live, every button named", (await unnamed(host.page)).length === 0, (await unnamed(host.page)).join(" "));
  ok("a11y: viewer watching, every button named", (await unnamed(viewers[0].page)).length === 0, (await unnamed(viewers[0].page)).join(" "));
  const hostChatter = await liveChatter(host.page, 10000);
  ok("a11y: host live: live regions quiet over 10 s", hostChatter.changes.length === 0, `${hostChatter.changes.length} changes: ${[...new Set(hostChatter.changes)].join(" | ")}; regions: ${hostChatter.regions.join(" | ")}`);
  const viewerChatter = await liveChatter(viewers[0].page, 10000);
  ok("a11y: viewer watching: live regions quiet over 10 s", viewerChatter.changes.length === 0, `${viewerChatter.changes.length} changes: ${[...new Set(viewerChatter.changes)].join(" | ")}; regions: ${viewerChatter.regions.join(" | ")}`);
  await host.page.click('[data-testid="end-live"]');
  await host.page.getByRole("dialog", { name: "End this webinar?" }).waitFor();
  const stops = [];
  for (let i = 0; i < 5; i++) {
    await host.page.keyboard.press("Tab");
    stops.push(await host.page.evaluate(() => (document.querySelector('[role="dialog"]')?.contains(document.activeElement) ? document.activeElement.textContent.trim() : "OUTSIDE")));
  }
  ok("a11y: the end dialog keeps the focus in", !stops.includes("OUTSIDE"), stops.join(" → "));
  await host.page.keyboard.press("Escape");
  await sleep(200);
  ok("a11y: Escape gives the focus back to End webinar", await host.page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "end-live"));
  await endWebinar(host);
  await viewers[0].page.locator('[data-testid="live-over"]').waitFor({ timeout: 15000 });
  ok("a11y: the ended state takes the viewer's focus", await viewers[0].page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "live-over"));
  ok("a11y: …and the host's", await host.page.evaluate(() => document.activeElement?.tagName === "H2" && /ended/.test(document.activeElement.textContent)));
  for (const p of [host, ...viewers]) await p.ctx.close();
}

const SECTIONS = { happy, scale, "host-leaves": hostLeaves, viewer, host: hostCases, home, a11y };

(async () => {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(SECTIONS);
  console.log(`Meetly (Worker preview) at ${BASE}`);
  const browser = await H.launch();
  for (const name of names) {
    try {
      await SECTIONS[name](browser);
    } catch (error) {
      ok(`${name}: ran to the end`, false, String(error && error.stack).split("\n").slice(0, 3).join(" "));
    }
  }
  await browser.close();
  process.exit(H.finish());
})();
