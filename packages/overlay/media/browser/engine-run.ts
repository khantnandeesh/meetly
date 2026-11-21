/**
 * Drives ./engine-av.ts on overlay-integration (this branch has no engine to drive: it is copied
 * there by .github/workflows/overlay-media.yml): the package's Node coordinator, one source and
 * `viewers` viewers under it (`fanout` children of the source), each sender's links impaired by a
 * profile (the harness's shim, bundled in). Ports 4225 (coordinator) and 4226 (page): E-media's.
 *
 *   node --experimental-transform-types --import ./test/register.mjs packages/overlay/media/browser/engine-run.ts '{"program":"busy","viewers":2,"fanout":2,"profile":"clean","seconds":30}'
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { signTicket } from "../../protocol";
import { startNodeCoordinator } from "../../coordinator/node";

/** As the harness launches its peers. */
const CHROMIUM_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];

type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => Promise<T> | T, arg: A): Promise<T>;
  exposeFunction(name: string, fn: () => unknown): Promise<void>;
  on(event: string, listener: (value: { message?: string; text?: () => string; type?: () => string }) => void): void;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const options = { program: "av", viewers: 2, fanout: 2, gapMs: 2000, profile: "clean", seconds: 25, sourceProfile: "", width: 640, height: 360, bitrateKbps: 600, ...(process.argv[2] ? JSON.parse(process.argv[2]) : {}) } as {
  program: string;
  viewers: number;
  fanout: number;
  gapMs: number;
  profile: string;
  seconds: number;
  sourceProfile: string;
  width: number;
  height: number;
  bitrateKbps: number;
};
const ADMISSION = "media-av-admission-secret-0123456789";
const SERVER = "media-av-server-secret-0123456789";
const room = "med-iaav-run";
const loadavg = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const coordinator = await startNodeCoordinator({ port: 4225, host: "127.0.0.1", admissionSecret: ADMISSION, serverSecret: SERVER, params: { sourceFanout: options.fanout, maxFanout: 1, probationMs: 3000 } as Parameters<typeof startNodeCoordinator>[0]["params"] });
// The page, with the harness's impairment shim put where it looks for it.
const entry = `import { createImpairment, emptyImpairmentCounters } from "../../harness/impairment";
import { PROFILES } from "../../harness/scenarios";
globalThis.__impair = { createImpairment, emptyImpairmentCounters, PROFILES };
import "./engine-av.ts";`;
const script = (await build({ stdin: { contents: entry, resolveDir: import.meta.dirname, loader: "ts" }, bundle: true, format: "iife", target: "es2022", write: false, logLevel: "silent" })).outputFiles[0]!.text;
const server = createServer((request, response) => {
  if (request.url === "/page.js") response.writeHead(200, { "content-type": "text/javascript" }).end(script);
  else response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><title>av</title><script src="/page.js"></script>`);
});
await new Promise<void>((resolve) => server.listen(4226, "127.0.0.1", resolve));
const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: { launch(o: { args: string[] }): Promise<Browser> } };
const browser = await chromium.launch({ args: [...CHROMIUM_ARGS, "--autoplay-policy=no-user-gesture-required"] });
let nonce = 0;
const ticket = (index: number, role: "source" | "viewer") =>
  signTicket({ v: 1, room, identity: `av-${index}`, name: `peer ${index}`, role, exp: Math.floor(Date.now() / 1000) + 60, nonce: `av-${index}-${nonce++}-nonce`.padEnd(8, "0") }, ADMISSION);

const pages: Page[] = [];
async function start(index: number) {
  const role = index === 0 ? "source" : "viewer";
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type?.() === "error") console.log(`  [${index}] ${m.text?.()}`);
  });
  page.on("pageerror", (e) => console.log(`  [${index}] page error ${e.message}`));
  await page.exposeFunction("__overlayTicket", () => ticket(index, role));
  await page.goto("http://127.0.0.1:4226/");
  const o = { coordinatorUrl: coordinator.url, room, ticket: await ticket(index, role), profile: index === 0 ? options.sourceProfile || options.profile : options.profile, seed: 7, index, program: options.program, width: options.width, height: options.height, bitrateKbps: options.bitrateKbps };
  await page.evaluate((arg) => (window as unknown as { __av: Record<string, (a: unknown) => Promise<unknown>> }).__av[arg.role]!(arg.o), { role, o });
  pages.push(page);
}

const before = loadavg();
try {
  await start(0);
  for (let i = 1; i <= options.viewers; i++) {
    await start(i);
    // Long enough for this viewer to pass probation and be probed, so the next one can sit below it.
    await sleep(i < options.viewers ? options.gapMs : 0);
  }
  await sleep(options.seconds * 1000);
  console.log(`\n${options.program}: ${options.viewers} viewers, ${options.width}x${options.height} at ${options.bitrateKbps} kbps, profile ${options.profile}; load before ${before}, after ${loadavg()}`);
  for (let i = 1; i < pages.length; i++) {
    // The page measures the last part of the run, once every viewer has joined.
    const result = await pages[i]!.evaluate((seconds) => (window as unknown as { __av: { results(f: number): unknown } }).__av.results(seconds), options.seconds - 5);
    console.log(`viewer ${i}: ${JSON.stringify(result)}`);
  }
} finally {
  await browser.close();
  server.close();
  await coordinator.close();
}
