/**
 * K6 (PLAN §5): how much one coordinator carries. Not a unit test: a measurement, run by hand
 * or in CI with `npm run`-less node, as
 *
 *   node --experimental-transform-types --import ./test/register.mjs \
 *     packages/overlay/coordinator/load.ts [node|worker|core] [peers] [joinSeconds] [holdSeconds]
 *
 * `node` and `worker` start the entry point in a process of its own (the Node server, or
 * `wrangler dev`'s workerd) and read that process's CPU time from /proc, so the load generator's
 * own work is not counted. `core` drives `CoordinatorCore` directly in this process, with no
 * sockets: the cost of the logic alone, which is what a Durable Object pays per message on top
 * of the runtime's own.
 *
 * Every simulated peer does what a real one does with the coordinator: a ticket, `hello`, five
 * clock probes, a dozen `signal`s to the parent it was given (an offer, an answer, candidates),
 * `status` every `statusMs`, `metrics` every `metricsMs`, a clock probe every 30 s.
 *
 * Owner: E-coordinator.
 */
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DEFAULT_PARAMS, decodeServerMessage, encodeClientMessage, encodeServerMessage } from "../protocol";
import type { ClientMessage, MetricsSample, PeerId } from "../protocol";
import { createCore } from "./core";
import { ADMISSION_SECRET, SERVER_SECRET, STREAMS, leafCaps, relayCaps, ticketFor } from "./testkit";
import { cleanUp, findWrangler, killGroup, startWrangler } from "./wranglerDev";

const ROOM = "load-room";
const NODE_PORT = 4264;
const WORKER_PORT = 4265;
const SIGNALS_PER_JOIN = 12;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (values: number[], q: number) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/** CPU seconds some processes (and their threads) have used, from /proc. */
function cpuSeconds(pids: number[]): number {
  let total = 0;
  for (const pid of pids) {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    total += (Number(fields[11]) + Number(fields[12])) / 100;
  }
  return total;
}

const statusOf = (parent: PeerId | null, depth: number): ClientMessage => ({
  t: "status",
  depth,
  links: parent === null ? [] : STREAMS.map((stream) => ({ stream: stream.id, stripe: 0, parent, backup: null })),
  children: 0,
  standby: 0,
  free: parent === null ? 3 : 0,
  caps: leafCaps(),
  lossPct: 0.2,
  rttMs: 20,
});
const sampleOf = (peer: PeerId, seq: number): MetricsSample => ({ peer, seq, at: seq * 2000, intervalMs: 2000, role: "leaf", depth: 1, playoutDelayMs: 80, events: [] });
const signal = (to: PeerId, i: number): ClientMessage => ({ t: "signal", to, data: i === 0 ? { sdp: { type: "offer", sdp: "v=0\r\n".padEnd(2_000, "a") } } : { candidate: { candidate: `candidate:${i} 1 udp 2122260223 192.168.1.${i} 5${i}000 typ host`, sdpMid: "0", sdpMLineIndex: 0 } } });

type Counters = { sent: number; received: number; byType: Record<string, number> };

