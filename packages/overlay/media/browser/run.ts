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
import type { Scenarios } from "./page";

type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: (arg: { name: string; options: unknown }) => Promise<T>, arg: { name: string; options: unknown }): Promise<T>;
  on(event: string, listener: (value: { message?: string; text?: () => string; type?: () => string }) => void): void;
  click(selector: string): Promise<void>;
  close(): Promise<void>;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Check = [name: string, ok: boolean, detail: string];
/** What a scenario of the page returns. */
type ResultOf<Name extends keyof Scenarios> = Awaited<ReturnType<Scenarios[Name]>>;
type Scenario<Name extends keyof Scenarios> = { options: Record<string, unknown>; args?: string[]; check: (result: ResultOf<Name>) => Check[] };

const PORT = Number(process.env.OVERLAY_MEDIA_PORT ?? 4220);
const here = import.meta.dirname;
const loadavg = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");

/** A measurement that was not made fails every comparison. */
const n = (value: number | null | undefined): number => value ?? Number.NaN;

export const SCENARIOS: { [Name in keyof Scenarios]: Scenario<Name> } = {
  m1: {
    options: { seconds: 20 },
    check: (r) => [
      ["video bitrate within 15% of the target", Math.abs(n(r.videoKbps) - r.targetKbps) <= 0.15 * r.targetKbps, `${r.videoKbps} of ${r.targetKbps} kbps`],
      ["a keyframe every 60 frames", r.keyGapMin === 60 && r.keyGapMax === 60, `gaps ${r.keyGapMin}..${r.keyGapMax} over ${r.keyframes} keyframes`],
      ["every header obeys §9.2", r.headerProblems.length === 0, r.headerProblems.join("; ") || `${r.frames} frames`],
      ["capture to frame event p95 ≤ 40 ms", n(r.captureToFrameMs.p95) <= 40, `p50 ${r.captureToFrameMs.p50}, p95 ${r.captureToFrameMs.p95}, max ${r.captureToFrameMs.max} ms`],
      ["the encoder never holds more than 2 frames", r.maxEncoderFrames <= 2, `${r.maxEncoderFrames} at most; ${r.skippedBusy} skipped`],
      ["a decoder takes every frame", r.decodeErrors.length === 0 && r.decoded >= r.frames - 2, `${r.decoded} of ${r.frames}`],
      ["audio: 50 Opus frames a second, 20 ms apart, each announced twice", Math.abs(n(r.audioFps) - 50) < 1 && n(r.audioStepUs.min) >= 19000 && n(r.audioStepUs.max) <= 21000 && r.audioAnnounced >= 2 * r.audioFrames - 2, `${r.audioFps} fps, steps ${r.audioStepUs.min}..${r.audioStepUs.max} µs, ${r.audioAnnounced} announcements of ${r.audioFrames} frames, ${r.audioKbps} kbps`],
      ["no errors", r.errors.length === 0, r.errors.join("; ")],
    ],
  },
  m3: {
    options: { seconds: 20 },
    check: (r) => [
      [`glass-to-glass p95 ≤ 130 ms at D = ${r.playoutMinMs}`, n(r.glassToGlassMs.p95) <= 130, `p50 ${r.glassToGlassMs.p50}, p95 ${r.glassToGlassMs.p95}, max ${r.glassToGlassMs.max} ms; path ${r.pathMs}, delay ${r.appliedDelayMs}`],
      ["0 decode errors with 5% of layer 1 and 10% of layer 2 removed", r.decodeErrors.length === 0, `${r.decodeErrors.length} errors; ${r.loopback.framesRemoved} of ${r.loopback.framesSent} frames removed; ${r.player.video?.lost} lost, ${r.player.video?.dropped} dropped`],
      ["a <video> element shows the track", r.element !== null && r.element.width > 0 && n(r.elementFps) >= 15, `${r.element?.width}×${r.element?.height}, ${r.elementFps} fps presented, ${r.renderedFps} rendered, ${r.encodedFps} encoded`],
      ["no errors", r.errors.length === 0, r.errors.join("; ")],
    ],
  },
  clap: {
    options: { seconds: 12, lostAudioEvery: 37 },
    check: (r) => [
      ["every flash rendered and every click heard", r.flashes >= r.seconds - 1 && r.clicks >= r.seconds - 1, `${r.flashes} flashes, ${r.clicks} clicks`],
      ["click against flash within ±45 ms", r.pairs.filter((p) => p.clickMinusFlashMs !== null).length >= r.seconds - 1 && r.pairs.every((p) => p.clickMinusFlashMs === null || Math.abs(p.clickMinusFlashMs) <= 45), `${r.skewMs.min}..${r.skewMs.max} ms, p50 ${r.skewMs.p50}; opus adds ${r.opusDelayMs} ms; output latency ${r.outputLatencyMs} ms`],
      ["a lost audio frame is concealed and counted", Math.abs(n(r.concealedMs) - 20 * r.lostAudioFrames) <= 40, `${r.concealedMs} ms concealed for ${r.lostAudioFrames} frames lost`],
      ["never a gap of raw silence under 40 ms", r.rawSilencesUnder40Ms === 0, `${r.rawSilencesUnder40Ms}`],
      ["with every frame sent twice, nothing played twice", r.audio !== null && r.audio.late === 0 && r.audio.repeats === 0 && r.audio.drops === 0, JSON.stringify(r.audio)],
      ["no errors", r.errors.length === 0, r.errors.join("; ")],
    ],
  },
  m5: {
    options: { seconds: 12 },
    check: (r) => [
      ["light and decoding viewers within 15 ms at p50", Math.abs(n(r.light.p50Ms) - n(r.decoding.p50Ms)) <= 15, `light ${r.light.p50Ms}, decoding ${r.decoding.p50Ms} ms`],
      ["decoding: latency normal again within 300 ms of the parent's death", n(r.decoding.normalAfterKillMs) <= 300, `${r.decoding.normalAfterKillMs} ms; freeze ${r.decoding.freezeMs} ms; ${r.decoding.lateFramesAfterKill} late frames`],
      ["light: latency normal again within 300 ms of the parent's death", n(r.light.normalAfterKillMs) <= 300, `${r.light.normalAfterKillMs} ms; freeze ${r.light.freezeMs} ms; ${r.light.lateFramesAfterKill} late frames`],
      ["no errors", r.errors.length === 0, r.errors.join("; ")],
    ],
  },
  deps: {
    options: { seconds: 6 },
    check: (r) => [
      ["every header obeys §9.2", r.headerProblems.length === 0, r.headerProblems.join("; ") || r.pattern.join(" ")],
      ["the control (a needed frame removed, its dependents kept) is noticed", r.controlDifferent > 0, `${r.controlDifferent} frames decode differently`],
      ...r.results.map((p): Check => [`${p.policy}: what the headers allow decodes, to the same pixels`, p.errors.length === 0 && p.decoded === p.kept && p.differentPixels === 0, `${p.decoded} of ${p.kept} decoded (of ${p.of}); ${p.differentPixels} differ ${p.firstDifferent.join(",")} ${p.errors.join("; ")}`]),
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
  const known = Object.keys(SCENARIOS) as (keyof Scenarios)[];
  const names = which === "all" ? known : (which.split(",") as (keyof Scenarios)[]);
  for (const name of names) if (!known.includes(name)) throw new Error(`no scenario "${name}": ${known.join(", ")}`);
  const server = await serve(await bundle());
  let failed = 0;
  try {
    for (const name of names) {
      const scenario = SCENARIOS[name] as Scenario<typeof name>;
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
        const result = await page.evaluate(({ name, options }) => (globalThis as unknown as { mediaTest: Record<string, (options: unknown) => Promise<unknown>> }).mediaTest[name]!(options), { name, options });
        console.log(`\n## ${name} ${JSON.stringify(options)}   load before ${before}, after ${loadavg()}`);
        if (process.env.OVERLAY_MEDIA_JSON) console.log(JSON.stringify(result, null, 1));
        const checks = scenario.check(result as ResultOf<typeof name>);
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
