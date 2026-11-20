// Checks ending a poll on a RealtimeKit build against Cloudflare's real REST API, without anyone
// joining a call (joining is what is billed). RealtimeKit's polls themselves live in a session
// and cannot be reached this way; what can be is the part our server adds: who may end a poll,
// and that the fact is recorded and handed to everyone who asks or joins.
//
//   MEETLY_URL=http://localhost:3000 CLOUDFLARE_ACCOUNT_ID=… REALTIMEKIT_APP_ID=… \
//   CLOUDFLARE_API_TOKEN=… node test/e2e/realtimekit-polls-rest.cjs
//
// It creates one meeting and a few participant records in that app, and removes them again at
// the end (records deleted, meeting set INACTIVE). Anything it could not remove is listed.
const BASE = process.env.MEETLY_URL || "http://localhost:3000";
const CF = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${process.env.REALTIMEKIT_APP_ID}`;

const results = [];
function ok(name, pass, detail) {
  results.push(!!pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** One browser, as far as the server can tell: it keeps the cookies it is given. */
function browser() {
  const cookies = new Map();
  return {
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
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  };
}

async function cloudflare(method, path, body) {
  const response = await fetch(`${CF}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  return { ok: response.ok && !!(json && json.success), status: response.status, data: json && json.data };
}

(async () => {
  let meetingId = null;
  try {
    const ada = browser();
    const created = await ada.post("/api/meeting", { action: "create" });
    const code = created.body && created.body.code;
    const host = await ada.post("/api/token", { room: code, name: "Ada (poll test)" });
    meetingId = host.body && host.body.meetingId;
    ok("the creating browser joins as host", host.status === 200 && host.body.role === "host", `${host.status} ${code} ${meetingId}`);
    ok("a join says which polls have ended: none yet", Array.isArray(host.body.closedPolls) && host.body.closedPolls.length === 0, JSON.stringify(host.body.closedPolls));

    const ben = browser();
    const guest = await ben.post("/api/token", { room: code, name: "Ben (poll test)" });
    ok("someone else joins as a guest", guest.status === 200 && guest.body.role === "guest");
    const ask = (who, session, body) => who.post("/api/host", { session, ...body });

    const refused = await ask(ben, guest.body.session, { action: "closePoll", pollId: "poll-rest-1" });
    ok("a guest ending a poll is refused (403)", refused.status === 403, JSON.stringify(refused));
    const claimed = await ask(ben, guest.body.session, { action: "closePoll", pollId: "poll-rest-1", role: "host", isHost: true });
    ok("whatever role the request claims (403)", claimed.status === 403);
    const forged = await ask(ben, `${guest.body.session.slice(0, -4)}AAAA`, { action: "closePoll", pollId: "poll-rest-1" });
    ok("a tampered session is refused (403)", forged.status === 403);
    const bad = await ask(ada, host.body.session, { action: "closePoll", pollId: "not a poll id!" });
    ok("an id that is not an id is refused (400)", bad.status === 400);
    const before = await ask(ben, guest.body.session, { action: "roles" });
    ok("none of that recorded anything", before.status === 200 && before.body.closedPolls.length === 0, JSON.stringify(before.body));

    const ended = await ask(ada, host.body.session, { action: "closePoll", pollId: "poll-rest-1" });
    ok("the host ends a poll (200)", ended.status === 200, JSON.stringify(ended));
    const after = await ask(ben, guest.body.session, { action: "roles" });
    ok("anyone in the meeting is told it has ended", after.status === 200 && after.body.closedPolls.join() === "poll-rest-1", JSON.stringify(after.body));
    const again = await ask(ada, host.body.session, { action: "closePoll", pollId: "poll-rest-1" });
    const still = await ask(ada, host.body.session, { action: "roles" });
    ok("ending it twice records it once", again.status === 200 && still.body.closedPolls.join() === "poll-rest-1", JSON.stringify(still.body));

    const makeCoHost = await ask(ada, host.body.session, { action: "coHost", participantId: guest.body.participantId, on: true });
    const byCoHost = await ask(ben, guest.body.session, { action: "closePoll", pollId: "poll-rest-2" });
    ok("a co-host may end a poll", makeCoHost.status === 200 && byCoHost.status === 200, `${makeCoHost.status} ${byCoHost.status}`);

    const cy = browser();
    const late = await cy.post("/api/token", { room: code, name: "Cy (poll test)" });
    ok("someone who joins later is told at once", late.status === 200 && late.body.closedPolls.slice().sort().join() === "poll-rest-1,poll-rest-2", JSON.stringify(late.body.closedPolls));

    const route = await ada.post("/api/poll", { action: "mine", token: "x" });
    ok("/api/poll is LiveKit's: a RealtimeKit build answers 404", route.status === 404, String(route.status));
  } catch (error) {
    ok("ran to the end", false, String(error && error.message));
  }

  /* ---- clean up what was made ---- */
  const left = [];
  if (meetingId) {
    const listed = await cloudflare("GET", `/meetings/${meetingId}/participants?per_page=100`);
    const records = listed.ok ? listed.data : [];
    if (!listed.ok) left.push(`could not list participants of meeting ${meetingId} (${listed.status})`);
    for (const record of records) {
      const gone = await cloudflare("DELETE", `/meetings/${meetingId}/participants/${record.id}`);
      if (!gone.ok && gone.status !== 404) left.push(`participant ${record.id} (${record.custom_participant_id}) in meeting ${meetingId}: ${gone.status}`);
    }
    const off = await cloudflare("PATCH", `/meetings/${meetingId}`, { status: "INACTIVE" });
    if (!off.ok) left.push(`meeting ${meetingId} is still ACTIVE (${off.status})`);
    console.log(`\nCreated and removed: meeting ${meetingId}, ${records.length} participant records (deleted), meeting set INACTIVE: ${off.ok}`);
  }
  if (left.length) console.log(`NOT cleaned up:\n  ${left.join("\n  ")}`);
  const failed = results.filter((pass) => !pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed || left.length ? 1 : 0);
})();
