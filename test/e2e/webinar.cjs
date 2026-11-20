// Webinars on LiveKit, against a real LiveKit server: "New webinar" on the home page, the
// audience's pre-join (no device prompt), what the audience can and cannot do, bringing someone
// on stage from People › Audience with their consent and a device check, sending them back from
// either side, and a 300-person audience that makes no noise.
//
// Checks of what LiveKit enforces use the call's own interface and LiveKit's room object
// (window.__meetly, with localStorage meetly:debug=1); everything a person does goes through the
// screen.
const H = require("./lib.cjs");

/**
 * The home page offers "New webinar" only when the server says webinars are on (the cost guard's
 * switch, `{ action: "webinars" }`). That answer is the switch's business and tested with it; here
 * the server is taken to say yes, and everything else reaches the real server.
 */
async function offerWebinars(person) {
  await person.page.route("**/api/meeting", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.action === "webinars") return route.fulfill({ json: { enabled: true } });
    return route.continue();
  });
}

/** Counts every request for a camera or microphone this page makes, from before it loads. */
async function countDevicePrompts(person) {
  await person.ctx.addInitScript(() => {
    window.__deviceAsks = 0;
    const media = navigator.mediaDevices;
    if (!media) return;
    const ask = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => {
      window.__deviceAsks++;
      return ask(constraints);
    };
  });
}
const deviceAsks = (person) => person.page.evaluate(() => window.__deviceAsks);

const inWebinar = (person) => person.page.locator("[data-in-call]:not([inert])").getByRole("button", { name: "Leave webinar" });
const onStageCall = (person) => person.page.locator("[data-in-call]:not([inert])").getByRole("button", { name: "Leave meeting" });

async function watch(person, url, name) {
  const { page } = person;
  await page.goto(url);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Watch" }).click();
  await inWebinar(person).waitFor({ timeout: 20000 });
}

const tilesOf = (person) =>
  person.page.evaluate(() => window.__meetly.call.tiles().map((tile) => `${tile.participant.identity}:${tile.source}`));
const call = (person, fn, arg) => person.page.evaluate(fn, arg);
const roleOf = (person) => call(person, () => window.__meetly.call.local.role);

