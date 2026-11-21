/**
 * The client in a real browser (PLAN K3): `CoordinatorClient`, bundled as the overlay's page will
 * bundle it, in one headless Chromium page against the Node coordinator on port 4270. What the
 * contract suite checks of the client from Node, checked again where it will run: the browser's
 * own WebSocket, timers and clock.
 *
 * Playwright is not a dependency of the repository: found through NODE_PATH, as test/e2e does.
 * Without it the test says so and skips.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { startNodeCoordinator } from "./node";
import { ADMISSION_SECRET, SERVER_SECRET, leafCaps, ticketFor } from "./testkit";
import type { NodeCoordinator } from "./types";

const PORT = Number(process.env.OVERLAY_CLIENT_BROWSER_PORT ?? 4270);
const ROOM = "browser-client";

type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = {
  setContent(html: string): Promise<void>;
  addScriptTag(options: { content: string }): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
};

function playwright(): { chromium: { launch(): Promise<Browser> } } | null {
  try {
    return createRequire(import.meta.url)("playwright") as { chromium: { launch(): Promise<Browser> } };
  } catch {
    return null;
  }
}

const pw = playwright();

describe("the coordinator client in Chromium (PLAN K3)", () => {
  if (!pw) {
    it("needs Playwright", (t) => t.skip("playwright not found through NODE_PATH"));
    return;
  }
  const storage = new Map<string, Map<string, string>>();
  let server: NodeCoordinator | null = null;
  let browser: Browser | null = null;
  const start = async () => {
    server = await startNodeCoordinator({ port: PORT, admissionSecret: ADMISSION_SECRET, serverSecret: SERVER_SECRET, storage });
  };
  before(async () => {
    await start();
    browser = await pw.chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await server?.close();
  });

  it("joins, keeps the session clock, and comes back with the same PeerId after the coordinator restarts", { timeout: 60_000 }, async () => {
    const bundle = await build({
      stdin: {
        contents: `import { createCoordinatorClient } from "./index"; globalThis.createCoordinatorClient = createCoordinatorClient;`,
        resolveDir: import.meta.dirname,
        loader: "ts",
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome120",
      write: false,
      absWorkingDir: join(import.meta.dirname, "..", "..", ".."),
    });
    const page = await browser!.newPage();
    await page.setContent("<!doctype html><title>client</title>");
    await page.exposeFunction("overlayTicket", () => ticketFor("browser", "viewer", Date.now(), { room: ROOM }));
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const welcome = await page.evaluate(
      async ({ url, caps }) => {
        const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const clock = {
          now: () => performance.now(),
          setTimeout: (callback: () => void, ms: number) => {
            const timer = setTimeout(callback, ms);
            return () => clearTimeout(timer);
          },
          setInterval: (callback: () => void, ms: number) => {
            const timer = setInterval(callback, ms);
            return () => clearInterval(timer);
          },
        };
        const client = w.createCoordinatorClient({ url, ticket: () => w.overlayTicket(), clock, maxBackoffMs: 500 });
        w.client = client;
        w.offline = 0;
        w.welcomes = [];
        client.on("offline", () => w.offline++);
        client.on("welcome", (again: { peer: string }) => w.welcomes.push(again.peer));
        const first = await client.connect(caps);
        return { peer: first.peer as string, epochMs: first.epochMs as number };
      },
      { url: `ws://127.0.0.1:${PORT}/overlay/v1/rooms/${ROOM}/ws`, caps: leafCaps({ browser: "chromium" }) },
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    const clock = await page.evaluate(
      ({ epochMs }) => {
        const client = (window as unknown as { client: { sessionClock: { now(): number; uncertaintyMs: number } } }).client;
        return { error: Math.abs(client.sessionClock.now() - (Date.now() - epochMs)), uncertainty: client.sessionClock.uncertaintyMs };
      },
      { epochMs: welcome.epochMs },
    );
    console.log(`      in Chromium: clock error ${clock.error.toFixed(2)} ms, uncertainty ${clock.uncertainty.toFixed(2)} ms`);
    assert.ok(clock.error < 5 && clock.uncertainty < 5);

    await server!.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await page.evaluate(() => (window as unknown as { offline: number; client: { connected: boolean } }).client.connected, null), false);
    await start();
    const up = Date.now();
    let back = false;
    while (!back && Date.now() - up < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      back = await page.evaluate(() => (window as unknown as { client: { connected: boolean } }).client.connected, null);
    }
    const after = await page.evaluate(() => {
      const w = window as unknown as { offline: number; welcomes: string[] };
      return { offline: w.offline, welcomes: w.welcomes };
    }, null);
    console.log(`      in Chromium: reconnected ${Date.now() - up} ms after the restart`);
    assert.ok(back && Date.now() - up < 3_000);
    assert.equal(after.offline, 1);
    assert.equal(after.welcomes.at(-1), welcome.peer);
    await page.evaluate(() => (window as unknown as { client: { close(): void } }).client.close(), null);
  });
});
