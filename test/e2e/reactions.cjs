// Feature 2: emoji reactions.
const H = require("./lib.cjs");

/** Counts the reactions a client is told about, split by sender name, from now on. */
const watch = (person) =>
  person.page.evaluate(() => {
    window.__seen = [];
    if (window.__watching) return;
    window.__watching = true;
    window.__meetly.call.on("reaction", (who, emoji) => window.__seen.push({ name: who.name, emoji }));
  });
const seen = (person) => person.page.evaluate(() => window.__seen.slice());
const badgeOn = (person, name, emoji) =>
  person.page.locator("[data-tile]").filter({ hasText: name }).locator(`[data-tile-reaction="${emoji}"]`);
const soundsPlayed = (person) =>
  person.page.evaluate(() => (window.__meetlySounds ? window.__meetlySounds.log.filter((entry) => entry.outcome === "played").length : 0));

module.exports = async function reactions(browser) {
  console.log("\n— emoji reactions —");
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser);
  const cy = await H.client(browser);
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Lovelace");
  await H.join(ben, url, "Ben Okri");
  await H.join(cy, url, "Cy Twombly");
  await ada.page.waitForFunction(() => document.querySelectorAll("[data-tile]").length === 3, null, { timeout: 20000 });
  await H.sleep(2800); // past the settle window, so a sound would be heard if one were made
  for (const person of [ada, ben, cy]) await watch(person);

  // The strip, and a reaction reaching everyone on the sender's tile.
  await ben.page.getByRole("button", { name: "React", exact: true }).click();
  await ben.page.locator("[data-reactions]").waitFor();
  H.ok("the strip offers six reactions", (await ben.page.locator("[data-reactions]").getByRole("menuitem").count()) === 6);
  await H.shot(ben, "reactions-strip-desktop-guest");
  const toastsBefore = await ada.page.locator("[data-toast]").count();
  const soundsBefore = await soundsPlayed(ada);
  await ben.page.getByRole("menuitem", { name: "Clapping" }).click();
  await badgeOn(ada, "Ben Okri", "👏").waitFor({ timeout: 5000 }).catch(() => {});
  H.ok("a reaction shows on the sender's tile for someone else", (await badgeOn(ada, "Ben Okri", "👏").count()) === 1);
  H.ok("…and for a third person", await H.until(async () => (await badgeOn(cy, "Ben Okri", "👏").count()) === 1, 4000));
  H.ok("…and on the sender's own tile", (await badgeOn(ben, "Ben Okri", "👏").count()) === 1);
  H.ok("the strip stays open for another", (await ben.page.locator("[data-reactions]").count()) === 1);
  await H.shot(ada, "reactions-tile-desktop");
  H.ok("a visible reaction uses the tile only: nothing in the lane", (await ada.page.locator("[data-reaction-lane]").count()) === 0);
  await H.sleep(600);
  H.ok(
    "a reaction raises no toast and makes no sound",
    (await ada.page.locator("[data-toast]").count()) === toastsBefore && (await soundsPlayed(ada)) === soundsBefore,
  );
  H.ok("the reaction leaves the tile again", await H.until(async () => (await badgeOn(ada, "Ben Okri", "👏").count()) === 0, 6000));
  await ben.page.keyboard.press("Escape");

  // Keyboard: R opens the strip, a digit sends.
  await ada.page.mouse.click(640, 300);
  await ada.page.keyboard.press("r");
  await ada.page.locator("[data-reactions]").waitFor({ timeout: 3000 }).catch(() => {});
  await ada.page.keyboard.press("2");
  H.ok("R then 2 sends a heart", await H.until(async () => (await badgeOn(ben, "Ada Lovelace", "❤️").count()) === 1, 4000));
  await H.shot(ada, "reactions-strip-desktop");
  await ada.page.keyboard.press("Escape");
  await H.sleep(3600);

  // Rate limit, sender side: ten sends in a burst through the app's own call object.
  for (const person of [ada, ben, cy]) await watch(person);
  await ben.page.evaluate(async () => {
    for (let i = 0; i < 10; i++) {
      void window.__meetly.call.sendReaction("🎉");
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  });
  await H.sleep(1200);
  const burst = (await seen(ada)).filter((entry) => entry.name === "Ben Okri").length;
  H.ok("ten sends in 0.6 s arrive as one or two (one per 400 ms)", burst >= 1 && burst <= 2, `received ${burst}`);

  // Rate limit, receiver side: a client that ignores the rule and publishes straight to LiveKit.
  for (const person of [ada, ben, cy]) await watch(person);
  await ben.page.evaluate(async () => {
    const me = window.__meetly.room.localParticipant;
    const data = new TextEncoder().encode(JSON.stringify({ emoji: "👍" }));
    for (let i = 0; i < 12; i++) await me.publishData(data, { reliable: true, topic: "meetly-reaction" });
  });
  await H.sleep(1200);
  const flood = (await seen(ada)).filter((entry) => entry.name === "Ben Okri").length;
  H.ok("a client that floods anyway is rate-limited by each receiver", flood >= 1 && flood <= 3, `12 published, ${flood} shown`);

  // Anything that is not one of the six is dropped on arrival.
  for (const person of [ada, ben, cy]) await watch(person);
  await ben.page.evaluate(async () => {
    const me = window.__meetly.room.localParticipant;
    for (const emoji of ["💩", "<img src=x>", 7]) {
      await me.publishData(new TextEncoder().encode(JSON.stringify({ emoji })), { reliable: true, topic: "meetly-reaction" });
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    await me.publishData(new TextEncoder().encode("not json"), { reliable: true, topic: "meetly-reaction" });
  });
  await H.sleep(800);
  H.ok("reactions outside the allowed six never show", (await seen(ada)).length === 0, JSON.stringify(await seen(ada)));

  // Not in view: Spotlight shows one person, so the others' reactions rise in the lane instead.
  await ada.page.getByRole("button", { name: "Change layout" }).click();
  await ada.page.getByRole("menuitemradio", { name: /^Spotlight/ }).click();
  await ada.page.mouse.move(640, 300);
  await H.sleep(1500);
  const offStage = await ada.page.evaluate(() => {
    const shown = Array.from(document.querySelectorAll("[data-tile]"), (tile) => tile.getAttribute("aria-label") || "");
    return ["Ben Okri", "Cy Twombly"].find((name) => !shown.some((label) => label.startsWith(name)));
  });
  const sender = offStage === "Ben Okri" ? ben : cy;
  await sender.page.evaluate(() => window.__meetly.call.sendReaction("😂"));
  const lane = ada.page.locator("[data-reaction-lane]");
  await lane.waitFor({ timeout: 5000 }).catch(() => {});
  H.ok(
    "someone whose tile is not in view reacts in the lane, with their first name",
    (await lane.count()) === 1 && (await lane.innerText().catch(() => "")).includes(String(offStage).split(" ")[0]),
    `${offStage}: ${(await lane.innerText().catch(() => "")).replace(/\s+/g, " ")}`,
  );
  await H.shot(ada, "reactions-lane-desktop");
  H.ok("the lane empties again", await H.until(async () => (await lane.count()) === 0, 6000));

  // Phone: the bar has no room for a hand as well, so the strip carries it.
  const mo = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await H.join(mo, url, "Mo Phone");
  await H.sleep(1500);
  const react = mo.page.getByRole("button", { name: "Reactions and raise hand" });
  H.ok("phone: React takes the hand's place in the bar", (await react.count()) === 1 && (await mo.page.getByRole("button", { name: "Raise hand", exact: true }).count()) === 0);
  await react.click();
  await mo.page.locator("[data-reactions]").waitFor();
  await H.shot(mo, "reactions-strip-phone");
  H.ok("phone: the strip fits the screen", await H.noOverflow(mo));
  await mo.page.getByRole("menuitem", { name: "Thumbs up" }).click();
  H.ok("phone: a reaction sent from the strip reaches others", await H.until(async () => (await seen(ben)).some((entry) => entry.name === "Mo Phone" && entry.emoji === "👍"), 4000));
  await mo.page.getByRole("menuitem", { name: "Raise hand" }).click();
  H.ok("phone: Raise hand in the strip raises the hand", await H.until(() => ben.page.evaluate(() => window.__meetly.call.participants().some((p) => p.name === "Mo Phone" && p.handRaised)), 5000));
  H.ok("phone: the button shows the hand is up", await H.until(async () => (await mo.page.getByRole("button", { name: "Reactions, hand raised" }).count()) === 1, 3000));
  await H.shot(mo, "reactions-hand-up-phone");

  // Reduced motion: still shown, on the tile.
  const rae = await H.client(browser, { reducedMotion: "reduce" });
  await H.join(rae, url, "Rae Still");
  await H.sleep(1500);
  await cy.page.evaluate(() => window.__meetly.call.sendReaction("😮"));
  H.ok("reduced motion: the reaction still shows on the tile", await H.until(async () => (await badgeOn(rae, "Cy Twombly", "😮").count()) === 1, 4000));

  for (const person of [ada, ben, cy, mo, rae]) await person.ctx.close();
};
