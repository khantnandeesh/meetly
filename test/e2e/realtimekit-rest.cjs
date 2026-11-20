// Checks the server routes of a RealtimeKit build against Cloudflare's real REST API, without
// anyone joining a call (joining is what is billed, and needs a browser on both ends).
//
//   MEETLY_URL=http://localhost:3000 node test/e2e/realtimekit-rest.cjs
//
// It creates two meetings and a handful of participant records in the app the server is
// configured for, and prints their ids at the end so they can be removed. What it can show: who
// is made host, that the host key survives a "reload", every refusal, and the record-keeping
// (co-hosts, lock, removal). What it cannot: anything that needs a live session. Muting, removing
// and ending answer 404 "nobody is in the call" here, which shows the request was authorised and
// reached Cloudflare, not that it works.
const BASE = process.env.MEETLY_URL || "http://localhost:3000";

const results = [];
function ok(name, pass, detail) {
  results.push(!!pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** One browser, as far as the server can tell: it keeps the cookies it is given. */
function browser() {
  const cookies = new Map();
  return {
    cookies,
    async post(path, body) {
      const response = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cookies.size ? { cookie: Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ") } : {}),
        },
        body: JSON.stringify(body),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        cookies.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
      }
      return { status: response.status, body: await response.json().catch(() => null), setCookie: response.headers.getSetCookie() };
    },
  };
}

const randomCode = () => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const run = (n) => Array.from({ length: n }, () => letters[Math.floor(Math.random() * 26)]).join("");
  return `${run(3)}-${run(4)}-${run(3)}`;
};

