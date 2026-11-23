/**
 * `runShard`: this process's share of a swarm. It starts the coordinator if the run has none
 * yet (shard 0 of a run whose coordinator is not "external"), opens one page per peer in headless
 * Chromium, has each join at its time, carries out its share of the churn script, collects every
 * metrics sample, and measures itself: its own event-loop lag, its pages', and the machine's
 * load, so a run that starved its machine is reported as invalid and not as a slow overlay.
 *
 * Playwright is not a dependency of the repository: it is found through NODE_PATH (README).
 *
 * Owner: E-harness.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { availableParallelism, loadavg } from "node:os";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { decodeMetricsSample, emptyHistogram, latencyBucket, mergeHistogram, signTicket, type MetricsSample, type PeerId } from "../protocol";
import { startNodeCoordinator } from "../coordinator/node";
import type { NodeCoordinator } from "../coordinator/types";
import { busyVideoFile } from "./busyVideo";
import { seededRandom } from "./clock";
import { bundlePage, servePage, type PageServer } from "./page/build";
import { addLinks } from "./report";
import { churnSteps, fillS, joinAtS, profileOf, shardOf, PROFILES, type ChurnStep } from "./scenarios";
import { startStandinCoordinator, type StandinCoordinator } from "./standin/coordinator";
import { probeStubs } from "./stubs";
import type { ImpairmentCounters, ImpairmentProfile, LinkCounts, PageStartOptions, PageState, PeerPick, ShardResult, SwarmConfig } from "./types";

/* Just enough of Playwright's types for what is used here: it is not installed in the project. */
type PwPage = {
  goto(url: string): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
  on(event: "crash" | "pageerror" | "console", listener: (arg: never) => void): void;
};
type PwContext = { newPage(): Promise<PwPage>; newCDPSession?(page: PwPage): Promise<PwCdp> };
type PwCdp = { send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> };
type PwBrowser = { newContext(): Promise<PwContext>; close(): Promise<void> };
type Playwright = { chromium: { launch(options: { args: string[]; headless?: boolean }): Promise<PwBrowser> } };

