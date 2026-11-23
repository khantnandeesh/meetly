/**
 * The harness's page: one peer. It puts a `PageApi` on `window.__overlay` for the driver to call
 * through Playwright. The peer is the package's own (`createOverlayViewer` /
 * `createOverlaySource`, and nothing else of it: PLAN §4), or, until those exist, the harness's
 * stand-in (./standin.ts). Either way every channel is wrapped by the impairment shim, and the
 * page measures its own event-loop lag, so a starved machine is seen and not taken for a slow
 * overlay.
 *
 * Bundled by ./build.ts. Owner: E-harness.
 */
import { NotImplementedError, createOverlaySource, createOverlayViewer, emptyHistogram, latencyBucket, type MetricsSample, type OverlaySource, type OverlayViewer, type PeerId } from "../../index";
import { realClock } from "../clock";
import { createImpairment, emptyImpairmentCounters } from "../impairment";
import type { ImpairmentProfile, LinkCounts, PageApi, PageStartOptions, PageState } from "../types";
import { createStandinPeer, type StandinPeer } from "./standin";

declare global {
  interface Window {
    __overlay: PageApi & { linkList(): { peer: PeerId; open: boolean; failed: boolean; turn: boolean; candidates: string | null }[] };
    /** A binding the driver exposes: a fresh ticket, signed in Node. */
    __overlayTicket?: () => Promise<string>;
  }
}

const clock = realClock();
const impairment = emptyImpairmentCounters();
let profile: ImpairmentProfile | null = null;
/** When set, `profile` is on the link to this peer only. */
let profilePeer: PeerId | null = null;
let engine: "real" | "standin" = "standin";
let standin: StandinPeer | null = null;
let real: OverlayViewer | OverlaySource | null = null;
let realStarted = false;
let failure: string | null = null;
const realSamples: MetricsSample[] = [];
let uncertaintyMax = 0;
/** How many times the viewer called `connect()`: more than one, and the coordinator was unreachable at first. */
let connectAttempts = 0;

/*
 * The page's own event-loop lag: how late a 20 ms timer fires, each one against the moment it
 * was set for. (Measured against a fixed schedule, a repeating timer's own drift built up into a
 * sawtooth of up to 20 ms, which read as lag on an idle machine.)
 */
const LAG_EVERY_MS = 20;
let lag = emptyHistogram();
const lagTick = (due: number): void => {
  clock.setTimeout(() => {
    const now = clock.now();
    lag[latencyBucket(Math.max(0, now - due))]++;
    lagTick(now + LAG_EVERY_MS);
  }, LAG_EVERY_MS);
};
lagTick(clock.now() + LAG_EVERY_MS);

