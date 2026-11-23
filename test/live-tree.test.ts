import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeerRecord, RoomSnapshot } from "../packages/overlay/coordinator/types";
import { anonymize, audience, branches, viewKey } from "../src/lib/live/tree";

/** Live (beta)'s "Who's connected": the coordinator's tree map, with nobody identifiable in it. */

const peer = (id: string, role: PeerRecord["role"], joinedAt: number, parent: string | null, depth: number, children: number, conn: string | null = `c-${id}`): PeerRecord =>
  ({
    peer: id,
    conn,
    identity: `identity-${id}`,
    role,
    caps: { browser: "chromium", desktop: true, onPower: true, nat: "open", uplinkKbps: 9000, cores: 8, decode: [], dataSaver: false, visible: true },
    region: "LHR",
    joinedAt,
    lastStatusAt: joinedAt,
    depth,
    links: [{ stream: 0, stripe: 0, parent, backup: null }],
    children,
    standby: 0,
    free: 0,
  }) as PeerRecord;

const snapshot = (peers: PeerRecord[], ended = false): RoomSnapshot => ({ room: "abc-defg-hij", startedAt: 1, ended, source: "SRC", streams: [], peers });

test("the tree keeps its shape, labels viewers by arrival, and leaves out who they are", async () => {
  const tree = await anonymize(
    snapshot([
      peer("SRC", "source", 0, null, 0, 1),
      peer("BBB", "leaf", 30, "AAA", 2, 0),
      peer("AAA", "relay", 10, "SRC", 1, 2),
      peer("CCC", "leaf", 20, "AAA", 2, 0),
      peer("GONE", "leaf", 5, "SRC", 1, 0, null),
    ]),
  );
  assert.equal(tree.viewers, 3);
  assert.equal(tree.started, true);
  assert.equal(tree.full, false);
  assert.deepEqual(
    tree.nodes.map((n) => [n.label, n.depth, n.children]),
    [
      ["Host", 0, 1],
      ["Viewer 1", 1, 2],
      ["Viewer 2", 2, 0],
      ["Viewer 3", 2, 0],
    ],
  );
  const text = JSON.stringify(tree);
  for (const secret of ["SRC", "AAA", "BBB", "CCC", "identity-", "LHR", "chromium"]) assert.ok(!text.includes(secret), secret);
  const a = tree.nodes.find((n) => n.label === "Viewer 1")!;
  assert.equal(a.key, await viewKey("AAA"));
  const { roots, waiting } = branches(tree.nodes);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].below.map((n) => n.label), ["Viewer 1"]);
  assert.deepEqual(roots[0].below[0].below.map((n) => n.label), ["Viewer 2", "Viewer 3"]);
  assert.equal(waiting.length, 0);
});

test("a viewer without a parent is waiting; an ended or full stream says so", async () => {
  const lone = await anonymize(snapshot([peer("SRC", "source", 0, null, 0, 0), peer("AAA", "leaf", 1, null, 255, 0)]));
  assert.equal(lone.nodes[1].depth, null);
  assert.deepEqual(branches(lone.nodes).waiting.map((n) => n.label), ["Viewer 1"]);
  assert.equal((await anonymize(snapshot([], true))).ended, true);
  const many = Array.from({ length: 3 }, (_, i) => peer(`P${i}`, "leaf", i, "SRC", 1, 0));
  assert.equal((await anonymize(snapshot([peer("SRC", "source", 0, null, 0, 3), ...many]), 3)).full, true);
  // A viewer who has just left still holds its place at the coordinator, which refuses the next
  // one: full, though it is no longer counted as watching.
  const justLeft = [...many.slice(0, 2), peer("P2", "leaf", 2, "SRC", 1, 0, null)];
  const leaving = await anonymize(snapshot([peer("SRC", "source", 0, null, 0, 3), ...justLeft]), 3);
  assert.equal(leaving.viewers, 2);
  assert.equal(leaving.full, true);
});

test("the audience counts placed viewers as watching and the rest as connecting", async () => {
  const tree = await anonymize(snapshot([peer("SRC", "source", 0, null, 0, 1), peer("AAA", "relay", 1, "SRC", 1, 0), peer("BBB", "leaf", 2, null, 255, 0)]));
  assert.equal(tree.viewers, 2);
  assert.deepEqual(audience(tree), { watching: 1, connecting: 1 });
  assert.deepEqual(audience(null), { watching: 0, connecting: 0 });
});
