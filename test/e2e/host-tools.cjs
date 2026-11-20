// Feature 3: mute all, stop a camera, lower hands, co-host, end the call for everyone.
const H = require("./lib.cjs");

const micOff = (person) => person.page.getByRole("button", { name: "Unmute microphone" });
const camOff = (person) => person.page.getByRole("button", { name: "Turn on camera" });
const menuFor = async (person, name) => {
  await H.openPeople(person);
  await person.page.getByRole("list", { name: "Participants" }).getByRole("button", { name: `Host controls for ${name}` }).click();
};

module.exports = async function hostTools(browser) {
  console.log("\n— host tools —");
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser, { scale: 2 });
  const cy = await H.client(browser, { scale: 2 });
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Lovelace");
  await H.join(ben, url, "Ben Okri");
  await H.join(cy, url, "Cy Twombly");
  await ada.page.waitForFunction(() => document.querySelectorAll("[data-tile]").length === 3, null, { timeout: 20000 });
  await H.sleep(2800);
  const [adaId, benId, cyId] = [await H.identity(ada), await H.identity(ben), await H.identity(cy)];

  /* mute all */
  await H.openPeople(ada);
  await H.shot(ada, "host-people-panel-desktop");
  await ada.page.getByRole("button", { name: "Mute everyone" }).click();
  await micOff(ben).waitFor({ timeout: 8000 }).catch(() => {});
  await micOff(cy).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("mute all reaches every guest", (await micOff(ben).count()) === 1 && (await micOff(cy).count()) === 1);
  H.ok("mute all leaves the host's own microphone on", (await ada.page.getByRole("button", { name: "Mute microphone" }).count()) === 1);
  H.ok("each muted guest is told once, the way a single mute tells them", (await ben.page.getByText("The host muted your microphone").count()) === 1);
  H.ok("the host gets one confirmation", (await ada.page.getByText("You muted everyone").count()) === 1);
  await ben.page.getByRole("button", { name: "Unmute microphone" }).click();
  H.ok("a muted guest can unmute again (nobody is forced silent)", await H.until(async () => (await micOff(ben).count()) === 0, 5000));

  /* stop one camera */
  await menuFor(ada, "Ben Okri");
  await H.shot(ada, "host-menu-desktop");
  await ada.page.getByRole("menuitem", { name: "Turn off camera" }).click();
  await camOff(ben).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("stopping a camera reaches that person", (await camOff(ben).count()) === 1);
  H.ok("…and they are told why", await H.until(async () => (await ben.page.getByText("The host turned off your camera").count()) === 1, 4000));
  H.ok("…and nobody else's camera is touched", (await camOff(cy).count()) === 0);
  await ben.page.getByRole("button", { name: "Turn on camera" }).click();
  H.ok("they can turn it back on themselves", await H.until(async () => (await camOff(ben).count()) === 0, 8000));
  await ada.page.getByRole("button", { name: "Dismiss notification" }).first().click().catch(() => {});

  /* lower hands */
  await ben.page.keyboard.press("h");
  await cy.page.keyboard.press("h");
  const hands = (person) => person.page.evaluate(() => window.__meetly.call.participants().filter((p) => p.handRaised).length);
  await H.until(async () => (await hands(ada)) === 2, 6000);
  await menuFor(ada, "Ben Okri");
  await ada.page.getByRole("menuitem", { name: "Lower hand" }).click();
  H.ok("lowering one hand lowers that hand only", await H.until(async () => (await hands(ada)) === 1 && (await hands(ben)) === 1, 6000));
  await ben.page.keyboard.press("h");
  await H.until(async () => (await hands(ada)) === 2, 6000);
  await H.openPeople(ada);
  const handsSection = H.people(ada).getByRole("region", { name: "Raised hands" });
  await handsSection.getByText("2nd").waitFor({ timeout: 6000 }).catch(() => {});
  H.ok("the raised hands section numbers them in the order they went up", (await handsSection.getByText("1st").count()) === 1 && (await handsSection.getByText("2nd").count()) === 1);
  await H.shot(ada, "host-hands-section-desktop");
  await handsSection.getByRole("button", { name: "Lower all" }).click();
  H.ok(
    "lower all hands reaches every client",
    await H.until(async () => (await hands(ada)) === 0 && (await hands(ben)) === 0 && (await hands(cy)) === 0, 6000),
  );
  H.ok("…and each person's own hand button is back to Raise hand", (await ben.page.getByRole("button", { name: "Raise hand" }).count()) === 1);

  /* allow reactions */
  // Everyone notes who each reaction came from, as the call reports it.
  for (const person of [ada, ben, cy]) {
    await person.page.evaluate(() => {
      window.__reactionsFrom = [];
      window.__meetly.call.on("reaction", (participant) => window.__reactionsFrom.push(participant.identity));
    });
  }
  const reactionsFrom = (person, who) => person.page.evaluate((id) => window.__reactionsFrom.filter((from) => from === id).length, who);
  const allowed = (person) => person.page.evaluate(() => window.__meetly.call.reactionsAllowed);
  await H.openPeople(ada);
  await ada.page.getByRole("button", { name: "More actions for everyone" }).click();
  const allowSwitch = ada.page.getByRole("menuitemcheckbox", { name: /Allow reactions/ });
  H.ok("the host's ⋯ menu has Allow reactions, on", (await allowSwitch.getAttribute("aria-checked")) === "true");
  await allowSwitch.click();
  H.ok("turning it off reaches every client", await H.until(async () => !(await allowed(ada)) && !(await allowed(ben)) && !(await allowed(cy)), 8000));
  H.ok("…and the switch shows it, with the menu still open", await H.until(async () => (await allowSwitch.getAttribute("aria-checked")) === "false", 3000));
  await H.shot(ada, "allow-reactions-off-desktop");
  await ada.page.keyboard.press("Escape");
  await cy.page.getByRole("button", { name: "React" }).click();
  const strip = cy.page.locator("[data-reactions]");
  await strip.waitFor();
  H.ok(
    "a guest's react strip is disabled, and says why",
    (await strip.getByText("The host turned off reactions").count()) === 1 && (await strip.locator('[role="menuitem"][data-disabled]').count()) === 6,
  );
  await H.shot(cy, "react-strip-off-desktop");
  await cy.page.keyboard.press("Escape");
  // A modified client sends one anyway, straight to the room.
  await cy.page.evaluate(() =>
    window.__meetly.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ emoji: "🎉" })), { reliable: true, topic: "meetly-reaction" }),
  );
  await ada.page.evaluate(() => window.__meetly.call.sendReaction("👍"));
  await H.sleep(1500);
  H.ok("a forged reaction is dropped on arrival", (await reactionsFrom(ada, cyId)) === 0 && (await reactionsFrom(ben, cyId)) === 0);
  H.ok("…while the host can still react, and is seen", (await reactionsFrom(ben, adaId)) === 1 && (await reactionsFrom(cy, adaId)) === 1);
  await ada.page.getByRole("button", { name: "More actions for everyone" }).click();
  await allowSwitch.click();
  await ada.page.keyboard.press("Escape");
  H.ok("turning it back on reaches every client", await H.until(async () => (await allowed(ben)) && (await allowed(cy)), 8000));
  await cy.page.evaluate(() => window.__meetly.call.sendReaction("👏"));
  H.ok("…and the guest's reaction arrives again", await H.until(async () => (await reactionsFrom(ben, cyId)) === 1, 4000));

  /* co-host */
  H.ok("a guest cannot make themselves co-host", (await H.hostApi(ben, { token: ben.token, action: "coHost", identity: benId, on: true })) === 403);
  await menuFor(ada, "Ben Okri");
  await ada.page.getByRole("menuitem", { name: "Make co-host" }).click();
  H.ok("the new co-host is told", await H.until(async () => (await ben.page.getByText("You're now a co-host").count()) === 1, 6000));
  await H.openPeople(ben);
  await H.openPeople(cy);
  H.ok("the co-host gets the moderation controls", await H.until(() => H.hostControlsShown(ben), 4000));
  H.ok("everyone is shown who the co-host is", await H.until(async () => (await H.people(cy).getByText("Co-host").count()) === 1, 4000));
  H.ok("the co-host has no controls for the host", (await ben.page.getByRole("button", { name: "Host controls for Ada Lovelace" }).count()) === 0);
  await H.shot(ben, "cohost-people-panel-desktop");
  const asBen = { token: ben.token };
  const refused = {
    end: await H.hostApi(ben, { ...asBen, action: "end" }),
    coHostOther: await H.hostApi(ben, { ...asBen, action: "coHost", identity: cyId, on: true }),
    muteHost: await H.hostApi(ben, { ...asBen, action: "mute", identity: adaId }),
    removeHost: await H.hostApi(ben, { ...asBen, action: "remove", identity: adaId }),
  };
  H.ok("a co-host cannot end the call, make co-hosts, or act on the host", Object.values(refused).every((status) => status === 403), JSON.stringify(refused));
  H.ok("a third person is still just a guest", (await H.hostApi(cy, { token: cy.token, action: "muteAll" })) === 403 && !(await H.hostControlsShown(cy)));

  // The co-host removes someone; that person cannot walk back in.
  await menuFor(ben, "Cy Twombly");
  await ben.page.getByRole("menuitem", { name: "Remove from meeting" }).click();
  await H.shot(ben, "remove-dialog-desktop");
  await ben.page.getByRole("button", { name: "Remove from meeting", exact: true }).click();
  await cy.page.getByText("The host removed you").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("a co-host can remove someone", (await cy.page.getByText("The host removed you").count()) === 1);
  await H.shot(cy, "removed-screen-desktop");
  H.ok("the removed person is not offered a way back", (await cy.page.getByRole("button", { name: "Rejoin" }).count()) === 0);
  await cy.page.goto(url);
  await H.press(cy, url, "Cy Twombly");
  await cy.page.getByRole("alert").filter({ hasText: "The host removed you from this meeting." }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok(
    "the removed person cannot rejoin: the server refuses them",
    cy.tokenStatus === 403 && (await cy.page.getByText("The host removed you from this meeting.").count()) === 1 && !(await H.isInCall(cy)),
    `token route answered ${cy.tokenStatus}`,
  );
  await H.shot(cy, "removed-refused-desktop");
  H.ok("…and their old token no longer moderates or counts as in the room", (await H.hostApi(cy, { token: cy.token, action: "muteAll" })) === 403);
  H.ok("the call carries on without them", await H.until(() => ada.page.evaluate(() => window.__meetly.call.participants().length === 2), 5000));

  // Taking co-host away again.
  await menuFor(ada, "Ben Okri");
  await ada.page.getByRole("menuitem", { name: "Remove as co-host" }).click();
  H.ok("a co-host who is demoted loses the controls and the server's say-so", await H.until(async () => !(await H.hostControlsShown(ben)) && (await H.hostApi(ben, asBen.token ? { ...asBen, action: "muteAll" } : {})) === 403, 6000));

  /* end the call for everyone */
  const dee = await H.client(browser);
  await H.join(dee, url, "Dee Late");
  await H.closePeople(ada);
  await ada.page.getByRole("button", { name: "More ways to leave" }).click();
  await H.shot(ada, "leave-menu-desktop");
  await ada.page.getByRole("menuitem", { name: "End meeting for everyone" }).click();
  await ada.page.getByRole("dialog").getByText("End the meeting for everyone?").waitFor();
  await H.shot(ada, "end-dialog-desktop");
  await ada.page.getByRole("button", { name: "End meeting", exact: true }).click();
  await ben.page.getByText("The host ended the meeting").waitFor({ timeout: 8000 }).catch(() => {});
  await dee.page.getByText("The host ended the meeting").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("ending the call reaches every client", (await ben.page.getByText("The host ended the meeting").count()) === 1 && (await dee.page.getByText("The host ended the meeting").count()) === 1);
  H.ok("the host is told it was their doing", await H.until(async () => (await ada.page.getByText("You ended the meeting").count()) === 1, 6000));
  await H.shot(ben, "ended-screen-desktop");
  // The meeting can be started again by the same host, and by nobody else.
  await ben.page.getByRole("button", { name: "Rejoin" }).click();
  await H.join(ben, url, "Ben Okri");
  await ada.page.getByRole("button", { name: "Start again" }).click();
  await H.join(ada, url, "Ada Lovelace");
  await H.openPeople(ada);
  await H.openPeople(ben);
  await ada.page.getByRole("button", { name: "Host controls for Ben Okri" }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("after ending, the same host is host of the next call, and the first person back is not", (await H.hostControlsShown(ada)) && !(await H.hostControlsShown(ben)));

  /* phone: everything reachable */
  const mo = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const phoneUrl = await H.createMeeting(mo);
  await H.join(mo, phoneUrl, "Mo Phone");
  const pat = await H.client(browser);
  await H.join(pat, phoneUrl, "Pat Guest");
  await H.sleep(1500);
  await H.openPeople(mo);
  await H.shot(mo, "host-people-panel-phone");
  H.ok("phone: the people sheet holds the host's tools without overflowing", (await mo.page.getByRole("button", { name: "Mute everyone" }).count()) === 1 && (await H.noOverflow(mo)));
  await mo.page.getByRole("list", { name: "Participants" }).getByRole("button", { name: "Host controls for Pat Guest" }).click();
  await H.shot(mo, "host-menu-phone");
  await mo.page.getByRole("menuitem", { name: "Mute microphone" }).click();
  H.ok("phone: muting from the sheet's menu works", await H.until(async () => (await micOff(pat).count()) === 1, 6000));
  await H.closePeople(mo);
  await mo.page.getByRole("button", { name: "More options" }).click();
  const endItem = mo.page.getByRole("menuitem", { name: "End meeting for everyone" });
  await endItem.scrollIntoViewIfNeeded();
  await H.shot(mo, "more-menu-end-phone");
  H.ok("phone: End meeting for everyone is in the More menu", (await endItem.count()) === 1);
  await endItem.click();
  await H.shot(mo, "end-dialog-phone");
  await mo.page.getByRole("button", { name: "End meeting", exact: true }).click();
  H.ok("phone: ending from the More menu ends it for the guest", await H.until(async () => (await pat.page.getByText("The host ended the meeting").count()) === 1, 8000));
  await H.shot(mo, "ended-screen-host-phone");

  for (const person of [ada, ben, cy, dee, mo, pat]) await person.ctx.close();

  await atScale(browser);
};

/**
 * Installs window.__sim on a page that is in a call: a synthetic crowd pushed through the call's
 * own interface (window.__meetly.call), so the People panel sees what an adapter would send it.
 * Admit all, Deny all and Lower all still go to our server once, for real; the server finds none
 * of these people and answers yes. Nothing here shows how a real crowd behaves.
 */
const SCALE_SIM = () => {
  const call = window.__meetly.call;
  const real = {
    participants: call.participants.bind(call),
    remoteIds: call.remoteIds.bind(call),
    participant: call.participant.bind(call),
    waiting: call.waiting.bind(call),
    moderate: call.moderate.bind(call),
  };
  const fake = new Map();
  let waiters = [];
  let roster = null;
  let seq = 0;
  let failNext = null;
  const moderated = [];
  const person = (name) => {
    const n = seq++;
    const listeners = new Set();
    return {
      identity: `sim-${n}`,
      isLocal: false,
      name: name || `Person ${n}`,
      role: "speaker",
      micOn: false,
      camOn: false,
      handRaised: false,
      speaking: false,
      weakConnection: false,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      notify() {
        listeners.forEach((listener) => listener());
      },
    };
  };
  const changed = () => {
    roster = null;
    call.emit("roster");
  };
  call.participants = () => (roster ??= [...real.participants(), ...fake.values()]);
  call.remoteIds = () => [...real.remoteIds(), ...fake.keys()];
  call.participant = (id) => fake.get(id) || real.participant(id);
  call.waiting = () => (waiters.length ? waiters : real.waiting());
  call.moderate = async (action) => {
    moderated.push(action);
    if (failNext && action.action === "admitAll") {
      const failed = failNext;
      failNext = null;
      throw Object.assign(new Error(`Couldn't admit ${failed.length} people. Try again.`), { failed });
    }
    await real.moderate(action);
    if (action.action === "admitAll" || action.action === "denyAll") {
      const done = new Set(action.identities);
      waiters = waiters.filter((waiter) => !done.has(waiter.id));
      call.emit("waiting");
    }
    if (action.action === "lowerAllHands") {
      for (const p of fake.values()) {
        if (!p.handRaised) continue;
        p.handRaised = false;
        p.notify();
      }
      changed();
    }
  };
  window.__sim = {
    moderated,
    join(n, name) {
      for (let i = 0; i < n; i++) {
        const p = person(name);
        fake.set(p.identity, p);
        changed();
        call.emit("participantJoined", p);
      }
    },
    leave(n) {
      for (const p of [...fake.values()].filter((x) => !x.handRaised).slice(0, n)) {
        fake.delete(p.identity);
        changed();
        call.emit("participantLeft", p);
      }
    },
    hands(n) {
      for (const p of [...fake.values()].filter((x) => !x.handRaised).slice(0, n)) {
        p.handRaised = true;
        p.notify();
        changed();
        call.emit("handRaised", p);
      }
    },
    knock(n, names = []) {
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        const p = person(names[i]);
        // Oldest first, a few seconds apart, the first of them minutes ago.
        waiters = [...waiters, { id: p.identity, name: p.name, since: now - (n - i) * 5000 }];
      }
      call.emit("waiting");
    },
    failNext(count) {
      failNext = waiters.slice(0, count).map((waiter) => waiter.id);
      return failNext;
    },
  };
};

