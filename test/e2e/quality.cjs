// Feature 10: telling people when their own connection is the problem (once), and "use less
// data", measured with getStats before and after.
const H = require("./lib.cjs");

/** Keeps every RTCPeerConnection the page makes, so a test can read its statistics. */
const KEEP_CONNECTIONS = () => {
  window.__pcs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      window.__pcs.push(this);
    }
  };
};

/** Video sent and received by this page over `ms`: bits a second, and the largest picture sent. */
async function measure(person, ms = 5000) {
  const sample = () =>
    person.page.evaluate(async () => {
      const out = { sent: 0, received: 0, width: 0, height: 0, fps: 0, layers: [] };
      for (const pc of window.__pcs) {
        if (pc.connectionState === "closed") continue;
        (await pc.getStats()).forEach((s) => {
          if (s.type === "outbound-rtp" && s.kind === "video") {
            out.sent += s.bytesSent || 0;
            if (s.frameWidth && s.framesPerSecond) out.layers.push(`${s.frameWidth}x${s.frameHeight}@${Math.round(s.framesPerSecond)}`);
            if ((s.frameWidth || 0) > out.width && s.framesPerSecond) {
              out.width = s.frameWidth;
              out.height = s.frameHeight;
              out.fps = s.framesPerSecond;
            }
          }
          if (s.type === "inbound-rtp" && s.kind === "video") out.received += s.bytesReceived || 0;
        });
      }
      return out;
    });
  const a = await sample();
  await H.sleep(ms);
  const b = await sample();
  const kbps = (bytes) => Math.round((bytes * 8) / ms);
  return { sentKbps: kbps(b.sent - a.sent), receivedKbps: kbps(b.received - a.received), width: b.width, height: b.height, fps: Math.round(b.fps), layers: b.layers.join(" ") };
}

/** LiveKit's own numbering of connection quality, as its server sends it. */
const POOR = 0;
const EXCELLENT = 2;
/**
 * Tells the page's LiveKit participant what the server would tell it about its connection, and
 * holds it there: what the real server says meanwhile (this connection is fine) is set aside.
 * This drives the adapter from the SDK's event upward; it is not a bad network.
 */
const hold = (person, quality) =>
  person.page.evaluate((q) => {
    const me = window.__meetly.room.localParticipant;
    if (!me.__say) {
      me.__say = me.setConnectionQuality.bind(me);
      me.setConnectionQuality = () => {};
    }
    me.__say(q);
  }, quality);
const notice = (person) => person.page.locator("[data-weak-connection]:not([data-leaving='true'])");
const connection = (person) => person.page.evaluate(() => window.__meetly.call.quality().connection);

async function openMore(person) {
  await person.page.getByRole("button", { name: "More options" }).click();
  await person.page.getByRole("menu").waitFor();
}
const saverItem = (person) => person.page.getByRole("menuitemcheckbox", { name: /Use less data/ });
const escape = async (person) => {
  await person.page.keyboard.press("Escape");
  await person.page.getByRole("menu").waitFor({ state: "detached" }).catch(() => {});
};
const videosShown = (person) =>
  person.page.evaluate(() => Array.from(document.querySelectorAll("[data-tile] video")).filter((v) => v.videoWidth > 0 && !v.paused).length);

