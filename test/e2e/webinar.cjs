// Webinars on LiveKit: a webinar made from the home page's server call, its audience's tokens,
// tiles, and bringing someone on stage and back, against a real LiveKit server.
//
// This part drives the call through its interface (window.__meetly.call) and LiveKit's own room
// object, because it checks what the server and LiveKit enforce. The audience's own screens
// (pre-join, control bar, invitation, the Audience list) are checked further down once they exist.
const H = require("./lib.cjs");

/** Makes a webinar from the person's own page, so the host key lands in their cookies. */
async function createWebinar(person) {
  await person.page.goto(`${H.BASE}/`);
  const code = await person.page.evaluate(async () => {
    const response = await fetch("/api/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", mode: "webinar" }),
    });
    return (await response.json()).code;
  });
  return `${H.BASE}/${code}`;
}

/** Joins with microphone and camera off on the pre-join screen. */
async function joinQuietly(person, url, name) {
  const { page } = person;
  await page.goto(url);
  await page.getByLabel("Your name").fill(name);
  const mic = page.getByRole("button", { name: "Mute microphone" });
  const cam = page.getByRole("button", { name: "Turn off camera" });
  await page.getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).waitFor();
  if (await mic.count()) await mic.click();
  if (await cam.count()) await cam.click();
  await page.getByRole("button", { name: /^(Join now|Ask to join)$/ }).click();
  await H.inCall(person);
}

const tilesOf = (person) =>
  person.page.evaluate(() => window.__meetly.call.tiles().map((tile) => `${tile.participant.identity}:${tile.source}`));
const call = (person, fn, arg) => person.page.evaluate(fn, arg);

module.exports = async function webinar(browser) {
  console.log("\n— webinar —");
  const host = await H.client(browser);
  const vic = await H.client(browser);
  const wes = await H.client(browser);
  const url = await createWebinar(host);
  H.ok("New webinar makes a link", /\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url), url);

  await H.join(host, url, "Hana Host");
  H.ok("the host's grant says webinar", host.tokenBody && host.tokenBody.mode === "webinar");
  await joinQuietly(vic, url, "Vic Viewer");
  await joinQuietly(wes, url, "Wes Watcher");
  H.ok("a viewer's grant says webinar", vic.tokenBody && vic.tokenBody.mode === "webinar");
  const [hostId, vicId, wesId] = [await H.identity(host), await H.identity(vic), await H.identity(wes)];

  /* the audience cannot publish */
  H.ok("a viewer's LiveKit permissions say they cannot publish", (await call(vic, () => window.__meetly.room.localParticipant.permissions?.canPublish)) === false);
  H.ok("a viewer's role is viewer", (await call(vic, () => window.__meetly.call.local.role)) === "viewer");
  const forced = await call(vic, async () => {
    // A modified client trying anyway: a real track, published straight through LiveKit's own API.
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    const [track] = canvas.captureStream(5).getVideoTracks();
    try {
      await window.__meetly.room.localParticipant.publishTrack(track, { name: "forced" });
      return "published";
    } catch (error) {
      return `refused: ${error && error.message}`;
    }
  });
  H.ok("LiveKit refuses a viewer's forced publish", forced.startsWith("refused"), forced);
  await H.sleep(1500);
  H.ok(
    "…and nobody receives it",
    (await call(host, (id) => window.__meetly.room.remoteParticipants.get(id)?.trackPublications.size ?? -1, vicId)) === 0,
  );

  /* viewers are never tiles */
  await H.until(async () => (await tilesOf(host)).length > 0, 8000);
  const hostTiles = await tilesOf(host);
  H.ok("the host's stage has only the host", hostTiles.join() === `${hostId}:camera`, hostTiles.join());
  const vicTiles = await tilesOf(vic);
  H.ok("a viewer has no tile of their own and sees only the stage", vicTiles.join() === `${hostId}:camera`, vicTiles.join());

  /* hand → invite → yes → speaking */
  await call(vic, () => window.__meetly.call.setHandRaised(true));
  H.ok("the host sees the viewer's hand", await H.until(() => call(host, (id) => !!window.__meetly.call.participant(id)?.handRaised, vicId), 6000));
  const guestTries = await H.hostApi(wes, { token: wes.token, action: "stage", identity: vicId, on: true });
  H.ok("another viewer cannot invite anyone", guestTries === 403);
  await call(host, (id) => window.__meetly.call.moderate({ action: "stage", identity: id, on: true }), vicId);
  H.ok("the viewer is asked", await H.until(() => call(vic, () => window.__meetly.call.local.stageInvite), 6000));
  H.ok("…and is still a viewer with no tile until they say yes", (await call(vic, () => window.__meetly.call.local.role)) === "viewer" && (await tilesOf(host)).length === 1);
  await call(vic, (id) => window.__meetly.call.moderate({ action: "stage", identity: id, on: true }), vicId);
  H.ok("saying yes makes them a speaker", await H.until(() => call(vic, () => window.__meetly.call.local.role === "speaker"), 6000));
  const media = await call(vic, async () => {
    const c = window.__meetly.call;
    try {
      await c.setEnabled("microphone", true);
      await c.setEnabled("camera", true);
      return JSON.stringify(c.localMedia());
    } catch (error) {
      return `failed: ${error && error.message}`;
    }
  });
  H.ok("a speaker's microphone and camera are allowed", media === JSON.stringify({ microphone: true, camera: true, screenShare: false }), media);
  for (const [name, person] of [["host", host], ["another viewer", wes]]) {
    H.ok(
      `a speaker tile appears for the ${name}`,
      await H.until(async () => (await tilesOf(person)).includes(`${vicId}:camera`), 8000),
    );
  }

  /* back to audience */
  await call(host, (id) => window.__meetly.call.moderate({ action: "stage", identity: id, on: false }), vicId);
  H.ok("back to audience takes away the right to publish", await H.until(() => call(vic, () => window.__meetly.room.localParticipant.permissions?.canPublish === false), 6000));
  H.ok("…their microphone and camera go off", await H.until(() => call(vic, () => { const m = window.__meetly.call.localMedia(); return !m.microphone && !m.camera; }), 6000));
  H.ok("…and their tile goes for everyone", await H.until(async () => !(await tilesOf(host)).some((t) => t.startsWith(vicId)) && !(await tilesOf(wes)).some((t) => t.startsWith(vicId)), 8000));

  /* stepping down yourself */
  await call(host, (id) => window.__meetly.call.moderate({ action: "stage", identity: id, on: true }), wesId);
  await H.until(() => call(wes, () => window.__meetly.call.local.stageInvite), 6000);
  await call(wes, (id) => window.__meetly.call.moderate({ action: "stage", identity: id, on: false }), wesId);
  H.ok("Not now withdraws the invitation from the viewer's side", await H.until(() => call(wes, () => !window.__meetly.call.local.stageInvite && window.__meetly.room.localParticipant.permissions?.canPublish === false), 6000));

  /* chat is read-only for the audience */
  const chat = await call(vic, async (token) => {
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "send", text: "hi" }) });
    return response.status;
  }, vic.token);
  H.ok("a viewer's chat message is refused by the server", chat === 403);

  await Promise.all([host, vic, wes].map((person) => person.ctx.close()));
};
