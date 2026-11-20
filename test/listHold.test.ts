import assert from "node:assert/strict";
import { test } from "node:test";
import { holdList } from "../src/lib/listHold";

type P = { id: string; name: string };
const key = (p: P) => p.id;
const p = (id: string, name = id): P => ({ id, name });

test("a held list adds nobody and counts who arrived since", () => {
  const held = [p("a"), p("b")];
  const { shown, added } = holdList(held, [p("a"), p("x"), p("b"), p("y")], key);
  assert.deepEqual(shown.map(key), ["a", "b"]);
  assert.equal(added, 2);
});

test("a held list keeps its own order, whatever order the current list is in", () => {
  const { shown } = holdList([p("a"), p("b"), p("c")], [p("c"), p("b"), p("a")], key);
  assert.deepEqual(shown.map(key), ["a", "b", "c"]);
});

test("someone who left leaves a held list; someone new is not counted twice for it", () => {
  const { shown, added } = holdList([p("a"), p("b"), p("c")], [p("a"), p("c"), p("n")], key);
  assert.deepEqual(shown.map(key), ["a", "c"]);
  assert.equal(added, 1);
});

test("a held list shows each person as they are now, in the place they had", () => {
  const { shown } = holdList([p("a", "Ann"), p("b", "Bo")], [p("b", "Bob"), p("a", "Ann")], key);
  assert.deepEqual(shown.map((x) => x.name), ["Ann", "Bob"]);
});

test("nothing held, nothing current", () => {
  assert.deepEqual(holdList([], [], key), { shown: [], added: 0 });
});

test("someone you changed yourself shows at once in a held list; everyone else still waits", () => {
  const { shown, added } = holdList([p("a"), p("b")], [p("a"), p("mine"), p("b"), p("theirs")], key, new Set(["mine"]));
  assert.deepEqual(shown.map(key), ["a", "b", "mine"]);
  assert.equal(added, 1, "only someone else's arrival is behind the pill");
});
