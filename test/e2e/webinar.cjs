// Webinars on LiveKit, against a real LiveKit server: "New webinar" on the home page, the
// audience's pre-join (no device prompt) and screen, the invitation dialog (focus, Esc, the
// connection dropping, being withdrawn), on stage and back from either side, speakers chatting,
// a co-host moderating from the audience, every place a webinar is named, who is listed as
// having left, and a 300-person audience that makes no noise.
//
// Checks of what LiveKit enforces use the call's own interface and LiveKit's room object
// (window.__meetly, with localStorage meetly:debug=1); everything a person does goes through the
// screen. Shots (MEETLY_SHOTS) are at 1440×900 @2 and 390×844 @2.
const H = require("./lib.cjs");

const WIDE = { width: 1440, height: 900 };

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

const inCall = (person) => person.page.locator("[data-in-call]:not([inert])");
/** The audience's screen, and the meeting's screen that people on stage have. */
const watchingScreen = (person) => inCall(person).locator("[data-viewer-bar]");
const stageScreen = (person) => inCall(person).getByRole("toolbar", { name: "Webinar controls" }).getByRole("button", { name: /^(Mute|Unmute) microphone$/ });

async function watch(person, url, name) {
  const { page } = person;
  await page.goto(url);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Watch" }).click();
  await watchingScreen(person).waitFor({ timeout: 20000 });
}

const tilesOf = (person) =>
  person.page.evaluate(() => window.__meetly.call.tiles().map((tile) => `${tile.participant.identity}:${tile.source}`));
const call = (person, fn, arg) => person.page.evaluate(fn, arg);
const roleOf = (person) => call(person, () => window.__meetly.call.local.role);
const canPublish = (person) => call(person, () => window.__meetly.room.localParticipant.permissions?.canPublish);
const chatStatus = (person, text) =>
  call(
    person,
    async ({ token, text }) => {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "send", text }) });
      return response.status;
    },
    { token: person.token, text },
  );
const invitation = (person) => person.page.getByRole("dialog", { name: "The host invited you to speak" });
const notice = (person, text) => person.page.locator(".toast-region").getByText(text);
const heading = async (locator) => (await locator.getByRole("heading").first().innerText()).replace(/\s+/g, " ").trim();