/** One simulated peer on a real WebSocket. */
async function socketPeer(url: string, identity: string, role: "source" | "viewer", counters: Counters, welcomeMs: number[], stopAt: () => boolean): Promise<void> {
  const ticket = await ticketFor(identity, role, Date.now(), { room: ROOM });
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/overlay/v1/rooms/${ROOM}/ws?ticket=${encodeURIComponent(ticket)}`);
  const send = (message: ClientMessage) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeClientMessage(message));
    counters.sent++;
  };
  let helloAt = 0;
  let seq = 0;
  let peer: PeerId | null = null;
  let parent: PeerId | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];
  ws.addEventListener("message", (event) => {
    counters.received++;
    const message = decodeServerMessage(String(event.data));
    const key = message.t === "error" ? `error:${message.code}` : message.t;
    counters.byType[key] = (counters.byType[key] ?? 0) + 1;
    if (message.t !== "welcome") return;
    welcomeMs.push(performance.now() - helloAt);
    peer = message.peer;
    parent = message.assign[0]?.parents[0]?.peer ?? null;
    if (role === "source") send({ t: "streams", streams: STREAMS });
    for (let i = 0; i < 5; i++) setTimeout(() => send({ t: "time", t0: performance.now() }), i * 100);
    if (parent) for (let i = 0; i < SIGNALS_PER_JOIN; i++) setTimeout(() => send(signal(parent!, i)), 50 + i * 30);
    const jitter = Math.random();
    setTimeout(() => send(statusOf(role === "source" ? null : parent, role === "source" ? 0 : 1)), 300);
    timers.push(
      setInterval(() => send(statusOf(role === "source" ? null : parent, role === "source" ? 0 : 1)), DEFAULT_PARAMS.statusMs),
      setInterval(() => send({ t: "metrics", sample: sampleOf(peer!, seq++) }), DEFAULT_PARAMS.metricsMs + jitter * 10),
      setInterval(() => send({ t: "time", t0: performance.now() }), 30_000 + jitter * 1000),
    );
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`${identity}: could not connect`)), { once: true });
  });
  helloAt = performance.now();
  send({ t: "hello", v: 1, caps: role === "source" ? relayCaps({ uplinkKbps: 50_000 }) : leafCaps() });
  while (!stopAt()) await sleep(250);
  for (const timer of timers) clearInterval(timer);
  ws.close(1000);
}

async function socketRun(kind: "node" | "worker", peers: number, joinS: number, holdS: number) {
  /** The processes whose CPU is the entry point's. */
  let pids: number[];
  let url: string;
  let stop: () => Promise<void>;
  if (kind === "node") {
    const child: ChildProcess = fork(join(import.meta.dirname, "loadServer.ts"), [String(NODE_PORT)], { execArgv: process.execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    await new Promise<void>((resolve) => child.once("message", () => resolve()));
    pids = [child.pid!];
    url = `http://127.0.0.1:${NODE_PORT}`;
    stop = async () => {
      child.kill("SIGKILL");
    };
  } else {
    const wrangler = findWrangler();
    if (!wrangler) throw new Error("wrangler not found: set OVERLAY_WRANGLER");
    const persistTo = mkdtempSync(join(tmpdir(), "overlay-load-"));
    const child = await startWrangler(wrangler, persistTo, WORKER_PORT, { OVERLAY_ADMISSION_SECRET: ADMISSION_SECRET, OVERLAY_SERVER_SECRET: SERVER_SECRET });
    // wrangler dev runs two workerd processes, an entry proxy and the Worker itself: both are
    // the local path a message takes, so both are counted. Wrangler's own Node process is not.
    pids = execFileSync("pgrep", ["-g", String(child.pid), "workerd"]).toString().trim().split("\n").map(Number);
    url = `http://127.0.0.1:${WORKER_PORT}`;
    stop = async () => {
      await killGroup(child);
      rmSync(persistTo, { recursive: true, force: true });
      cleanUp();
    };
  }
  try {
    const counters: Counters = { sent: 0, received: 0, byType: {} };
    const welcomeMs: number[] = [];
    let done = false;
    const running: Promise<void>[] = [];
    const cpu0 = cpuSeconds(pids);
    const t0 = performance.now();
    running.push(socketPeer(url, "host", "source", counters, [], () => done));
    await sleep(500);
    const gap = (joinS * 1000) / peers;
    for (let i = 0; i < peers; i++) {
      running.push(socketPeer(url, `viewer-${i}`, "viewer", counters, welcomeMs, () => done).catch((error: unknown) => console.error(String(error))));
      const due = t0 + 500 + (i + 1) * gap;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    }
    const cpuJoined = cpuSeconds(pids);
    const eachJoined = pids.map((pid) => cpuSeconds([pid]));
    const joinWall = (performance.now() - t0) / 1000;
    const sentJoined = counters.sent;
    const receivedJoined = counters.received;
    const typesJoined = { ...counters.byType };
    await sleep(holdS * 1000);
    const cpuHeld = cpuSeconds(pids);
    const eachHeld = pids.map((pid, index) => Number((cpuSeconds([pid]) - eachJoined[index]).toFixed(2)));
    const holdSent = counters.sent - sentJoined;
    const holdReceived = counters.received - receivedJoined;
    const stats = (await (await fetch(`${url}/overlay/v1/rooms/${ROOM}/stats`, { headers: { authorization: `Bearer ${SERVER_SECRET}` } })).json()) as { viewers: number };
    done = true;
    await Promise.all(running);
    const result = {
      entry: kind,
      peers,
      watching: stats.viewers,
      joinSeconds: Number(joinWall.toFixed(1)),
      helloToWelcomeMs: { p50: quantile(welcomeMs, 0.5), p95: quantile(welcomeMs, 0.95), p99: quantile(welcomeMs, 0.99), n: welcomeMs.length },
      join: { messagesIn: sentJoined, messagesOut: receivedJoined, cpuSeconds: Number((cpuJoined - cpu0).toFixed(2)) },
      hold: {
        seconds: holdS,
        messagesInPerSecond: Math.round(holdSent / holdS),
        messagesOutPerSecond: Math.round(holdReceived / holdS),
        cpuSeconds: Number((cpuHeld - cpuJoined).toFixed(2)),
        cpuShare: Number(((cpuHeld - cpuJoined) / holdS).toFixed(3)),
        cpuSecondsByProcess: eachHeld,
        cpuUsPerMessageIn: Math.round(((cpuHeld - cpuJoined) * 1e6) / Math.max(1, holdSent)),
        out: Object.fromEntries(Object.entries(counters.byType).map(([type, n]) => [type, n - (typesJoined[type] ?? 0)]).filter(([, n]) => Number(n) > 0)),
      },
      loadavg: readFileSync("/proc/loadavg", "utf8").trim(),
    };
    for (const h of [result.helloToWelcomeMs]) for (const key of ["p50", "p95", "p99"] as const) h[key] = Number(h[key].toFixed(1));
    return result;
  } finally {
    await stop();
  }
}

