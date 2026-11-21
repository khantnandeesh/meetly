/**
 * One peer of the topology bench, in a browser page: real links (`RTCPeerConnection`, host
 * candidates), the real node, and topology's stand-ins for the congestion module. The bench's
 * driver (./run.ts) plays the coordinator and relays signalling through Playwright, as the
 * proof's `tree.js` did; nothing here is the harness's, which is E-harness's to build.
 *
 * The source publishes a synthetic program feed shaped like SPEC §9.2 (L1T3 headers, a keyframe
 * every 60 frames, about 1.2 Mbps, audio every 20 ms): forwarding and repair read only headers,
 * so this measures them as they are. Viewers are light (D29): a frame counts as shown when it
 * becomes whole and decodable, with no jitter buffer and no decoder.
 *
 * Owner: E-transport+topology.
 */
import { DEFAULT_PARAMS, type Assignment, type MetricsEvent, type OverlayRole, type PeerId, type SignalData } from "../../protocol";
import type { Clock, SessionClock } from "../../runtime";
import { createLinkManager } from "../../transport/link";
import { createOverlayNode } from "../node";
import { AUDIO, VIDEO, audioFrame, videoFrame } from "../sim";
import { createBasicEstimator, createOpenGate } from "../standins";
import type { CoordinatorPort, NodeStats } from "../types";

type Bridge = {
  benchSignal(to: PeerId, data: SignalData): void;
  benchNeed(stream: number, stripe: number, want: "parent" | "backup", exclude: PeerId[]): Promise<Assignment | null>;
  benchReport(event: string, peer: PeerId, next: PeerId | null): void;
  benchStatus(status: string): void;
};

declare global {
  interface Window {
    bench: Bench;
  }
}

type Init = { self: PeerId; role: OverlayRole; epochMs: number; assignments: Assignment[]; warm: boolean };

const wall = () => performance.timeOrigin + performance.now();

const clock: Clock = {
  now: () => performance.now(),
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    return () => clearInterval(handle);
  },
};

class Bench {
  private bridge = window as unknown as Window & Bridge;
  private signalListeners: ((from: PeerId, data: SignalData) => void)[] = [];
  private node: ReturnType<typeof createOverlayNode> | null = null;
  private epochMs = 0;
  /** Video frames whole: [frameId, wall ms, captureUs, temporal]. */
  readonly video: [number, number, number, number][] = [];
  readonly metrics: MetricsEvent[] = [];
  readonly stats: NodeStats[] = [];
  readonly errors: string[] = [];
  private stopSource: (() => void) | null = null;

  init(options: Init): void {
    this.epochMs = options.epochMs;
    const epoch = options.epochMs;
    const sessionClock: SessionClock = {
      now: () => wall() - epoch,
      fromLocal: (local) => performance.timeOrigin + local - epoch,
      uncertaintyMs: 0,
    };
    const links = createLinkManager({
      self: options.self,
      // The grant check is transport's and is tested there; the bench admits everyone.
      grant: () => "bench",
      verifyPeer: async () => true,
      signaler: {
        send: (to, data) => this.bridge.benchSignal(to, data),
        onSignal: (listener) => {
          this.signalListeners.push(listener);
          return () => {};
        },
      },
      ice: [],
      clock,
    });
    const port: CoordinatorPort = {
      connected: true,
      need: (stream, stripe, want, exclude) => this.bridge.benchNeed(stream, stripe, want, exclude),
      report: (event, _stream, _stripe, peer, next) => this.bridge.benchReport(event, peer, next ?? null),
      onAssign: () => () => {},
      onRole: () => () => {},
      onPeerGone: () => () => {},
    };
    const node = createOverlayNode({
      self: options.self,
      links,
      coordinator: port,
      params: DEFAULT_PARAMS,
      clock,
      sessionClock,
      createLinkEstimator: createBasicEstimator,
      createLayerGate: createOpenGate,
    });
    this.node = node;
    node.on("frame", (frame) => {
      if (frame.header.streamId === 0) this.video.push([frame.header.frameId, wall(), frame.header.captureUs, frame.header.temporal]);
    });
    node.on("metric", (event) => this.metrics.push(event));
    if (!crossOriginIsolated) this.errors.push("not cross-origin isolated: performance.now() is coarse");
    node.on("error", (error) => this.errors.push(String(error)));
    node.on("status", () => this.bridge.benchStatus(JSON.stringify(node.status())));
    clock.setInterval(() => this.stats.push(node.takeStats()), 2000);
    node.start(options.role, [VIDEO, AUDIO], options.assignments);
    this.bridge.benchStatus(JSON.stringify(node.status()));
  }

  signal(from: PeerId, data: SignalData): void {
    for (const listener of this.signalListeners) listener(from, data);
  }

  /** The source only: about 1.2 Mbps of L1T3-shaped video at 30 fps, and audio at 50 a second. */
  publish(): void {
    const node = this.node!;
    let videoId = 0;
    let audioId = 0;
    const captureUs = () => Math.round((wall() - this.epochMs) * 1000);
    const bytes = (id: number) => (id % 60 === 0 ? 30_000 : id % 4 === 0 ? 6000 : id % 2 === 0 ? 4000 : 3000);
    const video = setInterval(() => node.publish(videoFrame(videoId, captureUs(), bytes(videoId++))), 1000 / 30);
    const audio = setInterval(() => node.publish(audioFrame(audioId++, captureUs())), 20);
    this.stopSource = () => {
      clearInterval(video);
      clearInterval(audio);
    };
  }

  status(): string {
    return JSON.stringify(this.node?.status() ?? null);
  }

  async leave(): Promise<void> {
    this.stopSource?.();
    await this.node?.stop();
  }

  dump() {
    this.stats.push(this.node!.takeStats());
    return { video: this.video, metrics: this.metrics, stats: this.stats, errors: this.errors, status: this.node!.status(), now: wall() };
  }
}

window.bench = new Bench();
