// Webinars on RealtimeKit, checked against Cloudflare's real REST API without anyone joining a
// call (joining is what is billed). Not part of run.cjs: it needs the RealtimeKit app's API
// token, and it creates meetings and participant records, whose ids it prints at the end.
//
//   MEETLY_URL=http://localhost:3000 CLOUDFLARE_ACCOUNT_ID=… REALTIMEKIT_APP_ID=… \
//   CLOUDFLARE_API_TOKEN=… node test/e2e/realtimekit-webinar-rest.cjs
//
// What it can show:
// - the three webinar presets hold the permissions the stage flow relies on, and only those;
// - New webinar, the audience's preset, and a co-host's fresh token with the co-host preset.
// What it cannot, because it needs a live session:
// - whether a preset change reaches someone already connected (Meetly does not rely on it: a new
//   co-host rejoins);
// - `stage.grantAccess` and the rest of the stage, which are the SDK's;
// - the speaker's chat permission (`participants.updatePermissions`, also the SDK's: RealtimeKit's
//   REST API has no call that changes a live participant's permissions).
const BASE = process.env.MEETLY_URL || "http://localhost:3000";
const { CLOUDFLARE_ACCOUNT_ID: account, REALTIMEKIT_APP_ID: app, CLOUDFLARE_API_TOKEN: token } = process.env;
const PRESETS = {
  host: process.env.REALTIMEKIT_WEBINAR_HOST_PRESET || "meetly-webinar-host",
  viewer: process.env.REALTIMEKIT_WEBINAR_VIEWER_PRESET || "meetly-webinar-viewer",
  cohost: process.env.REALTIMEKIT_WEBINAR_COHOST_PRESET || "meetly-webinar-cohost",
};

