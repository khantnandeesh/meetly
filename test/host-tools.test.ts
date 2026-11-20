import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { liveKitHostAction, parseRoomMeta, type Caller } from "../src/lib/host.server";
import {
  BULK_CONFIRM,
  FIRST_ROWS,
  MAX_DEPARTURES,
  matchesName,
  oldestFirst,
  ordinal,
  people,
  recordJoin,
  recordLeave,
  waitingFor,
  type Departure,
} from "../src/lib/hostLists";
import { MAX_BULK, isHostOnly, parseHostAction } from "../src/lib/rtc/hostAction";
import { readRecord, realtimeKitHostAction } from "../src/lib/rtc/server/realtimekit";
import { signSession } from "../src/lib/rtc/server/session";

/**
 * Host tools at scale on our server: Admit all and Deny all as one request, and the switch that
 * turns reactions off. LiveKit's and Cloudflare's APIs are stood in for at `fetch`, so what is
 * checked is what our server asks of them, not how they answer for real.
 */

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
});

/* ------------------------------------------------------------- the request */

test("Admit all and Deny all are read as a list of people; a missing, empty, odd or huge list is refused", () => {
  assert.deepEqual(parseHostAction({ action: "admitAll", identities: ["a", "b", "a"] }), { action: "admitAll", identities: ["a", "b"] });
  assert.deepEqual(parseHostAction({ action: "denyAll", identities: ["c"] }), { action: "denyAll", identities: ["c"] });
  assert.equal(parseHostAction({ action: "admitAll" }), null);
  assert.equal(parseHostAction({ action: "admitAll", identities: [] }), null);
  assert.equal(parseHostAction({ action: "admitAll", identities: ["a", 7] }), null);
  assert.equal(parseHostAction({ action: "admitAll", identities: [""] }), null);
  assert.equal(parseHostAction({ action: "denyAll", identities: "a" }), null);
  const many = Array.from({ length: MAX_BULK + 1 }, (_, i) => `w${i}`);
  assert.equal(parseHostAction({ action: "admitAll", identities: many }), null);
  assert.equal((parseHostAction({ action: "admitAll", identities: many.slice(1) }) as { identities: string[] }).identities.length, MAX_BULK);
});

test("the reactions switch is read only with a yes or no", () => {
  assert.deepEqual(parseHostAction({ action: "reactions", allowed: false }), { action: "reactions", allowed: false });
  assert.deepEqual(parseHostAction({ action: "reactions", allowed: true }), { action: "reactions", allowed: true });
  assert.equal(parseHostAction({ action: "reactions" }), null);
  assert.equal(parseHostAction({ action: "reactions", allowed: "no" }), null);
});

test("co-hosts may answer everyone waiting and switch reactions, as they may let one person in or change who can join", () => {
  assert.equal(isHostOnly({ action: "admitAll", identities: ["a"] }), false);
  assert.equal(isHostOnly({ action: "denyAll", identities: ["a"] }), false);
  assert.equal(isHostOnly({ action: "reactions", allowed: false }), false);
  assert.equal(isHostOnly({ action: "end" }), true);
});

/* ----------------------------------------------------------------- LiveKit */

type Twirp = { method: string; body: Record<string, unknown> };

/**
 * LiveKit's RoomService, answering from `lobby` (identity → name) and `metadata`. `fail` says how
 * a call about one identity goes wrong: "gone" is LiveKit's 404, "error" any other refusal.
 */
function fakeLiveKit(setup: { lobby?: Record<string, string>; metadata?: string; fail?: Record<string, "gone" | "error"> } = {}) {
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret-secret-secret-secret-secret";
  process.env.LIVEKIT_URL = "ws://livekit.test";
  const calls: Twirp[] = [];
  let metadata = setup.metadata ?? JSON.stringify({ host: "m-host", kid: "k", access: "ask" });
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    const who = typeof body.identity === "string" ? body.identity : (body.destinationIdentities?.[0] as string | undefined);
    const failure = who ? setup.fail?.[who] : undefined;
    if (failure === "gone") return json({ code: "not_found", msg: "participant not found" }, 404);
    if (failure === "error") return json({ code: "invalid_argument", msg: "refused" }, 400);
    switch (method) {
      case "ListParticipants":
        return json({ participants: Object.entries(setup.lobby ?? {}).map(([identity, name]) => ({ identity, name })) });
      case "ListRooms":
        return json({ rooms: [{ name: "abc-defg-hij", metadata, numParticipants: 3 }] });
      case "UpdateRoomMetadata":
        metadata = body.metadata;
        return json({ name: "abc-defg-hij", metadata });
      default:
        return json({});
    }
  }) as typeof fetch;
  return { calls, metadata: () => parseRoomMeta(metadata) };
}