module.exports = async function webinar(browser) {
  console.log("\n— webinar —");
  const host = await H.client(browser, { scale: 2 });
  const vic = await H.client(browser, { scale: 2 });
  const wes = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await countDevicePrompts(vic);
  await countDevicePrompts(wes);

  /* New webinar, from the home page */
  await offerWebinars(host);
  await host.page.goto(`${H.BASE}/`);
  await host.page.getByRole("button", { name: "More ways to start a meeting" }).click();
  await H.shot(host, "webinar-home-menu-desktop");
  await host.page.getByRole("menuitem", { name: "New webinar" }).click();
  await host.page.waitForURL(/\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  const url = host.page.url();
  H.ok("New webinar on the home page makes a link and opens it", /\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url), url);
  await H.join(host, url, "Hana Host");
  H.ok("the host joins through the ordinary pre-join, and the grant says webinar", host.tokenBody && host.tokenBody.mode === "webinar");

  /* the audience's pre-join */
  await vic.page.goto(url);
  await vic.page.getByRole("button", { name: "Watch" }).waitFor();
  await H.shot(vic, "webinar-viewer-prejoin-desktop");
  H.ok(
    "the audience's pre-join has a name and Watch, and no camera or microphone controls",
    (await vic.page.getByLabel("Your name").count()) === 1 &&
      (await vic.page.getByRole("button", { name: /microphone|camera/i }).count()) === 0,
  );
  await watch(vic, url, "Vic Viewer");
  await wes.page.goto(url);
  await wes.page.getByRole("button", { name: "Watch" }).waitFor();
  await H.shot(wes, "webinar-viewer-prejoin-phone");
  await watch(wes, url, "Wes Watcher");
  H.ok("joining the audience never asks for a camera or microphone", (await deviceAsks(vic)) === 0 && (await deviceAsks(wes)) === 0, `${await deviceAsks(vic)}, ${await deviceAsks(wes)}`);
  H.ok("a viewer's grant says webinar", vic.tokenBody && vic.tokenBody.mode === "webinar");
  const [hostId, vicId, wesId] = [await H.identity(host), await H.identity(vic), await H.identity(wes)];

  /* the audience cannot publish */
  H.ok("a viewer's LiveKit permissions say they cannot publish", (await call(vic, () => window.__meetly.room.localParticipant.permissions?.canPublish)) === false);
  H.ok("a viewer's role is viewer", (await roleOf(vic)) === "viewer");
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
  H.ok("…and nobody receives it", (await call(host, (id) => window.__meetly.room.remoteParticipants.get(id)?.trackPublications.size ?? -1, vicId)) === 0);

  /* what the audience sees */
  await H.until(async () => (await tilesOf(host)).length > 0, 8000);
  H.ok("the host's stage has only the host", (await tilesOf(host)).join() === `${hostId}:camera`, (await tilesOf(host)).join());
  H.ok("a viewer has no tile of their own and sees only the stage", (await tilesOf(vic)).join() === `${hostId}:camera`, (await tilesOf(vic)).join());
  H.ok("the top bar says Live and how many are watching", await H.until(async () => (await vic.page.locator("[data-live]").innerText()).replace(/\s+/g, " ").includes("Live · 2 watching"), 8000));
  const bar = vic.page.getByRole("toolbar", { name: "Webinar controls" });
  H.ok(
    "the audience's controls are Raise hand, React and Leave, nothing else",
    (await bar.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")).join())) === "Raise hand,React,Leave webinar",
  );
  H.ok("the host with people watching is not told they are the only one here", (await host.page.getByText("You're the only one here").count()) === 0);
  await H.shot(vic, "webinar-viewer-desktop");
  await H.shot(wes, "webinar-viewer-phone");
  await vic.page.getByRole("button", { name: "Chat" }).click();
  H.ok("the chat is there to read, with no box to write in", (await vic.page.locator("[data-chat-read-only]").count()) === 1 && (await vic.page.getByRole("textbox", { name: "Message" }).count()) === 0);
  await H.shot(vic, "webinar-viewer-chat-desktop");
  await vic.page.getByRole("button", { name: "Close chat" }).click();
  const chat = await call(vic, async (token) => {
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "send", text: "hi" }) });
    return response.status;
  }, vic.token);
  H.ok("a viewer's chat message is refused by the server too", chat === 403);

  /* hands, and People › Audience */
  await vic.page.getByRole("button", { name: "Raise hand" }).click();
  await H.openPeople(host);
  const audience = H.people(host).getByRole("region", { name: "Audience" });
  H.ok("the host sees the audience in People, with its count", await H.until(async () => /^audience\s*2$/i.test((await audience.getByRole("heading").innerText()).trim()), 8000));
  H.ok("…the raised hand first, with its place", await H.until(async () => (await audience.locator("[data-audience-row]").first().innerText()).includes("Vic Viewer") && (await audience.locator("[data-audience-row]").first().innerText()).includes("1st"), 6000));
  H.ok("…and the audience is not in the list of people on stage", (await H.people(host).getByRole("list", { name: "Participants" }).getByText("Wes Watcher").count()) === 0);
  await H.shot(host, "webinar-host-audience-desktop");
  H.ok("another viewer is never shown who is watching", !(await vic.page.locator("body").innerText()).includes("Wes Watcher") && !(await wes.page.locator("body").innerText()).includes("Vic Viewer"));
  const guestTries = await H.hostApi(wes, { token: wes.token, action: "stage", identity: vicId, on: true });
  H.ok("a viewer cannot invite anyone", guestTries === 403);

  /* invite → consent → device check → on stage */
  await audience.getByRole("button", { name: "Invite Vic Viewer to speak" }).click();
  const invitation = vic.page.getByRole("region", { name: "Invitation to speak" });
  H.ok("the viewer is asked: The host invited you to speak", await H.until(async () => (await invitation.count()) === 1, 8000));
  H.ok("…and nothing is asked of the browser until they choose to", (await deviceAsks(vic)) === 0);
  H.ok("while one invitation is out, nobody else can be invited", await H.until(async () => await audience.getByRole("button", { name: "Invite Wes Watcher to speak" }).isDisabled(), 4000));
  await H.shot(vic, "webinar-invitation-desktop");
  await invitation.getByRole("button", { name: "Join stage…" }).click();
  H.ok("Join stage… opens the device check", await H.until(async () => (await deviceAsks(vic)) > 0, 6000));
  await H.shot(vic, "webinar-device-check-desktop");
  H.ok("…and they are still in the audience with no tile", (await roleOf(vic)) === "viewer" && !(await tilesOf(host)).some((t) => t.startsWith(vicId)));
  await invitation.getByRole("button", { name: "Join stage" }).click();
  H.ok("saying yes puts them on stage, with the meeting's own controls", await H.until(async () => (await onStageCall(vic).count()) === 1, 10000));
  H.ok("…their microphone and camera come on as checked", await H.until(() => call(vic, () => { const m = window.__meetly.call.localMedia(); return m.microphone && m.camera; }), 10000));
  for (const [name, person] of [["host", host], ["other viewer", wes]]) {
    H.ok(`a speaker tile appears for the ${name}`, await H.until(async () => (await tilesOf(person)).includes(`${vicId}:camera`), 10000));
  }
  H.ok("the speaker is shown how to go back", (await vic.page.getByRole("button", { name: "Back to audience" }).count()) === 1);
  H.ok("…and the hand that asked to speak is lowered", await H.until(() => call(vic, () => !window.__meetly.call.local.handRaised), 6000));
  await H.shot(vic, "webinar-on-stage-desktop");

  /* back to audience, from the speaker's side */
  await vic.page.getByRole("button", { name: "Back to audience" }).click();
  H.ok("Back to audience (speaker) returns them to the audience's screen", await H.until(async () => (await inWebinar(vic).count()) === 1, 10000));
  H.ok("…takes away the right to publish", await H.until(() => call(vic, () => window.__meetly.room.localParticipant.permissions?.canPublish === false), 6000));
  H.ok("…and their tile goes for everyone", await H.until(async () => !(await tilesOf(host)).some((t) => t.startsWith(vicId)) && !(await tilesOf(wes)).some((t) => t.startsWith(vicId)), 10000));

  /* back to audience, from the host's side */
  await audience.getByRole("button", { name: "Invite Wes Watcher to speak" }).click();
  const wesInvite = wes.page.getByRole("region", { name: "Invitation to speak" });
  await wesInvite.waitFor({ timeout: 8000 });
  await H.shot(wes, "webinar-invitation-phone");
  await wesInvite.getByRole("button", { name: "Join stage…" }).click();
  await wesInvite.getByRole("button", { name: "Join stage" }).click();
  await onStageCall(wes).waitFor({ timeout: 10000 });
  await H.until(async () => (await tilesOf(host)).includes(`${wesId}:camera`), 10000);
  await host.page.getByRole("list", { name: "Participants" }).getByRole("button", { name: "Host controls for Wes Watcher" }).click();
  await host.page.getByRole("menuitem", { name: "Back to audience" }).click();
  H.ok("Back to audience (host) returns the speaker to the audience", await H.until(async () => (await inWebinar(wes).count()) === 1, 10000));
  H.ok("…and removes their right to publish", await H.until(() => call(wes, () => window.__meetly.room.localParticipant.permissions?.canPublish === false), 6000));

  /* Not now */
  await audience.getByRole("button", { name: "Invite Vic Viewer to speak" }).click();
  await invitation.waitFor({ timeout: 8000 });
  await invitation.getByRole("button", { name: "Not now" }).click();
  H.ok("Not now withdraws the invitation from the viewer's side", await H.until(async () => (await invitation.count()) === 0 && (await call(vic, () => window.__meetly.room.localParticipant.permissions?.canPublish)) === false, 8000));
  H.ok("…and the host can invite again", await H.until(async () => !(await audience.getByRole("button", { name: "Invite Vic Viewer to speak" }).isDisabled()), 6000));

  /* reactions from the audience are anonymous */
  await call(vic, () => window.__meetly.call.sendReaction("👏"));
  await host.page.locator("[data-reaction-lane]").waitFor({ timeout: 5000 }).catch(() => {});
  const lane = await host.page.locator("[data-reaction-lane]").innerText().catch(() => "");
  H.ok("an audience reaction reaches the host without a name", lane.includes("👏") && !lane.includes("Vic"), lane);

  /* 300 people watching: no notices, no sounds, a windowed list */
  await H.closePeople(host);
  const crowd = (n, role = "viewer") =>
    call(host, ({ count, role }) => {
      // A synthetic audience pushed through the call's own events: what the adapter would send.
      const c = window.__meetly.call;
      if (!window.__crowd) {
        window.__crowd = new Map();
        const real = { participants: c.participants.bind(c), participant: c.participant.bind(c), remoteIds: c.remoteIds.bind(c) };
        let roster = null;
        c.participants = () => (roster ??= [...real.participants(), ...window.__crowd.values()]);
        c.participant = (id) => window.__crowd.get(id) || real.participant(id);
        c.remoteIds = () => [...real.remoteIds(), ...window.__crowd.keys()];
        window.__crowdChanged = () => {
          roster = null;
          c.emit("roster");
          c.emit("stage");
        };
      }
      for (let i = 0; i < count; i++) {
        const n = window.__crowd.size;
        const person = { identity: `crowd-${n}`, isLocal: false, name: role === "viewer" ? `Watcher ${n}` : `Speaker ${n}`, role, stageInvite: false, micOn: false, camOn: false, handRaised: false, speaking: false, weakConnection: false, subscribe: () => () => {} };
        window.__crowd.set(person.identity, person);
        window.__crowdChanged();
        c.emit("participantJoined", person);
      }
    }, { count: n, role });
  // The control: someone joining the stage is announced, so the counts below can move at all.
  await crowd(1, "speaker");
  H.ok("(control) someone joining the stage is announced", await H.until(() => call(host, () => document.querySelectorAll('.toast-region [data-priority="presence"]').length > 0), 4000));
  await call(host, () => {
    const c = window.__meetly.call;
    const person = window.__crowd.get("crowd-0");
    window.__crowd.delete("crowd-0");
    window.__crowdChanged();
    c.emit("participantLeft", person);
  });
  // Their departure is announced too, a moment later; then the slate is cleared.
  await H.sleep(1000);
  await host.page.getByRole("button", { name: "Dismiss notification" }).evaluateAll((buttons) => buttons.forEach((b) => b.click()));
  await H.until(() => call(host, () => document.querySelectorAll('.toast-region [data-priority="presence"]').length === 0), 8000);
  const before = await call(host, () => ({
    toasts: document.querySelectorAll('.toast-region [data-priority="presence"]').length,
    sounds: (window.__meetlySounds?.log || []).filter((s) => s.name === "joined" || s.name === "left").length,
  }));
  await crowd(5);
  await H.sleep(1200);
  await crowd(293);
  await H.sleep(1500);
  const after = await call(host, () => ({
    toasts: document.querySelectorAll('.toast-region [data-priority="presence"]').length,
    sounds: (window.__meetlySounds?.log || []).filter((s) => s.name === "joined" || s.name === "left").length,
  }));
  H.ok("300 people watching: no join notices", after.toasts === before.toasts, JSON.stringify({ before, after }));
  H.ok("…and no join sounds", after.sounds === before.sounds, JSON.stringify({ before, after }));
  await H.openPeople(host);
  H.ok("the host sees Audience 300", await H.until(async () => /audience\s*300/i.test(await audience.getByRole("heading").innerText()), 6000));
  await audience.getByRole("button", { name: "See all 300 in the audience" }).click();
  const list = H.people(host).locator("[data-audience-list]");
  await list.waitFor({ timeout: 5000 });
  const rows = await list.locator("li").count();
  H.ok("the full audience list draws only the rows in view", rows > 0 && rows < 40, `${rows} of 300 drawn`);
  await H.people(host).getByLabel("Search the audience").fill("Watcher 29");
  H.ok("…and is searchable", await H.until(async () => (await list.locator("li").count()) === 9, 4000), `${await list.locator("li").count()} matches`);
  await H.shot(host, "webinar-host-audience-all-desktop");

  await Promise.all([host, vic, wes].map((person) => person.ctx.close()));
};