const results = [];
function ok(name, pass, detail) {
  results.push(!!pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function cf(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/realtime/kit/${app}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => null);
  return json && json.success ? json.data : null;
}

/** A preset by name, with its permissions, from the app's own list. */
async function preset(name) {
  const list = (await cf("/presets?per_page=100")) || [];
  const found = list.find((entry) => entry.name === name);
  return found ? cf(`/presets/${found.id}`) : null;
}

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

(async () => {
  if (!account || !app || !token) {
    console.error("Set CLOUDFLARE_ACCOUNT_ID, REALTIMEKIT_APP_ID and CLOUDFLARE_API_TOKEN.");
    process.exit(2);
  }

  /* the presets */
  const [host, viewer, cohost] = await Promise.all([preset(PRESETS.host), preset(PRESETS.viewer), preset(PRESETS.cohost)]);
  for (const [name, p] of [[PRESETS.host, host], [PRESETS.viewer, viewer], [PRESETS.cohost, cohost]]) {
    ok(`${name} exists and is a webinar preset`, p && p.config && p.config.view_type === "WEBINAR", p && p.config && p.config.view_type);
  }
  const media = (p) => p && p.permissions && p.permissions.media;
  const produce = (p) => ["audio", "video", "screenshare"].map((kind) => media(p) && media(p)[kind] && media(p)[kind].can_produce);
  ok("the host's media is ALLOWED", produce(host).every((v) => v === "ALLOWED"), JSON.stringify(produce(host)));
  ok("the host may change the stage and someone's chat", host && host.permissions.can_accept_production_requests && host.permissions.can_change_participant_permissions);
  ok("the audience's media is CAN_REQUEST", produce(viewer).every((v) => v === "CAN_REQUEST"), JSON.stringify(produce(viewer)));
  ok("the audience cannot send public chat, and can vote in polls", viewer && !viewer.permissions.chat.public.can_send && viewer.permissions.polls.can_vote);
  ok(
    "the audience has no moderation at all",
    viewer &&
      !viewer.permissions.accept_waiting_requests &&
      !viewer.permissions.can_accept_production_requests &&
      !viewer.permissions.can_change_participant_permissions &&
      !viewer.permissions.kick_participant &&
      !viewer.permissions.disable_participant_audio,
  );
  const c = cohost && cohost.permissions;
  ok("a co-host's media is CAN_REQUEST (off stage until invited)", produce(cohost).every((v) => v === "CAN_REQUEST"), JSON.stringify(produce(cohost)));
  ok(
    "a co-host may let people in, change the stage, mute and remove",
    c && c.accept_waiting_requests && c.can_accept_production_requests && c.disable_participant_audio && c.disable_participant_video && c.kick_participant,
  );
  ok("a co-host may start, vote in and see polls, and send public chat", c && c.polls.can_create && c.polls.can_vote && c.polls.can_view && c.chat.public.can_send);
  ok("a co-host may not record", c && !c.can_record && !c.can_livestream);
  // Meetly turns a speaker's chat on and off with the SDK's participants.updatePermissions,
  // which takes this permission. Without it a co-host's invitation cannot be all or nothing,
  // so the interface does not offer one (supports.stage is false for them).
  ok("a co-host may change someone's chat (needed for Invite to speak)", c && c.can_change_participant_permissions, String(c && c.can_change_participant_permissions));

  /* New webinar, the audience, a co-host */
  const ada = browser();
  const made = await ada.post("/api/meeting", { action: "create", mode: "webinar" });
  const code = made.body && made.body.code;
  ok("New webinar answers with a code", made.status === 200 && typeof code === "string", JSON.stringify(made.body));
  const adaJoin = await ada.post("/api/token", { room: code, name: "Ada" });
  ok("the host joins as host, with the webinar host's preset named", adaJoin.body.role === "host" && adaJoin.body.hostPreset === PRESETS.host && adaJoin.body.mode === "webinar");
  const ben = browser();
  const benJoin = await ben.post("/api/token", { room: code, name: "Ben" });
  ok("someone else joins the audience", benJoin.body.role === "guest" && benJoin.body.mode === "webinar" && benJoin.body.canAsk === false);
  ok("…and is told both webinar presets", JSON.stringify(benJoin.body.webinarPresets) === JSON.stringify({ viewer: PRESETS.viewer, cohost: PRESETS.cohost }));
  const records = (await cf(`/meetings/${benJoin.body.meetingId}/participants?per_page=100`)) || [];
  const benRecord = records.find((p) => p.id === benJoin.body.participantId);
  ok("their record holds the audience's preset", benRecord && benRecord.preset_name === PRESETS.viewer, benRecord && benRecord.preset_name);
  const benIdentity = benRecord && benRecord.custom_participant_id;
  const coHost = await ada.post("/api/host", { session: adaJoin.body.session, action: "coHost", participantId: benIdentity, on: true });
  ok("the host makes them co-host", coHost.status === 200);
  const rejoin = await ben.post("/api/host", { session: benJoin.body.session, action: "rejoin" });
  ok("the new co-host is given a fresh token", rejoin.status === 200 && typeof rejoin.body.authToken === "string");
  const after = ((await cf(`/meetings/${benJoin.body.meetingId}/participants?per_page=100`)) || []).find((p) => p.id === benJoin.body.participantId);
  ok("…for the same record, now with the co-host preset", after && after.preset_name === PRESETS.cohost && after.custom_participant_id === benIdentity, after && after.preset_name);
  await ada.post("/api/host", { session: adaJoin.body.session, action: "coHost", participantId: benIdentity, on: false });
  await ben.post("/api/host", { session: benJoin.body.session, action: "rejoin" });
  const back = ((await cf(`/meetings/${benJoin.body.meetingId}/participants?per_page=100`)) || []).find((p) => p.id === benJoin.body.participantId);
  ok("no longer co-host: back to the audience's preset", back && back.preset_name === PRESETS.viewer, back && back.preset_name);
  const asViewer = await ben.post("/api/host", { session: benJoin.body.session, action: "stage", participantId: "anyone", on: true });
  ok("someone in the audience cannot change the stage", asViewer.status === 403);

  console.log(`\nMeeting ${benJoin.body.meetingId} (code ${code}) was created for this check.`);
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