const caller = (role: Caller["role"] = "cohost"): Caller => ({
  room: "abc-defg-hij",
  identity: "m-me",
  role,
  meta: { host: "m-host", cohosts: ["m-me"], access: "ask" },
});

test("livekit: Admit all lets 128 people in with one look at the lobby and one message each", async () => {
  const lobby = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`w${i}`, `Person ${i}`]));
  const { calls } = fakeLiveKit({ lobby });
  const result = await liveKitHostAction(caller(), { action: "admitAll", identities: Object.keys(lobby) });
  assert.deepEqual(result, { status: 200 });
  assert.equal(calls.filter((c) => c.method === "ListParticipants").length, 1);
  const sent = calls.filter((c) => c.method === "SendData");
  assert.equal(sent.length, 128);
  // Each person is sent only their own way in, on the lobby.
  assert.deepEqual(sent[0].body.destinationIdentities, ["w0"]);
  assert.equal(sent[0].body.room, "abc-defg-hij.lobby");
  assert.equal(sent[0].body.topic, "meetly-admit");
});

test("livekit: Admit all carries on past a failure and lists who is still waiting; someone who left is not a failure", async () => {
  const { calls } = fakeLiveKit({ lobby: { a: "Ann", b: "Bo", c: "Cy", d: "Di" }, fail: { b: "error", d: "error", c: "gone" } });
  const result = await liveKitHostAction(caller(), { action: "admitAll", identities: ["a", "b", "c", "d", "left-already"] });
  assert.deepEqual(result, { status: 200, failed: ["b", "d"] });
  // Nobody is asked about someone who is not in the lobby.
  assert.ok(!calls.some((c) => JSON.stringify(c.body).includes("left-already")));
});

test("livekit: Deny all removes everyone from the lobby in one request, and lists who it could not", async () => {
  const { calls } = fakeLiveKit({ lobby: { a: "Ann", b: "Bo", c: "Cy" }, fail: { b: "error" } });
  const result = await liveKitHostAction(caller(), { action: "denyAll", identities: ["a", "b", "c"] });
  assert.deepEqual(result, { status: 200, failed: ["b"] });
  assert.deepEqual(
    calls.filter((c) => c.method === "RemoveParticipant").map((c) => [c.body.room, c.body.identity]),
    [
      ["abc-defg-hij.lobby", "a"],
      ["abc-defg-hij.lobby", "b"],
      ["abc-defg-hij.lobby", "c"],
    ],
  );
});

test("livekit: a guest cannot answer the lobby or switch reactions", async () => {
  const { calls } = fakeLiveKit({ lobby: { a: "Ann" } });
  assert.equal((await liveKitHostAction(caller("guest"), { action: "admitAll", identities: ["a"] })).status, 403);
  assert.equal((await liveKitHostAction(caller("guest"), { action: "reactions", allowed: false })).status, 403);
  assert.equal(calls.length, 0);
});

test("livekit: turning reactions off is kept in the meeting's record, and turning them on removes it", async () => {
  const live = fakeLiveKit();
  assert.deepEqual(await liveKitHostAction(caller(), { action: "reactions", allowed: false }), { status: 200 });
  assert.equal(live.metadata().reactions, false);
  assert.equal(live.metadata().access, "ask", "the rest of the record is kept");
  // Asking for what is already so writes nothing.
  const writes = () => live.calls.filter((c) => c.method === "UpdateRoomMetadata").length;
  await liveKitHostAction(caller(), { action: "reactions", allowed: false });
  assert.equal(writes(), 1);
  await liveKitHostAction(caller(), { action: "reactions", allowed: true });
  assert.equal(live.metadata().reactions, undefined);
  assert.equal(writes(), 2);
});

