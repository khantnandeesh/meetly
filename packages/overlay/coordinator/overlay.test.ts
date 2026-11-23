/**
 * The coordinator under a real overlay: SPEC §3.1 and §7.5, "a peer that is already watching keeps
 * watching, and keeps repairing, while the coordinator is unreachable; only joining needs it."
 *
 * In one process, in real time: the Node coordinator on a real socket; for each peer a real
 * `CoordinatorClient`, transport's real `LinkManager` (hello and grant checked with the key from
 * `welcome`, signalling carried by this coordinator) over transport's fake peer connection, and
 * topology's real `OverlayNode`. The source publishes frames shaped like the program feed. Then
 * the coordinator is killed, a relay is killed, and its children must repair to their warm
 * backups without it, while a joiner is refused cleanly; the coordinator comes back and the map
 * returns.
 *
 * It needs transport (T1) and topology (T3), which are other engineers' and land in this branch
 * only when `overlay-engine` has them: until then it says so and skips. It is written against
 * their public faces (`transport/index`, `topology/index`) and the two test stand-ins they ship
 * (`transport/fakeRtc`, `topology/standins`), loaded by name so this file compiles without them.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_PARAMS, MediaFlag, PacketType, importGrantPublicKey, verifyGrant } from "../protocol";
import type { Assignment, Capabilities, MetricsEvent, OverlayRole, PeerId, ServerMessageOf } from "../protocol";
import { NotImplementedError } from "../runtime";
import type { EncodedFrame } from "../types";
import type { LayerGate, LayerGateOptions, LinkEstimator } from "../congestion/types";
import type { LinkManager, TransportOptions } from "../transport/types";
import type { OverlayNode, OverlayNodeOptions } from "../topology/types";
import { CoordinatorError, createClient } from "./client";
import { realClock } from "./contract";
import { startNodeCoordinator } from "./node";
import { ADMISSION_SECRET, SERVER_SECRET, STREAMS, leafCaps, relayCaps, ticketFor } from "./testkit";
import type { CoordinatorClient, NodeCoordinator, RoomSnapshot } from "./types";

const PORT = Number(process.env.OVERLAY_INTEGRATION_PORT ?? 4268);
const ROOM = "overlay-integration";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What this test uses of the modules it does not own, loaded by name. */
type Modules = {
  createLinkManager: (options: TransportOptions) => LinkManager;
  createOverlayNode: (options: OverlayNodeOptions) => OverlayNode;
  FakeNet: new (clock: typeof realClock) => {
    factory: () => RTCPeerConnection;
    connectMs: number;
    latencyMs: number;
  };
  createBasicEstimator: () => LinkEstimator;
  createOpenGate: (options: LayerGateOptions) => LayerGate;
};

async function load(): Promise<Modules | string> {
  // A variable, so that this file compiles on a branch where these files do not exist yet.
  const named = (path: string) => import(path);
  let modules: Modules;
  try {
    modules = {
      ...((await named("../transport/index")) as Pick<Modules, "createLinkManager">),
      ...((await named("../topology/index")) as Pick<Modules, "createOverlayNode">),
      ...((await named("../transport/fakeRtc")) as Pick<Modules, "FakeNet">),
      ...((await named("../topology/standins")) as Pick<Modules, "createBasicEstimator" | "createOpenGate">),
    };
  } catch (error) {
    return `transport's and topology's test stand-ins are not on this branch yet (${String(error).split("\n")[0]})`;
  }
  for (const probe of [() => modules.createOverlayNode(undefined as never), () => modules.createLinkManager(undefined as never)]) {
    try {
      probe();
    } catch (error) {
      // A stub says whose it is; the real thing fails on the missing options, which is fine.
      if (error instanceof NotImplementedError) return `${error.what} is not built on this branch yet`;
    }
  }
  return modules;
}

/** Frames shaped like the program feed: L1T3 video at 30 fps with a keyframe every 60, Opus at 50 a second. */
function videoFrame(frameId: number, captureUs: number): EncodedFrame {
  const inGop = frameId % 60;
  const temporal = inGop % 4 === 0 ? 0 : inGop % 2 === 0 ? 1 : 2;
  return {
    header: {
      type: PacketType.Media,
      flags: inGop === 0 ? MediaFlag.Key : temporal === 2 ? MediaFlag.Discardable : 0,
      streamId: 0,
      stripe: 0,
      spatial: 0,
      temporal,
      refDelta: inGop === 0 ? 0 : temporal === 0 ? 4 : temporal === 1 ? 2 : 1,
      keyDelta: inGop,
      frameId,
      captureUs,
      configId: 0,
    },
    data: new Uint8Array(inGop === 0 ? 6000 : 1500).fill(frameId & 0xff),
  };
}
const audioFrame = (frameId: number, captureUs: number): EncodedFrame => ({
  header: { type: PacketType.Media, flags: MediaFlag.Key, streamId: 1, stripe: 0, spatial: 0, temporal: 0, refDelta: 0, keyDelta: 0, frameId, captureUs, configId: 0 },
  data: new Uint8Array(80).fill(frameId & 0xff),
});