/** Playwright, from NODE_PATH, or from beside the `node` that is running (a global install). */
export function loadPlaywright(): Playwright {
  const require = createRequire(import.meta.url);
  const tried: string[] = [];
  for (const name of ["playwright", join(dirname(process.execPath), "..", "lib", "node_modules", "playwright")]) {
    try {
      return require(name) as Playwright;
    } catch (error) {
      tried.push(`${name}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`Playwright was not found. Install it outside the project and set NODE_PATH (see packages/overlay/harness/README.md).\n${tried.join("\n")}`);
}

export const CHROMIUM_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  // Host candidates as addresses, not mDNS names: peers on one machine find each other at once.
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  // A page nobody looks at must keep its timers: every peer here is one.
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

type PeerHandle = {
  index: number;
  role: "source" | "viewer";
  page: PwPage;
  profile: ImpairmentProfile | null;
  startedAt: number;
  /** Still running: not killed, not left, not crashed. */
  alive: boolean;
  /** How it ended, if the harness ended it. */
  ended: "killed" | "left" | null;
  state: PageState | null;
  links: { peer: PeerId; open: boolean; failed: boolean; turn: boolean; candidates: string | null }[];
  clockMax: number;
  /** Session clock minus wall clock, at the last poll. */
  vsWall: number | null;
  vsWallRange: [number, number] | null;
  /** Decodes for real (D29); the rest are light. */
  decode: boolean;
};

/** This machine's time sync, from chrony, if it has it. A shard's wall clock is only as good as this. */
export function readNtp(): { boundMs: number | null; text: string } | undefined {
  let text: string;
  try {
    text = execFileSync("chronyc", ["-n", "tracking"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
  return { boundMs: ntpBoundMs(text), text: text.trim().slice(0, 2000) };
}

/** |system time offset| + root delay / 2 + root dispersion, in ms, from `chronyc tracking`. */
export function ntpBoundMs(text: string): number | null {
  const seconds = (label: string): number | null => {
    const match = new RegExp(`^${label}\\s*:\\s*([0-9.]+) seconds`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const offset = seconds("System time");
  const delay = seconds("Root delay");
  const dispersion = seconds("Root dispersion");
  if (offset === null || delay === null || dispersion === null) return null;
  return 1000 * (offset + delay / 2 + dispersion);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SERVER_SECRET = "harness-server-secret";
/** A viewer that has not rendered when the run ends, and joined less than this long before, is still joining, not failed. */
export const STILL_JOINING_MS = 30_000;

/** Whom a churn step falls on, among this shard's viewers, by what their pages last said of themselves. */
export function pickPeer<T extends { index: number; children: number; depth: number }>(peers: T[], pick: PeerPick, seed: number): T | null {
  const sorted = [...peers].sort((a, b) => a.index - b.index);
  const relays = sorted.filter((p) => p.children > 0);
  let pool: T[];
  switch (pick) {
    case "any":
      pool = sorted;
      break;
    case "leaf":
      pool = sorted.filter((p) => p.children === 0);
      break;
    case "relay":
      pool = relays;
      break;
    case "deepest-relay": {
      const depth = Math.max(...relays.map((p) => p.depth));
      pool = relays.filter((p) => p.depth === depth);
      break;
    }
    case "shallowest-relay": {
      const depth = Math.min(...relays.map((p) => p.depth));
      pool = relays.filter((p) => p.depth === depth);
      break;
    }
    case "impaired":
      // Whoever an earlier "impair" fell on (the driver marks them), so a later one can lift it.
      pool = sorted.filter((p) => (p as { impaired?: boolean }).impaired);
      break;
    case "busiest-relay": {
      const children = Math.max(...relays.map((p) => p.children));
      pool = relays.filter((p) => p.children === children);
      break;
    }
  }
  return pool.length ? pool[Math.floor(seededRandom(seed)() * pool.length)] : null;
}

/** Runs this process's share of a swarm to the end and returns what its peers measured. */
export async function runShard(config: SwarmConfig): Promise<ShardResult> {
  const log = config.log ?? (() => undefined);
  const mine = (index: number): boolean => shardOf(index, config) === config.shard.index;
  const stubbed = probeStubs();
  const notes: string[] = [];
  const startedAt = Date.now();
  const startAt = config.startAtMs ?? startedAt + 1500;
  const atS = (): number => (Date.now() - startAt) / 1000;

  /* ------------------------------ the coordinator ------------------------------ */

  const url = new URL(config.coordinatorUrl);
  const wanted = config.coordinator ?? "auto";
  const ownsCoordinator = wanted !== "external" && config.shard.index === 0;
  const realCoordinatorBuilt = !stubbed.includes("coordinator.startNodeCoordinator");
  if (wanted === "real" && !realCoordinatorBuilt) throw new Error("coordinator: \"real\" was asked for, but startNodeCoordinator is still a stub");
  const useReal = ownsCoordinator && (wanted === "real" || (wanted === "auto" && realCoordinatorBuilt));
  // One store across a kill and a restart, as a Durable Object's storage outlives its eviction: the
  // session's key and clock survive, so peers can `resume` (the package's coordinator reads it).
  const coordinatorOptions = { port: Number(url.port), host: url.hostname, admissionSecret: config.admissionSecret, serverSecret: SERVER_SECRET, params: config.params, seed: config.seed, iceServers: config.iceServers, storage: new Map<string, Map<string, string>>() };
  let coordinator: NodeCoordinator | StandinCoordinator | null = null;
  if (ownsCoordinator) {
    coordinator = useReal ? await startNodeCoordinator(coordinatorOptions) : await startStandinCoordinator(coordinatorOptions);
    log(`coordinator: ${useReal ? "the package's" : "STAND-IN"} at ${coordinator.url}`);
  }

  /* ------------------------------ the page, the browsers ------------------------------ */

  // Only when there is a page to open: shard 0 of a laid-out run, the coordinator's, has none.
  let playwright: Playwright | null = null;
  // A padded program wants a stream as big as asked: give the fake camera something no encoder can shrink.
  const fakeVideo = config.program?.pad && config.program.source === "camera" ? [`--use-file-for-fake-video-capture=${busyVideoFile()}`] : [];
  if (fakeVideo.length) notes.push("the fake camera played a drifting, grainy pattern (harness/busyVideo.ts), so that the encoder reaches its bitrate");
  let server: PageServer | null = null;
  const browsers: PwBrowser[] = [];
  const peers = new Map<number, PeerHandle>();
  const failed: ShardResult["peersFailed"] = [];
  const samples: MetricsSample[] = [];
  const churnLog: NonNullable<ShardResult["churnLog"]> = [];
  const impaired = new Set<number>();
  const loads: number[] = [];
  const settledLoads: number[] = [];
  const pageLag = emptyHistogram();
  const driverLag = emptyHistogram();
  let badSamples = 0;
  let pagesInBrowser = 0;
  let context: PwContext | null = null;
  let engine: "real" | "standin" | null = null;
  let ticketNonce = 0;
  /** The run is over and its browsers are closing. */
  let ending = false;

  // The driver's own event loop: if it is late, everything it times is late.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  // Each 20 ms timer against the moment it was set for (see page/main.ts).
  let lagTimer: ReturnType<typeof setTimeout> | undefined;
  const lagTick = (due: number): void => {
    lagTimer = setTimeout(() => {
      const now = performance.now();
      driverLag[latencyBucket(Math.max(0, now - due))]++;
      lagTick(now + 20);
    }, 20);
  };
  lagTick(performance.now() + 20);

  const ticket = (index: number, role: "source" | "viewer"): Promise<string> =>
    signTicket(
      { v: 1, room: config.room, identity: `${config.runId}-s${config.shard.index}-p${index}`, name: `peer ${index}`, role, exp: Math.floor(Date.now() / 1000) + 60, nonce: `${config.shard.index}-${index}-${ticketNonce++}-${Math.floor(Math.random() * 1e9).toString(36)}`.padEnd(8, "0") },
      config.admissionSecret,
    );

  /**
   * The source page profiled (OVERLAY_PROFILE_SOURCE=<dir>, a diagnosis, not the gate): its main
   * thread sampled every 2 ms (OVERLAY_PROFILE_SOURCE_US) by DevTools' profiler, its long tasks, and its heap every
   * second, written to <dir> when the run ends. For the source's 150-240 ms stalls (D69).
   */
  const profileDir = process.env.OVERLAY_PROFILE_SOURCE || null;
  let sourceCdp: PwCdp | null = null;
  let sourcePage: PwPage | null = null;
  const sourceHeap: [number, number, number][] = [];
  let heapTimer: ReturnType<typeof setInterval> | undefined;
  async function profileSource(page: PwPage): Promise<void> {
    if (!profileDir || !context?.newCDPSession) return;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: Number(process.env.OVERLAY_PROFILE_SOURCE_US) || 2000 });
    await cdp.send("Profiler.start");
    sourceCdp = cdp;
    sourcePage = page;
    heapTimer = setInterval(() => {
      void cdp
        .send("Runtime.getHeapUsage")
        .then((heap) => sourceHeap.push([Date.now(), Number(heap.usedSize), Number(heap.totalSize)]))
        .catch(() => undefined);
    }, 1000);
    log(`the source page is profiled into ${profileDir}`);
  }
  async function saveSourceProfile(): Promise<void> {
    if (!sourceCdp || !profileDir) return;
    clearInterval(heapTimer);
    try {
      const { profile } = await sourceCdp.send("Profiler.stop");
      writeFileSync(join(profileDir, "source.cpuprofile"), JSON.stringify(profile));
      const longTasks = await sourcePage!.evaluate(() => (window as unknown as { __longTasks?: unknown[] }).__longTasks ?? [], null);
      const timeOrigin = await sourcePage!.evaluate(() => performance.timeOrigin, null);
      writeFileSync(join(profileDir, "source-longtasks.json"), JSON.stringify({ timeOrigin, longTasks }));
      writeFileSync(join(profileDir, "source-heap.json"), JSON.stringify(sourceHeap));
    } catch (error) {
      notes.push(`the source's profile was not saved: ${String(error)}`);
    }
  }

  async function newPage(): Promise<PwPage> {
    if (!context || pagesInBrowser >= Math.max(1, config.pagesPerBrowser)) {
      playwright ??= loadPlaywright();
      const browser = await playwright.chromium.launch({ args: [...CHROMIUM_ARGS, ...fakeVideo] });
      browsers.push(browser);
      context = await browser.newContext();
      pagesInBrowser = 0;
    }
    pagesInBrowser++;
    return context.newPage();
  }

  async function startPeer(index: number): Promise<void> {
    const role = index === 0 ? "source" : "viewer";
    const profile = profileOf(config, index);
    try {
      const page = await newPage();
      const decode = role === "viewer" && config.decodeEvery > 0 && (index - 1) % config.decodeEvery === 0;
      const handle: PeerHandle = { index, role, page, profile, startedAt: Date.now(), alive: true, ended: null, state: null, links: [], clockMax: -1, vsWall: null, vsWallRange: null, decode };
      page.on("crash", () => {
        if (!handle.alive) return;
        handle.alive = false;
        failed.push({ index, why: "the page crashed" });
      });
      page.on("pageerror", (error: Error) => log(`peer ${index}: page error: ${error.message}`));
      await page.exposeFunction("__overlayTicket", () => ticket(index, role));
      await page.goto(server!.url);
      const options: PageStartOptions = {
        coordinatorUrl: config.coordinatorUrl,
        coordinatorAlternates: config.coordinatorAlternates,
        room: config.room,
        ticket: await ticket(index, role),
        role,
        decode,
        profile,
        seed: config.seed,
        engine: config.engine ?? "auto",
        ice: config.ice,
        program: config.program,
        index,
        shard: config.shard.index,
      };
      peers.set(index, handle);
      if (role === "source" && profileDir) {
        // A diagnosis: a profiler that will not attach costs the run nothing.
        await profileSource(page).catch(async () => {
          await sleep(500);
          await profileSource(page).catch((error: unknown) => notes.push(`the source page could not be profiled: ${String(error)}`));
        });
        await page.evaluate(() => {
          const tasks: { start: number; ms: number; name: string; attribution: string }[] = [];
          (window as unknown as { __longTasks: typeof tasks }).__longTasks = tasks;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const attribution = ((entry as unknown as { attribution?: { containerType?: string; name?: string }[] }).attribution ?? []).map((a) => `${a.containerType ?? ""}:${a.name ?? ""}`).join(",");
              tasks.push({ start: entry.startTime, ms: entry.duration, name: entry.name, attribution });
            }
          }).observe({ type: "longtask", buffered: true });
        }, null);
      }
      await page.evaluate((o) => window.__overlay.start(o), options);
    } catch (error) {
      const handle = peers.get(index);
      // The run ended (its browsers closed) while this peer was still starting: it is judged below
      // as any viewer that has not rendered is, by how long it had, not as a page that broke.
      if (ending && handle) return;
      if (handle) handle.alive = false;
      failed.push({ index, why: `did not start: ${(error as Error).message.split("\n")[0].slice(0, 300)}` });
      log(`peer ${index}: FAILED to start: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  /** Takes every live page's samples and state. A page that does not answer is left for the next round. */
  async function poll(): Promise<void> {
    loads.push(loadavg()[0]);
    // Once the swarm has filled: launching the browsers is not the run.
    if (atS() >= fillS(config)) settledLoads.push(loadavg()[0]);
    await Promise.all(
      [...peers.values()]
        .filter((p) => p.alive)
        .map(async (p) => {
          try {
            const got = await p.page.evaluate(() => ({ samples: window.__overlay.takeSamples(), state: window.__overlay.state(), links: window.__overlay.linkList() }), null);
            p.state = got.state;
            p.links = got.links;
            engine = got.state.engine;
            if (got.state.clockUncertaintyMs >= 0) p.clockMax = Math.max(p.clockMax, got.state.clockUncertaintyMs);
            if (typeof got.state.sessionMinusWallMs === "number") {
              const v = got.state.sessionMinusWallMs;
              p.vsWall = v;
              // Not in the first seconds, while the clock is still settling on its first probes.
              if (Date.now() - p.startedAt > 5000) p.vsWallRange = p.vsWallRange ? [Math.min(p.vsWallRange[0], v), Math.max(p.vsWallRange[1], v)] : [v, v];
            }
            mergeHistogram(pageLag, got.state.lag);
            for (const sample of got.samples) {
              try {
                samples.push(decodeMetricsSample(JSON.stringify(sample)));
              } catch (error) {
                if (badSamples++ === 0) notes.push(`a metrics sample did not fit the schema and was left out: ${(error as Error).message}`);
              }
            }
          } catch {
            // Closed between the filter and the call (a kill), or busy: nothing to take this time.
          }
        }),
    );
  }

  async function churn(step: ChurnStep): Promise<void> {
    const event = step.event;
    const entry: NonNullable<ShardResult["churnLog"]>[number] = { atS: Math.round(atS() * 10) / 10, action: event.action, targets: [] };
    churnLog.push(entry);
    if (event.action === "kill-coordinator") {
      if (!coordinator) return;
      log(`churn ${entry.atS}s: the coordinator dies for ${event.forS} s`);
      await coordinator.kill();
      entry.targets.push("coordinator");
      setTimeout(() => {
        void (async () => {
          if (coordinator && "restart" in coordinator) await coordinator.restart();
          else coordinator = await startNodeCoordinator(coordinatorOptions);
          log(`churn: the coordinator is back`);
        })().catch((error) => notes.push(`the coordinator did not come back: ${String(error)}`));
      }, event.forS * 1000);
      return;
    }
    if (event.action === "join") {
      if (step.index === undefined) return;
      entry.targets.push(`peer ${step.index}`);
      await startPeer(step.index);
      return;
    }
    // Fresh numbers, so the pick is made on the tree as it is now.
    await poll();
    const viewers = [...peers.values()].filter((p) => p.alive && p.role === "viewer" && p.state?.started).map((p) => ({ index: p.index, children: p.state?.children ?? 0, depth: p.state?.depth ?? 255, impaired: impaired.has(p.index), handle: p }));
    const target = pickPeer(viewers, event.pick, step.seed);
    if (!target) {
      entry.targets.push(`nobody: no "${event.pick}" on this shard`);
      return;
    }
    const peer = target.handle;
    entry.targets.push(`peer ${peer.index} (${peer.state?.peer ?? "?"}, depth ${target.depth}, ${target.children} children)`);
    if (peer.state?.peer) entry.peer = peer.state.peer;
    // When, on the session clock: what the samples' times are on.
    if (typeof peer.state?.sessionMinusWallMs === "number") entry.sessionMs = Date.now() + peer.state.sessionMinusWallMs;
    log(`churn ${entry.atS}s: ${event.action} ${entry.targets[0]}`);
    if (event.action === "kill") {
      peer.alive = false;
      peer.ended = "killed";
      await peer.page.close({ runBeforeUnload: false }).catch(() => undefined);
    } else if (event.action === "leave") {
      peer.alive = false;
      peer.ended = "left";
      try {
        const last = await peer.page.evaluate(async () => {
          await window.__overlay.leave();
          return window.__overlay.takeSamples();
        }, null);
        for (const sample of last) {
          try {
            samples.push(decodeMetricsSample(JSON.stringify(sample)));
          } catch {
            badSamples++;
          }
        }
      } catch {
        // It was already going.
      }
      await peer.page.close().catch(() => undefined);
    } else if (event.action === "impair") {
      const profile = config.profiles.find((p) => p.name === event.profile) ?? PROFILES[event.profile] ?? null;
      peer.profile = profile;
      impaired.add(peer.index);
      const only = event.link === "from-parent" ? "parent" : undefined;
      await peer.page.evaluate(([p, o]) => window.__overlay.setProfile(p, o), [profile, only] as const).catch(() => undefined);
      if (only) entry.targets.push(`on its link from its parent ${peer.state?.parent ?? "?"} only`);
    }
  }

  /* ------------------------------ the run ------------------------------ */

  try {
    // Beside the coordinator's port; a coordinator on another machine (an https URL with no port) leaves 4280 + 1 + shard.
    server = await servePage((Number(url.port) || 4280) + 1 + config.shard.index, await bundlePage());
    const joins = Array.from({ length: config.peers }, (_, index) => index)
      .filter(mine)
      .map((index) => ({ atS: joinAtS(config, index), index }));
    const steps = churnSteps(config).filter((step) => (step.shard === -1 ? ownsCoordinator : step.shard === config.shard.index));
    log(`shard ${config.shard.index}/${config.shard.count}: ${joins.length} of ${config.peers} peers, ${steps.length} churn steps, ${config.durationS} s; engine "${config.engine ?? "auto"}"; stubbed: ${stubbed.length ? stubbed.join(", ") : "nothing"}`);

    const running = new Set<Promise<void>>();
    const run = (work: Promise<void>): void => {
      running.add(work);
      void work.finally(() => running.delete(work));
    };
    let lastPoll = 0;
    let polling: Promise<void> | null = null;
    while (atS() < config.durationS) {
      const now = atS();
      while (joins.length && joins[0].atS <= now) run(startPeer(joins.shift()!.index));
      while (steps.length && steps[0].atS <= now) run(churn(steps.shift()!));
      if (!polling && Date.now() - lastPoll >= 2000) {
        lastPoll = Date.now();
        polling = poll().finally(() => (polling = null));
      }
      await sleep(100);
    }
    await polling;
    await Promise.race([Promise.all(running), sleep(5000)]);
    await poll();
    await saveSourceProfile();
  } finally {
    ending = true;
    clearTimeout(lagTimer);
    loopDelay.disable();
    await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
    await server?.close().catch(() => undefined);
    await (coordinator as NodeCoordinator | null)?.close().catch(() => undefined);
  }

  /* ------------------------------ what it all came to ------------------------------ */

  const unfinishedJoins: number[] = [];
  for (const peer of peers.values()) {
    if (peer.role !== "viewer" || peer.ended || failed.some((f) => f.index === peer.index)) continue;
    if (peer.state?.error) failed.push({ index: peer.index, why: peer.state.error });
    else if (!peer.state?.started) {
      // A viewer that had half a minute and rendered nothing failed. One that joined later is
      // still joining: its join time is at least what it has waited, and counts as that.
      const waited = Date.now() - peer.startedAt;
      if (waited > STILL_JOINING_MS) failed.push({ index: peer.index, why: `never rendered a frame in ${Math.round(waited / 1000)} s${peer.state?.parent ? "" : ", and never had a parent"}` });
      else unfinishedJoins.push(waited);
    }
  }
  const source = peers.get(0);
  if (source && !source.state?.started && !failed.some((f) => f.index === 0)) failed.push({ index: 0, why: source.state?.error ?? "the source never sent a frame" });

  const local = new Set<PeerId>();
  for (const peer of peers.values()) if (peer.state?.peer) local.add(peer.state.peer);
  const links: LinkCounts = { opened: 0, failed: 0, turn: 0, candidates: {}, crossShard: 0, crossShardTurn: 0, crossShardFailed: 0 };
  const impairment: ImpairmentCounters = { sent: 0, delivered: 0, lost: 0, queueDropped: 0, lateMsSum: 0, lateMsMax: 0 };
  for (const peer of peers.values()) {
    const counts: LinkCounts = { opened: 0, failed: 0, turn: 0, candidates: {}, crossShard: 0, crossShardTurn: 0, crossShardFailed: 0 };
    for (const link of peer.links) {
      // Each link has two ends; count it at the end that sorts first, or here if the other end is elsewhere.
      const elsewhere = !local.has(link.peer);
      if (!elsewhere && (peer.state?.peer ?? "") > link.peer) continue;
      if (link.open) counts.opened++;
      if (link.failed) counts.failed++;
      if (link.turn) counts.turn++;
      if (link.candidates) counts.candidates[link.candidates] = (counts.candidates[link.candidates] ?? 0) + 1;
      if (elsewhere && link.open) {
        counts.crossShard++;
        if (link.turn) counts.crossShardTurn++;
      }
      if (elsewhere && link.failed) counts.crossShardFailed = (counts.crossShardFailed ?? 0) + 1;
    }
    addLinks(links, counts);
    const i = peer.state?.impairment;
    if (i) {
      impairment.sent += i.sent;
      impairment.delivered += i.delivered;
      impairment.lost += i.lost;
      impairment.queueDropped += i.queueDropped;
      impairment.lateMsSum += i.lateMsSum;
      impairment.lateMsMax = Math.max(impairment.lateMsMax, i.lateMsMax);
    }
  }
  if (config.shard.count > 1) notes.push("a link between two shards is counted by both, each at its own end");
  const retried = [...peers.values()].filter((p) => (p.state?.connectAttempts ?? 0) > 1).length;
  if (retried) notes.push(`${retried} viewer${retried === 1 ? "" : "s"} found the coordinator unreachable and tried again; their joins are timed from the first try`);
  if (ownsCoordinator && !useReal) stubbed.push("harness: the coordinator was the stand-in (harness/standin/coordinator.ts)");
  if (engine === "standin") stubbed.push("harness: every peer was the stand-in (harness/page/standin.ts)");

  const viewers = [...peers.values()].filter((p) => p.role === "viewer" && p.clockMax >= 0);
  return {
    runId: config.runId,
    shard: config.shard,
    role: !config.layout ? "all" : config.layout.coordinatorShard === config.shard.index && !peers.size ? "coordinator" : peers.has(0) && peers.size === 1 ? "source" : "viewers",
    peersOfRun: [...peers.values()].filter((p) => p.index < config.peers).length,
    ice: config.ice,
    startedAt,
    endedAt: Date.now(),
    peersStarted: peers.size,
    peersFailed: failed.sort((a, b) => a.index - b.index),
    samples,
    host: { cores: availableParallelism(), loadAvg1: loads, loadAvg1Settled: settledLoads, maxEventLoopLagMs: loopDelay.max / 1e6, driverLag, pageLag, ntp: readNtp() },
    peers: config.peers,
    durationS: config.durationS,
    scenario: config.scenario,
    seed: config.seed,
    expect: config.expect,
    engine: engine ?? undefined,
    coordinator: wanted === "external" || !ownsCoordinator ? "external" : useReal ? "real" : "standin",
    stubbed: [...new Set(stubbed)].sort(),
    clock: {
      source: source && source.clockMax >= 0 ? source.clockMax : null,
      viewers: viewers.map((p) => p.clockMax),
      sourceVsWallMs: source?.vsWall ?? null,
      viewersVsWallMs: viewers.filter((p) => p.vsWall !== null).map((p) => p.vsWall as number),
      sourceVsWallRangeMs: source?.vsWallRange ?? null,
      viewersVsWallRangeMs: viewers.filter((p) => p.vsWallRange !== null).map((p) => p.vsWallRange as [number, number]),
    },
    links,
    tree: [...peers.values()].filter((p) => p.state?.peer).map((p) => ({ peer: p.state!.peer as PeerId, parent: p.state!.parent, index: p.index, profile: p.profile?.name ?? "clean" })),
    unfinishedJoins,
    decoders: [...peers.values()].filter((p) => p.decode && p.state?.peer).map((p) => p.state!.peer as PeerId),
    impairment,
    churnLog,
    notes,
  };
}