module.exports = async function webinar(browser) {
  console.log("\n— webinar —");
  const host = await H.client(browser, { viewport: WIDE, scale: 2 });
  const vic = await H.client(browser, { viewport: WIDE, scale: 2 });
  const wes = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await countDevicePrompts(vic);
  await countDevicePrompts(wes);

  /* the home page */
  await offerWebinars(wes);
  await wes.page.goto(`${H.BASE}/`);
  await wes.page.getByRole("button", { name: "More ways to start a meeting" }).click();
  await wes.page.getByRole("menuitem", { name: "New webinar" }).waitFor();
  // The illustration's notification ("Pat wants to join"). The still poster draws the computer and
  // phone designs and shows one; the animated stage, once loaded, lies over the poster for a frame
  // and then replaces it. Either way, the first one on screen.
  const heroNotice = () => wes.page.locator("[data-hero-toast]").filter({ visible: true }).first();
  H.ok(
    "phone home: the illustration's notification steps aside while the menu is open",
    await H.until(() => heroNotice().evaluate((el) => el.hasAttribute("data-quiet") && getComputedStyle(el).opacity === "0"), 3000),
  );
  await H.shot(wes, "home-menu-phone");
  await wes.page.keyboard.press("Escape");
  H.ok("…and comes back when it closes", await H.until(() => heroNotice().evaluate((el) => !el.hasAttribute("data-quiet") && getComputedStyle(el).opacity === "1"), 3000));

  await offerWebinars(host);
  await host.page.goto(`${H.BASE}/`);
  await host.page.getByRole("button", { name: "More ways to start a meeting" }).click();
  await H.shot(host, "home-menu-desktop");
  await host.page.getByRole("menuitem", { name: "New webinar" }).click();
  await host.page.waitForURL(/\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  const url = host.page.url();
  H.ok("New webinar on the home page makes a link and opens it", /\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url), url);
  await host.page.getByLabel("Your name").fill("Hana Host");
  H.ok("the host's pre-join names the webinar", (await host.page.getByPlaceholder("Shown to everyone in the webinar").count()) === 1);
  await host.page.getByRole("button", { name: /^Join now$/ }).click();
  await stageScreen(host).waitFor({ timeout: 20000 });
  H.ok("the host joins through the ordinary pre-join, and the grant says webinar", host.tokenBody && host.tokenBody.mode === "webinar");

  /* the audience's pre-join */
  await vic.page.goto(url);
  await vic.page.getByRole("button", { name: "Watch" }).waitFor();
  await H.shot(vic, "webinar-viewer-prejoin-desktop");
  H.ok(
    "the audience's pre-join has a name and Watch, and no camera or microphone controls",
    (await vic.page.getByLabel("Your name").count()) === 1 && (await vic.page.getByRole("button", { name: /microphone|camera/i }).count()) === 0,
  );
  const form = await vic.page.getByRole("button", { name: "Watch" }).boundingBox();
  H.ok("…in one column, centred on a wide screen", form && Math.abs(form.x + form.width / 2 - WIDE.width / 2) < 4, form && `${Math.round(form.x + form.width / 2)} of ${WIDE.width / 2}`);
  await watch(vic, url, "Vic Viewer");
  await wes.page.goto(url);
  await wes.page.getByRole("button", { name: "Watch" }).waitFor();
  await H.shot(wes, "webinar-viewer-prejoin-phone");
  await watch(wes, url, "Wes Watcher");
  H.ok("joining the audience never asks for a camera or microphone", (await deviceAsks(vic)) === 0 && (await deviceAsks(wes)) === 0, `${await deviceAsks(vic)}, ${await deviceAsks(wes)}`);
  const [hostId, vicId, wesId] = [await H.identity(host), await H.identity(vic), await H.identity(wes)];

  /* the audience cannot publish */
  H.ok("a viewer's LiveKit permissions say they cannot publish", (await canPublish(vic)) === false);
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
  H.ok("a viewer is never a tile, theirs or anyone's", (await tilesOf(vic)).join() === `${hostId}:camera` && (await tilesOf(host)).join() === `${hostId}:camera`);
  const bar = vic.page.locator("footer");
  H.ok("desktop: no top bar; the control bar's left cluster says ● Live · 2 watching", (await inCall(vic).locator("header").count()) === 0 && (await H.until(async () => (await bar.locator("[data-live]").innerText()).replace(/\s+/g, " ").includes("Live · 2 watching"), 8000)));
  H.ok("…with the code and its copy button beside it", (await bar.getByRole("button", { name: /^Copy webinar link, code / }).count()) === 1);
  H.ok(
    "…the audience's controls are Raise hand, React and Leave",
    (await watchingScreen(vic).getByRole("toolbar").getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")).join())) === "Raise hand,React,Leave webinar",
  );
  H.ok("…and Chat sits on the right", (await bar.getByRole("button", { name: "Chat" }).count()) === 1);
  H.ok("phone: ● Live · 2 in the top bar, the code beside the logo", await H.until(async () => (await wes.page.locator("header [data-live]").innerText()).replace(/\s+/g, " ").includes("Live · 2"), 6000));
  H.ok("the host with people watching is not told they are the only one here", (await host.page.getByText("You're the only one here").count()) === 0);
  await H.shot(vic, "webinar-viewer-desktop");
  await H.shot(wes, "webinar-viewer-phone");

  /* chat: read-only for the audience, and the badge counts polls */
  await call(host, () => window.__meetly.call.createPoll({ question: "Which topic next?", options: ["Pricing", "Roadmap"], anonymous: true }));
  H.ok("a new poll shows on the audience's Chat badge", await H.until(async () => (await bar.locator("[data-chat-badge]").count()) === 1, 8000));
  await vic.page.getByRole("button", { name: /^Chat/ }).click();
  H.ok("the audience's chat has no box to write in", (await vic.page.getByRole("textbox", { name: "Message" }).count()) === 0);
  H.ok("…it says who can write: Only speakers and hosts can send messages", (await vic.page.locator("[data-chat-read-only]").innerText()).trim() === "Only speakers and hosts can send messages");
  H.ok("…and, while empty, what will appear there", (await vic.page.getByText("Messages from the people on stage appear here.").count()) === 1);
  await vic.page.locator("[data-poll-option='1']").click();
  H.ok("the audience votes in a poll from the chat", await H.until(() => call(vic, () => window.__meetly.call.polls()[0]?.voted === true), 6000));
  await H.shot(vic, "webinar-viewer-chat-desktop");
  await vic.page.getByRole("button", { name: "Close chat" }).click();
  await wes.page.getByRole("button", { name: /^Chat/ }).click();
  H.ok("phone: the same chat, as a sheet, to read", (await wes.page.locator("[data-chat-read-only]").count()) === 1);
  await H.shot(wes, "webinar-viewer-chat-phone");
  await wes.page.getByRole("button", { name: "Close chat" }).click();
  H.ok("a viewer's chat message is refused by the server too", (await chatStatus(vic, "hi")) === 403);

  /* People: Speakers and Audience */
  await vic.page.getByRole("button", { name: "Raise hand" }).click();
  await H.openPeople(host);
  const audience = H.people(host).getByRole("region", { name: "Audience" });
  H.ok("People has Audience 2 for the host", await H.until(async () => /^audience\s*2$/i.test(await heading(audience)), 8000));
  H.ok("…the raised hand first, with its place", await H.until(async () => /Vic Viewer[\s\S]*1st/.test(await audience.locator("[data-audience-row]").first().innerText()), 6000));
  H.ok("…and Speakers 1 for who is on stage, without the audience", await H.until(async () => /speakers\s*1/i.test(await H.people(host).getByRole("list", { name: "Participants" }).innerText()), 4000) && (await H.people(host).getByRole("list", { name: "Participants" }).getByText("Wes Watcher").count()) === 0);
  await H.shot(host, "webinar-host-audience-desktop");
  H.ok("another viewer is never shown who is watching", !(await vic.page.locator("body").innerText()).includes("Wes Watcher") && !(await wes.page.locator("body").innerText()).includes("Vic Viewer"));
  H.ok("a viewer cannot invite anyone", (await H.hostApi(wes, { token: wes.token, action: "stage", identity: vicId, on: true })) === 403);

  /* the invitation: a dialog, Not now first, Esc */
  const invite = (name) => audience.getByRole("button", { name: `Invite ${name} to speak` }).click();
  await invite("Vic Viewer");
  H.ok("the viewer is asked in a dialog: The host invited you to speak", await H.until(async () => (await invitation(vic).count()) === 1, 8000));
  H.ok("…with their camera preview in it from the first frame", await H.until(async () => (await deviceAsks(vic)) > 0, 6000));
  H.ok("…focus on Not now, never on Join stage", await H.until(() => vic.page.evaluate(() => document.activeElement?.textContent?.trim() === "Not now"), 3000));
  H.ok("…and they are still in the audience with no tile", (await roleOf(vic)) === "viewer" && !(await tilesOf(host)).some((t) => t.startsWith(vicId)));
  H.ok("while one invitation is out, nobody else can be invited", await H.until(() => audience.getByRole("button", { name: "Invite Wes Watcher to speak" }).isDisabled(), 4000));
  await H.shot(vic, "webinar-invitation-desktop");
  await vic.page.keyboard.press("Escape");
  H.ok("Esc is Not now: the dialog closes and the invitation is turned down", await H.until(async () => (await invitation(vic).count()) === 0 && (await canPublish(vic)) === false, 8000));
  H.ok("…without telling them the host withdrew it", (await notice(vic, "The host withdrew the invitation").count()) === 0);

  /* withdrawn by the host */
  await H.until(async () => !(await audience.getByRole("button", { name: "Invite Vic Viewer to speak" }).isDisabled()), 6000);
  await invite("Vic Viewer");
  await invitation(vic).waitFor({ timeout: 8000 });
  await audience.getByRole("button", { name: "Cancel the invitation to Vic Viewer" }).click();
  H.ok("withdrawn by the host: the dialog closes", await H.until(async () => (await invitation(vic).count()) === 0, 8000));
  H.ok("…and a notice says The host withdrew the invitation", await H.until(async () => (await notice(vic, "The host withdrew the invitation").count()) === 1, 4000));

  /* the connection drops while the dialog is up */
  await H.until(async () => !(await audience.getByRole("button", { name: "Invite Vic Viewer to speak" }).isDisabled()), 6000);
  await invite("Vic Viewer");
  await invitation(vic).waitFor({ timeout: 8000 });
  // What the call reports while LiveKit reconnects, said to the screen the way the call says it.
  await call(vic, () => {
    const c = window.__meetly.call;
    Object.defineProperty(c, "status", { get: () => "reconnecting", configurable: true });
    c.emit("status");
  });
  const join = invitation(vic).getByRole("button", { name: "Join stage" });
  H.ok("reconnecting: the dialog says Reconnecting…", await H.until(async () => (await invitation(vic).locator("[data-invite-reconnecting]").count()) === 1, 4000));
  H.ok("…and Join stage waits", await join.isDisabled());
  await H.shot(vic, "webinar-invitation-reconnecting-desktop");
  await call(vic, () => {
    const c = window.__meetly.call;
    delete c.status;
    c.emit("status");
  });
  H.ok("…the invitation is still there once the connection is back", await H.until(async () => !(await join.isDisabled()) && (await invitation(vic).count()) === 1, 4000));
  await H.shot(vic, "webinar-device-check-desktop");

  /* on stage */
  await join.click();
  H.ok("Join stage puts them on stage, with the meeting's own controls", await H.until(async () => (await stageScreen(vic).count()) === 1, 10000));
  H.ok("…their microphone and camera come on as checked", await H.until(() => call(vic, () => { const m = window.__meetly.call.localMedia(); return m.microphone && m.camera; }), 10000));
  for (const [name, person] of [["host", host], ["other viewer", wes]]) {
    H.ok(`a speaker tile appears for the ${name}`, await H.until(async () => (await tilesOf(person)).includes(`${vicId}:camera`), 10000));
  }
  H.ok("…and the hand that asked to speak is lowered", await H.until(() => call(vic, () => !window.__meetly.call.local.handRaised), 6000));
  const chip = vic.page.locator("footer").getByRole("button", { name: "Live, on stage. Stage options" });
  H.ok("desktop: ● Live · On stage sits in the control bar's left cluster", (await chip.count()) === 1 && /Live\s*·\s*On stage/.test(await chip.innerText()));
  H.ok("…and the leave button says Leave webinar", (await inCall(vic).getByRole("toolbar", { name: "Webinar controls" }).getByRole("button", { name: "Leave webinar" }).count()) === 1);
  await H.shot(vic, "webinar-on-stage-desktop");

  /* a speaker chats */
  await vic.page.locator("#toggle-chat").click();
  await vic.page.getByRole("textbox", { name: "Message" }).fill("Hello from the stage");
  await vic.page.keyboard.press("Enter");
  H.ok("a speaker can send a message, and everyone sees it", await H.until(() => call(host, () => window.__meetly.call.chatMessages().some((m) => m.message === "Hello from the stage")), 8000));
  await vic.page.getByRole("button", { name: "Close chat" }).click();

  /* back to audience, from the speaker's side */
  await chip.click();
  const back = vic.page.getByRole("menuitem", { name: /Back to audience/ });
  H.ok("the chip's menu says what going back does", /Your camera and microphone turn off\./.test(await back.innerText()));
  await H.shot(vic, "webinar-on-stage-menu-desktop");
  await back.click();
  H.ok("Back to audience (speaker) returns them to the audience's screen", await H.until(async () => (await watchingScreen(vic).count()) === 1, 10000));
  H.ok("…takes away the right to publish", await H.until(async () => (await canPublish(vic)) === false, 6000));
  H.ok("…and their tile goes for everyone", await H.until(async () => !(await tilesOf(host)).some((t) => t.startsWith(vicId)) && !(await tilesOf(wes)).some((t) => t.startsWith(vicId)), 10000));
  H.ok("back in the audience, a forced chat message is refused", (await chatStatus(vic, "still here?")) === 403);

  /* on stage on a phone, and back from the host's side */
  await invite("Wes Watcher");
  await invitation(wes).waitFor({ timeout: 8000 });
  await H.shot(wes, "webinar-invitation-phone");
  await invitation(wes).getByRole("button", { name: "Join stage" }).click();
  await stageScreen(wes).waitFor({ timeout: 10000 });
  H.ok("phone: ● Live · On stage sits in the top bar", await H.until(async () => (await wes.page.locator("header").getByRole("button", { name: "Live, on stage. Stage options" }).count()) === 1, 6000));
  await H.until(async () => (await tilesOf(host)).includes(`${wesId}:camera`), 10000);
  await H.shot(wes, "webinar-on-stage-phone");
  // The host's pointer has rested on the People list since pressing Invite, which holds the list
  // still (listHold.ts). The stage is the host's own doing: Speakers shows it at once, and its
  // count always matches its rows.
  const speakers = H.people(host).getByRole("list", { name: "Participants" });
  H.ok("while the list is held, the host's pointer on it", await H.people(host).locator(".scroll-quiet").first().evaluate((el) => el.matches(":hover")));
  H.ok("…Wes is under Speakers at once", await H.until(async () => (await speakers.getByRole("button", { name: "Host controls for Wes Watcher" }).count()) === 1, 4000));
  const counted = await speakers.evaluate((el) => ({ header: Number(el.querySelector("h3 span")?.textContent), rows: el.querySelectorAll('[role="listitem"]').length }));
  H.ok("…and the Speakers count equals its rows", counted.header === 2 && counted.rows === 2, JSON.stringify(counted));
  H.ok("…with no pill for the host's own change", (await H.people(host).locator("[data-new-pill]").count()) === 0);
  await speakers.getByRole("button", { name: "Host controls for Wes Watcher" }).click();
  await host.page.getByRole("menuitem", { name: "Back to audience" }).click();
  H.ok("Back to audience (host) returns the speaker to the audience", await H.until(async () => (await watchingScreen(wes).count()) === 1, 10000));
  H.ok("…and removes their right to publish", await H.until(async () => (await canPublish(wes)) === false, 6000));

  /* a co-host moderates from the audience */
  // The switch can be over within one look on a fast machine, so the page notes what it showed.
  await call(wes, () => {
    window.__switchShown = [];
    new MutationObserver(() => {
      const shown = document.querySelector("[data-switching]");
      if (shown) window.__switchShown.push(shown.textContent.trim());
    }).observe(document.body, { childList: true, subtree: true });
  });
  await audience.getByRole("button", { name: "Host controls for Wes Watcher" }).click();
  await host.page.getByRole("menuitem", { name: "Make co-host" }).click();
  H.ok(
    "made co-host, the client says Switching to co-host…",
    await H.until(() => call(wes, () => window.__switchShown.includes("Switching to co-host…")), 8000),
    await call(wes, () => window.__switchShown.join()),
  );
  H.ok("…and is back a moment later, still off stage", await H.until(async () => (await wes.page.locator("[data-switching]").count()) === 0 && (await watchingScreen(wes).count()) === 1, 15000));
  H.ok("…as the same person", (await H.identity(wes)) === wesId);
  const peopleButton = wes.page.locator("header").getByRole("button", { name: "People" });
  H.ok("a co-host in the audience has People", await H.until(async () => (await peopleButton.count()) === 1, 6000));
  await peopleButton.click();
  const coAudience = H.people(wes).getByRole("region", { name: "Audience" });
  H.ok("…with the host's Audience section", await H.until(async () => (await coAudience.locator("[data-audience-row]").count()) === 1, 6000));
  await H.shot(wes, "webinar-cohost-audience-phone");
  await coAudience.getByRole("button", { name: "Invite Vic Viewer to speak" }).click();
  H.ok("a co-host can invite a viewer on stage", await H.until(async () => (await invitation(vic).count()) === 1, 8000));
  await invitation(vic).getByRole("button", { name: "Not now" }).click();
  await H.people(wes).getByRole("button", { name: "More actions for everyone" }).click();
  H.ok("a co-host cannot end the webinar: nothing offers it", (await wes.page.getByRole("menuitem", { name: /End webinar/ }).count()) === 0);
  await wes.page.keyboard.press("Escape");
  H.ok("…and the server refuses it", (await H.hostApi(wes, { token: wes.token, action: "end" })) === 403);
  await H.closePeople(wes);
  await wes.page.getByRole("button", { name: /^Chat/ }).click();
  H.ok("a co-host can write in the chat", (await wes.page.getByRole("textbox", { name: "Message" }).count()) === 1);
  await wes.page.getByRole("button", { name: "Close chat" }).click();

  /* every place a webinar is named */
  await host.page.getByRole("button", { name: "More ways to leave" }).click();
  const leaveMenu = await host.page.getByRole("menu").innerText();
  H.ok("the host's leave menu: Leave webinar, End webinar for everyone", /Leave webinar/.test(leaveMenu) && /End webinar for everyone/.test(leaveMenu), leaveMenu.replace(/\s+/g, " "));
  await host.page.keyboard.press("Escape");
  await H.people(host).getByRole("button", { name: "More actions for everyone" }).click();
  H.ok("People's menu: End webinar for everyone", (await host.page.getByRole("menuitem", { name: "End webinar for everyone" }).count()) === 1);
  await host.page.keyboard.press("Escape");
  H.ok("People: Copy webinar link", (await H.people(host).getByText("Copy webinar link").count()) === 1);

  /* who left: speakers and co-hosts, never the audience */
  const leftSection = H.people(host).getByRole("region", { name: "Left the webinar" });
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
        window.__crowdSeq = 0;
      }
      for (let i = 0; i < count; i++) {
        const n = window.__crowdSeq++;
        const person = { identity: `crowd-${n}`, isLocal: false, name: role === "viewer" ? `Watcher ${n}` : `Speaker ${n}`, role, stageInvite: false, micOn: false, camOn: false, handRaised: false, speaking: false, weakConnection: false, subscribe: () => () => {} };
        window.__crowd.set(person.identity, person);
        window.__crowdChanged();
        c.emit("participantJoined", person);
      }
    }, { count: n, role });
  const crowdLeaves = () =>
    call(host, () => {
      const c = window.__meetly.call;
      for (const person of Array.from(window.__crowd.values())) {
        window.__crowd.delete(person.identity);
        window.__crowdChanged();
        c.emit("participantLeft", person);
      }
    });
  await crowd(50);
  await crowdLeaves();
  await H.sleep(800);
  H.ok("50 viewers leaving add no rows to Left the webinar", (await leftSection.count()) === 0);
  await H.closePeople(host);
  // A real speaker leaving: Vic, brought on stage and leaving from there.
  await H.openPeople(host);
  await invite("Vic Viewer");
  await invitation(vic).getByRole("button", { name: "Join stage" }).click();
  await stageScreen(vic).waitFor({ timeout: 10000 });
  await H.until(async () => (await tilesOf(host)).includes(`${vicId}:camera`), 10000);
  await inCall(vic).getByRole("toolbar", { name: "Webinar controls" }).getByRole("button", { name: "Leave webinar" }).click();
  H.ok("the leave screen: You left the webinar", await H.until(async () => (await vic.page.getByRole("heading", { name: "You left the webinar" }).count()) === 1, 8000));
  H.ok("…The webinar stays open for others until everyone has left.", (await vic.page.getByText("The webinar stays open for others until everyone has left.").count()) === 1);
  await H.shot(vic, "webinar-left-desktop");
  H.ok("one speaker leaving adds one row: Left the webinar 1", await H.until(async () => (await leftSection.count()) === 1 && /left the webinar\s*1/i.test(await leftSection.innerText()), 8000));

  /* 300 people watching: no notices, no sounds, a windowed list */
  await H.closePeople(host);
  await crowd(1, "speaker");
  H.ok("(control) someone joining the stage is announced", await H.until(() => call(host, () => document.querySelectorAll('.toast-region [data-priority="presence"]').length > 0), 4000));
  await crowdLeaves();
  await H.sleep(1000);
  await host.page.getByRole("button", { name: "Dismiss notification" }).evaluateAll((buttons) => buttons.forEach((b) => b.click()));
  await H.until(() => call(host, () => document.querySelectorAll('.toast-region [data-priority="presence"]').length === 0), 8000);
  const count = () =>
    call(host, () => ({
      toasts: document.querySelectorAll('.toast-region [data-priority="presence"]').length,
      sounds: (window.__meetlySounds?.log || []).filter((s) => s.name === "joined" || s.name === "left").length,
    }));
  const before = await count();
  await crowd(5);
  await H.sleep(1200);
  await crowd(294);
  await H.sleep(1500);
  const after = await count();
  H.ok("300 people watching: no join notices", after.toasts === before.toasts, JSON.stringify({ before, after }));
  H.ok("…and no join sounds", after.sounds === before.sounds, JSON.stringify({ before, after }));
  await H.openPeople(host);
  H.ok("the host sees Audience 300", await H.until(async () => /^audience\s*300$/i.test(await heading(audience)), 6000));
  await audience.getByRole("button", { name: "See all 300 in the audience" }).click();
  const list = H.people(host).locator("[data-audience-list]");
  await list.waitFor({ timeout: 5000 });
  const rows = await list.locator("li").count();
  H.ok("the full audience list draws only the rows in view", rows > 0 && rows < 40, `${rows} of 300 drawn`);
  await H.people(host).getByLabel("Search the audience").fill("Watcher 29");
  // The audience is Watcher 51 to 349: "Watcher 29" is 290 to 299.
  H.ok("…and is searchable", await H.until(async () => (await list.locator("li").count()) === 10, 4000), `${await list.locator("li").count()} matches`);
  await H.shot(host, "webinar-host-audience-all-desktop");
  await H.people(host).getByRole("button", { name: "Back to everyone" }).click();

  /* ending it */
  await host.page.getByRole("button", { name: "More ways to leave" }).click();
  await host.page.getByRole("menuitem", { name: "End webinar for everyone" }).click();
  const dialog = host.page.getByRole("dialog", { name: "End webinar for everyone?" });
  H.ok("the end dialog: End webinar for everyone?", (await dialog.count()) === 1);
  await dialog.getByRole("button", { name: "End webinar for everyone" }).click();
  H.ok("the host: You ended the webinar", await H.until(async () => (await host.page.getByRole("heading", { name: "You ended the webinar" }).count()) === 1, 10000));
  H.ok("the audience: The host ended the webinar", await H.until(async () => (await wes.page.getByRole("heading", { name: "The host ended the webinar" }).count()) === 1, 10000));
  await H.shot(wes, "webinar-ended-phone");

  await Promise.all([host, vic, wes].map((person) => person.ctx.close()));
};
