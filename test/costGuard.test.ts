import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { MAX_CALLS, forgetKnownModes, participantMinutes, runCostGuard, runScheduledCostGuard, type CostGuardEnv } from "../src/lib/costGuard.server";
import { limitWarningText, readLimitFacts, webinarMinuteLimit, webinarsEnabled } from "../src/lib/webinarLimit";
import { FakeRealtimeKitApi } from "./fake-realtimekit";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const ENV: CostGuardEnv = {
  CLOUDFLARE_ACCOUNT_ID: "acct",
  REALTIMEKIT_APP_ID: "app",
  CLOUDFLARE_API_TOKEN: "token",
  REALTIMEKIT_GUEST_PRESET: "meetly-guest",
};

let api: FakeRealtimeKitApi;
beforeEach(() => {
  forgetKnownModes();
  api = new FakeRealtimeKitApi();
  api.now = () => NOW;
});

const run = (env: CostGuardEnv = ENV, at = NOW) => runCostGuard({ env, provider: "realtimekit", fetch: api.fetch, now: () => at });
const writes = () => api.calls.filter((call) => !call.startsWith("GET"));

test("the switch is on unless it says off, and the limit is 5,000 unless set to a positive whole number", () => {
  assert.equal(webinarsEnabled(undefined), true);
  assert.equal(webinarsEnabled(""), true);
  assert.equal(webinarsEnabled("1"), true);
  assert.equal(webinarsEnabled("ture"), true);
  for (const off of ["0", "false", "OFF", " no "]) assert.equal(webinarsEnabled(off), false, off);
  assert.equal(webinarMinuteLimit(undefined), 5000);
  assert.equal(webinarMinuteLimit("1200"), 1200);
  for (const bad of ["", "0", "-5", "12.5", "lots"]) assert.equal(webinarMinuteLimit(bad), 5000, bad);
});

test("on LiveKit, or without RealtimeKit's settings, it does nothing at all", async () => {
  const livekit = await runCostGuard({ env: ENV, provider: "livekit", fetch: api.fetch, now: () => NOW });
  assert.equal(livekit.skipped, "livekit");
  const bare = await run({ ...ENV, CLOUDFLARE_API_TOKEN: undefined });
  assert.equal(bare.skipped, "not-configured");
  assert.deepEqual(api.calls, []);
});

test("the Cron Trigger's entry runs on RealtimeKit with the Worker's own variables, and logs one line", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logged: string[] = [];
  globalThis.fetch = api.fetch as typeof fetch;
  console.log = (line: string) => logged.push(line);
  try {
    const report = await runScheduledCostGuard(ENV);
    assert.equal(report.skipped, undefined);
    assert.equal(report.calls, 1);
    assert.match(logged[0], /^cost guard: \{"calls":1/);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
});

test("under the limit nothing happens, and a session that cannot be near it costs no call of its own", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  // 100 people for 30 minutes: at most 3,000, under the 4,000 that would need a warning.
  api.live("w1", { minutesAgo: 30, people: 100 });
  const report = await run();
  assert.equal(report.calls, 1, api.calls.join("\n"));
  assert.match(api.calls[0], /^GET \/sessions\?status=LIVE&per_page=100&page_no=1$/);
  assert.deepEqual(writes(), []);
  assert.deepEqual(report.errors, []);
});

test("a session that could be near the limit but is not, by its participants' real times, is left alone", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  const session = api.live("w1", { minutesAgo: 60, people: 100 });
  // 100 at once at some point, but most stayed ten minutes: 10 × 99 + 60 = 1,050 minutes.
  for (const person of session.people.slice(1)) {
    person.peer_events!.push({ peer_id: person.peer_events![0].peer_id, event_name: "PEER_LEAVING", created_at: new Date(NOW - 50 * 60_000).toISOString() });
  }
  session.live_participants = 1;
  const report = await run();
  assert.equal(Math.round(report.counted[0].minutes), 1050);
  assert.deepEqual(writes(), []);
});

test("at 80% the host is warned once, with when it should end at the current rate", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  // 250 people for 17 minutes: 4,250 minutes, 750 to go at 250 a minute: 3 minutes.
  const session = api.live("w1", { minutesAgo: 17, people: 250 });
  const first = await run();
  assert.equal(first.warned.length, 1);
  assert.equal(first.warned[0].session, session.id);
  assert.equal(first.warned[0].endsAt, NOW + 3 * 60_000);
  assert.deepEqual(api.facts("w1"), ["meetly-mode:webinar", `meetly-limit-warning:${session.id}:${NOW + 180_000}`]);
  assert.equal(limitWarningText(first.warned[0].endsAt, NOW), "This webinar ends in about 3 minutes (free limit).");
  assert.deepEqual(first.ended, []);
  // A 250-person webinar: the live list, its record (3 pages), its people (2 pages), one write.
  assert.equal(first.calls, 7, api.calls.join("\n"));

  // A minute later: still under the limit, and not warned again.
  const second = await run(ENV, NOW + 60_000);
  assert.deepEqual(second.warned, []);
  assert.equal(api.facts("w1").filter((fact) => fact.startsWith("meetly-limit-warning:")).length, 1);
});

