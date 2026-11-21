/**
 * One peer of the browser run (./run.ts), in one page. The peer is the same fake node as in the
 * unit tests (../sim/peer.ts), with the estimator and the gate as they ship; what is different is
 * what they stand on: real `RTCPeerConnection`s and the two data channels of SPEC §3.2, real
 * timers, a real clock.
 *
 * Still not real: the media (synthetic frames, no encoder), the signalling (a `BroadcastChannel`
 * between the pages, where the coordinator will be), and the slow link (a rate cap in front of
 * the channel, where E-harness's impairment shim will be: `TransportOptions.wrapChannel`).
 */
import { createUplinkProbe } from "../probe";
import { FakePeer } from "../sim/peer";
import { STAGE1_SHAPE, createSyntheticProgram } from "../sim/program";
import { viewerStats } from "../sim/tree";
import { RateCap, type Pipe } from "../sim/world";

export type PeerConfig = { run: string; id: string; parent: string | null; children: string[]; depth: number; epochMs: number };

type Signal = { run: string; from: string; to: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

/**
 * The run's session clock: milliseconds since the driver started the run, the same in every page
 * of one machine. (SPEC §4.1's comes from the coordinator; this one from the machine's own clock.)
 */
let epoch = 0;
const wallClock = (): number => performance.timeOrigin + performance.now() - epoch;

/** A data channel behind a rate cap with a bounded queue. `bufferedAmount` is the queue's and the channel's together. */
class CappedPipe implements Pipe {
  private cap: RateCap<Uint8Array> | null = null;
  constructor(private readonly channel: RTCDataChannel) {}

  setCap(kbps: number | null, queueMs: number): void {
    this.pump();
    if (kbps === null) {
      if (this.cap) for (const packet of this.cap.take(Infinity)) this.channel.send(packet as Uint8Array<ArrayBuffer>);
      this.cap = null;
    } else if (this.cap) {
      this.cap.kbps = kbps;
      this.cap.queueMs = queueMs;
    } else {
      this.cap = new RateCap(kbps, queueMs);
    }
  }

  get dropped(): number {
    return this.cap?.dropped ?? 0;
  }

  get bufferedAmount(): number {
    return (this.cap?.backlog ?? 0) + this.channel.bufferedAmount;
  }

  send(packet: Uint8Array): void {
    if (this.channel.readyState !== "open") return;
    if (!this.cap) return this.channel.send(packet as Uint8Array<ArrayBuffer>);
    this.cap.push(packet.slice(), packet.byteLength, wallClock());
    this.pump();
  }

  /** Lets out what is due. Called from the page's timer. */
  pump(): void {
    if (!this.cap || this.channel.readyState !== "open") return;
    for (const packet of this.cap.take(wallClock())) this.channel.send(packet as Uint8Array<ArrayBuffer>);
  }
}

function createPagePeer(config: PeerConfig) {
  epoch = config.epochMs;
  const program = createSyntheticProgram(STAGE1_SHAPE);
  const peer = new FakePeer({
    id: config.id,
    depth: config.depth,
    streamKbps: STAGE1_SHAPE.videoKbps,
    temporalLayers: 3,
    frameIntervalMs: program.frameIntervalMs,
    audioFrameMs: STAGE1_SHAPE.audioFrameMs,
  });
  const signalling = new BroadcastChannel(`econg-${config.run}`);
  const connections = new Map<string, RTCPeerConnection>();
  const down = new Map<string, CappedPipe>();
  let up: CappedPipe | null = null;
  let lagMaxMs = 0;
  const early = new Map<string, RTCIceCandidateInit[]>();
  const queue = new Map<string, Promise<void>>();

  const signal = (to: string, body: Omit<Signal, "run" | "from" | "to">): void =>
    signalling.postMessage({ run: config.run, from: config.id, to, ...body } satisfies Signal);

  /** One link: a peer connection and SPEC §3.2's two channels, neither side waiting for the other's. */
  const link = (other: string): { connection: RTCPeerConnection; media: RTCDataChannel; opened: Promise<void> } => {
    const connection = new RTCPeerConnection({ iceServers: [] });
    connections.set(other, connection);
    connection.onicecandidate = (event) => {
      if (event.candidate) signal(other, { candidate: event.candidate.toJSON() });
    };
    connection.createDataChannel("ctl", { negotiated: true, id: 0, ordered: true });
    const media = connection.createDataChannel("media", { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    media.binaryType = "arraybuffer";
    const opened = new Promise<void>((resolve, reject) => {
      media.onopen = () => resolve();
      media.onerror = () => reject(new Error(`media channel to ${other} failed`));
    });
    return { connection, media, opened };
  };

  const links = [...config.children, ...(config.parent === null ? [] : [config.parent])].map((other) => ({ other, ...link(other) }));

  signalling.onmessage = (event: MessageEvent<Signal>) => {
    const message = event.data;
    if (message.run !== config.run || message.to !== config.id) return;
    const connection = connections.get(message.from);
    if (!connection) return;
    // One at a time per link, and no candidate before the description it belongs to.
    const step = async (): Promise<void> => {
      if (message.candidate) {
        if (connection.remoteDescription) await connection.addIceCandidate(message.candidate);
        else early.set(message.from, [...(early.get(message.from) ?? []), message.candidate]);
      }
      if (message.description) {
        await connection.setRemoteDescription(message.description);
        for (const candidate of early.get(message.from) ?? []) await connection.addIceCandidate(candidate);
        early.delete(message.from);
        if (message.description.type === "offer") {
          await connection.setLocalDescription(await connection.createAnswer());
          signal(message.from, { description: connection.localDescription!.toJSON() });
        }
      }
    };
    queue.set(message.from, (queue.get(message.from) ?? Promise.resolve()).then(step));
  };

  return {
    /** The parent makes the offer on each link; resolves when every channel of this peer is open. */
    async connect(): Promise<void> {
      for (const { other, connection } of links) {
        if (!config.children.includes(other)) continue;
        await connection.setLocalDescription(await connection.createOffer());
        signal(other, { description: connection.localDescription!.toJSON() });
      }
      await Promise.all(links.map((entry) => entry.opened));
      for (const { other, media } of links) {
        const pipe = new CappedPipe(media);
        if (other === config.parent) {
          up = pipe;
          peer.setParent(pipe);
          media.onmessage = (event: MessageEvent<ArrayBuffer>) => peer.fromParent(new Uint8Array(event.data), wallClock());
        } else {
          down.set(other, pipe);
          peer.addChild(other, pipe, wallClock());
          media.onmessage = (event: MessageEvent<ArrayBuffer>) => peer.fromChild(other, new Uint8Array(event.data), wallClock());
        }
      }
    },

    /** Starts the timers. On the source, `startAt` is when the program begins: frames are made by the clock, not by the timer. */
    run(startAt: number): void {
      let videoFrames = 0;
      let audioFrames = 0;
      let last = wallClock();
      setInterval(() => {
        const now = wallClock();
        lagMaxMs = Math.max(lagMaxMs, now - last - 4);
        last = now;
        if (config.parent === null && now >= startAt) {
          for (; startAt + videoFrames * program.frameIntervalMs <= now; videoFrames++)
            peer.publish(program.video((startAt + videoFrames * program.frameIntervalMs) * 1000), now);
          for (; startAt + audioFrames * STAGE1_SHAPE.audioFrameMs <= now; audioFrames++)
            peer.publish(program.audio((startAt + audioFrames * STAGE1_SHAPE.audioFrameMs) * 1000), now);
        }
        for (const pipe of down.values()) pipe.pump();
        up?.pump();
        peer.tick(now);
      }, 4);
    },

    now: wallClock,

    /** Caps what this peer sends to one child. Null lifts the cap. */
    capDown(child: string, kbps: number | null, queueMs = 300): void {
      down.get(child)!.setCap(kbps, queueMs);
    },

    /** Caps what this peer sends to its parent. */
    capUp(kbps: number | null, queueMs = 300): void {
      up!.setCap(kbps, queueMs);
    },

    /** Runs an uplink probe to the parent and resolves with what it measured. */
    probe(targetKbps: number, durationMs: number): Promise<number> {
      const probe = createUplinkProbe({ targetKbps, durationMs });
      peer.probe = probe;
      return new Promise((resolve) => {
        const poll = setInterval(() => {
          if (probe.spareKbps === null) return;
          clearInterval(poll);
          peer.probe = null;
          resolve(probe.spareKbps);
        }, 20);
      });
    },

    /** What this peer received of the frames captured in a stretch of time, and what it did for each child. */
    report(fromMs: number, toMs: number) {
      const now = wallClock();
      return {
        id: config.id,
        lagMaxMs,
        duplicates: peer.duplicates,
        stats: config.parent === null ? null : viewerStats(peer, fromMs, toMs),
        uplink: peer.up ? peer.up.estimator.estimate(now) : null,
        children: [...peer.children.values()].map((port) => ({
          id: port.id,
          caps: port.caps,
          starvedAt: port.starvedAt,
          offered: port.offered,
          sent: port.sent,
          refused: port.refused,
          estimate: port.estimator.estimate(now),
          dropped: down.get(port.id)!.dropped,
          firstCongestedAt: port.states.find((entry) => entry.at >= fromMs && entry.state === "congested")?.at ?? null,
        })),
      };
    },
  };
}

export type PagePeer = ReturnType<typeof createPagePeer>;

declare global {
  interface Window {
    __econg: { create(config: PeerConfig): void; peer: PagePeer | null };
  }
}

window.__econg = {
  peer: null,
  create(config) {
    this.peer = createPagePeer(config);
  },
};
