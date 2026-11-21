/**
 * Media's browser runs: PLAN.md's acceptance tests for E-media that need a real encoder, decoder
 * and sound card. Headless Chromium with a fake camera and microphone, one page, no network.
 *
 *   npm run overlay:media -- m1            one scenario
 *   npm run overlay:media -- all           every scenario, at its short length
 *   npm run overlay:media -- m1 '{"seconds":60}'
 *
 * Playwright is not a dependency of the repository: it is found through NODE_PATH, as test/e2e
 * does. Ports 4220–4239 are E-media's.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";

type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: (arg: { name: string; options: unknown }) => Promise<T>, arg: { name: string; options: unknown }): Promise<T>;
  on(event: string, listener: (value: { message?: string; text?: () => string; type?: () => string }) => void): void;
  click(selector: string): Promise<void>;
  close(): Promise<void>;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Check = [name: string, ok: boolean, detail: string];
type Scenario = { options: Record<string, unknown>; args?: string[]; check: (result: any) => Check[] };

const PORT = Number(process.env.OVERLAY_MEDIA_PORT ?? 4220);
const here = import.meta.dirname;
const loadavg = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");

export const SCENARIOS: Record<string, Scenario> = {
  m1: {
    options: { seconds: 20 },
    check: (r) => [
      ["video bitrate within 15% of the target", Math.abs(r.videoKbps - r.targetKbps) <= 0.15 * r.targetKbps, `${r.videoKbps} of ${r.targetKbps} kbps`],
      ["a keyframe every 60 frames", r.keyGapMin === 60 && r.keyGapMax === 60, `gaps ${r.keyGapMin}..${r.keyGapMax} over ${r.keyframes} keyframes`],
      ["every header obeys §9.2", r.headerProblems.length === 0, r.headerProblems.join("; ") || `${r.frames} frames`],
      ["capture to frame event p95 ≤ 40 ms", r.captureToFrameMs.p95 <= 40, `p50 ${r.captureToFrameMs.p50}, p95 ${r.captureToFrameMs.p95}, max ${r.captureToFrameMs.max} ms`],
      ["the encoder never holds more than 2 frames", r.maxEncoderFrames <= 2, `${r.maxEncoderFrames} at most; ${r.skippedBusy} skipped`],
      ["a decoder takes every frame", r.decodeErrors.length === 0 && r.decoded >= r.frames - 2, `${r.decoded} of ${r.frames}`],
      ["audio: 50 Opus frames a second, 20 ms apart, each announced twice", Math.abs(r.audioFps - 50) < 1 && r.audioStepUs.min >= 19000 && r.audioStepUs.max <= 21000 && r.audioAnnounced >= 2 * r.audioFrames - 2, `${r.audioFps} fps, steps ${r.audioStepUs.min}..${r.audioStepUs.max} µs, ${r.audioAnnounced} announcements of ${r.audioFrames} frames, ${r.audioKbps} kbps`],
      ["no errors", r.errors.length === 0, r.errors.join("; ")],
    ],
  },
  deps: {
    options: { seconds: 6 },
    check: (r) => [
      ["every header obeys §9.2", r.headerProblems.length === 0, r.headerProblems.join("; ") || r.pattern.join(" ")],
      ["the control (a needed frame removed, its dependents kept) is noticed", r.controlDifferent > 0, `${r.controlDifferent} frames decode differently`],
      ...r.results.map((p: any): Check => [`${p.policy}: what the headers allow decodes, to the same pixels`, p.errors.length === 0 && p.decoded === p.kept && p.differentPixels === 0, `${p.decoded} of ${p.kept} decoded (of ${p.of}); ${p.differentPixels} differ ${p.firstDifferent.join(",")} ${p.errors.join("; ")}`]),
    ],
  },
};

async function bundle(): Promise<string> {
  const result = await build({ entryPoints: [join(here, "page.ts")], bundle: true, format: "iife", target: "es2022", write: false, sourcemap: "inline", logLevel: "silent" });
  return result.outputFiles[0]!.text;
}

function serve(script: string): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === "/page.js") response.writeHead(200, { "content-type": "text/javascript" }).end(script);
    else response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><title>overlay media</title><body style="margin:0;background:#111"><button id="go">go</button><video id="out" muted autoplay playsinline style="width:640px"></video><script src="/page.js"></script>`);
  });
  return new Promise((resolve, reject) => server.once("error", reject).listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function launch(extra: string[] = []): Promise<Browser> {
  const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: { launch(options: { args: string[] }): Promise<Browser> } };
  return chromium.launch({
    args: [
      "--use-fake-device-for-media-stream=fps=30",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...extra,
    ],
  });
}

async function main(): Promise<void> {
  const [which = "all", json] = process.argv.slice(2);
  const names = which === "all" ? Object.keys(SCENARIOS) : which.split(",");
  for (const name of names) if (!SCENARIOS[name]) throw new Error(`no scenario "${name}": ${Object.keys(SCENARIOS).join(", ")}`);
  const server = await serve(await bundle());
  let failed = 0;
  try {
    for (const name of names) {
      const scenario = SCENARIOS[name]!;
      const options = { ...scenario.options, ...(json ? (JSON.parse(json) as Record<string, unknown>) : {}) };
      const browser = await launch(scenario.args);
      const before = loadavg();
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error.message)));
        page.on("console", (message) => {
          if (message.type?.() === "error" || process.env.OVERLAY_MEDIA_VERBOSE) console.log(`  [page] ${message.text?.()}`);
        });
        await page.goto(`http://127.0.0.1:${PORT}/`);
        if (options.click) await page.click("#go");
        const result = await page.evaluate(({ name, options }) => (globalThis as any).mediaTest[name](options), { name, options });
        console.log(`\n## ${name} ${JSON.stringify(options)}   load before ${before}, after ${loadavg()}`);
        if (process.env.OVERLAY_MEDIA_JSON) console.log(JSON.stringify(result, null, 1));
        const checks = scenario.check(result);
        if (errors.length) checks.push(["no uncaught errors in the page", false, errors.join("; ")]);
        for (const [label, ok, detail] of checks) {
          console.log(`${ok ? "  ok  " : "  FAIL"} ${label}  (${detail})`);
          if (!ok) failed++;
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