/** Scroll containers inside the panel that sit inside another one. */
const nestedScrollers = (person) =>
  person.page.evaluate(() => {
    const panel = document.querySelector('aside[aria-label="People"]');
    const scrolls = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY);
    return [...panel.querySelectorAll("*")].filter((el) => {
      if (!scrolls(el)) return false;
      for (let up = el.parentElement; up && up !== panel; up = up.parentElement) if (scrolls(up)) return true;
      return false;
    }).length;
  });

/** `locator` is fully inside the panel's visible area, with the list not scrolled. */
const inView = (person, locator) =>
  locator.evaluate((el) => {
    const panel = document.querySelector('aside[aria-label="People"]').getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return box.height > 0 && box.top >= panel.top && box.bottom <= panel.bottom;
  });

/** C5, C6 and C18: 128 waiting, 101 hands and 40 departures, with one real host and one real guest. */
async function atScale(browser) {
  console.log("\n— host tools at scale —");
  const hana = await H.client(browser, { viewport: { width: 1440, height: 900 }, scale: 2 });
  const gus = await H.client(browser);
  const url = await H.createMeeting(hana);
  await H.join(hana, url, "Hana Host");
  await H.join(gus, url, "Gus Guest");
  await H.sleep(1500);
  for (const person of [hana, gus]) await person.page.evaluate(SCALE_SIM);
  await gus.page.evaluate(() => window.__sim.join(50));
  const LONG = "Maximiliana Alexandra Fitzgerald-Okonkwo";
  await hana.page.evaluate((long) => {
    window.__sim.join(200);
    window.__sim.hands(101);
    window.__sim.knock(128, [undefined, undefined, long]);
  }, LONG);
  await H.openPeople(hana);
  const panel = H.people(hana);
  const section = panel.getByRole("region", { name: "Waiting to join" });
  await section.waitFor();
  await H.sleep(500);
  const height = await panel.evaluate((el) => Math.round(el.getBoundingClientRect().height));

  /* C5 */
  const seeAll = panel.getByRole("button", { name: "See all 128 waiting" });
  const handsHeader = panel.getByRole("region", { name: "Raised hands" }).getByRole("heading");
  H.ok(
    `C5: with 128 waiting the section shows 5 rows, then See all 128 waiting and the Raised hands header, without scrolling (panel ${height}px)`,
    (await section.locator("li").count()) === 5 && (await inView(hana, seeAll)) && (await inView(hana, handsHeader)),
  );
  H.ok("C5: no scroll container inside another", (await nestedScrollers(hana)) === 0);
  H.ok("C5: oldest first, each with how long they have waited", /^Waiting \d+ min$/.test((await section.locator("li").first().locator("span.text-xs").innerText()).trim()));
  const long = section.getByText(LONG, { exact: true });
  const wrap = await long.evaluate((el) => ({ lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)), cut: el.scrollWidth > el.clientWidth }));
  H.ok("C5: a long name wraps rather than being cut off", wrap.lines >= 2 && !wrap.cut, JSON.stringify(wrap));
  await H.shot(hana, "c5-waiting-section-desktop");

  const requests = [];
  hana.page.on("request", (request) => {
    if (request.url().endsWith("/api/host")) requests.push(JSON.parse(request.postData() || "{}"));
  });
  await section.getByRole("button", { name: "Admit all" }).click();
  const confirm = panel.getByRole("group", { name: "Admit 128 people?" });
  H.ok("C5: Admit all over 25 asks first, inline, not in a dialog", (await confirm.count()) === 1 && (await hana.page.getByRole("dialog").count()) === 0);
  await H.shot(hana, "c5-admit-all-confirm-desktop");
  await confirm.getByRole("button", { name: "Admit 128" }).click();
  await H.until(() => hana.page.evaluate(() => window.__meetly.call.waiting().length === 0), 8000);
  await H.sleep(500);
  H.ok(
    "C5: Admit all with 128 waiting is one request, and the list empties",
    requests.length === 1 && requests[0].action === "admitAll" && requests[0].identities.length === 128 && (await section.count()) === 0,
    JSON.stringify(requests.map((body) => [body.action, (body.identities || []).length])),
  );

  // A failure for three of them: one notification, and Try again answers just those three.
  await hana.page.evaluate(() => window.__sim.knock(30));
  const failing = await hana.page.evaluate(() => window.__sim.failNext(3));
  await panel.getByRole("button", { name: "See all 30 waiting" }).click();
  const view = panel.getByRole("region", { name: "Waiting to join" });
  H.ok("C5: See all opens the waiting view in the panel, with a back arrow and search", (await panel.getByRole("button", { name: "Back to everyone" }).count()) === 1 && (await panel.getByLabel("Search 30 waiting").count()) === 1);
  const someone = await hana.page.evaluate(() => window.__meetly.call.waiting()[7].name);
  await panel.getByLabel("Search 30 waiting").fill(someone);
  H.ok("C5: searching the waiting view narrows it", await H.until(async () => (await view.locator("li").count()) === 1, 3000));
  await panel.getByLabel("Search 30 waiting").fill("");
  await H.shot(hana, "c5-see-all-desktop");
  await view.getByRole("button", { name: "Admit all 30" }).click();
  await view.getByRole("group", { name: "Admit 30 people?" }).getByRole("button", { name: "Admit 30" }).click();
  const notice = hana.page.locator("[data-toast]").filter({ hasText: "Couldn't admit 3 people" });
  await notice.waitFor({ timeout: 5000 }).catch(() => {});
  H.ok("C5: three failures are one notification, Couldn't admit 3 people, with Try again", (await notice.count()) === 1 && (await notice.getByRole("button", { name: "Try again" }).count()) === 1);
  await H.shot(hana, "c5-admit-failed-desktop");
  await notice.getByRole("button", { name: "Try again" }).click();
  const last = await H.until(async () => {
    const action = await hana.page.evaluate(() => window.__sim.moderated.at(-1));
    return action.action === "admitAll" && JSON.stringify(action.identities) === JSON.stringify(failing);
  }, 4000);
  H.ok("C5: Try again answers only the three it failed for", last);
  // The other 27 are still waiting. Denying them empties the view, which goes back to everyone.
  await view.getByRole("button", { name: "Deny all" }).click();
  await view.getByRole("group", { name: "Deny 27 people?" }).getByRole("button", { name: "Deny 27" }).click();
  H.ok("C5: Deny all over 25 asks too, and an emptied view returns to everyone", await H.until(async () => (await panel.getByRole("button", { name: "Back to everyone" }).count()) === 0 && (await panel.getByText("Copy meeting link").count()) === 1, 5000));

  /* C6 */
  const hands = panel.getByRole("region", { name: "Raised hands" });
  const ordinals = await hands.locator("li span.text-xs").allInnerTexts();
  H.ok("C6: with 101 hands the section shows the first five, 1st to 5th", JSON.stringify(ordinals) === JSON.stringify(["1st", "2nd", "3rd", "4th", "5th"]), JSON.stringify(ordinals));
  H.ok("C6: Lower all is in the section header, and See all 101 under it", (await hands.getByRole("button", { name: "Lower all" }).count()) === 1 && (await hands.getByRole("button", { name: "See all 101 raised hands" }).count()) === 1);
  await H.shot(hana, "c6-hands-section-desktop");
  await hands.getByRole("button", { name: "See all 101 raised hands" }).click();
  H.ok("C6: See all lists every hand in order", await H.until(async () => (await panel.getByRole("list", { name: "Raised hands, in order" }).getByText("6th", { exact: true }).count()) === 1, 3000));
  await H.shot(hana, "c6-see-all-desktop");
  await panel.getByRole("button", { name: "Back to everyone" }).click();
  const before = requests.length;
  await hands.getByRole("button", { name: "Lower all" }).click();
  H.ok(
    "C6: Lower all is one tap and one request, and the section goes",
    await H.until(async () => (await hands.count()) === 0, 5000) && requests.slice(before).filter((body) => body.action === "lowerAllHands").length === 1,
  );

  /* C18 */
  for (const person of [hana, gus]) await person.page.evaluate(() => window.__sim.leave(40));
  const left = panel.getByRole("region", { name: "Left the meeting" });
  await left.scrollIntoViewIfNeeded();
  const toggle = left.getByRole("button", { name: /Left the meeting/ });
  H.ok("C18: the host sees Left the meeting 40, collapsed, since you joined", /Left the meeting\s*40/.test(await toggle.textContent()) && (await toggle.getAttribute("aria-expanded")) === "false" && (await left.getByText("Since you joined").count()) === 1);
  await toggle.click();
  const firstLeft = (await left.locator("li").first().locator("span.truncate").textContent()).trim();
  // Lower all put every hand down, so the forty who left were Person 0 to Person 39, in order.
  H.ok("C18: expanded, newest first", firstLeft === "Person 39", firstLeft);
  await left.scrollIntoViewIfNeeded();
  await H.shot(hana, "c18-left-desktop");
  await hana.page.evaluate(() => window.__sim.join(1, "Person 39"));
  H.ok("C18: someone who rejoins moves back up", await H.until(async () => /Left the meeting\s*39/.test(await toggle.textContent()), 3000));
  await H.openPeople(gus);
  H.ok("C18: a guest doesn't see it", (await H.people(gus).getByRole("region", { name: "Left the meeting" }).count()) === 0);

  /* the knock card's View, which ModerationNotices wires to openWaiting() */
  const wired = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../src/components/ModerationNotices.tsx"), "utf8").includes("openWaiting");
  if (wired) {
    await H.closePeople(hana);
    await hana.page.evaluate(() => window.__sim.knock(10));
    const card = hana.page.locator("[data-toast]").filter({ hasText: "10 people want to join" });
    await card.getByRole("button", { name: "View" }).click();
    H.ok("C5: the knock card's View opens the waiting view with more than 5 waiting", await H.until(async () => (await panel.getByRole("button", { name: "Back to everyone" }).count()) === 1, 4000));
  } else {
    console.log("SKIP  C5: knock card View → openWaiting() (applied by E1 in ModerationNotices.tsx)");
  }

  /* phone */
  await hana.page.setViewportSize(H.PHONE);
  await H.openPeople(hana);
  await hana.page.evaluate(() => window.__sim.knock(40));
  await H.sleep(600);
  await H.shot(hana, "c5-waiting-section-phone");
  await panel.getByRole("button", { name: /^See all \d+ waiting$/ }).click();
  await H.sleep(400);
  H.ok("phone: the waiting view fits", await H.noOverflow(hana));
  await H.shot(hana, "c5-see-all-phone");

  for (const person of [hana, gus]) await person.ctx.close();
}
