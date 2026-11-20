// Layout and phone (E3): the reaction lane's rules, and how counts are written where room is short.
import assert from "node:assert/strict";
import test from "node:test";
import { badgeCount, fullCount, shortCount } from "../src/lib/counts";
import {
  addToLane,
  createReactionStore,
  describeReactions,
  LANE_LIMIT,
  NAMELESS_FROM,
  PHONE_LANE_LIMIT,
  type LaneEntry,
  type LaneRules,
} from "../src/lib/reactions";

const EMOJI = ["👍", "❤️", "😂", "😮", "👏", "🎉"];

/** `count` reactions spread over the six emoji, as a lane with these rules would hold them. */
function flood(count: number, rules: LaneRules): LaneEntry[] {
  let lane: LaneEntry[] = [];
  for (let i = 1; i <= count; i++) lane = addToLane(lane, { id: i, emoji: EMOJI[(i * 7) % 6], name: `Person${i}` }, rules);
  return lane;
}

test("a flood of 200 reactions never holds more than 4 rows, or 3 on a phone", () => {
  for (const people of [5, 50, 231]) {
    assert.ok(flood(200, { limit: LANE_LIMIT, people }).length <= 4, `desktop, ${people} people`);
    assert.ok(flood(200, { limit: PHONE_LANE_LIMIT, people }).length <= 3, `phone, ${people} people`);
  }
});

test("at most 10 people, each reaction is its own row with a first name, until the lane is full", () => {
  const rules = { limit: LANE_LIMIT, people: 10 };
  let lane: LaneEntry[] = [];
  lane = addToLane(lane, { id: 1, emoji: "🎉", name: "Maya" }, rules);
  lane = addToLane(lane, { id: 2, emoji: "🎉", name: "Sam" }, rules);
  assert.deepEqual(
    lane.map((row) => [row.emoji, row.name, row.count]),
    [
      ["🎉", "Maya", 1],
      ["🎉", "Sam", 1],
    ],
  );
});

test("above 10 people, reactions with the same emoji share one row whose count climbs in place", () => {
  const rules = { limit: LANE_LIMIT, people: 11 };
  let lane: LaneEntry[] = [];
  lane = addToLane(lane, { id: 1, emoji: "👏", name: "Maya" }, rules);
  lane = addToLane(lane, { id: 2, emoji: "🎉", name: "Sam" }, rules);
  for (let id = 3; id < 40; id++) lane = addToLane(lane, { id, emoji: "👏", name: `P${id}` }, rules);
  assert.deepEqual(
    lane.map((row) => [row.id, row.emoji, row.name, row.count]),
    [
      [1, "👏", "", 38],
      [2, "🎉", "Sam", 1],
    ],
    "the 👏 row stays first (at the bottom) while it grows; Sam's row is still one person's",
  );
});

test("from 200 people the lane carries counts only, never names", () => {
  const lane = flood(200, { limit: LANE_LIMIT, people: NAMELESS_FROM });
  assert.ok(lane.every((row) => row.name === ""));
  const one = addToLane([], { id: 1, emoji: "🎉", name: "Maya" }, { limit: LANE_LIMIT, people: NAMELESS_FROM });
  assert.equal(one[0].name, "");
  assert.equal(describeReactions([{ name: "Maya", emoji: "👏" }, { name: "Sam", emoji: "👏" }], false), "2 reactions 👏");
  assert.equal(describeReactions([{ name: "Maya", emoji: "👏" }], false), "1 reaction 👏");
});

test("a new emoji row goes on top: the rows already there keep their order and place", () => {
  const rules = { limit: LANE_LIMIT, people: 50 };
  let lane: LaneEntry[] = [];
  lane = addToLane(lane, { id: 1, emoji: "👏", name: "A" }, rules);
  lane = addToLane(lane, { id: 2, emoji: "🎉", name: "B" }, rules);
  const before = lane.map((row) => row.id);
  lane = addToLane(lane, { id: 3, emoji: "😂", name: "C" }, rules);
  assert.deepEqual(lane.slice(0, 2).map((row) => row.id), before);
  assert.equal(lane.at(-1)!.emoji, "😂");
});

