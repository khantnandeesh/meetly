// Checks that a deployed Meetly answers: the home page, a meeting page, one of the page's
// scripts, and /api/meeting. Run after every production deploy (.github/workflows/deploy.yml),
// or by hand:
//
//   node scripts/smoke-test.mjs https://meet.nandeesh.dev
//
// With EXPECT_BUILD_ID set (the .next/BUILD_ID of the build just deployed), it also waits until
// the home page is served by that build, so it never passes against the previous version.
//
// It never joins a call and never asks for a token. The only request that reaches the media
// provider is "peek" for a random meeting code, which on RealtimeKit is one meeting search (a
// GET); no meeting and no participant is created, so nothing is billed.
//
// It also checks /live (Go live, beta) and the webinars switch answer, and which kind of
// deployment answered:
//
// - production (the default): pages are indexable and carry no environment label;
// - SMOKE_STAGING=1 (staging, .github/workflows/staging.yml): every page says
//   `X-Robots-Tag: noindex`, /robots.txt disallows everything, <html> carries
//   data-meetly-env="Staging" (src/lib/environmentLabel.ts), and webinars are off.
//
// Optional, staging only:
//
// - SMOKE_RTK_OFF=1: the deployment has no RealtimeKit credentials, so it cannot start a
//   RealtimeKit session (peek answers without a participant count). Drop it once staging has
//   its own CLOUDFLARE_API_TOKEN.
// - SMOKE_LIVE=1: a browser test of Live (beta). A host with a fake camera goes live, one viewer
//   watches until it gets a picture, the host sees "1 watching" and ends the stream. It also
//   checks that the label is still on <html> once React has hydrated the page. Live is
//   peer-to-peer through the Worker's own Durable Object: nothing reaches RealtimeKit. It needs
//   Playwright's Chromium (found through NODE_PATH, as in ci.yml), and it starts a stream, so it
//   is refused against production.
import { createRequire } from "node:module";

const base = (process.argv[2] || process.env.SMOKE_URL || "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(base)) {
  console.error("Usage: node scripts/smoke-test.mjs <https://host>");
  process.exit(2);
}
const expectBuildId = (process.env.EXPECT_BUILD_ID || "").trim();
const staging = process.env.SMOKE_STAGING === "1";
const label = (process.env.SMOKE_ENV_LABEL || "Staging").trim();
const rtkOff = process.env.SMOKE_RTK_OFF === "1";
const live = process.env.SMOKE_LIVE === "1";
if ((rtkOff || live) && !staging) {
  console.error("SMOKE_RTK_OFF and SMOKE_LIVE are for staging: set SMOKE_STAGING=1 too. Production is only read.");
  process.exit(2);
}
const ATTEMPTS = Number(process.env.SMOKE_ATTEMPTS || 12);
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS || 10_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const letters = "abcdefghijklmnopqrstuvwxyz";
const run = (n) => Array.from({ length: n }, () => letters[Math.floor(Math.random() * 26)]).join("");
// Meeting codes look like abc-defg-hij; a random one is almost certainly not a real meeting.
const code = `${run(3)}-${run(4)}-${run(3)}`;

async function get(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    redirect: "manual",
    ...init,
    headers: { "user-agent": "meetly-smoke-test", ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: response.status,
    type: response.headers.get("content-type") || "",
    robots: response.headers.get("x-robots-tag") || "",
    body: await response.text(),
  };
}

const NOINDEX = /noindex/i;
/** The label custom-worker.ts writes on <html>, or null. */
const htmlLabel = (body) => (body.match(/<html\b[^>]*\bdata-meetly-env="([^"]*)"/i) || [])[1] ?? null;

/** What kind of deployment a page says it is: labelled and noindex on staging, neither on production. */
function deploymentMark(page) {
  const found = htmlLabel(page.body);
  if (staging) {
    if (!NOINDEX.test(page.robots)) return `X-Robots-Tag is "${page.robots}", expected noindex`;
    return found === label ? null : `<html> data-meetly-env is ${found === null ? "missing" : `"${found}"`}, expected "${label}"`;
  }
  if (NOINDEX.test(page.robots)) return `production says X-Robots-Tag: ${page.robots}`;
  return found === null ? null : `production is labelled "${found}"`;
}

