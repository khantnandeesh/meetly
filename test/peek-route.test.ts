import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

/**
 * POST /api/meeting { action: "peek" } on a LiveKit build: what the pre-join screen may know,
 * including how many people are in the meeting. LiveKit's API is stood in for at `fetch`.
 * The RealtimeKit build is in ./peek-route-realtimekit.test.ts: the provider is fixed when the
 * app loads, and each test file runs in a process of its own.
 */

delete process.env.NEXT_PUBLIC_RTC_PROVIDER;
const { POST } = await import("../src/app/api/meeting/route");

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
});

const CODE = "abc-defg-hij";
const peek = async (code: string = CODE) => {
  const response = await POST(new Request("http://meetly.test/api/meeting", { method: "POST", body: JSON.stringify({ action: "peek", code }) }));
  return { status: response.status, body: await response.json() };
};

/** LiveKit's ListRooms, answering with `rooms`, or failing with `status`. Counts the calls. */
function liveKit(answer: { rooms?: unknown[]; status?: number }) {
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret-secret-secret-secret-secret";
  process.env.LIVEKIT_URL = "ws://livekit.test";
  const asked: string[] = [];
  globalThis.fetch = (async (url: URL | string) => {
    asked.push(String(url).split("/").pop()!);
    const status = answer.status ?? 200;
    const body = status === 200 ? { rooms: answer.rooms ?? [] } : { code: "invalid_argument", msg: "no" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return asked;
}

test("peek: the count is LiveKit's own, from the one call that also reads the record", async () => {
  const asked = liveKit({ rooms: [{ name: CODE, metadata: JSON.stringify({ kid: "k", access: "ask" }), numParticipants: 9 }] });
  assert.deepEqual(await peek(), { status: 200, body: { access: "ask", host: false, count: 9 } });
  assert.deepEqual(asked, ["ListRooms"]);
});

test("peek: a meeting nobody has started has nobody in it", async () => {
  liveKit({ rooms: [] });
  assert.deepEqual((await peek()).body, { access: "open", host: false, count: 0 });
});

test("peek: when LiveKit cannot be asked, the count is unknown, never a guess", async () => {
  liveKit({ status: 400 });
  assert.deepEqual((await peek()).body, { access: "open", host: false, count: null });
  delete process.env.LIVEKIT_URL;
  assert.deepEqual((await peek()).body, { access: "open", host: false, count: null });
});

test("peek: a code that isn't one is refused without asking LiveKit", async () => {
  const asked = liveKit({ rooms: [] });
  assert.equal((await peek("not a code")).status, 400);
  assert.deepEqual(asked, []);
});
