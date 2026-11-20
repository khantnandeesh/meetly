import assert from "node:assert/strict";
import { test } from "node:test";
import { handQueue } from "../src/lib/handQueue";
import {
  CHAT_PREVIEW_EVERY_MS,
  DESKTOP_MODE,
  QUEUE_MS,
  createChatPreviewGate,
  crowdSentence,
  deviceError,
  laneSurface,
  order,
  overflow,
  place,
  queueUntil,
  statusBanner,
  waitingSentence,
  type NoticeEntry,
} from "../src/lib/notices";

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

/* ---------------------------------------------------------------- C16: never dropped */

test("notices: a change to your own state waits for room for as long as it takes; errors expire", () => {
  for (const tag of ["muted-by-host", "cam-by-host", "role-self", "blur-slow"]) {
    assert.equal(queueUntil({ tag }, 1000), Infinity, tag);
  }
  // A request to join waits too: it stays until answered.
  assert.equal(queueUntil({ tag: "knock", duration: Infinity }, 1000), Infinity);
  // Errors and confirmations go stale.
  assert.equal(queueUntil({ tag: "device-microphone" }, 1000), 1000 + QUEUE_MS);
  assert.equal(queueUntil({ tag: "mute-all" }, 1000), 1000 + QUEUE_MS);
  assert.equal(queueUntil({}, 1000), 1000 + QUEUE_MS);
});

test("notices: with two notifications up, 'the host muted you' queues instead of being dropped", () => {
  const full = [n(1, "you"), n(2, "you")];
  assert.deepEqual(place(full, { id: 3, priority: "you", tag: "muted-by-host" }, DESKTOP_MODE), { kind: "queue" });
});

/* ---------------------------------------------------------------- C9: one per device */

test("notices: a failing device is one tagged notification per device", () => {
  assert.equal(deviceError("microphone").tag, "device-microphone");
  assert.equal(deviceError("camera").tag, "device-camera");
  assert.equal(deviceError("microphone").title, "Couldn't start your microphone");
  assert.equal(deviceError("camera").tone, "danger");
});

/* ---------------------------------------------------------------- C8: chat previews */

/** Feeds `count` messages spread evenly over `ms`, returns how many were previewed. */
function previews(headcount: number, count: number, ms: number, enabled = true, start = 0): number {
  const gate = createChatPreviewGate();
  let shown = 0;
  for (let i = 0; i < count; i++) if (gate(start + (i * ms) / count, headcount, enabled)) shown++;
  return shown;
}

test("chat previews: 300 messages in 10 s with 51 people give at most one preview", () => {
  assert.ok(previews(51, 300, 10_000) <= 1);
  assert.equal(previews(51, 300, 10_000), 1);
});

test("chat previews: switched off, none at any size", () => {
  for (const size of [2, 24, 51, 199, 500]) assert.equal(previews(size, 50, 600_000, false), 0, `${size} people`);
});

test("chat previews: none from 200 people", () => {
  assert.equal(previews(200, 50, 600_000), 0);
  assert.equal(previews(1204, 50, 600_000), 0);
});

test("chat previews: up to 24 people, every message after a 4 s lull; from 25, at most one per 30 s", () => {
  // One message every 5 s for a minute: each follows a lull.
  assert.equal(previews(24, 12, 60_000), 12);
  // The same in a 25-person meeting: one every 30 s at most.
  assert.equal(previews(25, 12, 60_000), 2);
  const gate = createChatPreviewGate();
  assert.equal(gate(0, 51, true), true);
  assert.equal(gate(CHAT_PREVIEW_EVERY_MS - 1, 51, true), false);
  assert.equal(gate(2 * CHAT_PREVIEW_EVERY_MS, 51, true), true);
});

test("chat previews: the lull is measured from the last message, shown or not", () => {
  const gate = createChatPreviewGate();
  assert.equal(gate(0, 5, true), true);
  // A steady stream every 3 s never leaves a 4 s lull.
  for (let t = 3000; t <= 30_000; t += 3000) assert.equal(gate(t, 5, true), false);
  assert.equal(gate(35_000, 5, true), true);
});

/* ---------------------------------------------------------------- C3 + C4: the status lane */

test("status lane: one banner, Reconnecting › Turn on sound › Weak connection", () => {
  assert.equal(statusBanner({ reconnecting: true, soundBlocked: true, weak: true }), "reconnecting");
  assert.equal(statusBanner({ reconnecting: true, soundBlocked: false, weak: true }), "reconnecting");
  assert.equal(statusBanner({ reconnecting: false, soundBlocked: true, weak: true }), "sound");
  assert.equal(statusBanner({ reconnecting: false, soundBlocked: false, weak: true }), "weak");
  assert.equal(statusBanner({ reconnecting: false, soundBlocked: false, weak: false }), null);
});

test("status lane: on a phone the banner counts toward the two", () => {
  assert.deepEqual(laneSurface(false, false, "weak"), DESKTOP_MODE);
  assert.deepEqual(laneSurface(true, false, null), DESKTOP_MODE);
  assert.deepEqual(laneSurface(true, false, "weak"), { max: 1, info: true });
  // A sheet open: the one line, unless Reconnecting or Turn on sound has taken it.
  assert.deepEqual(laneSurface(true, true, null), { max: 1, info: false, compact: true });
  assert.deepEqual(laneSurface(true, true, "reconnecting"), { max: 0, info: false, compact: true });
  assert.deepEqual(laneSurface(true, true, "sound"), { max: 0, info: false, compact: true });
});

test("status lane: weak, then a knock, then a chat message on a phone: banner, knock, no chat", () => {
  const mode = laneSurface(true, false, "weak");
  let showing: NoticeEntry[] = [];
  const knock = place(showing, n(1, "action"), mode);
  assert.equal(knock.kind, "show");
  showing = [n(1, "action")];
  assert.equal(place(showing, n(2, "info"), mode).kind, "drop");
});