test("livekit: the record keeps reactions off through any other change", () => {
  assert.equal(parseRoomMeta(JSON.stringify({ reactions: false })).reactions, false);
  assert.equal(parseRoomMeta(JSON.stringify({ reactions: true })).reactions, undefined);
  assert.equal(parseRoomMeta("{}").reactions, undefined);
});

/* ------------------------------------------------------------- RealtimeKit */

const SESSION_SECRET = "session-secret-session-secret";

type Record_ = { id: string; custom_participant_id: string; preset_name: string; created_at: string };

/** Cloudflare's RealtimeKit REST API, holding one meeting's participant records. */
function fakeCloudflare(records: Record_[]) {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  process.env.REALTIMEKIT_APP_ID = "app";
  process.env.REALTIMEKIT_HOST_PRESET = "meetly-host";
  process.env.REALTIMEKIT_GUEST_PRESET = "meetly-guest";
  process.env.CLOUDFLARE_API_TOKEN = "token";
  process.env.MEETLY_SESSION_SECRET = SESSION_SECRET;
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let next = 0;
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    const path = String(url).replace(/^.*\/realtime\/kit\/app/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
    if (method === "GET" && path.startsWith("/meetings/meeting-1/participants")) return ok(records);
    if (method === "POST" && path === "/meetings/meeting-1/participants") {
      const made = { id: `x${next++}`, custom_participant_id: body.custom_participant_id, preset_name: body.preset_name, created_at: new Date().toISOString() };
      records.push(made);
      return ok({ ...made, token: "thrown-away" });
    }
    if (method === "DELETE") {
      const id = path.split("/").pop();
      records.splice(records.findIndex((r) => r.id === id), 1);
      return ok({});
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }) as typeof fetch;
  return { calls, records };
}

const at = "2026-11-20T10:00:00Z";
const meetingRecords = (): Record_[] => [
  { id: "p-host", custom_participant_id: "m-host", preset_name: "meetly-host", created_at: at },
  { id: "p-co", custom_participant_id: "m-co", preset_name: "meetly-guest", created_at: at },
  { id: "p-guest", custom_participant_id: "m-guest", preset_name: "meetly-guest", created_at: at },
  { id: "x-co", custom_participant_id: "meetly-cohost:p-co", preset_name: "meetly-guest", created_at: at },
];
const sessionOf = (participantId: string, identity: string) =>
  signSession(
    { meetingId: "meeting-1", participantId, identity, role: "guest", exp: Math.floor(Date.now() / 1000) + 3600 },
    SESSION_SECRET,
  );

test("rtk: Admit all and Deny all are authorised with one look at the records, for the host and co-hosts only", async () => {
  const { calls } = fakeCloudflare(meetingRecords());
  const ids = Array.from({ length: 128 }, (_, i) => `peer-${i}`);
  assert.deepEqual(await realtimeKitHostAction(sessionOf("p-co", "m-co"), { action: "admitAll", identities: ids }), { status: 200 });
  assert.deepEqual(await realtimeKitHostAction(sessionOf("p-host", "m-host"), { action: "denyAll", identities: ids }), { status: 200 });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "GET"],
    "nothing but reading the records: the caller's client then answers the waiting room",
  );
  assert.equal((await realtimeKitHostAction(sessionOf("p-guest", "m-guest"), { action: "admitAll", identities: ids })).status, 403);
});