const postMeeting = (body) =>
  get("/api/meeting", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Each check returns null when it passes, or what was wrong. */
const checks = [
  [
    "home page: 200 with the New meeting button" + (expectBuildId ? ` from build ${expectBuildId}` : ""),
    async (state) => {
      const home = await get("/");
      if (home.status !== 200) return `status ${home.status}`;
      if (!home.body.includes("New meeting") || !home.body.includes("Meetly")) return "expected text missing";
      if (expectBuildId && !home.body.includes(`\\"b\\":\\"${expectBuildId}\\"`) && !home.body.includes(`"b":"${expectBuildId}"`)) {
        const served = home.body.match(/\\?"b\\?":\\?"([A-Za-z0-9_-]+)\\?"/);
        return `still serving build ${served ? served[1] : "(unknown)"}`;
      }
      state.script = (home.body.match(/\/_next\/static\/[^"'\\\s]+\.js/) || [])[0];
      return null;
    },
  ],
  [
    "a script the home page loads: 200 from static assets",
    async (state) => {
      if (!state.script) return "the home page links no /_next/static script";
      const script = await get(state.script);
      if (script.status !== 200) return `${state.script}: status ${script.status}`;
      return /javascript/.test(script.type) ? null : `${state.script}: content-type ${script.type}`;
    },
  ],
  [
    `meeting page /${code}: 200, rendered for that code`,
    async () => {
      const page = await get(`/${code}`);
      if (page.status !== 200) return `status ${page.status}`;
      return page.body.includes(`<title>${code} · Meetly</title>`) ? null : "title for the code missing";
    },
  ],
  [
    "POST /api/meeting peek, random code: 200 with an access mode",
    async () => {
      const peek = await postMeeting({ action: "peek", code });
      if (peek.status !== 200) return `status ${peek.status}: ${peek.body.slice(0, 200)}`;
      const json = JSON.parse(peek.body);
      return typeof json.access === "string" && json.host === false ? null : `unexpected body ${peek.body.slice(0, 200)}`;
    },
  ],
  [
    "POST /api/meeting peek, malformed code: 400",
    async () => {
      const bad = await postMeeting({ action: "peek", code: "not-a-code" });
      return bad.status === 400 ? null : `status ${bad.status}`;
    },
  ],
  [
    "/live (Go live, beta): 200",
    async () => {
      const page = await get("/live");
      if (page.status !== 200) return `status ${page.status}`;
      return page.body.includes("Go live") ? null : "expected text missing";
    },
  ],
  [
    `POST /api/meeting webinars: 200 with a switch${staging ? ", off" : ""}`,
    async () => {
      const answer = await postMeeting({ action: "webinars" });
      if (answer.status !== 200) return `status ${answer.status}`;
      const json = JSON.parse(answer.body);
      if (typeof json.enabled !== "boolean") return `unexpected body ${answer.body.slice(0, 200)}`;
      return staging && json.enabled ? "webinars are on" : null;
    },
  ],
  [
    staging ? `home and /live: noindex, labelled "${label}"` : "home and /live: indexable, no environment label",
    async () => {
      for (const path of ["/", "/live"]) {
        const problem = deploymentMark(await get(path));
        if (problem) return `${path}: ${problem}`;
      }
      return null;
    },
  ],
  ...(staging
    ? [
        [
          "/robots.txt disallows everything",
          async () => {
            const robots = await get("/robots.txt");
            if (robots.status !== 200) return `status ${robots.status}`;
            return /^User-agent: \*\s*\nDisallow: \/\s*$/m.test(robots.body) ? null : `body ${JSON.stringify(robots.body.slice(0, 80))}`;
          },
        ],
      ]
    : []),
  ...(rtkOff
    ? [
        [
          "no RealtimeKit credentials: peek has no participant count",
          async () => {
            const peek = await postMeeting({ action: "peek", code });
            if (peek.status !== 200) return `status ${peek.status}`;
            return JSON.parse(peek.body).count === null ? null : `peek counted participants: ${peek.body.slice(0, 200)}`;
          },
        ],
      ]
    : []),
  ...(live ? [["Live (beta) in a browser: a fake-camera host and one viewer", liveInBrowser]] : []),
];

/**
 * Live (beta), end to end in Chromium: the host goes live with a fake camera, one viewer opens
 * the share link and gets a picture, the host sees one viewer, and the host ends the stream.
 * Also checks that React's hydration kept the environment label on <html>.
 */
async function liveInBrowser() {
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)("playwright"));
  } catch {
    return "Playwright is not installed (install it outside the project and set NODE_PATH, as ci.yml does)";
  }
  const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const errors = [];
  const contextFor = async () => {
    // The clipboard: the host's share link, key and all, is had by "Copy link", as people do.
    const context = await browser.newContext({ permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"], userAgent: "meetly-smoke-test (Playwright)" });
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    return context;
  };
  try {
    const host = await (await contextFor()).newPage();
    host.on("pageerror", (error) => errors.push(error.message));
    host.on("console", (message) => {
      if (message.type() === "error" && /hydrat|#418|#423|#425/i.test(message.text())) errors.push(message.text());
    });
    await host.goto(`${base}/live`, { waitUntil: "load" });
    await host.getByTestId("go-live").and(host.locator(":enabled")).waitFor({ timeout: 30_000 });

    // After hydration (the Go live button only enables once React runs), the label is still there.
    const mark = await host.evaluate(() => ({
      attribute: document.documentElement.getAttribute("data-meetly-env"),
      tab: getComputedStyle(document.documentElement, "::after").content,
    }));
    if (mark.attribute !== label) return `after hydration <html> data-meetly-env is ${JSON.stringify(mark.attribute)}`;
    if (mark.tab !== JSON.stringify(label)) return `the label tab shows ${mark.tab}, expected "${label}"`;

    await host.getByTestId("go-live").click();
    const share = host.getByTestId("share-link");
    await share.waitFor({ timeout: 30_000 });
    // A button that copies the link (an <input> before the serverless webinar UI). The link ends
    // with its end-to-end key; only its start is ever printed.
    const link = (await share.evaluate((element) => element.tagName)) === "INPUT" ? await share.inputValue() : await (async () => {
      await share.click();
      await host.getByText("Copied").waitFor({ timeout: 5_000 });
      return host.evaluate(() => navigator.clipboard.readText());
    })();
    if (!link.startsWith(`${base}/live/`)) return `share link ${link.replace(/#.*/, "#…")} is not on ${base}`;

    const viewer = await (await contextFor()).newPage();
    viewer.on("pageerror", (error) => errors.push(error.message));
    await viewer.goto(link, { waitUntil: "load" });
    await viewer.getByTestId("watch").and(viewer.locator(":enabled")).click({ timeout: 30_000 });
    await viewer.waitForFunction(() => {
      const video = document.querySelector('[data-testid="live-video"]');
      return video instanceof HTMLVideoElement && video.videoWidth > 0 && !video.classList.contains("opacity-0");
    }, null, { timeout: 60_000 });
    const size = await viewer.evaluate(() => {
      const video = document.querySelector('[data-testid="live-video"]');
      return `${video.videoWidth}x${video.videoHeight}`;
    });

    // "1 watching": on the picture's Live chip (host-viewers), or the older count (host-viewer-count).
    await host.locator('[data-testid="host-viewers"], [data-testid="host-viewer-count"]').filter({ hasText: /(^|\D)1 watching/ }).first().waitFor({ timeout: 30_000 });
    await host.getByTestId("end-live").click();
    // End asks first, in a dialog, where there is one.
    const confirm = host.getByTestId("end-live-confirm");
    if (await confirm.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await confirm.click();
    await viewer.getByTestId("live-over").waitFor({ timeout: 30_000 });
    if (errors.length) return `page errors: ${errors.slice(0, 3).join(" | ").slice(0, 300)}`;
    console.log(`     the viewer got a ${size} picture; the host saw 1 watching; the stream ended for the viewer`);
    return null;
  } catch (error) {
    return `${String(error?.message || error).split("\n")[0]}${errors.length ? ` (page errors: ${errors.slice(0, 2).join(" | ").slice(0, 200)})` : ""}`;
  } finally {
    await browser.close();
  }
}

console.log(`Smoke test of ${base} (${staging ? `staging, label "${label}"` : "production, read-only"})`);
const state = {};
let failed = 0;
for (const [name, check] of checks) {
  let problem = "not run";
  // The browser test starts a stream each time, so it is tried twice at most.
  const attempts = check === liveInBrowser ? Math.min(ATTEMPTS, 2) : ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    problem = await check(state).catch((error) => {
      const cause = error?.cause?.code || error?.cause?.message;
      return `${error?.message || error}${cause ? ` (${cause})` : ""}`;
    });
    if (!problem) break;
    if (attempt < attempts) {
      console.log(`  …  ${name}: ${problem} (attempt ${attempt}/${attempts}, retrying)`);
      await sleep(WAIT_MS);
    }
  }
  console.log(`${problem ? "FAIL" : "PASS"}  ${name}${problem ? `  — ${problem}` : ""}`);
  if (problem) failed++;
}
console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