/** The core alone: `peers` join and then talk for `holdS` simulated seconds, as fast as this process can drive it. */
async function coreRun(peers: number, holdS: number) {
  let wake: number | null = null;
  let now = Date.now();
  let out = 0;
  const core = createCore({ room: ROOM, admissionSecret: ADMISSION_SECRET, serverSecret: SERVER_SECRET, params: DEFAULT_PARAMS, viewerCap: 100_000, iceServers: async () => [], random: Math.random, metricsKeep: 2_000 });
  const apply = (effects: Awaited<ReturnType<typeof core.tick>>) => {
    for (const effect of effects) {
      if (effect.type === "wake") wake = effect.at;
      // An entry point encodes every message it sends: counted, since a Durable Object pays it too.
      else if (effect.type === "send") {
        encodeServerMessage(effect.message);
        out++;
      }
    }
  };
  type P = { conn: string; peer: PeerId; parent: PeerId | null };
  const all: P[] = [];
  const tickets: string[] = [];
  for (let i = 0; i <= peers; i++) tickets.push(await ticketFor(i === 0 ? "host" : `viewer-${i}`, i === 0 ? "source" : "viewer", now, { room: ROOM }));
  let messages = 0;
  const say = async (p: { conn: string }, message: ClientMessage) => {
    messages++;
    apply(await core.message(p.conn, encodeClientMessage(message), now));
  };
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  for (let i = 0; i <= peers; i++) {
    const conn = `c${i}`;
    apply(await core.open(conn, tickets[i], {}, now));
    const effects = await core.message(conn, encodeClientMessage({ t: "hello", v: 1, caps: i === 0 ? relayCaps({ uplinkKbps: 50_000 }) : leafCaps() }), now);
    messages++;
    let p: P | null = null;
    for (const effect of effects) if (effect.type === "send" && effect.message.t === "welcome") p = { conn, peer: effect.message.peer, parent: effect.message.assign[0]?.parents[0]?.peer ?? null };
    apply(effects);
    all.push(p!);
    if (i === 0) await say(p!, { t: "streams", streams: STREAMS });
    for (let k = 0; k < 5; k++) await say(p!, { t: "time", t0: k });
    if (p!.parent) for (let k = 0; k < SIGNALS_PER_JOIN; k++) await say(p!, signal(p!.parent, k));
    await say(p!, statusOf(i === 0 ? null : p!.parent, i === 0 ? 0 : 1));
    now += 50;
  }
  const joinCpu = process.cpuUsage(cpu0);
  const joinMessages = messages;
  const joinWall = performance.now() - t0;
  const cpu1 = process.cpuUsage();
  const m0 = messages;
  for (let s = 0; s < holdS; s++) {
    now += 1000;
    if (wake !== null && wake <= now) apply(await core.tick(now));
    for (const [index, p] of all.entries()) {
      if ((s + index) % 5 === 0) await say(p, statusOf(index === 0 ? null : p.parent, index === 0 ? 0 : 1));
      if ((s + index) % 2 === 0) await say(p, { t: "metrics", sample: sampleOf(p.peer, s) });
    }
  }
  const holdCpu = process.cpuUsage(cpu1);
  const held = messages - m0;
  const us = (cpu: NodeJS.CpuUsage) => cpu.user + cpu.system;
  return {
    entry: "core",
    peers,
    join: { messages: joinMessages, wallMs: Math.round(joinWall), cpuUsPerMessage: Math.round(us(joinCpu) / joinMessages) },
    hold: { simulatedSeconds: holdS, messages: held, messagesPerSimulatedSecond: Math.round(held / holdS), cpuUsPerMessage: Math.round(us(holdCpu) / held), messagesPerCpuSecond: Math.round(held / (us(holdCpu) / 1e6)) },
    sent: out,
    loadavg: readFileSync("/proc/loadavg", "utf8").trim(),
  };
}

const [kind = "node", peersArg = "1000", joinArg = "60", holdArg = "30"] = process.argv.slice(2);
const result = kind === "core" ? await coreRun(Number(peersArg), Number(holdArg)) : await socketRun(kind as "node" | "worker", Number(peersArg), Number(joinArg), Number(holdArg));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
