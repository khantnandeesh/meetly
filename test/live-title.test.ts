import assert from "node:assert/strict";
import { test } from "node:test";
import { signTitle, verifiedTitle } from "../src/lib/live/title.server";
import { cleanTitle, durationWords, viewerLink } from "../src/lib/live/webinar";

/** A serverless webinar's title: it travels in the link, signed, so an edited link shows none. */

const SECRET = "test-admission-secret-0123456789";

test("a signed title survives the link and an edited one does not", async () => {
  process.env.OVERLAY_ADMISSION_SECRET = SECRET;
  const signed = await signTitle("abc-defg-hij", "  Quarterly   product update ");
  assert.ok(signed);
  assert.equal(signed.title, "Quarterly product update");
  const link = new URL(viewerLink("https://meet.example", "abc-defg-hij", signed));
  assert.equal(link.pathname, "/live/abc-defg-hij");
  const [title, ts] = [link.searchParams.get("title"), link.searchParams.get("ts")];
  assert.equal(await verifiedTitle("abc-defg-hij", title, ts), "Quarterly product update");
  // Another title, another webinar, or no signature: nothing is shown.
  assert.equal(await verifiedTitle("abc-defg-hij", "Urgent: reset your password", ts), "");
  assert.equal(await verifiedTitle("xyz-defg-hij", title, ts), "");
  assert.equal(await verifiedTitle("abc-defg-hij", title, undefined), "");
  assert.equal(await verifiedTitle("abc-defg-hij", title, ["x"]), "");
});

test("no title, or no secret, means no title in the link", async () => {
  process.env.OVERLAY_ADMISSION_SECRET = SECRET;
  assert.equal(await signTitle("abc-defg-hij", "   "), null);
  assert.equal(viewerLink("https://meet.example", "abc-defg-hij", null), "https://meet.example/live/abc-defg-hij");
  delete process.env.OVERLAY_ADMISSION_SECRET;
  assert.equal(await signTitle("abc-defg-hij", "A title"), null);
  assert.equal(await verifiedTitle("abc-defg-hij", "A title", "anything"), "");
});

test("titles are one line of at most 80 characters, and lengths read as lengths", () => {
  assert.equal(cleanTitle("a\n\tb"), "a b");
  assert.equal(cleanTitle("x".repeat(200)).length, 80);
  assert.equal(cleanTitle(42), "");
  // Characters, not UTF-16 units: an emoji at the limit is kept whole or left out, never halved,
  // and a link can always be made of the result (encodeURIComponent throws on half an emoji).
  const emoji = cleanTitle(`${"x".repeat(79)}😀😀`);
  assert.equal(emoji, `${"x".repeat(79)}😀`);
  for (const raw of [`${"y".repeat(79)}😀`, "\uD83D", "a\uDE00b", `${"z".repeat(319)}😀tail`]) {
    assert.doesNotThrow(() => viewerLink("https://meet.example", "abc-defg-hij", { title: cleanTitle(raw), sig: "c2ln" }), raw);
  }
  assert.equal(cleanTitle("a\uDE00b"), "ab");
  // No invisible characters to make a title read as something else; emoji sequences stay joined.
  assert.equal(cleanTitle("Pay‮gnp.exe"), "Paygnp.exe");
  assert.equal(cleanTitle("Zero​width⁦ and⁩ bidi﻿"), "Zerowidth and bidi");
  assert.equal(cleanTitle("Family 👨‍👩‍👧 day"), "Family 👨‍👩‍👧 day");
  // A huge input is cut before any of it is looked at.
  assert.equal(cleanTitle(" ".repeat(1_000_000) + "late"), "");
  assert.equal(cleanTitle("ok" + " ".repeat(1_000_000)), "ok");
  assert.equal(durationWords(1), "1 second");
  assert.equal(durationWords(35), "35 seconds");
  assert.equal(durationWords(12 * 60 + 3), "12 min");
  assert.equal(durationWords(3600), "1 h");
  assert.equal(durationWords(3900), "1 h 5 min");
});
