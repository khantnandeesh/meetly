// Feature 8: the mini window (Document Picture-in-Picture). Opens from More, the main tile and
// Shift+P; shows the right person; its controls work; closing it returns to the tab; the call
// goes on throughout; and where the browser has no such window, nothing offers one.
const H = require("./lib.cjs");

const MINI = { width: 360, height: 300 };

async function openMore(person) {
  await person.page.getByRole("button", { name: "More options" }).click();
  await person.page.getByRole("menu").waitFor();
}
const escape = async (person) => {
  await person.page.keyboard.press("Escape");
  await person.page.getByRole("menu").waitFor({ state: "detached" }).catch(() => {});
};
/** Does `act` and returns the mini window it opened, as a page of its own. */
async function opening(person, act) {
  const [mini] = await Promise.all([person.ctx.waitForEvent("page", { timeout: 8000 }), act()]);
  // Headless Chromium opens it at the size of a tab; a real one honours the size asked for.
  await mini.setViewportSize(MINI).catch(() => {});
  await mini.locator("[data-mini-window]").waitFor({ timeout: 8000 });
  return mini;
}
const openFromMore = (person) =>
  opening(person, async () => {
    await openMore(person);
    await person.page.getByRole("menuitem", { name: /Open mini window/ }).click();
  });
const showing = (mini) => mini.locator("[data-mini-showing]").getAttribute("data-mini-showing", { timeout: 3000 }).catch(() => null);
const placeholder = (person) => person.page.locator("[data-mini-placeholder]");
const status = (person) => person.page.evaluate(() => window.__meetly.call.status);
const media = (person) => person.page.evaluate(() => window.__meetly.call.localMedia());
const playing = (page, selector) => page.evaluate((s) => Array.from(document.querySelectorAll(s)).filter((v) => v.videoWidth > 0 && !v.paused).length, selector);
/** Screen sharing without a picker: the fake camera stands in for a screen. */
const fakeScreen = (person) =>
  person.page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = () => navigator.mediaDevices.getUserMedia({ video: true });
  });
const closed = (mini) => H.until(() => mini.isClosed(), 5000);

