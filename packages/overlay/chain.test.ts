/**
 * The whole tree-building path at once: the package's Node coordinator, its client, transport's
 * real LinkManager over transport's fake peer connection, and topology's real node. With a
 * fan-out of one everywhere, viewers that can relay arrive one at a time; each is promoted once
 * past probation (SPEC §6.6, §8.1) and the next hangs below it, so a chain several hops deep must
 * form, with video at its far end. (The gate needs real chains: E-media's three-page run never
 * saw a viewer promoted.)
 *
 * Port 4201 (the integration's range, 4200–4219). Owner: the composition root's.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { importGrantPublicKey, verifyGrant, type Capabilities, type PeerId } from "./protocol";
import { createCoordinatorClient } from "./coordinator/index";
import { realClock } from "./coordinator/contract";
import { startNodeCoordinator } from "./coordinator/node";
import { ADMISSION_SECRET, SERVER_SECRET, STREAMS, relayCaps, ticketFor } from "./coordinator/testkit";
import type { CoordinatorClient, NodeCoordinator } from "./coordinator/types";
import { createOverlayNode } from "./topology/index";
import { createBasicEstimator, createOpenGate } from "./topology/standins";
import type { OverlayNode } from "./topology/types";
import { createLinkManager } from "./transport/index";
import { FakeNet } from "./transport/fakeRtc";
import { audioFrame, videoFrame } from "./topology/sim";

const PORT = Number(process.env.OVERLAY_CHAIN_PORT ?? 4201);
const ROOM = "overlay-chain";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Peer = { name: string; peer: PeerId; client: CoordinatorClient; node: OverlayNode; frames: Set<number> };

describe("a chain forms through promotion (SPEC §6.6, §8.1)", () => {
  let server: NodeCoordinator | null = null;
  const net = new FakeNet(realClock);
  net.connectMs = 20;
  net.latencyMs = 2;
  const peers: Peer[] = [];
  const stops: (() => void)[] = [];
  const url = `ws://127.0.0.1:${PORT}/overlay/v1/rooms/${ROOM}/ws`;

  async function join(name: string, role: "source" | "viewer", caps: Capabilities): Promise<Peer> {
    const client = createCoordinatorClient({ url, ticket: () => ticketFor(name, role, Date.now(), { room: ROOM }), clock: realClock, maxBackoffMs: 500 });
    const welcome = await client.connect(caps);
    const key = await importGrantPublicKey(welcome.key.pub);
    const links = createLinkManager({
      self: welcome.peer,
      grant: () => client.grant(),
      verifyPeer: async (peer, grant) => (await verifyGrant(grant, key, { room: ROOM, now: Date.now(), peer })) !== null,
      signaler: client.signaler,
      ice: welcome.ice,
      clock: realClock,
      peerConnection: () => net.factory(),
    });
    const node = createOverlayNode({ self: welcome.peer, links, coordinator: client, params: welcome.params, clock: realClock, sessionClock: client.sessionClock, createLinkEstimator: createBasicEstimator, createLayerGate: createOpenGate });
    const peer: Peer = { name, peer: welcome.peer, client, node, frames: new Set() };
    // What the composition root does with status (engine.ts), with the uplink a probe would have found.
    const report = () => {
      const status = node.status();
      client.sendStatus({
        depth: Math.min(255, status.depth),
        links: status.stripes.map((s) => ({ stream: s.stream, stripe: s.stripe, parent: s.parent, backup: s.backup })),
        children: status.children.length,
        standby: status.standbyChildren.length,
        free: status.freeSlots,
        caps,
        lossPct: 0,
        rttMs: null,
      });
    };
    node.on("status", report);
    node.on("frame", (frame) => {
      if (frame.header.streamId === 0) peer.frames.add(frame.header.frameId);
    });
    peers.push(peer);
    if (role === "source") client.sendStreams(STREAMS);
    node.start(welcome.role, welcome.streams.length > 0 ? welcome.streams : STREAMS, welcome.assign);
    report();
    return peer;
  }

  before(async () => {
    server = await startNodeCoordinator({ port: PORT, admissionSecret: ADMISSION_SECRET, serverSecret: SERVER_SECRET, params: { sourceFanout: 1, maxFanout: 1, sourceAloneFanout: 1, probationMs: 1000 }, storage: new Map(), seed: 5 });
  });
  after(async () => {
    for (const stop of stops) stop();
    for (const peer of peers) {
      peer.client.close();
      void peer.node.stop().catch(() => {});
    }
    await sleep(100);
    await server?.close();
  });

  it("four viewers that can relay, a fan-out of one: a chain four hops deep, video at its end", { timeout: 60_000 }, async () => {
    const source = await join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
    let videoId = 0;
    let audioId = 0;
    stops.push(
      realClock.setInterval(() => source.node.publish(videoFrame(videoId++, Math.round(source.client.sessionClock.now() * 1000), 1500)), 1000 / 30),
      realClock.setInterval(() => source.node.publish(audioFrame(audioId++, Math.round(source.client.sessionClock.now() * 1000))), 20),
    );
    const viewers: Peer[] = [];
    for (let i = 0; i < 4; i++) {
      viewers.push(await join(`v${i}`, "viewer", relayCaps({ uplinkKbps: 20_000 })));
      await sleep(500);
    }
    const depths = () => viewers.map((viewer) => viewer.node.status().depth);
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && !(Math.max(...depths()) >= 4 && viewers.every((viewer) => viewer.node.status().stripes[0].state === "active"))) await sleep(250);
    const status = viewers.map((viewer) => `${viewer.name} ${viewer.node.status().role} depth ${viewer.node.status().depth} ${viewer.node.status().stripes[0].state}`);
    assert.deepEqual([...depths()].sort(), [1, 2, 3, 4], status.join("; "));
    // Each viewer's path runs through the one above it, back to the source.
    const deepest = viewers.find((viewer) => viewer.node.status().depth === 4)!;
    const path = deepest.node.status().path;
    assert.equal(path.length, 5);
    assert.equal(path[path.length - 1], source.peer);
    assert.equal(new Set(path).size, 5);
    // The ones above the last are relays now, promoted by the coordinator.
    for (const viewer of viewers) if (viewer !== deepest) assert.equal(viewer.node.status().role, "relay", viewer.name);
    // And the far end is watching.
    const before = deepest.frames.size;
    await sleep(1000);
    assert.ok(deepest.frames.size - before >= 20, `${deepest.frames.size - before} frames in the last second at depth 4`);
  });
});