test("when the lane is full, the row that changed longest ago makes room, not simply the oldest", () => {
  const rules = { limit: 3, people: 50 };
  let lane: LaneEntry[] = [];
  lane = addToLane(lane, { id: 1, emoji: "👏", name: "A" }, rules);
  lane = addToLane(lane, { id: 2, emoji: "🎉", name: "B" }, rules);
  lane = addToLane(lane, { id: 3, emoji: "😂", name: "C" }, rules);
  // 👏 is the oldest row but the busiest: it stays, and 🎉 goes.
  lane = addToLane(lane, { id: 4, emoji: "👏", name: "D" }, rules);
  lane = addToLane(lane, { id: 5, emoji: "😮", name: "E" }, rules);
  assert.deepEqual(
    lane.map((row) => row.emoji),
    ["👏", "😂", "😮"],
  );
});

test("the store follows the lane limit: a phone's lane is cut to its three freshest rows", () => {
  const store = createReactionStore(() => 0);
  store.setRules({ limit: LANE_LIMIT, people: 4 });
  ["👏", "🎉", "😂", "😮"].forEach((emoji, i) => store.add(`p${i}`, `P${i}`, emoji, false));
  assert.equal(store.lane().length, 4);
  let changes = 0;
  store.subscribeLane(() => changes++);
  store.setRules({ limit: PHONE_LANE_LIMIT, people: 4 });
  assert.deepEqual(
    store.lane().map((row) => row.emoji),
    ["🎉", "😂", "😮"],
  );
  assert.equal(changes, 1);
  store.setRules({ limit: PHONE_LANE_LIMIT, people: 5 });
  assert.equal(changes, 1, "nothing to cut, nothing redrawn");
});

test("badges count to 99, then read 99+", () => {
  assert.equal(badgeCount(1), "1");
  assert.equal(badgeCount(12), "12");
  assert.equal(badgeCount(99), "99");
  assert.equal(badgeCount(100), "99+");
  assert.equal(badgeCount(128), "99+");
});

test("the phone headcount reads 1.2k from 1,000; screen readers get the whole number", () => {
  assert.equal(shortCount(999), "999");
  assert.equal(shortCount(1000), "1k");
  assert.equal(shortCount(1204), "1.2k");
  assert.equal(shortCount(1999), "1.9k", "cut, not rounded up to 2k");
  assert.equal(shortCount(12_345), "12k");
  assert.equal(fullCount(1204), "1,204");
  assert.equal(fullCount(128), "128");
});

test("a tile too short for the full lane limits it to the rows that fit", () => {
  const store = createReactionStore(() => 0);
  store.setRules({ limit: LANE_LIMIT, people: 4 });
  store.setRoom(2);
  ["👏", "🎉", "😂", "😮"].forEach((emoji, i) => store.add(`p${i}`, `P${i}`, emoji, false));
  assert.equal(store.lane().length, 2);
  store.setRoom(Infinity);
  store.add("p9", "P9", "👍", false);
  assert.equal(store.lane().length, 3, "with room again, the limit is the screen's");
});

test("a row stays at least a second, so a flood spread evenly over six emoji counts instead of flickering", () => {
  let lane: LaneEntry[] = [];
  const made = new Set<number>();
  // Six emoji in turn, 100 a second for 2 s, into four rows.
  for (let id = 1; id <= 200; id++) {
    lane = addToLane(lane, { id, emoji: EMOJI[id % 6], name: "" }, { limit: LANE_LIMIT, people: 231, now: id * 10 });
    lane.forEach((row) => made.add(row.id));
  }
  assert.equal(lane.length, 4);
  // Four rows to begin with, then at most one replaced per second or so: not one per reaction.
  assert.ok(made.size <= 4 + 4 * 2, `${made.size} rows were shown`);
  assert.ok(lane.some((row) => row.count > 10), lane.map((row) => `${row.emoji}×${row.count}`).join(" "));
});