test("over the limit the record is marked first, then everyone is removed, exactly once", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  api.meeting("other", "zzz-zzzz-zzz", "webinar");
  const session = api.live("w1", { minutesAgo: 21, people: 250 });
  const report = await run();
  assert.equal(Math.round(report.counted[0].minutes), 5250);
  assert.deepEqual(report.ended, [{ session: session.id, meeting: "w1", reason: "limit" }]);
  assert.deepEqual(writes(), ["POST /meetings/w1/participants", "POST /meetings/w1/active-session/kick-all"]);
  assert.deepEqual(readLimitFacts(api.facts("w1")).limited, [session.id]);
  assert.equal(session.live_participants, 0);
  // Over the limit without ever having been warned (it went past 80% between two runs): no warning now.
  assert.deepEqual(report.warned, []);

  // The next minute RealtimeKit has ended it; nothing more is done.
  session.status = "ENDED";
  const after = await run(ENV, NOW + 60_000);
  assert.equal(after.calls, 1);
  assert.equal(api.calls.filter((call) => call.includes("kick-all")).length, 1);
  assert.equal(api.facts("w1").filter((fact) => fact.startsWith("meetly-limit:")).length, 1);
  // Another webinar's record is never written to.
  assert.deepEqual(api.facts("other"), ["meetly-mode:webinar"]);
});

test("a removal that failed is tried again the next minute, without marking the record twice", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  const session = api.live("w1", { minutesAgo: 30, people: 200 });
  api.failing = [{ match: /kick-all$/, status: 500 }];
  const first = await run();
  assert.deepEqual(first.ended, []);
  assert.equal(first.errors.length, 1);
  assert.equal(session.live_participants, 200);

  api.failing = [];
  const second = await run(ENV, NOW + 60_000);
  assert.deepEqual(second.ended, [{ session: session.id, meeting: "w1", reason: "limit" }]);
  assert.equal(api.facts("w1").filter((fact) => fact.startsWith("meetly-limit:")).length, 1);
  assert.equal(session.live_participants, 0);
});

test("if the record cannot be marked, nobody is removed: they would not be told why", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  const session = api.live("w1", { minutesAgo: 30, people: 200 });
  api.failing = [{ match: /^POST \/meetings\/w1\/participants$/, status: 429 }];
  const report = await run();
  assert.deepEqual(report.ended, []);
  assert.equal(api.calls.filter((call) => call.includes("kick-all")).length, 0);
  assert.equal(session.live_participants, 200);
});

test("a meeting that is not a webinar is never touched, however long and large, and is looked up only once", async () => {
  api.meeting("m1", "abc-defg-hij");
  api.record("m1", "meetly-access:locked");
  const session = api.live("m1", { minutesAgo: 120, people: 80 });
  const first = await run();
  assert.deepEqual(first.counted, []);
  assert.deepEqual(writes(), []);
  assert.deepEqual(api.facts("m1"), ["meetly-access:locked"]);
  assert.equal(session.live_participants, 80);
  // What it is does not change, so the next run does not ask again.
  api.calls = [];
  const second = await run(ENV, NOW + 60_000);
  assert.equal(second.calls, 1);
});

test("with webinars switched off, every live webinar is ended and meetings carry on", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  api.meeting("w2", "klm-nopq-rst", "webinar");
  api.meeting("m1", "uvw-xyza-bcd");
  // Small and new: far from any limit. The switch ends them anyway.
  const one = api.live("w1", { minutesAgo: 2, people: 3 });
  const two = api.live("w2", { minutesAgo: 1, people: 40 });
  const meeting = api.live("m1", { minutesAgo: 5, people: 6 });
  const report = await run({ ...ENV, MEETLY_WEBINARS_ENABLED: "0" });
  assert.deepEqual(
    report.ended.map((e) => [e.meeting, e.reason]).sort(),
    [
      ["w1", "paused"],
      ["w2", "paused"],
    ],
  );
  assert.equal(one.live_participants + two.live_participants, 0);
  assert.equal(meeting.live_participants, 6);
  // No limit fact: the link works again once webinars are back on.
  assert.deepEqual(readLimitFacts(api.facts("w1")).limited, []);
  assert.equal(api.calls.filter((call) => call.includes("/m1/active-session")).length, 0);
});