module.exports = async function quality(browser) {
  console.log("\n— call quality: one notice for a weak connection, and using less data —");
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser, { scale: 2 });
  const cy = await H.client(browser);
  for (const person of [ada, ben, cy]) await person.ctx.addInitScript(KEEP_CONNECTIONS);
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Lovelace");
  await H.join(ben, url, "Ben Okri");
  await H.join(cy, url, "Cy Twombly");

  /* ------------------------------------------------------------- the weak notice */
  H.ok("LiveKit rates the connection once in the call", await H.until(async () => ["good", "fair"].includes(await connection(ben)), 15000), await connection(ben));
  H.ok("a healthy connection shows no notice", (await notice(ben).count()) === 0);
  await hold(ben, POOR);
  const t0 = Date.now();
  H.ok("the adapter reports the connection as poor", await H.until(async () => (await connection(ben)) === "poor", 3000), await connection(ben));
  await H.sleep(6000);
  H.ok("a connection that has been poor for 6 s has not been mentioned yet", (await notice(ben).count()) === 0);
  await notice(ben).waitFor({ timeout: 9000 });
  const after = Date.now() - t0;
  H.ok("after about 10 s of it, one notice appears", after >= 9000 && after <= 14000, `${after} ms`);
  H.ok("it is the only signal: one chip, no notification", (await notice(ben).count()) === 1 && (await ben.page.locator("[data-toast]").count()) === 0);
  H.ok("it says whose connection, and offers the one switch that helps", /Your connection is weak/.test(await notice(ben).innerText()) && (await notice(ben).getByRole("button", { name: "Use less data" }).count()) === 1);
  H.ok("nobody else is shown it", (await notice(ada).count()) === 0 && (await notice(cy).count()) === 0);
  await H.shot(ben, "quality-notice-desktop");
  await H.sleep(8000);
  H.ok("while the connection stays poor it stays one notice, not a new one every few seconds", (await notice(ben).count()) === 1 && (await ben.page.locator("[data-toast]").count()) === 0);
  await hold(ben, EXCELLENT);
  const t1 = Date.now();
  await notice(ben).waitFor({ state: "detached", timeout: 12000 });
  H.ok("when the connection recovers the notice goes by itself, a few seconds later", Date.now() - t1 >= 4000, `${Date.now() - t1} ms`);
  await hold(ben, POOR);
  await H.sleep(14000);
  H.ok("a relapse straight afterwards is not announced again", (await notice(ben).count()) === 0 && (await connection(ben)) === "poor");
  await hold(ben, EXCELLENT);

  // Dismissing it.
  await hold(cy, POOR);
  await notice(cy).waitFor({ timeout: 16000 });
  await notice(cy).getByRole("button", { name: "Dismiss" }).click();
  await notice(cy).waitFor({ state: "detached", timeout: 3000 });
  await H.sleep(13000);
  H.ok("dismissed, it stays away although the connection is still poor", (await notice(cy).count()) === 0 && (await connection(cy)) === "poor");
  H.ok("the person's own tile still marks the weak connection, quietly", (await cy.page.locator('[data-tile][data-mirror="true"] .lucide-signal-low').count()) === 1);
  await hold(cy, EXCELLENT);

  /* ---------------------------------------------------------- the quality dialog */
  await openMore(ada);
  await ada.page.getByRole("menuitem", { name: "Connection quality…" }).click();
  const dialog = ada.page.locator("[data-call-quality]");
  await dialog.waitFor();
  H.ok("\"Connection quality\" says how the connection is in a word", await H.until(async () => /^(Good|Fair)$/.test((await dialog.locator("[data-connection] span").nth(1).innerText()).trim()), 8000), await dialog.locator("[data-connection]").innerText());
  H.ok("and shows what is being sent and received", await H.until(async () => /\d+ (kbps|Mbps)/.test(await dialog.innerText()) && /\d+ × \d+/.test(await dialog.innerText()), 8000), (await dialog.locator("dl").innerText()).replace(/\n+/g, " | "));
  await H.shot(ada, "quality-dialog-desktop");
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });

  /* --------------------------------------------------------------- use less data */
  await H.sleep(3000);
  H.ok("with three people, everyone's camera is on the stage", await H.until(async () => (await videosShown(ada)) === 3, 10000), String(await videosShown(ada)));
  const before = await measure(ada);
  H.ok("\"use less data\" is off until someone turns it on", (await ada.page.evaluate(() => window.__meetly.call.quality().dataSaver)) === false && (await ada.page.locator("[data-saver-badge]").count()) === 0);
  await openMore(ada);
  await saverItem(ada).click();
  H.ok("the switch in More shows it on", (await saverItem(ada).getAttribute("aria-checked")) === "true");
  await H.shot(ada, "quality-more-menu-desktop");
  await escape(ada);
  H.ok("the bar says it is on, for as long as it is", (await ada.page.locator("[data-saver-badge]").count()) === 1);
  H.ok("only the main picture and your own are shown; the other person is their avatar", await H.until(async () => (await videosShown(ada)) === 2, 8000), String(await videosShown(ada)));
  await H.sleep(7000);
  await H.shot(ada, "quality-less-data-desktop");
  const during = await measure(ada);
  console.log(`      before: ${JSON.stringify(before)}\n      during: ${JSON.stringify(during)}`);
  H.ok("the camera is sent smaller", during.width <= 320 && during.width < before.width, `${before.width}x${before.height} → ${during.width}x${during.height}`);
  H.ok("video sent drops to under 60% of what it was", during.sentKbps < before.sentKbps * 0.6, `${before.sentKbps} → ${during.sentKbps} kbps`);
  H.ok("video received drops to under 70% of what it was", during.receivedKbps < before.receivedKbps * 0.7, `${before.receivedKbps} → ${during.receivedKbps} kbps`);
  H.ok("the others still see the person who is saving data", (await ben.page.evaluate(() => Array.from(document.querySelectorAll("[data-tile] video")).filter((v) => v.videoWidth > 0).length)) === 3);
  H.ok("sound is not touched: everyone's microphone is still subscribed", (await ada.page.evaluate(() => Array.from(window.__meetly.room.remoteParticipants.values()).every((p) => Array.from(p.audioTrackPublications.values()).every((pub) => pub.isSubscribed)))) === true);

  await ada.page.locator("[data-saver-badge]").click();
  await dialog.waitFor();
  H.ok("the badge opens call quality, where the same switch is on", await dialog.getByRole("switch", { name: /Use less data/ }).isChecked());
  await dialog.getByText("Use less data", { exact: true }).click();
  await dialog.getByRole("button", { name: "Close" }).click();
  H.ok("switched off, the badge goes and the pictures come back", (await H.until(async () => (await ada.page.locator("[data-saver-badge]").count()) === 0, 3000)) && (await H.until(async () => (await videosShown(ada)) === 3, 8000)));
  await H.sleep(8000);
  const restored = await measure(ada);
  console.log(`      after:  ${JSON.stringify(restored)}`);
  H.ok("and the camera goes back to what it was", restored.width === before.width && restored.sentKbps > during.sentKbps * 1.5 && restored.receivedKbps > during.receivedKbps * 1.2, `${restored.width}x${restored.height}, sent ${restored.sentKbps} kbps, received ${restored.receivedKbps} kbps`);

  /* ----------------------------------------------------------------------- phone */
  const phone = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await H.join(phone, url, "Pia Phone");
  await hold(phone, POOR);
  await notice(phone).waitFor({ timeout: 16000 });
  const box = await notice(phone).boundingBox();
  H.ok("on a 390 px phone the notice fits, with its action and its dismiss within reach", box.x >= 0 && box.x + box.width <= H.PHONE.width && (await H.noOverflow(phone)) && (await notice(phone).getByRole("button", { name: "Use less data" }).boundingBox()).height >= 44, JSON.stringify(box));
  await H.shot(phone, "quality-notice-phone");
  await notice(phone).getByRole("button", { name: "Use less data" }).tap();
  H.ok("the notice's action turns it on, and the notice then says so", await H.until(async () => (await phone.page.evaluate(() => window.__meetly.call.quality().dataSaver)) === true && /Using less data/.test(await notice(phone).innerText()), 3000));
  H.ok("the phone's top bar shows it is on", (await phone.page.locator("header [data-saver-badge]").count()) === 1 && (await H.noOverflow(phone)));
  await hold(phone, EXCELLENT);
  await openMore(phone);
  H.ok("More on a phone has the switch and connection quality", (await saverItem(phone).count()) === 1 && (await phone.page.getByRole("menuitem", { name: "Connection quality…" }).count()) === 1);
  await phone.page.getByRole("menuitem", { name: "Connection quality…" }).tap();
  await phone.page.locator("[data-call-quality]").waitFor();
  H.ok("the call quality dialog fits a 390 px phone", await H.noOverflow(phone));
  await H.shot(phone, "quality-dialog-phone");

  for (const person of [ada, ben, cy, phone]) await person.ctx.close();
};
