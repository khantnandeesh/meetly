import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL_ATTRIBUTE, NOINDEX, environmentLabel, labelResponse, robotsResponse, type HtmlRewriter } from "../src/lib/environmentLabel";

/** The staging mark (MEETLY_ENVIRONMENT_LABEL): production has none, staging is noindex and labelled. */

test("no label in production: unset, empty or not text", () => {
  for (const value of [undefined, null, "", "   ", 1, {}, "<>"]) assert.equal(environmentLabel(value), null);
});

test("the label is plain text, at most 24 characters", () => {
  assert.equal(environmentLabel(" Staging "), "Staging");
  assert.equal(environmentLabel('Sta"ging<script>'), "Stagingscript");
  assert.equal(environmentLabel("x".repeat(40)), "x".repeat(24));
});

test("robots.txt disallows everything", async () => {
  const robots = robotsResponse();
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
});

/** Stands in for the Workers runtime's HTMLRewriter: records what it was asked to set on <html>. */
function fakeRewriter(seen: string[]): () => HtmlRewriter {
  return () => {
    const rewriter: HtmlRewriter = {
      on(selector, handlers) {
        handlers.element({ setAttribute: (name, value) => seen.push(`${selector} ${name}=${value}`) });
        return rewriter;
      },
      transform: (response) => response,
    };
    return rewriter;
  };
}

test("a page is noindex and its <html> is labelled, with its status and headers kept", async () => {
  const seen: string[] = [];
  const page = new Response("<html></html>", { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-kept": "yes" } });
  const marked = labelResponse(page, "Staging", fakeRewriter(seen));
  assert.equal(marked.status, 404);
  assert.equal(marked.headers.get("x-robots-tag"), NOINDEX);
  assert.equal(marked.headers.get("x-kept"), "yes");
  assert.deepEqual(seen, [`html ${LABEL_ATTRIBUTE}=Staging`]);
  assert.equal(await marked.text(), "<html></html>");
});

test("anything that is not a page is noindex and otherwise untouched", async () => {
  const seen: string[] = [];
  const marked = labelResponse(Response.json({ enabled: false }), "Staging", fakeRewriter(seen));
  assert.equal(marked.headers.get("x-robots-tag"), NOINDEX);
  assert.deepEqual(seen, []);
  assert.deepEqual(await marked.json(), { enabled: false });
});

test("a WebSocket upgrade is returned as it came", () => {
  // Node's Response cannot be made with status 101; the Workers runtime's can.
  const upgrade = { status: 101 } as Response;
  assert.equal(labelResponse(upgrade, "Staging", fakeRewriter([])), upgrade);
});