test("rtk: turning reactions off writes one statement to the record; turning them on removes it; roles say which", async () => {
  const { calls, records } = fakeCloudflare(meetingRecords());
  const co = sessionOf("p-co", "m-co");
  assert.deepEqual(await realtimeKitHostAction(co, { action: "reactions", allowed: false }), { status: 200 });
  assert.ok(records.some((r) => r.custom_participant_id === "meetly-reactions:off"));
  assert.equal(readRecord(records as never, "meetly-host", false).reactions, false);
  const roles = await realtimeKitHostAction(sessionOf("p-guest", "m-guest"), { action: "roles" });
  assert.equal(roles.status === 200 && roles.data?.reactions, false);
  // Again: already so, nothing written.
  const posts = () => calls.filter((c) => c.method === "POST").length;
  await realtimeKitHostAction(co, { action: "reactions", allowed: false });
  assert.equal(posts(), 1);
  assert.deepEqual(await realtimeKitHostAction(co, { action: "reactions", allowed: true }), { status: 200 });
  assert.ok(!records.some((r) => r.custom_participant_id === "meetly-reactions:off"));
  assert.equal(readRecord(records as never, "meetly-host", false).reactions, true);
  assert.equal((await realtimeKitHostAction(sessionOf("p-guest", "m-guest"), { action: "reactions", allowed: false })).status, 403);
});

beforeEach(() => {
  // Each test sets up its own stand-in; nothing reaches a real server.
  globalThis.fetch = (async () => {
    throw new Error("no network in unit tests");
  }) as typeof fetch;
});

/* ---------------------------------------------------- the panel's sections */

test("raised hands are numbered 1st, 2nd, 3rd … 11th, 12th, 13th … 21st, 101st", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(ordinal), ["1st", "2nd", "3rd", "4th", "5th"]);
  assert.deepEqual([11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal), ["11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th"]);
});

test("waiting time is whole minutes, and under a minute is just now", () => {
  const now = 10 * 60_000;
  assert.equal(waitingFor(now - 59_000, now), "Just now");
  assert.equal(waitingFor(now - 60_000, now), "Waiting 1 min");
  assert.equal(waitingFor(now - 4 * 60_000 - 30_000, now), "Waiting 4 min");
  assert.equal(waitingFor(now + 5_000, now), "Just now", "a clock ahead of ours is not negative");
});

test("the waiting list is oldest first, and ties keep their order", () => {
  const list = [
    { id: "c", name: "Cy", since: 300 },
    { id: "a", name: "Ann", since: 100 },
    { id: "b", name: "Bo", since: 300 },
  ];
  assert.deepEqual(oldestFirst(list).map((w) => w.id), ["a", "c", "b"]);
});

test("who left: newest first, once each, and someone who comes back is taken off", () => {
  let list: readonly Departure[] = [];
  for (let i = 0; i < 40; i++) list = recordLeave(list, { identity: `p${i}`, name: `Person ${i}`, at: i });
  assert.equal(list.length, 40);
  assert.equal(list[0].identity, "p39");
  list = recordLeave(list, { identity: "p0", name: "Person 0", at: 99 });
  assert.equal(list.length, 40);
  assert.equal(list[0].identity, "p0");
  // Back with the same identity, or (LiveKit mints a new one per join) under the same name.
  list = recordJoin(list, { identity: "p5", name: "Person 5" });
  list = recordJoin(list, { identity: "fresh", name: "Person 6" });
  assert.equal(list.length, 38);
  assert.ok(!list.some((d) => d.identity === "p5" || d.identity === "p6"));
  assert.equal(recordJoin(list, { identity: "new", name: "Somebody new" }), list, "nothing changes, nothing is copied");
  assert.equal(recordJoin([], { identity: "x", name: "" }).length, 0);
});

test("the remembered departures are capped, keeping the newest", () => {
  let list: readonly Departure[] = [];
  for (let i = 0; i < MAX_DEPARTURES + 10; i++) list = recordLeave(list, { identity: `p${i}`, name: "", at: i });
  assert.equal(list.length, MAX_DEPARTURES);
  assert.equal(list[0].identity, `p${MAX_DEPARTURES + 9}`);
});

test("bulk answers ask first only above 25, and say people the way the notification does", () => {
  assert.equal(BULK_CONFIRM, 25);
  assert.equal(FIRST_ROWS, 5);
  assert.equal(people(1), "1 person");
  assert.equal(people(3), "3 people");
  assert.equal(people(1204), "1,204 people");
  assert.ok(matchesName("Raj Subramanian", "subra"));
  assert.ok(matchesName("", "gue"), "no name is Guest");
});