module.exports = async function miniSuite(browser) {
  console.log("\n— mini window: opens, shows the right person, controls, closing, where it is absent —");
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser);
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Lovelace");
  await H.join(ben, url, "Ben Okri");
  const benId = await H.identity(ben);
  const adaId = await H.identity(ada);
  await H.sleep(1500);

  H.ok("this Chromium has Document Picture-in-Picture", await ada.page.evaluate(() => "documentPictureInPicture" in window), browser.version());
  await openMore(ada);
  H.ok("More offers \"Open mini window\" with its shortcut", /Open mini window/.test(await ada.page.getByRole("menu").innerText()) && /⇧P/.test(await ada.page.getByRole("menuitem", { name: /Open mini window/ }).innerText()));
  await H.shot(ada, "mini-more-menu-desktop");
  await escape(ada);

  /* ------------------------------------------------------------------ opening it */
  let mini = await openFromMore(ada);
  H.ok("it opens as a window of its own", ada.ctx.pages().length === 2 && (await ada.page.evaluate(() => !!window.documentPictureInPicture.window)));
  await H.sleep(500);
  const look = await mini.evaluate(() => {
    const button = document.querySelector('[aria-label="Leave meeting"]');
    return {
      sheets: document.querySelectorAll('link[rel="stylesheet"], style').length,
      body: getComputedStyle(document.body).backgroundColor,
      buttonHeight: button.getBoundingClientRect().height,
      buttonColour: getComputedStyle(button).backgroundColor,
      font: getComputedStyle(document.body).fontFamily.split(",")[0],
      overflow: document.documentElement.scrollWidth > window.innerWidth || document.documentElement.scrollHeight > window.innerHeight,
    };
  });
  H.ok("it carries the app's styles: tokens, fonts, control sizes", look.sheets > 0 && look.body === "rgb(11, 11, 15)" && look.buttonHeight === 48 && look.buttonColour === "rgb(229, 72, 77)" && /Inter/.test(look.font), JSON.stringify(look));
  H.ok(`at ${MINI.width} × ${MINI.height} nothing overflows`, !look.overflow);
  H.ok("it has microphone, camera, back and leave", (await mini.getByRole("toolbar").getByRole("button").count()) === 4 && (await mini.getByRole("button", { name: "Mute microphone" }).count()) === 1 && (await mini.getByRole("button", { name: "Turn off camera" }).count()) === 1 && (await mini.getByRole("button", { name: "Leave meeting" }).count()) === 1 && (await mini.getByRole("button", { name: "Close mini window" }).count()) === 1);
  H.ok("it shows the other person (the stage's main picture), not you", (await showing(mini)) === `${benId}:camera`, await showing(mini));
  H.ok("with their name", /Ben Okri/.test(await mini.locator("[data-mini-showing]").innerText()));
  H.ok("their picture is playing in it", await H.until(async () => (await playing(mini, "video")) === 1, 8000));
  const there = { count: await placeholder(ada).count(), text: await placeholder(ada).textContent().catch(() => ""), button: await placeholder(ada).locator("button").count() };
  H.ok("the tab says where the call went, and offers the way back", there.count === 1 && /The meeting is in a mini window/.test(there.text) && /Close mini window/.test(there.text) && there.button === 1, JSON.stringify(there));
  H.ok("the tab is not drawing the same pictures a second time", (await ada.page.locator("[data-tile]").count()) === 0);
  await H.shot(ada, "mini-placeholder-desktop");
  await mini.screenshot({ path: process.env.MEETLY_SHOTS ? `${process.env.MEETLY_SHOTS}/mini-window.png` : undefined }).catch(() => {});
  await openMore(ada);
  H.ok("More now offers to close it", (await ada.page.getByRole("menuitem", { name: /Close mini window/ }).count()) === 1);
  await escape(ada);

  /* ---------------------------------------------------------------- its controls */
  await mini.getByRole("button", { name: "Mute microphone" }).click();
  H.ok("its microphone button mutes you", (await H.until(async () => (await media(ada)).microphone === false, 5000)) && (await mini.getByRole("button", { name: "Unmute microphone" }).count()) === 1);
  H.ok("and the other person sees you muted", await H.until(async () => (await ben.page.evaluate((id) => window.__meetly.call.participant(id).micOn, adaId)) === false, 5000));
  await mini.getByRole("button", { name: "Unmute microphone" }).click();
  H.ok("and unmutes you", await H.until(async () => (await media(ada)).microphone === true, 5000));
  await mini.getByRole("button", { name: "Turn off camera" }).click();
  H.ok("its camera button turns your camera off", (await H.until(async () => (await media(ada)).camera === false, 5000)) && (await H.until(async () => (await ben.page.evaluate((id) => window.__meetly.call.participant(id).camOn, adaId)) === false, 5000)));
  await mini.getByRole("button", { name: "Turn on camera" }).click();
  H.ok("and on again", await H.until(async () => (await media(ada)).camera === true, 8000));

  /* -------------------------------------------------------- who it shows, and when */
  const cy = await H.client(browser);
  await H.join(cy, url, "Cy Twombly");
  const cyId = await H.identity(cy);
  // Everyone but Cy goes quiet: Cy is then the active speaker (fake microphones beep).
  await ben.page.keyboard.press("m");
  await mini.getByRole("button", { name: "Mute microphone" }).click();
  // A fake microphone only beeps, too briefly to count as talking. So LiveKit's "who is speaking"
  // is given to Ada's client as the server would send it, for a few seconds: Cy, and only Cy.
  await ada.page.evaluate((id) => {
    const room = window.__meetly.room;
    const speaker = room.remoteParticipants.get(id);
    let left = 30;
    const say = () => {
      room.activeSpeakers = [speaker];
      speaker.setIsSpeaking(true);
      room.emit("activeSpeakersChanged", [speaker]);
      if (--left <= 0) clearInterval(timer);
    };
    const timer = setInterval(say, 200);
    say();
  }, cyId);
  H.ok("it follows the active speaker",await H.until(async () => (await showing(mini)) === `${cyId}:camera`, 15000), `${await showing(mini)} (Cy is ${cyId})`);
  H.ok("and marks them as speaking", await H.until(async () => (await mini.locator("[data-mini-showing]").getAttribute("data-speaking")) === "true", 8000));
  await fakeScreen(ben);
  await ben.page.getByRole("button", { name: "Share screen" }).click();
  H.ok("a shared screen takes it over", await H.until(async () => (await showing(mini)) === `${benId}:screen_share`, 10000), await showing(mini));
  H.ok("the shared screen is playing, whole (not cropped)", (await H.until(async () => (await playing(mini, "video")) === 1, 8000)) && (await mini.evaluate(() => getComputedStyle(document.querySelector("video")).objectFit)) === "contain");
  await mini.screenshot({ path: process.env.MEETLY_SHOTS ? `${process.env.MEETLY_SHOTS}/mini-window-share.png` : undefined }).catch(() => {});
  await ben.page.getByRole("toolbar", { name: "Meeting controls" }).getByRole("button", { name: "Stop sharing" }).click();
  await H.until(async () => (await showing(mini)) !== `${benId}:screen_share`, 8000);

  /* ------------------------------------------------- the call goes on throughout */
  H.ok("the call never dropped", (await status(ada)) === "connected" && (await ada.page.evaluate(() => window.__meetly.room.remoteParticipants.size)) === 2);
  H.ok("sound is still arriving from everyone", await ada.page.evaluate(() => Array.from(window.__meetly.room.remoteParticipants.values()).every((p) => Array.from(p.audioTrackPublications.values()).every((pub) => pub.isSubscribed && pub.track && pub.track.attachedElements.length > 0))));

  /* ------------------------------------------------------------------ closing it */
  await mini.getByRole("button", { name: "Close mini window" }).click();
  H.ok("\"Close mini window\" closes it", await closed(mini));
  H.ok("and the stage is back in the tab, pictures playing", (await H.until(async () => (await placeholder(ada).count()) === 0 && (await ada.page.locator("[data-tile]").count()) === 3, 5000)) && (await H.until(async () => (await playing(ada.page, "[data-tile] video")) >= 2, 8000)));
  H.ok("still in the call", (await status(ada)) === "connected");

  mini = await opening(ada, () => ada.page.keyboard.press("Shift+P"));
  H.ok("Shift+P opens it", (await placeholder(ada).count()) === 1);
  H.ok("Shift+P did not also toggle People (plain P)", (await H.people(ada).count()) === 0);
  await mini.close();
  H.ok("closing the window itself returns to the tab, and the call goes on", (await H.until(async () => (await placeholder(ada).count()) === 0 && (await ada.page.locator("[data-tile]").count()) === 3, 5000)) && (await status(ada)) === "connected");
  mini = await opening(ada, () => ada.page.keyboard.press("Shift+P"));
  await ada.page.keyboard.press("Shift+P");
  H.ok("Shift+P closes it again", await closed(mini));
  mini = await openFromMore(ada);
  await placeholder(ada).getByRole("button", { name: "Close mini window" }).click();
  H.ok("\"Close mini window\" in the tab closes it", (await closed(mini)) && (await H.until(async () => (await placeholder(ada).count()) === 0, 3000)));

  /* --------------------------------------------------------------- the main tile */
  await ben.page.getByRole("button", { name: "Share screen" }).click();
  const mainTile = ada.page.locator('[data-tile][data-slot="main"]');
  await mainTile.waitFor({ timeout: 10000 });
  await mainTile.hover();
  H.ok("the main tile offers it among its actions", (await mainTile.getByRole("button", { name: "Open mini window" }).count()) === 1);
  H.ok("other tiles do not", (await ada.page.locator('[data-tile]:not([data-slot="main"])').getByRole("button", { name: "Open mini window" }).count()) === 0);
  await H.shot(ada, "mini-tile-action-desktop");
  mini = await opening(ada, () => mainTile.getByRole("button", { name: "Open mini window" }).click());
  H.ok("and opens it, on the shared screen", (await showing(mini)) === `${benId}:screen_share`);
  await ben.page.getByRole("toolbar", { name: "Meeting controls" }).getByRole("button", { name: "Stop sharing" }).click();

  /* ------------------------------------------------------- presenting yourself */
  await fakeScreen(ada);
  await placeholder(ada).getByText("Open it when I share my screen").click();
  H.ok("the opt-in to open it when presenting is remembered", (await ada.page.evaluate(() => JSON.parse(localStorage.getItem("meetly:call-settings")).miniOnShare)) === true);
  await placeholder(ada).getByRole("button", { name: "Close mini window" }).click();
  await closed(mini);
  mini = await opening(ada, () => ada.page.getByRole("button", { name: "Share screen" }).click());
  H.ok("opted in, starting to present opens it (here: no picker to wait for, see the report)", (await media(ada)).screenShare === true);
  const own = await showing(mini);
  H.ok("your own shared screen is never what it shows you", !!own && own !== `${adaId}:screen_share` && !own.startsWith(adaId), own);
  await mini.getByRole("button", { name: "Close mini window" }).click();
  await closed(mini);
  await ada.page.getByRole("toolbar", { name: "Meeting controls" }).getByRole("button", { name: "Stop sharing" }).click();

  /* -------------------------------------------------------------------- leaving */
  mini = await openFromMore(ada);
  await mini.getByRole("button", { name: "Leave meeting" }).click();
  H.ok("its leave button leaves the call", await H.until(async () => (await ada.page.getByText("You left the meeting").count()) === 1, 8000));
  H.ok("and takes the mini window with it", await closed(mini));
  H.ok("the others stay in their call", (await status(ben)) === "connected" && (await H.until(async () => (await ben.page.evaluate(() => window.__meetly.room.remoteParticipants.size)) === 1, 8000)));

  /* ----------------------------------------------------- where there is no such window */
  const plain = await H.client(browser);
  await plain.ctx.addInitScript(() => {
    // What Firefox and Safari look like to the page.
    Object.defineProperty(window, "documentPictureInPicture", { value: undefined, configurable: true });
  });
  await H.join(plain, url, "Fay Firefox");
  await openMore(plain);
  H.ok("without Document Picture-in-Picture, More does not offer a mini window", !/mini window/i.test(await plain.page.getByRole("menu").innerText()));
  await escape(plain);
  await fakeScreen(ben);
  await ben.page.getByRole("button", { name: "Share screen" }).click();
  const plainMain = plain.page.locator('[data-tile][data-slot="main"]');
  await plainMain.waitFor({ timeout: 10000 });
  await plainMain.hover();
  H.ok("nor does the main tile", (await plain.page.getByRole("button", { name: /mini window/i }).count()) === 0);
  await plain.page.keyboard.press("Shift+P");
  await H.sleep(500);
  H.ok("Shift+P does nothing there: no window, no placeholder, no panel", plain.ctx.pages().length === 1 && (await placeholder(plain).count()) === 0 && (await H.people(plain).count()) === 0);
  await plain.page.keyboard.press("?");
  const keys = plain.page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await keys.waitFor();
  H.ok("and the shortcut list does not mention it", !/mini window/i.test(await keys.innerText()));
  await plain.page.keyboard.press("Escape");
  await ben.page.keyboard.press("?");
  const benKeys = ben.page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await benKeys.waitFor();
  H.ok("where it exists, the shortcut list has it", /Shift P/.test(await benKeys.innerText()) && /mini window/.test(await benKeys.innerText()));
  await ben.page.keyboard.press("Escape");

  const phone = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await H.join(phone, url, "Pia Phone");
  await openMore(phone);
  H.ok("at phone width it is absent, even in a browser that has the window", !/mini window/i.test(await phone.page.getByRole("menu").innerText()) && (await phone.page.evaluate(() => "documentPictureInPicture" in window)));
  await escape(phone);
  H.ok("and no tile offers it", (await phone.page.getByRole("button", { name: /mini window/i }).count()) === 0 && (await H.noOverflow(phone)));

  for (const person of [ada, ben, cy, plain, phone]) await person.ctx.close();
};
