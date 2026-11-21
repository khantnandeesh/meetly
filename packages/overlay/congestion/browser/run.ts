/**
 * The browser half of C3's acceptance: eight peers, each a headless Chromium page, linked by real
 * WebRTC data channels in the tree of ../slowChild.test.ts, with one child's link capped at
 * 900 kbps mid-run. It checks what the simulated test checks, on a real clock: the slow child
 * loses its enhancement layers within the reaction time, and its siblings and their subtrees
 * keep every frame. Then it runs one uplink probe against a capped link (C5).
 *
 * How to run it is in ../README.md. It needs Playwright on NODE_PATH, as test/e2e does.
 *
 * What is and is not real is listed at the top of ./page.ts. This is congestion's own check, kept
 * small (8 peers, about 60 s); E-harness's **slow-child** scenario is the one PLAN accepts C3 on,
 * and replaces this when the node and the impairment shim exist.
 *
 * Port 4240 (E-congestion's range). Everything started here is stopped here.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PagePeer, PeerConfig } from "./page";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ECONG_PORT ?? 4240);
const CAP_KBPS = 900;

const TREE: Pick<PeerConfig, "id" | "parent">[] = [
  { id: "src", parent: null },
  { id: "a", parent: "src" },
  { id: "b", parent: "src" },
  { id: "slow", parent: "src" },
  { id: "a1", parent: "a" },
  { id: "a2", parent: "a" },
  { id: "b1", parent: "b" },
  { id: "s1", parent: "slow" },
];

type Report = ReturnType<PagePeer["report"]>;
type Check = { name: string; pass: boolean; value: unknown; limit: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const loadAvg = (): string => readFileSync("/proc/loadavg", "utf8").trim();

async function main(): Promise<number> {
  const esbuild = require("esbuild") as typeof import("esbuild");
  const { chromium } = require("playwright") as { chromium: { launch(options: object): Promise<Browser> } };
  const bundle = await esbuild.build({
    entryPoints: [join(here, "page.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const script = bundle.outputFiles[0].text;

  const server = createServer((request, response) => {
    if (request.url === "/page.js") response.writeHead(200, { "content-type": "text/javascript" }).end(script);
    else response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><title>congestion</title><script src="/page.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  // Seven of the eight pages are never in front: their timers must not be slowed for it. (The
  // engine itself will take its clock from a Worker, SPEC [D16]; this page uses plain timers.)
  const browser = await chromium.launch({
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  });
  const loadBefore = loadAvg();
  try {
    const context = await browser.newContext();
    const run = `r${process.pid}`;
    const epochMs = Date.now();
    const depthOf = (id: string): number => {
      const parent = TREE.find((peer) => peer.id === id)!.parent;
      return parent === null ? 0 : 1 + depthOf(parent);
    };
    const pages = new Map<string, Page>();
    for (const peer of TREE) {
      const page = await context.newPage();
      page.on("pageerror", (error: Error) => console.error(`[${peer.id}] ${error.message}`));
      await page.goto(`http://127.0.0.1:${PORT}/`);
      const config: PeerConfig = { run, epochMs, ...peer, depth: depthOf(peer.id), children: TREE.filter((other) => other.parent === peer.id).map((other) => other.id) };
      await page.evaluate((c: PeerConfig) => window.__econg.create(c), config);
      pages.set(peer.id, page);
    }
    const on = (id: string): Page => pages.get(id)!;
    const linkStart = Date.now();
    await Promise.all([...pages.values()].map((page) => page.evaluate(() => window.__econg.peer!.connect())));
    const linkMs = Date.now() - linkStart;
    const startAt = (await on("src").evaluate(() => window.__econg.peer!.now())) + 200;
    await Promise.all([...pages.values()].map((page) => page.evaluate((at: number) => window.__econg.peer!.run(at), startAt)));
    const reports = async (from: number, to: number): Promise<Map<string, Report>> =>
      new Map(
        await Promise.all([...pages].map(async ([id, page]) => [id, await page.evaluate(([f, t]: number[]) => window.__econg.peer!.report(f, t), [from, to])] as const)),
      );

    // 6 s clean, then 900 kbps for 20 s, 3 Mbps for 12 s, 1.1 Mbps for 10 s.
    await sleep(6200);
    const capAt = await on("src").evaluate((kbps: number) => {
      window.__econg.peer!.capDown("slow", kbps);
      return window.__econg.peer!.now();
    }, CAP_KBPS);
    await sleep(20_000);
    const end = await on("src").evaluate(() => window.__econg.peer!.now());
    const before = await reports(startAt + 1000, capAt - 300);
    const after = await reports(capAt, end - 500);
    const settled = await reports(capAt + 3000, end - 500);

    // C6: the cap goes up to 3 Mbps, room for the whole stream. The top layer comes back.
    const roomAt = await on("src").evaluate(() => {
      window.__econg.peer!.capDown("slow", 3000);
      return window.__econg.peer!.now();
    });
    await sleep(12_000);
    const roomEnd = await on("src").evaluate(() => window.__econg.peer!.now());
    const room = await reports(roomAt, roomEnd);

    // Rule 3 (integrator): just under the stream, 1.1 Mbps, the child settles on the middle layer too.
    const nearAt = await on("src").evaluate(() => {
      window.__econg.peer!.capDown("slow", 1100);
      return window.__econg.peer!.now();
    });
    await sleep(10_000);
    const nearEnd = await on("src").evaluate(() => window.__econg.peer!.now());
    const near = await reports(nearAt + 3000, nearEnd - 500);
    const nearDrops = near.get("src")!.children.find((child) => child.id === "slow")!.caps.filter((change) => change.at >= nearAt);

    // C5: a1's uplink to its parent capped at 3 Mbps, probed at 8.
    await on("a1").evaluate(() => window.__econg.peer!.capUp(3000));
    const probeFrom = await on("a1").evaluate(() => window.__econg.peer!.now());
    const spareKbps = await on("a1").evaluate(() => window.__econg.peer!.probe(8000, 1000));
    const probeTo = await on("a1").evaluate(() => window.__econg.peer!.now());
    await sleep(300);
    const duringProbe = await reports(probeFrom, probeTo);

    const slowPort = after.get("src")!.children.find((child) => child.id === "slow")!;
    const drops = slowPort.caps.filter((change) => change.at >= capAt);
    // If the cap went down twice, what the link looked like in the window before the second.
    const beforeSecondDrop =
      drops.length > 1
        ? (await on("src").evaluate(([from, to]: number[]) => window.__econg.peer!.trace("slow", from, to), [drops[1].at - 1200, drops[1].at + 1])).map((entry) => [
            Math.round(entry.at - drops[1].at),
            entry.state[0],
            Math.round(entry.bufferedBytes),
            +entry.lossPct.toFixed(1),
          ])
        : null;
    const checks: Check[] = [];
    const check = (name: string, pass: boolean, value: unknown, limit: string): void => void checks.push({ name, pass, value, limit });

    check(
      "every peer got every layer before the cap",
      [...before.values()].every((r) => r.stats === null || r.stats.decodable >= r.stats.captured - 2),
      Object.fromEntries([...before].map(([id, r]) => [id, r.stats?.video])),
      "all frames, give or take the window's edges",
    );
    check(
      "the slow child's top layer was dropped",
      drops.length >= 1 && drops[0].maxTemporal === 1 && drops[0].reason === "congestion",
      drops[0],
      "a drop to layer 1, for congestion",
    );
    check(
      "first drop after the cap, ms",
      drops.length >= 1 && drops[0].at - capAt <= 1000,
      drops.length ? Math.round(drops[0].at - capAt) : null,
      "<= 1000 (simulated: 700)",
    );
    check(
      "the cap settled on the middle layer, with one drop (rule 3's window)",
      drops.length === 1 && drops[0].maxTemporal === 1 && drops[0].at - capAt <= 2000,
      drops.map((change) => `${change.maxTemporal} at +${Math.round(change.at - capAt)}`),
      "one drop, to layer 1, within 2000 ms (PLAN C3)",
    );
    check("the slow child is not starved", slowPort.starvedAt.length === 0, slowPort.starvedAt, "none");
    const slow = settled.get("slow")!.stats!;
    check(
      "the slow child got the base and middle layers, whole",
      Math.abs(slow.video[0] - slow.captured / 4) <= 2 && Math.abs(slow.video[1] - slow.captured / 4) <= 2 && slow.video[2] === 0 && slow.decodable >= slow.video[0] + slow.video[1] - 1,
      slow.video,
      `about ${Math.round(slow.captured / 4)} frames of each of layers 0 and 1, none of layer 2`,
    );
    check(
      "the slow child's audio never stopped",
      after.get("slow")!.stats!.audio >= after.get("slow")!.stats!.audioCaptured - 1,
      `${after.get("slow")!.stats!.audio} of ${after.get("slow")!.stats!.audioCaptured}`,
      "all",
    );
    for (const id of ["a", "b", "a1", "a2", "b1"]) {
      const was = before.get(id)!.stats!;
      const is = after.get(id)!.stats!;
      check(`${id} kept every frame of every layer`, is.decodable >= is.captured - 2 && is.video[2] >= is.captured / 2 - 2, `${is.decodable} of ${is.captured}`, "all");
      check(`${id}: latency p95 moved by, ms`, Math.abs(is.delayMs.p95 - was.delayMs.p95) < 10, +(is.delayMs.p95 - was.delayMs.p95).toFixed(2), "< 10 (PLAN C3)");
    }
    for (const id of ["a", "b"]) {
      const caps = after.get("src")!.children.find((child) => child.id === id)!.caps;
      check(`${id}'s cap never moved`, caps.length === 1, caps.length - 1, "0 changes");
    }
    const heard = after.get("slow")!.layersHeard.filter((entry) => entry.at >= capAt);
    check(
      "the slow child was told of each change (`layers`)",
      heard.length === drops.length && heard.every((entry, i) => entry.maxTemporal === drops[i].maxTemporal && entry.reason === drops[i].reason),
      heard.map((entry) => `${entry.maxTemporal} ${entry.reason} +${Math.round(entry.at - drops[heard.indexOf(entry)]?.at)} ms`),
      "one message per change, as sent",
    );
    const rises = room.get("src")!.children.find((child) => child.id === "slow")!.caps.filter((change) => change.at >= roomAt);
    check(
      "with room again (3 Mbps), the slow child's top layer came back, ms",
      rises.length === 1 && rises[0].maxTemporal === 2 && rises[0].at - roomAt <= 7000,
      rises.map((change) => `${change.maxTemporal} at +${Math.round(change.at - roomAt)}`),
      "the top layer, within 7 s (5 s ok after the last keyframe it struggled with)",
    );
    const nearSlow = near.get("slow")!.stats!;
    check(
      "at 1.1 Mbps, one drop, to the middle layer, within 2 s",
      nearDrops.length === 1 && nearDrops[0].maxTemporal === 1 && nearDrops[0].at - nearAt <= 2000,
      nearDrops.map((change) => `${change.maxTemporal} at +${Math.round(change.at - nearAt)}`),
      "one drop, to layer 1 (simulated: +1,200 ms)",
    );
    check(
      "at 1.1 Mbps, the base and middle layers, whole",
      Math.abs(nearSlow.video[1] - nearSlow.captured / 4) <= 2 && nearSlow.video[2] === 0 && nearSlow.decodable >= nearSlow.video[0] + nearSlow.video[1] - 1,
      nearSlow.video,
      "layers 0 and 1, none of layer 2",
    );
    check("uplink probe against a 3 Mbps cap, kbps", Math.abs(spareKbps - 3000) <= 750, spareKbps, "3000 ± 25% (PLAN C5)");
    const a1 = duringProbe.get("a1")!.stats!;
    check("the prober kept receiving during its probe", a1.decodable >= a1.captured - 2, `${a1.decodable} of ${a1.captured}`, "all");

    const pick = (r: Report) =>
      r.stats && {
        video: r.stats.video,
        decodable: r.stats.decodable,
        captured: r.stats.captured,
        delayMs: Object.fromEntries(Object.entries(r.stats.delayMs).map(([k, v]) => [k, +v.toFixed(2)])),
        audio: `${r.stats.audio}/${r.stats.audioCaptured}`,
        audioDelayMaxMs: +r.stats.audioDelayMaxMs.toFixed(1),
      };
    const result = {
      loadAvg: { before: loadBefore, after: loadAvg() },
      linkSetupMs: linkMs,
      capKbps: CAP_KBPS,
      slowChild: {
        caps: slowPort.caps.map((change) => ({ msAfterCap: Math.round(change.at - capAt), maxTemporal: change.maxTemporal, reason: change.reason })),
        firstCongestedMsAfterCap: slowPort.firstCongestedAt === null ? null : Math.round(slowPort.firstCongestedAt - capAt),
        refused: slowPort.refused,
        droppedByTheCap: slowPort.dropped,
        estimate: slowPort.estimate,
      },
      before: Object.fromEntries([...before].map(([id, r]) => [id, pick(r)])),
      afterCap: Object.fromEntries([...after].map(([id, r]) => [id, pick(r)])),
      afterCapSettled: { slow: pick(settled.get("slow")!), s1: pick(settled.get("s1")!) },
      withRoomAgain: { caps: rises.map((change) => ({ msAfter: Math.round(change.at - roomAt), maxTemporal: change.maxTemporal })), slow: pick(room.get("slow")!) },
      atNearlyTheStream: { capKbps: 1100, caps: nearDrops.map((change) => ({ msAfter: Math.round(change.at - nearAt), maxTemporal: change.maxTemporal })), slow: pick(near.get("slow")!) },
      probe: { capKbps: 3000, targetKbps: 8000, durationMs: 1000, spareKbps },
      timerLagMaxMs: Object.fromEntries([...after].map(([id, r]) => [id, +r.lagMaxMs.toFixed(1)])),
      beforeSecondDrop,
      checks,
    };
    console.log(JSON.stringify(result, null, 1));
    const failed = checks.filter((entry) => !entry.pass);
    console.log(failed.length === 0 ? `\nPASS: ${checks.length} checks` : `\nFAIL: ${failed.map((entry) => entry.name).join("; ")}`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The little of Playwright's types this file uses: the package is not a dependency of the repository (PLAN §3). */
type Page = {
  goto(url: string): Promise<unknown>;
  on(event: "pageerror", listener: (error: Error) => void): void;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
};
type Browser = { newContext(): Promise<{ newPage(): Promise<Page> }>; close(): Promise<void> };

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
