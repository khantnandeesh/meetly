/**
 * The topology bench: small runs of real peers in headless Chromium, for PLAN T3–T4's browser
 * numbers before the harness exists. One browser, one context per peer, host candidates only, on
 * loopback, as the proof (SPEC §17) ran. This script is the coordinator: it places peers by a
 * fixed table, answers `need` from the peers' own status, and relays signalling.
 *
 *   NODE_PATH=<where playwright is> node --experimental-transform-types \
 *     --import ./test/register.mjs packages/overlay/topology/bench/run.ts [scenario] [repeats]
 *
 * Scenarios: tree-warm, tree-cold, chain-kill, tree-leave, chain (latency per hop). Each prints
 * one JSON line per repeat, then a summary. At most 8 pages; nothing listens on a port (the page
 * is served by request interception on 127.0.0.1:4200, inside E-transport's range).
 *
 * Owner: E-transport+topology.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Assignment, MetricsEvent, PeerHint, PeerId, SignalData } from "../../protocol";
import type { NodeStats, NodeStatus } from "../types";

type Page = {
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  close(): Promise<void>;
  on(event: "pageerror" | "console", listener: (value: { message?: string; text?(): string }) => void): void;
};
type Context = { newPage(): Promise<Page>; route(url: string, handler: (route: { fulfill(options: { contentType: string; body: string; headers?: Record<string, string> }): Promise<void> }) => void): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };
type Chromium = { launch(options: { args: string[] }): Promise<Browser> };

// Neither is imported: Playwright is not a dependency (NODE_PATH finds it, as for test/e2e), and
// esbuild may come from NODE_PATH too where node_modules predates it.
const load = createRequire(import.meta.url);
const { chromium } = load("playwright") as { chromium: Chromium };
const { build } = load("esbuild") as { build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };
const ORIGIN = "http://127.0.0.1:4200";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Dump = { video: [number, number, number, number][]; metrics: MetricsEvent[]; stats: NodeStats[]; errors: string[]; status: NodeStatus; now: number };
type Slot = { parent: string; backup: string | null; role: "relay" | "leaf" };
type Scenario = { peers: Record<string, Slot>; depth: Record<string, number>; kill?: string; leave?: string; backups: boolean };

const relay = (parent: string, backup: string | null = null): Slot => ({ parent, backup, role: "relay" });
const leaf = (parent: string, backup: string | null = null): Slot => ({ parent, backup, role: "leaf" });

/** The proof's tree: the source feeds 1 and 2; 1 feeds 3 and 4; 2 feeds 5 and 6; each leaf stands by on the other relay. */
const TREE = { "1": relay("0"), "2": relay("0"), "3": leaf("1", "2"), "4": leaf("1", "2"), "5": leaf("2", "1"), "6": leaf("2", "1") };
const TREE_DEPTH = { "0": 0, "1": 1, "2": 1, "3": 2, "4": 2, "5": 2, "6": 2 };

