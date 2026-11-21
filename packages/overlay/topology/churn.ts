/**
 * The churn of PLAN T4, as one seeded run: 50 nodes join, then 20 random events (kills, graceful
 * leaves, demotions, unasked advice, joins), then 3 s of quiet. It watches, every 20 ms, that no
 * node is in its own path and that the parents form no cycle, and at the end that every live node
 * is active and getting video. `node.random.test.ts` runs it for many seeds.
 *
 * Not used by the engine itself. Owner: E-transport+topology.
 */
import type { OverlayRole, PeerId } from "../protocol";
import { SimNet, seeded, type SimPeer } from "./sim";

export const NODES = 50;
const EVENTS = 20;
export const SETTLE_MS = 3000;
const CHECK_EVERY_MS = 20;

export type ChurnOutcome = { seed: number; problems: string[]; events: string[]; net: SimNet };

/** One run. Returns what went wrong, if anything. */
export async function churnRun(seed: number): Promise<ChurnOutcome> {
  const rnd = seeded(seed);
  const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  const net = new SimNet({ seed, connectMs: 10 + Math.floor(rnd() * 60), coordinatorMs: 2 + Math.floor(rnd() * 20) });
  const problems: string[] = [];
  const events: string[] = [];
  const log = (what: string) => events.push(`${Math.round(net.clock.now() - 100_000)} ${what}`);
  let next = 1;
  const fanout = (role: OverlayRole) => (role === "source" ? net.params.sourceFanout : role === "relay" ? net.params.maxFanout : 0);

  const live = () => [...net.nodes.values()].filter((peer) => peer.alive);
  const viewers = () => live().filter((peer) => peer.role !== "source");
  /** Active places the live relays offer, less the viewers that need one. */
  const spare = () => live().reduce((sum, peer) => sum + fanout(peer.role), 0) - viewers().length;
  /**
   * Whether the tree can take the loss of `peer` as a parent: its children need places outside
   * its own subtree, which only relays that are themselves receiving can give. The node cannot
   * make room that is not there; the coordinator's promotions would (SPEC §6.6), and this
   * coordinator does not promote, so the churn does not take more than the tree can give.
   */
  const canLose = (peer: SimPeer) => {
    const status = peer.node.status();
    const orphans = status.children.length;
    if (orphans === 0) return spare() - fanout(peer.role) >= 1;
    let free = 0;
    for (const other of live()) {
      if (other === peer) continue;
      const theirs = other.node.status();
      if (theirs.path.includes(peer.id) || (theirs.role !== "source" && theirs.stripes[0]?.state !== "active")) continue;
      free += theirs.freeSlots;
    }
    return free >= orphans + 2;
  };

  const join = () => {
    const id = String(next++);
    // Keep the tree able to hold its audience, as the coordinator's promotions would (SPEC §6.6).
    const role: OverlayRole = spare() < 4 || rnd() < 0.35 ? "relay" : "leaf";
    for (const other of net.nodes.keys()) net.setWire(id, other, { latencyMs: 1 + Math.floor(rnd() * 20) });
    net.joinPlaced(id, role);
    log(`join ${id} ${role}`);
  };

  const check = () => {
    const parentOf = new Map<PeerId, PeerId | null>();
    for (const peer of live()) {
      const status = peer.node.status();
      const path = status.path;
      if (path[0] !== peer.id || path.indexOf(peer.id, 1) >= 0) problems.push(`${net.clock.now()}: ${peer.id} is in its own path ${path.join(">")}`);
      if (new Set(path).size !== path.length) problems.push(`${net.clock.now()}: ${peer.id} has a path with a repeat ${path.join(">")}`);
      parentOf.set(peer.id, status.stripes[0]?.parent ?? null);
    }
    for (const start of parentOf.keys()) {
      const seen = new Set<PeerId>();
      for (let at: PeerId | null | undefined = start; at; at = parentOf.get(at)) {
        if (seen.has(at)) {
          problems.push(`${net.clock.now()}: the parents of ${start} go round: ${[...seen].join(">")}>${at}`);
          break;
        }
        seen.add(at);
      }
    }
  };

  const advance = async (ms: number) => {
    for (let done = 0; done < ms; done += CHECK_EVERY_MS) {
      await net.runAsync(Math.min(CHECK_EVERY_MS, ms - done), 10);
      check();
    }
  };

  const source = net.join("0", "source", []);
  // A light feed: one packet a frame, so that a thousand runs are affordable.
  net.publish(source, { fps: 15, frameBytes: () => 400 });
  await advance(200);
  for (let i = 0; i < NODES; i++) {
    join();
    await advance(100);
  }
  await advance(1500);

  for (let e = 0; e < EVENTS; e++) {
    const roll = rnd();
    const relays = viewers().filter((peer) => peer.node.status().role === "relay");
    if (roll < 0.3 && viewers().length > 5) {
      // Killed without a word; relays more often than their share.
      const victim = rnd() < 0.6 && relays.length > 0 ? pick(relays) : pick(viewers());
      if (canLose(victim)) {
        net.kill(victim.id);
        log(`kill ${victim.id} ${victim.role}`);
      } else join();
    } else if (roll < 0.45 && viewers().length > 5) {
      const leaver = pick(viewers());
      if (canLose(leaver)) {
        leaver.alive = false;
        void leaver.node.stop().then(() => net.kill(leaver.id));
        log(`leave ${leaver.id}`);
      } else join();
    } else if (roll < 0.55 && relays.length > 0) {
      const demoted = pick(relays);
      if (canLose(demoted)) {
        demoted.role = "leaf";
        net.setRole(demoted.id, "leaf");
        log(`demote ${demoted.id}`);
      } else join();
    } else if (roll < 0.7 && viewers().length > 0) {
      // Unasked advice, which may name anyone, even a peer's own descendants: the node must not follow it into a loop.
      const to = pick(viewers());
      const offered = [...new Set(Array.from({ length: 3 }, () => pick(live()).id))].filter((id) => id !== to.id);
      net.assign(to.id, [{ stream: 0, stripe: 0, parents: offered.map((peer) => ({ peer, depth: 1, free: 1 })), backups: [] }], "rebalance");
      log(`advise ${to.id}: ${offered.join(",")}`);
    } else {
      join();
    }
    await advance(150 + Math.floor(rnd() * 450));
  }
  await advance(SETTLE_MS);

  const newest = net.published - 1;
  for (const peer of viewers()) {
    const stripe = peer.node.status().stripes[0];
    if (stripe?.state !== "active") problems.push(`${peer.id} is ${stripe?.state} ${SETTLE_MS} ms after the last event`);
    // Active, and with video: a recent frame arrived.
    else if (![0, 1, 2, 3, 4, 5].some((back) => peer.video.has(newest - back))) problems.push(`${peer.id} is active but has had no video lately (newest ${Math.max(...peer.video)}, source at ${newest})`);
  }
  return { seed, problems: problems.slice(0, 10), events, net };
}