(async () => {
  const meetings = new Set();
  const join = async (who, code, name) => {
    const answer = await who.post("/api/token", { room: code, name });
    if (answer.body && answer.body.meetingId) meetings.add(answer.body.meetingId);
    return answer;
  };
  const host = (who, session, body) => who.post("/api/host", { session, ...body });

  /* ---- "New meeting": the creating browser is host, whoever joins first ---- */
  const ada = browser();
  const created = await ada.post("/api/meeting", { action: "create" });
  const code = created.body && created.body.code;
  ok("New meeting answers with a code and a host cookie", created.status === 200 && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code) && created.setCookie.length === 1, `status ${created.status}`);
  ok("the cookie is HttpOnly and SameSite", /HttpOnly/.test(created.setCookie[0] || "") && /SameSite=Lax/.test(created.setCookie[0] || ""));
  const peekHost = await ada.post("/api/meeting", { action: "peek", code });
  const stranger = browser();
  const peekStranger = await stranger.post("/api/meeting", { action: "peek", code });
  ok("before anyone joins, only the creating browser is told it is the host", peekHost.body.host === true && peekStranger.body.host === false && peekStranger.body.access === "open", JSON.stringify([peekHost.body, peekStranger.body]));

  const ben = browser();
  const benJoin = await join(ben, code, "Ben Guest");
  ok("a guest who asks for a token before the creator is a guest", benJoin.status === 200 && benJoin.body.role === "guest", `role ${benJoin.body && benJoin.body.role}`);
  ok("the join answer carries no API secret, and a token for the SDK", typeof benJoin.body.authToken === "string" && typeof benJoin.body.session === "string" && !JSON.stringify(benJoin.body).includes("proxy-injected"));
  const adaJoin = await join(ada, code, "Ada Host");
  ok("the creator is host", adaJoin.status === 200 && adaJoin.body.role === "host");
  const adaAgain = await join(ada, code, "Ada Host (reloaded)");
  ok(
    "the creator reloading is host again, as the same participant with a fresh token",
    adaAgain.body.role === "host" && adaAgain.body.participantId === adaJoin.body.participantId && adaAgain.body.authToken !== adaJoin.body.authToken,
  );
  const benAgain = await join(ben, code, "Ben Guest");
  ok("a guest reloading is still a guest, as a new participant", benAgain.body.role === "guest" && benAgain.body.participantId !== benJoin.body.participantId);

  // Forged and borrowed cookies.
  const eve = browser();
  eve.cookies.set(`meetly.${code}`, "eyJjIjoiZm9yZ2VkIn0.Zm9yZ2Vk");
  ok("a made-up cookie does not make a host", (await join(eve, code, "Eve")).body.role === "guest");
  const mallory = browser();
  const otherCode = randomCode();
  const malloryOwn = await join(mallory, otherCode, "Mallory");
  // Mallory is genuinely host of her own meeting; that cookie must be worth nothing in this one.
  mallory.cookies.set(`meetly.${code}`, mallory.cookies.get(`meetly.${otherCode}`));
  ok("a real host cookie from another meeting does not carry over", malloryOwn.body.role === "host" && (await join(mallory, code, "Mallory")).body.role === "guest");

  /* ---- /api/host: who may do what ---- */
  const guestSession = benAgain.body.session;
  const hostSession = adaAgain.body.session;
  const benIdentity = JSON.parse(Buffer.from(guestSession.split(".")[1], "base64url").toString()).identity;
  const adaIdentity = JSON.parse(Buffer.from(hostSession.split(".")[1], "base64url").toString()).identity;
  const actions = [
    { action: "mute", participantId: adaIdentity },
    { action: "remove", participantId: adaIdentity },
    { action: "stopCamera", participantId: adaIdentity },
    { action: "lowerHand", participantId: adaIdentity },
    { action: "admit", participantId: "someone" },
    { action: "deny", participantId: "someone" },
    { action: "muteAll" },
    { action: "lowerAllHands" },
    { action: "end" },
    { action: "access", access: "locked" },
    { action: "coHost", participantId: benIdentity, on: true },
  ];
  const asGuest = {};
  for (const body of actions) asGuest[body.action] = (await host(ben, guestSession, body)).status;
  ok("a guest's session gets 403 from every host action", Object.values(asGuest).every((status) => status === 403), JSON.stringify(asGuest));
  ok("no session is a bad request", (await ben.post("/api/host", { action: "end" })).status === 400);
  const edited = guestSession.split(".");
  edited[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(edited[1], "base64url").toString()), role: "host" })).toString("base64url");
  ok("a session edited to say 'host' is refused", (await host(ben, edited.join("."), { action: "muteAll" })).status === 403);
  ok("the host's stale first session still works: the role is read from the records", [200, 404].includes((await host(ada, adaJoin.body.session, { action: "muteAll" })).status));
  const roles = await host(ben, guestSession, { action: "roles" });
  ok("any participant may ask who the co-hosts are", roles.status === 200 && Array.isArray(roles.body.coHosts) && roles.body.coHosts.length === 0 && roles.body.access === "open", JSON.stringify(roles.body));
  ok("someone who never joined may not", (await host(ben, "not.a.session", { action: "roles" })).status === 403);

  // What only needs authorising answers 200 for the host; what needs a live session answers 404.
  const asHost = {};
  for (const body of [
    { action: "stopCamera", participantId: benIdentity },
    { action: "lowerHand", participantId: benIdentity },
    { action: "lowerAllHands" },
    { action: "admit", participantId: "someone" },
    { action: "mute", participantId: benIdentity },
    { action: "muteAll" },
    { action: "end" },
  ]) {
    asHost[body.action] = (await host(ada, hostSession, body)).status;
  }
  ok(
    "the host is authorised: 200 where our server only decides, 404 'nobody is in the call' where Cloudflare has to act",
    JSON.stringify(asHost) === JSON.stringify({ stopCamera: 200, lowerHand: 200, lowerAllHands: 200, admit: 200, mute: 404, muteAll: 404, end: 404 }),
    JSON.stringify(asHost),
  );
  ok("the host is told to use their own controls on themselves", (await host(ada, hostSession, { action: "mute", participantId: adaIdentity })).status === 400);

  /* ---- co-host ---- */
  ok("the host can make a co-host", (await host(ada, hostSession, { action: "coHost", participantId: benIdentity, on: true })).status === 200);
  const rolesAfter = await host(ben, guestSession, { action: "roles" });
  ok("the record says so to everyone who asks", rolesAfter.body.coHosts.length === 1 && rolesAfter.body.coHosts[0] === benIdentity, JSON.stringify(rolesAfter.body));
  const asCoHost = {
    muteAll: (await host(ben, guestSession, { action: "muteAll" })).status,
    access: (await host(ben, guestSession, { action: "access", access: "open" })).status,
    end: (await host(ben, guestSession, { action: "end" })).status,
    coHost: (await host(ben, guestSession, { action: "coHost", participantId: benIdentity, on: true })).status,
    muteHost: (await host(ben, guestSession, { action: "mute", participantId: adaIdentity })).status,
    removeHost: (await host(ben, guestSession, { action: "remove", participantId: adaIdentity })).status,
  };
  ok(
    "a co-host may moderate (authorised) but not end the call, choose co-hosts or act on the host",
    JSON.stringify(asCoHost) === JSON.stringify({ muteAll: 404, access: 200, end: 403, coHost: 403, muteHost: 403, removeHost: 403 }),
    JSON.stringify(asCoHost),
  );
  ok("a late joiner is told who the co-hosts are", (await join(browser(), code, "Late")).body.coHosts.includes(benIdentity));
  await host(ada, hostSession, { action: "coHost", participantId: benIdentity, on: false });
  ok("a demoted co-host is a guest again", (await host(ben, guestSession, { action: "muteAll" })).status === 403 && (await host(ben, guestSession, { action: "roles" })).body.coHosts.length === 0);

  /* ---- lock ---- */
  ok("ask-to-join is refused where the app has no preset for it", (await host(ada, hostSession, { action: "access", access: "ask" })).status === (process.env.EXPECT_ASK ? 200 : 400));
  if (process.env.EXPECT_ASK) await host(ada, hostSession, { action: "access", access: "open" });
  ok("the host can lock the meeting", (await host(ada, hostSession, { action: "access", access: "locked" })).status === 200);
  const fay = browser();
  const refused = await join(fay, code, "Fay Late");
  ok("locked: a new joiner is refused", refused.status === 403 && refused.body.reason === "locked", JSON.stringify(refused.body));
  ok("locked: the pre-join screen can know", (await fay.post("/api/meeting", { action: "peek", code })).body.access === "locked");
  ok("locked: the host still gets in", (await join(ada, code, "Ada Host")).body.role === "host");
  ok("locked: clients that ask are told", (await host(ben, guestSession, { action: "roles" })).body.access === "locked");
  const unlocked = await host(ada, hostSession, { action: "access", access: "open" });
  const fayIn = await join(fay, code, "Fay Late");
  ok("unlocked: the same browser now joins", unlocked.status === 200 && fayIn.status === 200 && fayIn.body.role === "guest" && fayIn.body.access === "open", `unlock ${unlocked.status}, join ${fayIn.status} ${JSON.stringify({ role: fayIn.body.role, access: fayIn.body.access, error: fayIn.body.error })}`);

  /* ---- removal ---- */
  const removal = await host(ada, hostSession, { action: "remove", participantId: benIdentity });
  ok("removing someone who is not connected answers 'may have left' (nobody to disconnect)…", removal.status === 404);
  const benBack = await join(ben, code, "Ben Guest");
  ok("…but their browser is refused from then on", benBack.status === 403 && benBack.body.reason === "removed", JSON.stringify(benBack.body));
  ok("…and their session is no longer anyone", (await host(ben, guestSession, { action: "roles" })).status === 403);
  ok("someone else's browser is not affected", (await join(fay, code, "Fay Late")).status === 200);

  /* ---- a code typed by hand ---- */
  const cy = browser();
  const typed = randomCode();
  const first = await join(cy, typed, "Cy First");
  const second = await join(browser(), typed, "Dee Second");
  const firstAgain = await join(cy, typed, "Cy First");
  ok("a hand-typed code: first in is host, second is a guest", first.body.role === "host" && second.body.role === "guest");
  ok("a hand-typed code: the host survives a reload as the same participant", firstAgain.body.role === "host" && firstAgain.body.participantId === first.body.participantId);

  const failed = results.filter((pass) => !pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  console.log(`RealtimeKit meetings created (remove them when done): ${Array.from(meetings).join(" ")}`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