type Peer = {
  name: string;
  peer: PeerId;
  client: CoordinatorClient;
  node: OverlayNode;
  /** Every RTCPeerConnection this peer made: a kill silences them all. */
  pcs: { channels: Map<number, { blackhole: boolean }> }[];
  /** When each video frame arrived, by id. */
  frames: Map<number, number>;
  metrics: MetricsEvent[];
  role: OverlayRole;
};

describe("the coordinator under a real overlay (SPEC §3.1, §7.5)", async () => {
  const modules = await load();
  if (typeof modules === "string") {
    it("needs transport and topology", (t) => t.skip(modules));
    return;
  }
  const { createLinkManager, createOverlayNode, FakeNet, createBasicEstimator, createOpenGate } = modules;
  const storage = new Map<string, Map<string, string>>();
  let server: NodeCoordinator | null = null;
  const start = async () => {
    server = await startNodeCoordinator({ port: PORT, admissionSecret: ADMISSION_SECRET, serverSecret: SERVER_SECRET, storage, seed: 3 });
  };
  const url = `ws://127.0.0.1:${PORT}/overlay/v1/rooms/${ROOM}/ws`;
  const net = new FakeNet(realClock);
  net.connectMs = 20;
  net.latencyMs = 2;
  const peers: Peer[] = [];
  const stops: (() => void)[] = [];

  async function join(name: string, role: "source" | "viewer", caps: Capabilities): Promise<Peer> {
    const client = createClient({ url, ticket: () => ticketFor(name, role, Date.now(), { room: ROOM }), clock: realClock, maxBackoffMs: 500 });
    const welcome: ServerMessageOf<"welcome"> = await client.connect(caps);
    const key = await importGrantPublicKey(welcome.key.pub);
    const pcs: Peer["pcs"] = [];
    const links = createLinkManager({
      self: welcome.peer,
      grant: () => client.grant(),
      verifyPeer: async (peer, grant) => (await verifyGrant(grant, key, { room: ROOM, now: Date.now(), peer })) !== null,
      signaler: client.signaler,
      ice: welcome.ice,
      clock: realClock,
      peerConnection: () => {
        const pc = net.factory();
        pcs.push(pc as unknown as Peer["pcs"][number]);
        return pc;
      },
    });
    const node = createOverlayNode({ self: welcome.peer, links, coordinator: client, params: welcome.params, clock: realClock, sessionClock: client.sessionClock, createLinkEstimator: createBasicEstimator, createLayerGate: createOpenGate });
    const peer: Peer = { name, peer: welcome.peer, client, node, pcs, frames: new Map(), metrics: [], role: welcome.role };
    // What the composition root does: tell the coordinator where the node is (SPEC §6.3 status).
    const report = () => {
      const status = node.status();
      peer.role = status.role;
      client.sendStatus({
        depth: status.depth,
        links: status.stripes.map((stripe) => ({ stream: stripe.stream, stripe: stripe.stripe, parent: stripe.parent, backup: stripe.backup })),
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
      if (frame.header.streamId === 0 && !peer.frames.has(frame.header.frameId)) peer.frames.set(frame.header.frameId, Date.now());
    });
    node.on("metric", (event) => peer.metrics.push(event));
    peers.push(peer);
    if (role === "source") client.sendStreams(welcome.streams.length > 0 ? welcome.streams : STREAMS);
    node.start(welcome.role, welcome.streams.length > 0 ? welcome.streams : STREAMS, welcome.assign as Assignment[]);
    report();
    return peer;
  }

  /** A tab that is killed (SPEC §7.4): nothing it sends arrives anywhere, and it says goodbye to no one. */
  function kill(peer: Peer): void {
    for (const pc of peer.pcs) for (const channel of pc.channels.values()) channel.blackhole = true;
    peer.client.close();
  }

  const tree = async (): Promise<RoomSnapshot> =>
    (await (await fetch(`http://127.0.0.1:${PORT}/overlay/v1/rooms/${ROOM}/tree`, { headers: { authorization: `Bearer ${SERVER_SECRET}` } })).json()) as RoomSnapshot;

  before(start);
  after(async () => {
    for (const stop of stops) stop();
    for (const peer of peers) {
      peer.client.close();
      void peer.node.stop().catch(() => {});
    }
    await sleep(100);
    await server?.close();
  });

  it("warm repair goes on with the coordinator dead; a joiner is refused cleanly; the map comes back", { timeout: 90_000 }, async () => {
    const source = await join("host", "source", relayCaps({ uplinkKbps: 50_000 }));
    let frameId = 0;
    let audioId = 0;
    stops.push(
      realClock.setInterval(() => source.node.publish(videoFrame(frameId++, Math.round(source.client.sessionClock.now() * 1000))), 1000 / 30),
      realClock.setInterval(() => source.node.publish(audioFrame(audioId++, Math.round(source.client.sessionClock.now() * 1000))), 20),
    );
    // Three that can relay fill the source. Past probation (20 s), with the tree short of slots
    // (SPEC §6.6: free slots under a fifth of the audience), some are promoted; viewers that can
    // never relay join meanwhile, wait for a slot, and are sent to one.
    const relays: Peer[] = [];
    for (let i = 0; i < 3; i++) relays.push(await join(`relay-${i}`, "viewer", relayCaps({ uplinkKbps: 20_000 })));
    const leaves: Peer[] = [];
    const viewers = () => [...relays, ...leaves];
    const fed = () => relays.some((relay) => relay.role === "relay" && relay.node.status().children.length > 0);
    // Everyone settled: an active parent, and a warm backup unless the parent is the source (no
    // backup can have the source off its path, SPEC §6.6, and stage 1 ends with the source).
    const settled = () =>
      viewers().every((peer) => peer.node.status().stripes.every((stripe) => stripe.state === "active" && stripe.parent !== null && (stripe.parent === source.peer || stripe.backup !== null)));
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline && !(fed() && settled() && leaves.length >= 5)) {
      await sleep(500);
      if (leaves.length < 5) leaves.push(await join(`leaf-${leaves.length}`, "viewer", leafCaps()));
    }
    assert.ok(fed(), "a relay was promoted and feeds someone");
    assert.ok(settled(), `settled: ${viewers().map((peer) => `${peer.name} ${peer.role} ${JSON.stringify(peer.node.status().stripes[0])}`).join("; ")}`);
    console.log(`      the tree: ${viewers().map((peer) => `${peer.name} (${peer.role}) under ${peers.find((other) => other.peer === peer.node.status().stripes[0].parent)?.name}`).join(", ")}`);

    // The relay with the most children.
    const victim = relays.map((relay) => ({ relay, kids: relay.node.status().children.length })).sort((a, b) => b.kids - a.kids)[0].relay;
    const orphans = viewers().filter((peer) => peer.node.status().stripes[0].parent === victim.peer);
    assert.ok(orphans.length > 0, "the relay feeds someone");

    // The coordinator dies, and then the relay.
    await server!.kill();
    server = null;
    await sleep(300);
    assert.ok(peers.every((peer) => !peer.client.connected));
    const killedAt = Date.now();
    kill(victim);
    await sleep(1_500);

    for (const orphan of orphans) {
      const repairs = orphan.metrics.filter((event): event is Extract<MetricsEvent, { t: "repair" }> => event.t === "repair" && event.dead === victim.peer);
      assert.equal(repairs.length, 1, `${orphan.name}: one repair`);
      const [repair] = repairs;
      console.log(`      ${orphan.name}: ${repair.kind} repair, freeze ${repair.freezeMs} ms, ${repair.framesLost} frames lost, coordinator used: ${repair.usedCoordinator}`);
      assert.equal(repair.kind, "warm");
      assert.equal(repair.usedCoordinator, false);
      assert.ok(repair.freezeMs !== null && repair.freezeMs < 500, `freeze ${repair.freezeMs} ms`);
      // And it is watching now: frames arrived in the last half second.
      const latest = Math.max(...orphan.frames.values());
      assert.ok(latest > killedAt && Date.now() - latest < 500, `${orphan.name} last frame ${Date.now() - latest} ms ago`);
      assert.notEqual(orphan.node.status().stripes[0].parent, victim.peer);
    }
    // Everyone else never stopped.
    for (const peer of viewers().filter((peer) => peer !== victim && !orphans.includes(peer))) assert.ok(Date.now() - Math.max(...peer.frames.values()) < 500, `${peer.name} still watching`);

    // A joiner, meanwhile, is told at once that it cannot join (SPEC §7.5: only joining needs the coordinator).
    const joiner = createClient({ url, ticket: () => ticketFor("late", "viewer", Date.now(), { room: ROOM }), clock: realClock });
    const refusal = await joiner.connect(leafCaps()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(refusal instanceof CoordinatorError && refusal.reason === "unreachable", String(refusal));

    // The coordinator comes back: everyone reconnects as who they were, and the map is rebuilt from status.
    await start();
    const live = peers.filter((peer) => peer !== victim);
    for (let i = 0; i < 40 && !live.every((peer) => peer.client.connected); i++) await sleep(100);
    assert.ok(live.every((peer) => peer.client.connected), "all reconnected");
    await sleep(DEFAULT_PARAMS.statusMs + 500);
    const map = await tree();
    for (const peer of live) {
      const record = map.peers.find((entry) => entry.peer === peer.peer);
      assert.ok(record, `${peer.name} is in the map as itself`);
      if (peer !== source) assert.equal(record.links[0]?.parent, peer.node.status().stripes[0].parent, `${peer.name}'s parent`);
    }
    // And a new joiner gets in, and gets the picture.
    const late = await join("later", "viewer", leafCaps());
    for (let i = 0; i < 40 && late.frames.size === 0; i++) await sleep(100);
    assert.ok(late.frames.size > 0, "the late joiner is watching");
  });
});

