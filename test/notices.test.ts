import assert from "node:assert/strict";
import { test } from "node:test";
import { handQueue } from "../src/lib/handQueue";
import { DESKTOP_MODE, crowdSentence, order, overflow, place, waitingSentence, type NoticeEntry } from "../src/lib/notices";

/** The notification rules (src/lib/notices.ts): what shows, what makes way, what waits, what is dropped. */

const n = (id: number, priority: NoticeEntry["priority"]): NoticeEntry => ({ id, priority });
const PHONE_SHEET = { max: 1, info: false };

test("notices: below the cap, anything shows", () => {
  assert.deepEqual(place([], n(1, "presence"), DESKTOP_MODE), { kind: "show" });
  assert.deepEqual(place([n(1, "info")], n(2, "info"), DESKTOP_MODE), { kind: "show" });
});

test("notices: at the cap, news is dropped rather than stacked", () => {
  const full = [n(1, "info"), n(2, "presence")];
  assert.deepEqual(place(full, n(3, "presence"), DESKTOP_MODE), { kind: "drop" });
  assert.deepEqual(place([n(1, "action"), n(2, "you")], n(3, "info"), DESKTOP_MODE), { kind: "drop" });
});

test("notices: a higher kind takes the place of the lowest, oldest first", () => {
  assert.deepEqual(place([n(1, "info"), n(2, "presence")], n(3, "info"), DESKTOP_MODE), { kind: "replace", evict: 2 });
  assert.deepEqual(place([n(1, "presence"), n(2, "presence")], n(3, "you"), DESKTOP_MODE), { kind: "replace", evict: 1 });
  assert.deepEqual(place([n(1, "you"), n(2, "info")], n(3, "action"), DESKTOP_MODE), { kind: "replace", evict: 2 });
});

test("notices: what concerns you waits for room instead of being lost or pushing past the cap", () => {
  assert.deepEqual(place([n(1, "action"), n(2, "you")], n(3, "you"), DESKTOP_MODE), { kind: "queue" });
  assert.deepEqual(place([n(1, "action")], n(2, "you"), PHONE_SHEET), { kind: "queue" });
});

test("notices: with a sheet or a dialog open, news does not interrupt at all", () => {
  assert.deepEqual(place([], n(1, "info"), PHONE_SHEET), { kind: "drop" });
  assert.deepEqual(place([], n(1, "presence"), { max: 2, info: false }), { kind: "drop" });
  assert.deepEqual(place([], n(1, "action"), PHONE_SHEET), { kind: "show" });
});

test("notices: the stack keeps its order: highest kind at the anchor, then oldest", () => {
  const list = [n(5, "presence"), n(2, "info"), n(9, "action"), n(3, "you"), n(1, "info")];
  assert.deepEqual(order(list).map((e) => e.id), [9, 3, 1, 2, 5]);
});

test("notices: when room shrinks, news goes and the rest are moved out lowest first", () => {
  const showing = [n(1, "action"), n(2, "info")];
  assert.deepEqual(overflow(showing, PHONE_SHEET).map((e) => e.id), [2]);
  assert.deepEqual(overflow([n(1, "you"), n(2, "action")], PHONE_SHEET).map((e) => e.id), [1]);
  assert.deepEqual(overflow([n(1, "you"), n(2, "info")], DESKTOP_MODE), []);
});

test("notices: a flood of a thousand arrivals never puts more than the cap on screen", () => {
  let showing: NoticeEntry[] = [];
  const kinds: NoticeEntry["priority"][] = ["presence", "info", "you", "action"];
  for (let id = 1; id <= 1000; id++) {
    const incoming = n(id, kinds[id % 4]);
    const placed = place(showing, incoming, DESKTOP_MODE);
    if (placed.kind === "show") showing = [...showing, incoming];
    if (placed.kind === "replace") showing = [...showing.filter((e) => e.id !== placed.evict), incoming];
    assert.ok(showing.length <= DESKTOP_MODE.max);
  }
  // What is left on screen is what matters most.
  assert.deepEqual(showing.map((e) => e.priority).sort(), ["action", "action"]);
});

test("notices: crowds are counted, not listed", () => {
  assert.equal(crowdSentence(["Ava"], "joined"), "Ava joined");
  assert.equal(crowdSentence(["Ava", "Ben"], "left"), "Ava and Ben left");
  assert.equal(crowdSentence(["Ava", "Ben", "Cy", "Di"], "joined"), "4 people joined");
  assert.equal(waitingSentence(1, "Pat"), "Pat wants to join");
  assert.equal(waitingSentence(100, "Pat"), "100 people want to join");
});

test("hands: listed in the order they went up, not by name", () => {
  const p = (identity: string, handRaised: boolean) => ({ identity, handRaised });
  assert.deepEqual(handQueue([p("zoe", true)]).map((x) => x.identity), ["zoe"]);
  assert.deepEqual(handQueue([p("amy", true), p("zoe", true)]).map((x) => x.identity), ["zoe", "amy"]);
  // Lowered and raised again goes to the back.
  handQueue([p("amy", true), p("zoe", false)]);
  assert.deepEqual(handQueue([p("amy", true), p("zoe", true)]).map((x) => x.identity), ["amy", "zoe"]);
});