async function start(options: PageStartOptions): Promise<void> {
  profile = options.profile;
  let firstTicket: string | null = options.ticket;
  const nextTicket = async (): Promise<string> => {
    const first = firstTicket;
    firstTicket = null;
    if (first) return first;
    if (!window.__overlayTicket) throw new Error("no more tickets: the driver exposed no __overlayTicket");
    return window.__overlayTicket();
  };
  const wrapChannel = createImpairment((info) => (profilePeer !== null && info.peer !== profilePeer ? null : profile), options.seed, { clock, self: String(options.index ?? ""), counters: impairment });

  if (options.engine !== "standin") {
    try {
      const ws = (url: string): string => `${url.replace(/^http/, "ws").replace(/\/$/, "")}/overlay/v1/rooms/${encodeURIComponent(options.room)}/ws`;
      // The coordinator's URLs: this shard's own first, then the run's other tunnels.
      const urls = [options.coordinatorUrl, ...(options.coordinatorAlternates ?? [])].map(ws);
      const connect = { coordinatorUrl: urls[0], ticket: nextTicket, wrapChannel };
      if (options.role === "source") {
        const source = createOverlaySource(connect);
        real = source;
        engine = "real";
        source.on("metrics", (sample) => realSamples.push(sample));
        source.on("error", (error) => (failure = String(error)));
        await source.connect();
        const media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: true });
        await source.publish({ video: media.getVideoTracks()[0], audio: media.getAudioTracks()[0] });
        realStarted = true;
      } else {
        // A viewer who arrives while the coordinator is dead (the gate's 30 s outage) tries again,
        // as a person would, for up to a minute. Its join is then timed from its first try: SPEC
        // §12.2 times a join from `connect()`, and the person pressed join then.
        const firstTry = clock.now();
        for (;;) {
          connectAttempts++;
          // Refused at one tunnel (it is full, or gone), a viewer tries the next: the coordinator is one.
          const viewer = createOverlayViewer({ ...connect, coordinatorUrl: urls[(connectAttempts - 1) % urls.length], decode: options.decode });
          real = viewer;
          engine = "real";
          viewer.on("metrics", (sample) => {
            if (connectAttempts > 1) {
              const started = viewer.sessionClock()?.fromLocal(firstTry);
              for (const event of sample.events) if (event.t === "join" && started !== undefined && Number.isFinite(started)) event.start = Math.min(event.start, Math.max(0, started));
            }
            realSamples.push(sample);
          });
          viewer.on("firstFrame", () => (realStarted = true));
          viewer.on("error", (error) => (failure = String(error)));
          try {
            await viewer.connect();
            break;
          } catch (error) {
            if (!/unreachable/i.test(String(error)) || clock.now() - firstTry > 60_000) throw error;
            await viewer.close().catch(() => undefined);
            await new Promise<void>((resolve) => clock.setTimeout(resolve, 1000));
          }
        }
      }
      return;
    } catch (error) {
      real = null;
      // "auto": the composition root is not built yet. Anything else is a real failure.
      if (!(error instanceof NotImplementedError) || options.engine === "real") throw error;
    }
  }
  engine = "standin";
  standin = createStandinPeer({ ...options, clock, nextTicket, wrapChannel, profile });
  await standin.start();
}

function linkCounts(): LinkCounts {
  const counts: LinkCounts = { opened: 0, failed: 0, turn: 0, candidates: {}, crossShard: 0, crossShardTurn: 0 };
  for (const link of standin?.links() ?? []) {
    if (link.open) counts.opened++;
    if (link.failed) counts.failed++;
    if (link.turn) counts.turn++;
    if (link.candidates) counts.candidates[link.candidates] = (counts.candidates[link.candidates] ?? 0) + 1;
  }
  return counts;
}

function state(): PageState {
  const status = real?.status() ?? null;
  const uncertainty = standin ? standin.clockUncertaintyMs() : (real?.sessionClock()?.uncertaintyMs ?? Infinity);
  if (Number.isFinite(uncertainty)) uncertaintyMax = Math.max(uncertaintyMax, uncertainty);
  const session = standin ? standin.sessionTime() : (real?.sessionClock()?.now() ?? null);
  const wall = Date.now();
  const taken = lag;
  lag = emptyHistogram();
  return {
    engine,
    peer: standin ? standin.peer : (status?.path[0] ?? null),
    started: standin ? standin.started : realStarted,
    error: failure ?? standin?.error ?? null,
    // Infinity does not survive the trip to the driver as JSON.
    clockUncertaintyMs: Number.isFinite(uncertainty) ? uncertainty : -1,
    clockUncertaintyMaxMs: uncertaintyMax,
    connectAttempts,
    sessionMinusWallMs: session === null || !Number.isFinite(session) ? null : session - wall,
    lag: taken,
    links: linkCounts(),
    impairment: { ...impairment },
    parent: standin ? standin.parent() : (status?.stripes[0]?.parent ?? null),
    backup: standin ? standin.backup() : (status?.stripes[0]?.backup ?? null),
    children: standin ? standin.children() : (status?.children.length ?? 0),
    depth: standin ? standin.depth() : (status?.depth ?? 255),
  };
}

window.__overlay = {
  start,
  setProfile: (next, onlyPeer) => {
    profile = next;
    // Not through state(): that takes the lag measured since the last poll.
    const parent = standin ? standin.parent() : (real?.status()?.stripes[0]?.parent ?? null);
    // No parent to name: the profile falls on no link at all, rather than on every one.
    profilePeer = onlyPeer === "parent" ? (parent ?? "") : (onlyPeer ?? null);
  },
  takeSamples: () => (standin ? standin.takeSamples() : realSamples.splice(0, realSamples.length)),
  leave: async () => {
    if (standin) await standin.leave();
    else await real?.close();
  },
  state,
  linkList: () => standin?.links() ?? [],
};
