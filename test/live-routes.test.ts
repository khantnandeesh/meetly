import assert from "node:assert/strict";
import { test } from "node:test";
import { POST as create } from "../src/app/api/live/route";
import { POST as end } from "../src/app/api/live/[id]/end/route";
import { POST as ticket } from "../src/app/api/live/[id]/ticket/route";
import { BODY_MAX, BodyTooLarge, isViewerPass, readJsonBody, viewerPass } from "../src/lib/live/server";

/**
 * Live (beta)'s routes: a viewer's ticket needs the pass from the full link, not just the id, and
 * no route reads a body larger than BODY_MAX.
 */

process.env.OVERLAY_ADMISSION_SECRET = "test-admission-secret-0123456789";
process.env.OVERLAY_SERVER_SECRET = "test-server-secret-0123456789ab";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://meet.example/api/live", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

test("going live hands out the viewers' pass with the host key", async () => {
  const response = await create(post({ title: "Launch" }));
  assert.equal(response.status, 200);
  const created = (await response.json()) as { id: string; hostKey: string; viewerPass: string; title: { title: string } };
  assert.match(created.viewerPass, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(created.viewerPass, await viewerPass(created.id));
  assert.notEqual(created.viewerPass, created.hostKey.slice(0, 22));
  assert.equal(created.title.title, "Launch");
  // Another webinar's pass is not this one's.
  assert.equal(await isViewerPass(created.id, await viewerPass("abc-defg-hij")), false);
  // A body that is not JSON is no title, as before.
  assert.equal((await create(post("not json"))).status, 200);
});

test("a viewer's ticket needs the link's pass: the id alone is refused", async () => {
  const id = "abc-defg-hij";
  const pass = await viewerPass(id);
  for (const body of [{ role: "viewer" }, { role: "viewer", pass: "" }, { role: "viewer", pass: await viewerPass("xyz-defg-hij") }, { role: "viewer", pass: pass.slice(0, -1) }, { role: "viewer", pass: [pass] }]) {
    const response = await ticket(post(body), params(id));
    assert.equal(response.status, 403, JSON.stringify(body));
  }
  const ok = await ticket(post({ role: "viewer", pass }), params(id));
  assert.equal(ok.status, 200);
  const answer = (await ok.json()) as { ticket: string; identity: string };
  assert.match(answer.identity, /^v-[A-Za-z0-9]{16}$/);
  assert.ok(answer.ticket.length > 20);
  // A source ticket still needs the host key, and a bad role or id is refused.
  assert.equal((await ticket(post({ role: "source", hostKey: pass }), params(id))).status, 403);
  assert.equal((await ticket(post({ role: "other", pass }), params(id))).status, 400);
  assert.equal((await ticket(post({ role: "viewer", pass }), params("nope"))).status, 404);
  assert.equal((await ticket(post("[1]"), params(id))).status, 400);
});

test("no Live route reads a body larger than BODY_MAX", async () => {
  const id = "abc-defg-hij";
  const big = JSON.stringify({ role: "viewer", pass: await viewerPass(id), filler: "x".repeat(BODY_MAX) });
  assert.equal((await ticket(post(big), params(id))).status, 413);
  assert.equal((await end(post(big), params(id))).status, 413);
  assert.equal((await create(post({ title: "x".repeat(BODY_MAX) }))).status, 413);
  // Refused on what Content-Length says, before reading.
  assert.equal((await ticket(post("{}", { "content-length": String(BODY_MAX + 1) }), params(id))).status, 413);
  // And as it streams in, when no length is given.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(1024).fill(32));
      controller.close();
    },
  });
  const chunked = new Request("https://meet.example/api/live", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readJsonBody(chunked), BodyTooLarge);
  assert.deepEqual(await readJsonBody(post({ a: 1 })), { a: 1 });
});
