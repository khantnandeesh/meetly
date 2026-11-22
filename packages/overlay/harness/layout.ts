/**
 * Which runner does what in a sharded run, decided once by shard 0 after every runner has said
 * what NAT it is behind (ci/natcheck.mjs), and handed to all of them in the rendezvous.
 *
 * - Shard 0 runs the coordinator and its tunnel, and no peer.
 * - The source has a runner of its own: encoding the program beside ten viewers put shard 0 at
 *   load 9 in the 19-runner gate.
 * - A runner behind a symmetric NAT (GitHub's AWS-hosted runners) can link to no other machine
 *   without TURN, which there is none of: it is excluded before it starts a peer, and its share
 *   of the viewers goes to the others. So is a runner that had not reported by the deadline.
 *
 * Owner: E-harness.
 */
import type { ShardLayout } from "./types";

export type NatReport = { shard: number; symmetric: boolean | null };

export function decideLayout(count: number, reports: NatReport[]): ShardLayout {
  const seen = new Map(reports.map((report) => [report.shard, report]));
  const excluded: ShardLayout["excluded"] = [];
  const open: number[] = [];
  for (let shard = 1; shard < count; shard++) {
    const report = seen.get(shard);
    if (!report) excluded.push({ shard, why: "late: had not reported its NAT when the run was laid out" });
    else if (report.symmetric === true) excluded.push({ shard, why: "symmetric NAT (an AWS-hosted runner): no link to another machine opens without TURN" });
    else open.push(shard);
  }
  if (open.length === 0) {
    // Nobody can take peers: run everything beside the coordinator, and let the report say so.
    return { coordinatorShard: 0, sourceShard: 0, viewerShards: [0], excluded };
  }
  // One open runner: the source shares it. Two or more: the source has one to itself.
  const [sourceShard, ...rest] = open;
  return { coordinatorShard: 0, sourceShard, viewerShards: rest.length ? rest : [sourceShard], excluded };
}
