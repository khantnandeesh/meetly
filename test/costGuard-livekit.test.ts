import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";

/**
 * The webinar switch on a LiveKit build: the token route refuses webinars when it is off, and
 * leaves meetings alone. LiveKit's room service is answered by a stub (its Twirp API speaks
 * JSON over fetch). Node runs each test file in its own process, so the provider is set here.
 */

Object.assign(process.env, { NEXT_PUBLIC_RTC_PROVIDER: "livekit", LIVEKIT_URL: "ws://livekit.test", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret" });

type Route = { POST: (request: Request) => Promise<Response> };
let token: Route;
const realFetch = globalThis.fetch;
/** Each room's record, as `createMeetingRecord` writes it. */
const rooms = new Map<string, string>();
const asked: string[] = [];

before(async () => {
  token = await import("../src/app/api/token/route");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MEETLY_WEBINARS_ENABLED;
});

function stubLiveKit() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split("/").pop()!;
    asked.push(method);
    const body = JSON.parse(String(init?.body ?? "{}")) as { names?: string[]; room?: string };
    if (method === "ListRooms") {
      const listed = (body.names ?? []).filter((name) => rooms.has(name)).map((name) => ({ name, metadata: rooms.get(name), numParticipants: 3 }));
      return Response.json({ rooms: listed });
    }
    if (method === "ListParticipants") return Response.json({ participants: [] });
    return Response.json({});
  }) as typeof fetch;
}

const join = (room: string, name: string) =>
  token.POST(new Request("http://localhost/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room, name }) }));

test("livekit: switched off, a webinar link refuses everyone with the paused sentence; meetings carry on", async () => {
  stubLiveKit();
  rooms.set("web-inar-abc", JSON.stringify({ kid: "kid-1", access: "open", mode: "webinar" }));
  rooms.set("mee-ting-abc", JSON.stringify({ kid: "kid-2", access: "open" }));

  assert.equal((await join("web-inar-abc", "Vic")).status, 200);

  process.env.MEETLY_WEBINARS_ENABLED = "false";
  const refused = await join("web-inar-abc", "Vic");
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "Webinars are paused right now.", reason: "paused" });
  // The audience was not even counted: the switch is the first rule.
  asked.length = 0;
  await join("web-inar-abc", "Vic");
  assert.deepEqual(asked, ["ListRooms"]);

  assert.equal((await join("mee-ting-abc", "Mo")).status, 200);
});