test("REST errors never throw; whatever failed is tried again the next minute", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  const session = api.live("w1", { minutesAgo: 30, people: 200 });

  api.failing = [{ match: /^GET \/sessions$/, status: 503 }];
  const down = await run();
  assert.equal(down.calls, 1);
  assert.equal(down.errors.length, 1);

  api.failing = [{ match: /^GET \/meetings\/w1\/participants$/, status: 500 }];
  const noRecord = await run();
  assert.deepEqual(noRecord.ended, []);
  assert.equal(noRecord.errors.length, 1);

  api.failing = [{ match: /^GET \/sessions\/[^/]+\/participants$/, status: 500 }];
  const noPeople = await run();
  assert.deepEqual(noPeople.ended, []);

  // Not even an answer: the network failing outright.
  const broken = await runCostGuard({ env: ENV, provider: "realtimekit", fetch: () => Promise.reject(new Error("socket hang up")), now: () => NOW });
  assert.match(broken.errors[0], /socket hang up/);

  api.failing = [];
  const fine = await run(ENV, NOW + 60_000);
  assert.deepEqual(fine.ended, [{ session: session.id, meeting: "w1", reason: "limit" }]);
});

test(`a run never makes more than ${MAX_CALLS} REST calls; what does not fit waits for the next minute`, async () => {
  for (let i = 0; i < 12; i++) {
    const id = api.meeting(`w${i}`, `w${i}`, "webinar");
    api.live(id, { minutesAgo: 30 + i, people: 150 });
  }
  const first = await run();
  assert.ok(first.calls <= MAX_CALLS, `${first.calls}`);
  assert.ok(first.deferred > 0);
  assert.ok(first.ended.length > 0);
  // The largest go first.
  assert.equal(first.ended[0].meeting, "w11");
  let ended = first.ended.length;
  for (let minute = 1; minute < 6 && ended < 12; minute++) {
    const next = await run(ENV, NOW + minute * 60_000);
    assert.ok(next.calls <= MAX_CALLS);
    ended += next.ended.length;
  }
  assert.equal(ended, 12);
});

test("RealtimeKit's own minutes_consumed counts when it is ahead of the participants' times", async () => {
  api.meeting("w1", "abc-defg-hij", "webinar");
  const session = api.live("w1", { minutesAgo: 10, people: 100 });
  session.max_concurrent_participants = 500;
  session.minutes_consumed = 5200;
  const report = await run();
  assert.equal(report.counted[0].minutes, 5200);
  assert.equal(report.ended.length, 1);
});

test("a participant's minutes are each connection's, from joining to leaving or now", () => {
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  // Joined, reloaded (a second connection), and is still here: 10 + 5 minutes.
  const reloaded = {
    peer_events: [
      { peer_id: "a", event_name: "PEER_CREATED", created_at: at(21) },
      { peer_id: "a", event_name: "PEER_JOINING", created_at: at(20) },
      { peer_id: "a", event_name: "PEER_LEAVING", created_at: at(10) },
      { peer_id: "b", event_name: "PEER_JOINING", created_at: at(5) },
      // Never got past the setup screen.
      { peer_id: "c", event_name: "PEER_CREATED", created_at: at(3) },
    ],
  };
  assert.equal(participantMinutes(reloaded, NOW), 15);
  // Without events: joined to left, or to now.
  assert.equal(participantMinutes({ joined_at: at(30), left_at: at(12) }, NOW), 18);
  assert.equal(participantMinutes({ joined_at: at(7) }, NOW), 7);
  // Never less than RealtimeKit's own duration.
  assert.equal(participantMinutes({ joined_at: at(7), left_at: at(6), duration: 4 }, NOW), 4);
  assert.equal(participantMinutes({}, NOW), 0);
});

test("the limit facts read back as written, and malformed ones are ignored", () => {
  const facts = readLimitFacts(["meetly-limit:s1", "meetly-limit-warning:s1:1700000000000", "meetly-limit-warning:bad", "meetly-limit:", "meetly-pin:x"]);
  assert.deepEqual(facts, { limited: ["s1"], warnings: [{ session: "s1", endsAt: 1700000000000 }] });
  assert.equal(limitWarningText(NOW + 50_000, NOW), "This webinar ends in about 1 minute (free limit).");
  assert.equal(limitWarningText(NOW - 50_000, NOW), "This webinar ends in about 1 minute (free limit).");
});
