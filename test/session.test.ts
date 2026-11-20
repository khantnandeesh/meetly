import assert from "node:assert/strict";
import { test } from "node:test";
import { signSession, verifySession, type Session } from "../src/lib/rtc/server/session";

const SECRET = "a-test-secret-not-used-anywhere";
const NOW = 1_800_000_000_000;
const session: Session = {
  meetingId: "meeting-1",
  participantId: "participant-1",
  identity: "m-1234",
  role: "host",
  exp: NOW / 1000 + 3600,
};

test("a session we signed verifies and comes back unchanged", () => {
  const token = signSession(session, SECRET);
  assert.equal(token.split(".").length, 3);
  assert.deepEqual(verifySession(token, SECRET, NOW), session);
});

test("a session signed with another secret is rejected", () => {
  assert.equal(verifySession(signSession(session, "someone-else"), SECRET, NOW), null);
});

test("a guest cannot edit their session into a host one", () => {
  const [header, , signature] = signSession({ ...session, role: "guest" }, SECRET).split(".");
  const forged = Buffer.from(JSON.stringify(session)).toString("base64url");
  assert.equal(verifySession(`${header}.${forged}.${signature}`, SECRET, NOW), null);
});

test("an unsigned (alg none) token is rejected", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  assert.equal(verifySession(`${header}.${payload}.`, SECRET, NOW), null);
});

test("an expired session is rejected", () => {
  const token = signSession(session, SECRET);
  assert.equal(verifySession(token, SECRET, session.exp * 1000 + 1), null);
});

test("anything that is not a token is rejected", () => {
  for (const value of [undefined, null, 42, "", "abc", "a.b", "a.b.c.d", {}]) {
    assert.equal(verifySession(value, SECRET, NOW), null);
  }
  assert.equal(verifySession(signSession(session, SECRET), "", NOW), null, "no secret configured means no host actions");
});