const SCENARIOS: Record<string, Scenario> = {
  "tree-warm": { peers: TREE, depth: TREE_DEPTH, kill: "1", backups: true },
  "tree-cold": { peers: Object.fromEntries(Object.entries(TREE).map(([id, slot]) => [id, { ...slot, backup: null }])), depth: TREE_DEPTH, kill: "1", backups: false },
  "tree-leave": { peers: TREE, depth: TREE_DEPTH, leave: "1", backups: true },
  // PLAN T4's chain-kill: depth 3, the depth-1 relay killed. Peer 2 stands by on the source.
  "chain-kill": { peers: { "1": relay("0"), "2": relay("1", "0"), "3": leaf("2"), "4": leaf("2"), "5": leaf("2") }, depth: { "0": 0, "1": 1, "2": 2, "3": 3, "4": 3, "5": 3 }, kill: "1", backups: false },
  chain: {
    peers: { "1": relay("0"), "2": relay("1"), "3": relay("2"), "4": relay("3"), "5": relay("4"), "6": leaf("5") },
    depth: { "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6 },
    backups: false,
  },
};

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./page.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

const quantile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const round = (x: number | null | undefined, digits = 1) => (x === null || x === undefined ? null : Number(x.toFixed(digits)));

async function run(name: string, scenario: Scenario, script: string) {
  const browser = await chromium.launch({
    args: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  const html = `<!doctype html><meta charset=utf-8><title>overlay bench</title><script>${script}</script>`;
  const ids = ["0", ...Object.keys(scenario.peers)];
  const pages = new Map<string, Page>();
  const statuses = new Map<string, NodeStatus>();
  const dead = new Set<string>();
  const calls: { at: number; peer: string; what: string }[] = [];
  const epochMs = Date.now();
  try {
    const hintOf = (id: string): PeerHint => ({ peer: id, depth: statuses.get(id)?.depth ?? scenario.depth[id] ?? 1, free: Math.max(1, statuses.get(id)?.freeSlots ?? 1) });
    /** The coordinator's placement (SPEC §6.6), from what the peers last said of themselves. */
    const place = (asker: string, want: "parent" | "backup", exclude: string[], stream: number, stripe: number): Assignment | null => {
      if (want === "backup" && !scenario.backups) return null;
      const askerParent = statuses.get(asker)?.stripes[0]?.parent ?? null;
      const usable = [...statuses.entries()]
        .filter(([id, status]) => !dead.has(id) && id !== asker && !exclude.includes(id) && status.role !== "leaf" && status.freeSlots > 0 && !status.path.includes(asker))
        .filter(([, status]) => status.role === "source" || status.stripes[0]?.state === "active")
        .sort(([a, x], [b, y]) => x.depth - y.depth || (a < b ? -1 : 1));
      const apart = usable.filter(([, status]) => askerParent === null || !status.path.includes(askerParent));
      const chosen = (want === "backup" ? (apart.length > 0 ? apart : usable) : usable).slice(0, 3).map(([id]) => hintOf(id));
      return want === "backup" ? { stream, stripe, parents: [], backups: chosen } : { stream, stripe, parents: chosen, backups: [] };
    };

    for (const id of ids) {
      const context = await browser.newContext();
      await context.route(`${ORIGIN}/**`, (route) =>
          // Cross-origin isolated, so that performance.now() has 5 µs resolution rather than 100: forwarding takes less than 100.
          void route.fulfill({ contentType: "text/html", body: html, headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } }));
      const page = await context.newPage();
      page.on("pageerror", (error) => console.error(`page ${id}:`, error.message));
      await page.exposeFunction("benchSignal", (to: PeerId, data: SignalData) => {
        const target = pages.get(to);
        if (target && !dead.has(to)) void target.evaluate(([from, signal]) => window.bench.signal(from, signal), [id, data] as [string, SignalData]).catch(() => {});
      });
      await page.exposeFunction("benchNeed", async (stream: number, stripe: number, want: "parent" | "backup", exclude: PeerId[]) => {
        calls.push({ at: Date.now(), peer: id, what: `need:${want}` });
        return place(id, want, exclude, stream, stripe);
      });
      await page.exposeFunction("benchReport", (event: string) => {
        calls.push({ at: Date.now(), peer: id, what: `report:${event}` });
      });
      await page.exposeFunction("benchStatus", (status: string) => {
        statuses.set(id, JSON.parse(status) as NodeStatus);
      });
      await page.goto(`${ORIGIN}/peer/${id}`);
      pages.set(id, page);
    }

    const init = (id: string, assignments: Assignment[]) =>
      pages.get(id)!.evaluate((options) => window.bench.init(options), { self: id, role: id === "0" ? ("source" as const) : scenario.peers[id].role, epochMs, assignments, warm: scenario.backups });
    await init("0", []);
    await pages.get("0")!.evaluate(() => window.bench.publish());
    await sleep(2500);
    const joinMs: Record<string, number> = {};
    for (const id of ids.slice(1)) {
      const slot = scenario.peers[id];
      const started = Date.now();
      await init(id, [{ stream: 0, stripe: 0, parents: [hintOf(slot.parent)], backups: slot.backup ? [hintOf(slot.backup)] : [] }]);
      for (let i = 0; i < 150 && statuses.get(id)?.stripes[0]?.state !== "active"; i++) await sleep(20);
      joinMs[id] = Date.now() - started;
      await sleep(300);
    }
    // Steady: backups found, rates settled.
    await sleep(5000);

    const event = scenario.kill ?? scenario.leave ?? null;
    let eventAt: number | null = null;
    if (scenario.kill) {
      eventAt = Date.now();
      dead.add(scenario.kill);
      // A tab that is killed: it says nothing more (SPEC §7.4).
      await pages.get(scenario.kill)!.close();
      await sleep(4000);
    } else if (scenario.leave) {
      eventAt = Date.now();
      await pages.get(scenario.leave)!.evaluate(() => window.bench.leave());
      dead.add(scenario.leave);
      await sleep(4000);
    }

    const dumps = new Map<string, Dump>();
    for (const id of ids) if (!(scenario.kill === id)) dumps.set(id, await pages.get(id)!.evaluate(() => window.bench.dump()));

    // Latency, capture to whole, over the five steady seconds before the event (or the end).
    const until = eventAt ?? dumps.get("0")!.now;
    const latencyByDepth: Record<number, number[]> = {};
    for (const [id, dump] of dumps) {
      if (id === "0" || id === event) continue;
      const steady = dump.video.filter(([, at]) => at > until - 5000 && at <= until).map(([, at, captureUs]) => at - epochMs - captureUs / 1000);
      (latencyByDepth[scenario.depth[id]] ??= []).push(...steady);
    }
    const forward = [...dumps.entries()]
      .filter(([id]) => scenario.peers[id]?.role === "relay")
      .flatMap(([, dump]) => dump.stats.filter((stats) => stats.relay && stats.relay.children > 0).map((stats) => stats.relay!.forwardP50Us));

    const affected = [];
    if (eventAt !== null) {
      for (const [id, dump] of dumps) {
        const repairs = dump.metrics.filter((m): m is Extract<MetricsEvent, { t: "repair" }> => m.t === "repair");
        if (repairs.length === 0) continue;
        const [repair] = repairs;
        // The same freeze, read from the page's own log of whole frames: the longest gap between
        // two frames, from the last before the event to one second after media came back.
        const frames = dump.video.filter(([, at]) => at > eventAt! - 3000 && at < eventAt! + 3000).sort((a, b) => a[1] - b[1]);
        const before = frames.filter(([, at]) => at <= eventAt!);
        const window = [...before.slice(-1), ...frames.filter(([, at]) => at > eventAt! && at < eventAt! + 1500)];
        let gap = 0;
        for (let i = 1; i < window.length; i++) gap = Math.max(gap, window[i][1] - window[i - 1][1]);
        const seen = new Set(dump.video.map(([frameId]) => frameId));
        const lo = before.at(-1)?.[0] ?? 0;
        const hi = frames.at(-1)?.[0] ?? lo;
        let lost = 0;
        for (let f = lo; f <= hi; f++) if (!seen.has(f)) lost++;
        const coordinatorBeforeMedia = calls.filter((call) => call.peer === id && call.at >= eventAt! && repair.firstPacket !== null && call.at - epochMs < repair.firstPacket).map((call) => call.what);
        affected.push({
          id,
          depth: scenario.depth[id],
          kind: repair.kind,
          repairs: repairs.length,
          detectedAfterSilenceMs: round(repair.detected - repair.lastHeard),
          detectedAfterEventMs: round(repair.detected - (eventAt - epochMs)),
          firstPacketAfterEventMs: repair.firstPacket === null ? null : round(repair.firstPacket - (eventAt - epochMs)),
          freezeMs: round(repair.freezeMs),
          framesLost: repair.framesLost,
          pageGapMs: round(gap),
          pageFramesLost: lost,
          usedCoordinator: repair.usedCoordinator,
          coordinatorBeforeMedia,
          parentAfter: dump.status.stripes[0]?.parent,
        });
      }
    }
    const errors = [...dumps.values()].flatMap((dump) => dump.errors);
    return {
      name,
      event: event ? `${scenario.kill ? "kill" : "leave"} ${event}` : null,
      joinMs,
      latencyP50ByDepth: Object.fromEntries(Object.entries(latencyByDepth).map(([depth, values]) => [depth, round(quantile(values, 0.5))])),
      forwardP50Us: round(quantile(forward, 0.5), 0),
      forwardP95OfP50sUs: round(quantile(forward, 0.95), 0),
      affected,
      errors,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const which = process.argv[2] ?? "tree-warm";
  const repeats = Number(process.argv[3] ?? 1);
  const scenario = SCENARIOS[which];
  if (!scenario) throw new Error(`no scenario ${which}: ${Object.keys(SCENARIOS).join(", ")}`);
  const script = await bundle();
  const results = [];
  for (let i = 0; i < repeats; i++) {
    const load = (await import("node:fs")).readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
    const result = { ...(await run(which, scenario, script)), loadAvg: load };
    console.log(JSON.stringify(result));
    results.push(result);
  }
  const freezes = results.flatMap((r) => r.affected.map((a) => a.freezeMs ?? 0));
  const lost = results.flatMap((r) => r.affected.map((a) => a.framesLost + a.pageFramesLost));
  console.log(
    JSON.stringify({
      summary: which,
      runs: repeats,
      repairs: freezes.length,
      freezeP50: quantile(freezes, 0.5),
      freezeP95: quantile(freezes, 0.95),
      freezeMax: Math.max(...freezes, 0),
      framesLostTotal: lost.reduce((a, b) => a + b, 0),
      forwardP50Us: quantile(results.map((r) => r.forwardP50Us ?? 0), 0.5),
    }),
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
